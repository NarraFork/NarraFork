import { hotSafe, hotTimer, hotTimerClear } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { isUnattendedShutdownFenced } from "../lib/shutdown-activity";
import { notifyScheduledRunChanged } from "./scheduled-task-notify";
import { setScheduledRunNotifier } from "./scheduled-task-run-service";
import { pollScheduledRuns } from "./scheduled-task-run-tracker";
import { scheduledTaskService } from "./scheduled-task-service";

const TIMER_KEY = "scheduled-task-scheduler";
const TRACKER_TIMER_KEY = "scheduled-task-run-tracker";
const TICK_INTERVAL_MS = 30_000;
const TRACKER_INTERVAL_MS = 2_000;
const state = hotSafe("scheduled-task-scheduler:state", () => ({
	ticking: false,
	stopped: false,
	generation: 0,
	startupRecovery: Promise.resolve() as Promise<void>,
	tracking: undefined as Promise<void> | undefined,
	drainWaiters: [] as Array<() => void>,
}));
// A hot replacement may retain the pre-drain scheduler state.
state.startupRecovery ??= Promise.resolve();
state.drainWaiters ??= [];

export function isScheduledTaskTickActive(): boolean {
	return state.ticking;
}

/** Poll for due work only after startup catch-up; dispatches are bounded by listDue. */
async function tick(): Promise<void> {
	if (state.ticking || state.stopped || isUnattendedShutdownFenced()) return;
	const generation = state.generation;
	state.ticking = true;
	try {
		await scheduledTaskService.reconcilePausedTasks();
		const due = await scheduledTaskService.listDue();
		if (state.stopped || generation !== state.generation || isUnattendedShutdownFenced()) return;
		const results = await Promise.allSettled(
			due.map((task) => scheduledTaskService.runTask(task.id)),
		);
		for (const [index, result] of results.entries()) {
			if (result.status === "rejected")
				logger.error("Scheduled task tick error", {
					taskId: due[index]?.id,
					error: String(result.reason),
				});
		}
	} catch (error) {
		logger.error("Scheduled task scheduler tick failed", { error: String(error) });
	} finally {
		state.ticking = false;
		for (const resolve of state.drainWaiters.splice(0)) resolve();
	}
}

function track(): void {
	if (state.stopped || state.tracking) return;
	state.tracking = pollScheduledRuns()
		.catch((error) => {
			logger.error("Scheduled run tracking failed", { error: String(error) });
		})
		.finally(() => {
			state.tracking = undefined;
		});
}

/** Generation fencing prevents a late recovery from restarting a stopped/hot-replaced timer. */
export function startScheduledTaskScheduler(): void {
	const generation = ++state.generation;
	state.stopped = false;
	hotTimerClear(TIMER_KEY);
	hotTimerClear(TRACKER_TIMER_KEY);
	setScheduledRunNotifier(notifyScheduledRunChanged);
	// Runtime recovery is mounted by main before continuation restoration. Its watchdog
	// must keep working even if schedule backfill fails; only new dispatch waits for it.
	hotTimer(TRACKER_TIMER_KEY, () => setInterval(track, TRACKER_INTERVAL_MS));
	track();
	const previousRecovery = state.startupRecovery;
	const recovery = scheduledTaskService
		.recoverOnStartup()
		.then(() => {
			if (state.stopped || generation !== state.generation) return;
			hotTimer(TIMER_KEY, () =>
				setInterval(() => {
					void tick();
				}, TICK_INTERVAL_MS),
			);
			void tick();
			logger.info("Scheduled task scheduler started");
		})
		.catch((error) => {
			logger.error("Scheduled task recovery failed; dispatch remains stopped", {
				error: String(error),
			});
		});
	// A superseded startup may still use the database even after its timers are fenced.
	state.startupRecovery = Promise.all([previousRecovery, recovery]).then(() => {});
}

/** Stop new dispatch and drain recovery, dispatch and tracking before closing database workers. */
export async function stopScheduledTaskScheduler(): Promise<void> {
	state.stopped = true;
	state.generation++;
	hotTimerClear(TIMER_KEY);
	hotTimerClear(TRACKER_TIMER_KEY);
	await state.startupRecovery;
	if (state.ticking) await new Promise<void>((resolve) => state.drainWaiters.push(resolve));
	await state.tracking;
}
