import {
	ACTIVE_RUN_STATUSES,
	isRunOutcome,
	RUN_AUTO_HANDLED_NOTE_LIMIT,
	type RunAutoHandled,
	type RunBlockReason,
	type RunErrorKind,
	type RunOutcome,
	type ScheduledRunStatus,
} from "@shared/scheduled-task-status";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { scheduledTaskRuns, scheduledTasks } from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { RunControl, RunResult } from "./agent-runtime/ownership";
import { getRunControl } from "./agent-runtime/ownership";
import {
	bindScheduledRunMember,
	getRegisteredScheduledRun,
	getScheduledRunById,
	getScheduledRunMember,
	recordScheduledRunTerminal,
	type ScheduledRunRegistration,
	unregisterScheduledRun,
} from "./scheduled-run-registry";

const locks = hotSafe("narrafork.scheduled-run-writes.v1", () => new AsyncMutex());
export type ScheduledRunNotice = "blocked" | "failed" | "completed" | "circuit_breaker";
const notifier = hotSafe("narrafork.scheduled-run-notifier.v1", () => ({
	callback: undefined as undefined | ((runId: string, kind: ScheduledRunNotice) => Promise<void>),
}));

export function setScheduledRunNotifier(callback: NonNullable<typeof notifier.callback>): void {
	notifier.callback = callback;
}

async function notify(runId: string, kind: ScheduledRunNotice): Promise<void> {
	eventBus.emit({ type: "scheduled_task:changed" });
	eventBus.emit({ type: "scheduled_task:notify_run", runId, kind });
	await notifier.callback?.(runId, kind).catch((error) => {
		logger.warn("Scheduled run notification failed", { runId, kind, error: String(error) });
	});
}

/** Real ancestry and exact runtime receipts, never a caller-supplied root/task id or trait. */
export async function lookupScheduledRun(
	narratorId: string,
): Promise<ScheduledRunRegistration | undefined> {
	const member = getScheduledRunMember(narratorId);
	if (!member) return undefined;
	const root = getScheduledRunById(member.runId);
	if (!root) return undefined;
	const control = getRunControl(narratorId);
	if (!control || control.logicalRunId !== member.logicalRunId) return undefined;
	const { narratorService } = await import("./narrator-service");
	const visited = new Set<string>();
	let id: string | null = narratorId;
	while (id && visited.size < 32 && !visited.has(id)) {
		visited.add(id);
		if (id === root.narratorId)
			return getScheduledRunById(root.runId) === root &&
				getScheduledRunMember(narratorId) === member &&
				getRunControl(narratorId)?.logicalRunId === member.logicalRunId
				? root
				: undefined;
		const row: { parentNarratorId: string | null } | null = await narratorService
			.getById(id)
			.catch(() => null);
		id = row?.parentNarratorId ?? null;
	}
	return undefined;
}

/** Called before any model pass; non-root membership must be authorized by its real parent. */
export async function attachScheduledRuntimeRun(input: {
	narratorId: string;
	run: RunControl;
	scheduledRunId?: string;
	initiatedBy?: "person" | "system";
}): Promise<void> {
	const { narratorId, run } = input;
	if (!run.logicalRunId) return;
	let root = getRegisteredScheduledRun(narratorId);
	let parentNarratorId: string | undefined;
	if (root && input.initiatedBy === "person" && input.scheduledRunId !== root.runId) {
		await finalizeScheduledRun(root.runId, "interrupted", {
			error: "A person started a new conversation turn",
			errorKind: "user_interrupt",
		});
		return;
	}
	if (input.scheduledRunId && root?.runId !== input.scheduledRunId)
		throw new ValidationError("Scheduled run registration expired before dispatch");
	if (!root) {
		const { narratorService } = await import("./narrator-service");
		const row = await narratorService.getById(narratorId).catch(() => null);
		parentNarratorId = row?.parentNarratorId ?? undefined;
		if (!parentNarratorId) return;
		const parent = getScheduledRunMember(parentNarratorId);
		if (!parent) return;
		root = getScheduledRunById(parent.runId);
		if (!root) return;
		// A persisted parent link alone is not proof: the live invocation must deliver
		// to that parent, and a supplied caller-run receipt must match its exact run.
		if (run.deliverTo?.narratorId !== parentNarratorId) return;
		if (run.cancelWith?.runId && run.cancelWith.runId !== parent.logicalRunId) return;
	}
	const registration = root;
	if (narratorId === registration.narratorId) {
		const changed = await db
			.update(scheduledTaskRuns)
			.set({ logicalRunId: run.logicalRunId })
			.where(
				and(
					eq(scheduledTaskRuns.id, registration.runId),
					inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
				),
			)
			.returning({ id: scheduledTaskRuns.id });
		if (!changed.length) throw new ValidationError("Scheduled run is no longer active");
	}
	bindScheduledRunMember({
		runId: registration.runId,
		narratorId,
		logicalRunId: run.logicalRunId,
		parentNarratorId,
	});
	const logicalRunId = run.logicalRunId;
	void run.terminal.then((result) => {
		const status = scheduledTerminalStatus(result);
		if (
			!recordScheduledRunTerminal(registration.runId, narratorId, {
				logicalRunId,
				status,
				error:
					result.terminalStatus?.errorMessage ??
					(result.hasError ? result.finalText.slice(0, 4000) : undefined),
				settledAt: Date.now(),
			})
		)
			return;
		// The scheduler is the durable polling fallback. The immediate check still
		// waits for inbox/background release; terminal alone is not task completion.
		void import("./scheduled-task-run-tracker")
			.then(({ pollScheduledRuns }) => pollScheduledRuns())
			.catch((error) => logger.warn("Scheduled terminal check failed", { error: String(error) }));
	});
}

export function scheduledTerminalStatus(
	result: Pick<RunResult, "started" | "timedOut" | "interrupted" | "hasError">,
) {
	if (result.timedOut) return "timed_out" as const;
	if (result.interrupted) return "interrupted" as const;
	if (result.hasError || !result.started) return "failed" as const;
	return "completed" as const;
}

export async function bindScheduledRunTrigger(
	runId: string,
	narratorId: string,
	messageId: string,
	nudge = false,
): Promise<void> {
	const registration = getRegisteredScheduledRun(narratorId);
	if (registration?.runId !== runId)
		throw new ValidationError("Scheduled run registration expired");
	const changed = await db
		.update(scheduledTaskRuns)
		.set(
			nudge
				? { status: "running", blockReason: null, blockedAt: null }
				: { triggerMessageId: messageId },
		)
		.where(
			and(
				eq(scheduledTaskRuns.id, runId),
				inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
				nudge ? undefined : isNull(scheduledTaskRuns.triggerMessageId),
			),
		)
		.returning({ id: scheduledTaskRuns.id });
	if (!changed.length)
		throw new ValidationError("Scheduled run has already been dispatched or settled");
	if (!nudge) registration.triggerMessageId = messageId;
}

export async function reportScheduledRun(
	narratorId: string,
	input: { outcome: RunOutcome; summary?: string },
) {
	if (!isRunOutcome(input.outcome)) throw new ValidationError("Invalid scheduled run outcome");
	const summary = input.summary?.trim() || null;
	if ((!summary && input.outcome !== "no_change") || (summary?.length ?? 0) > 2000)
		throw new ValidationError("Scheduled run summary must contain 1–2000 characters");
	const registration = await lookupScheduledRun(narratorId);
	if (!registration) throw new ValidationError("This narrator has no active scheduled run");
	return locks.acquire(registration.runId, async () => {
		// Permission/report races must not attach to the next task's run.
		if ((await lookupScheduledRun(narratorId))?.runId !== registration.runId)
			throw new ValidationError("Scheduled run has ended");
		const changed = await db
			.update(scheduledTaskRuns)
			.set({
				outcome: input.outcome,
				outcomeSummary: summary,
				outcomeReportedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(scheduledTaskRuns.id, registration.runId),
					inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
				),
			)
			.returning({ id: scheduledTaskRuns.id });
		if (!changed.length) throw new ValidationError("Scheduled run has ended");
		await db
			.update(scheduledTasks)
			.set({ lastOutcome: input.outcome, lastSummary: summary?.slice(0, 500) ?? null })
			.where(
				and(
					eq(scheduledTasks.id, registration.taskId),
					eq(scheduledTasks.lastRunId, registration.runId),
				),
			);
		eventBus.emit({ type: "scheduled_task:changed" });
		return { runId: registration.runId, outcome: input.outcome, summary };
	});
}

export async function recordScheduledAutoHandled(
	runId: string,
	reason: Exclude<RunBlockReason, "provider_wait">,
	note: string,
): Promise<void> {
	await locks.acquire(runId, async () => {
		const row = await db.query.scheduledTaskRuns.findFirst({
			where: eq(scheduledTaskRuns.id, runId),
			columns: { autoHandled: true },
		});
		if (!row) return;
		const value: RunAutoHandled = row.autoHandled ?? {
			question: 0,
			plan: 0,
			permission: 0,
			notes: [],
		};
		const autoHandled = {
			...value,
			[reason]: value[reason] + 1,
			notes: [...value.notes, note.slice(0, 200)].slice(-RUN_AUTO_HANDLED_NOTE_LIMIT),
		};
		await db
			.update(scheduledTaskRuns)
			.set({ autoHandled })
			.where(
				and(
					eq(scheduledTaskRuns.id, runId),
					inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
				),
			);
	});
}

export async function markScheduledRunBlocked(
	runId: string,
	reason: RunBlockReason | null,
): Promise<void> {
	const changed = await locks.acquire(runId, async () => {
		const row = await db.query.scheduledTaskRuns.findFirst({
			where: eq(scheduledTaskRuns.id, runId),
			columns: { taskId: true, status: true, blockReason: true, blockedAt: true },
		});
		if (!row || !ACTIVE_RUN_STATUSES.some((status) => status === row.status)) return false;
		const status = reason ? "blocked" : "running";
		if (row.status === status && row.blockReason === reason) return false;
		await db
			.update(scheduledTaskRuns)
			.set({
				status,
				blockReason: reason,
				blockedAt: reason ? (row.blockedAt ?? new Date().toISOString()) : null,
			})
			.where(
				and(
					eq(scheduledTaskRuns.id, runId),
					inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
				),
			);
		await db
			.update(scheduledTasks)
			.set({ lastStatus: status })
			.where(and(eq(scheduledTasks.id, row.taskId), eq(scheduledTasks.lastRunId, runId)));
		return true;
	});
	if (changed && reason) await notify(runId, "blocked");
}

/** At-most-once reservation is durable BEFORE sending; a crash must not resend it. */
export async function claimScheduledRunNudge(runId: string): Promise<boolean> {
	const rows = await db
		.update(scheduledTaskRuns)
		.set({ nudged: true })
		.where(
			and(
				eq(scheduledTaskRuns.id, runId),
				inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
				eq(scheduledTaskRuns.nudged, false),
				isNull(scheduledTaskRuns.outcome),
			),
		)
		.returning({ id: scheduledTaskRuns.id });
	return rows.length === 1;
}

export async function endScheduledRunForHumanInput(narratorId: string): Promise<void> {
	const registration = getRegisteredScheduledRun(narratorId);
	if (registration)
		await finalizeScheduledRun(registration.runId, "interrupted", {
			errorKind: "user_interrupt",
			error: "A person took over the conversation",
		});
}

/** Run and task projections settle in one short transaction; stale callbacks are inert. */
export async function finalizeScheduledRun(
	runId: string,
	status: Exclude<ScheduledRunStatus, "running" | "blocked" | "success">,
	details: { error?: string; errorKind?: RunErrorKind; expectedLogicalRunId?: string } = {},
): Promise<boolean> {
	const result = await locks.acquire(runId, async () => {
		const now = new Date().toISOString();
		const registration = getScheduledRunById(runId);
		return db.transaction((tx) => {
			const run = tx.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, runId)).get();
			if (!run || !ACTIVE_RUN_STATUSES.some((value) => value === run.status)) return null;
			if (details.expectedLogicalRunId && run.logicalRunId !== details.expectedLogicalRunId)
				return null;
			const changed = tx
				.update(scheduledTaskRuns)
				.set({
					status,
					error: details.error?.slice(0, 4000) ?? null,
					errorKind: details.errorKind ?? null,
					finishedAt: now,
					durationMs: Math.max(0, Date.parse(now) - Date.parse(run.startedAt ?? run.createdAt)),
					blockReason: null,
					blockedAt: null,
					stats: { ...run.stats, turns: registration?.turns ?? run.stats?.turns },
				})
				.where(
					and(
						eq(scheduledTaskRuns.id, runId),
						inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
					),
				)
				.returning({ id: scheduledTaskRuns.id })
				.get();
			if (!changed) return null;
			const task = tx
				.select({
					updatedAt: scheduledTasks.updatedAt,
					consecutiveFailures: scheduledTasks.consecutiveFailures,
				})
				.from(scheduledTasks)
				.where(eq(scheduledTasks.id, run.taskId))
				.get();
			let circuitBreaker = false;
			if (task) {
				const failures =
					status === "failed" || status === "timed_out"
						? task.consecutiveFailures + 1
						: status === "completed"
							? 0
							: task.consecutiveFailures;
				circuitBreaker = failures >= 5 && task.consecutiveFailures < 5;
				tx.update(scheduledTasks)
					.set({
						consecutiveFailures: failures,
						updatedAt: new Date(
							Math.max(Date.parse(now), (Date.parse(task.updatedAt) || 0) + 1),
						).toISOString(),
						...(circuitBreaker
							? { enabled: false, pauseReason: "circuit_breaker" as const, nextRunAt: null }
							: {}),
					})
					.where(eq(scheduledTasks.id, run.taskId))
					.run();
				tx.update(scheduledTasks)
					.set({
						lastStatus: status,
						lastError: details.error?.slice(0, 4000) ?? null,
						lastOutcome: run.outcome,
						lastSummary: run.outcomeSummary?.slice(0, 500) ?? null,
					})
					.where(and(eq(scheduledTasks.id, run.taskId), eq(scheduledTasks.lastRunId, runId)))
					.run();
			}
			tx.update(scheduledTasks)
				.set({ activeRunId: null })
				.where(and(eq(scheduledTasks.id, run.taskId), eq(scheduledTasks.activeRunId, runId)))
				.run();
			return { taskId: run.taskId, circuitBreaker };
		});
	});
	if (!result) return false;
	unregisterScheduledRun(runId);
	// Reconcile the actual schedule, not `enabled` or a null next-run timestamp.
	const { scheduledTaskService } = await import("./scheduled-task-service");
	await scheduledTaskService.reconcileCompletion(result.taskId);
	await notify(runId, status === "completed" ? "completed" : "failed");
	if (result.circuitBreaker) await notify(runId, "circuit_breaker");
	return true;
}
