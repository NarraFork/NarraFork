import { hotTimer, hotTimerClear } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { scheduledTaskService } from "./scheduled-task-service";

const TIMER_KEY = "scheduled-task-scheduler";
const TICK_INTERVAL_MS = 30_000;

let ticking = false;

/** Poll for due tasks and fire them. Guards against overlapping ticks. */
async function tick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		const due = await scheduledTaskService.listDue();
		// Fire due tasks concurrently. Each runTask is per-task locked and records its own
		// failures, and the actual agent loop is dispatched fire-and-forget (not awaited here),
		// so a slow launch (e.g. waking a dormant chapter's worktree) can't stall the others.
		// allSettled ensures one rejection never aborts the batch.
		const results = await Promise.allSettled(
			due.map((task) => scheduledTaskService.runTask(task.id)),
		);
		results.forEach((result, i) => {
			if (result.status === "rejected") {
				logger.error("Scheduled task tick error", {
					taskId: due[i]?.id,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
			}
		});
	} catch (err) {
		logger.error("Scheduled task scheduler tick failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		ticking = false;
	}
}

/**
 * Start the scheduled-task poller. Re-arms next run times on startup (no missed-run
 * backfill), then polls every 30s. Hot-reload safe via hotTimer.
 */
export function startScheduledTaskScheduler(): void {
	scheduledTaskService.recoverOnStartup().catch((err) =>
		logger.error("Scheduled task recovery failed", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);

	hotTimer(TIMER_KEY, () =>
		setInterval(() => {
			void tick();
		}, TICK_INTERVAL_MS),
	);
	logger.info("Scheduled task scheduler started");
}

/** Stop the scheduler (shutdown / hot-reload teardown). */
export function stopScheduledTaskScheduler(): void {
	hotTimerClear(TIMER_KEY);
}
