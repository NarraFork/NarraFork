import { normalizeRunContext } from "@shared/scheduled-task-run-context";
import {
	ACTIVE_RUN_STATUSES,
	SCHEDULED_TASK_LIMITS,
	type ScheduledRunInterruptTarget,
} from "@shared/scheduled-task-status";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, scheduledTaskRuns, scheduledTasks } from "../db/schema";
import { AppError, ForbiddenError, NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	getExecutionOwner,
	getLastExecutionEpoch,
	getRunControl,
	getRunHold,
} from "./agent-runtime/ownership";
import { canWriteNarrator } from "./narrator-acl";
import {
	getRegisteredScheduledRun,
	getScheduledRunById,
	getScheduledRunMember,
	listScheduledRunMembers,
	registerScheduledRun,
} from "./scheduled-run-registry";
import { assertTaskProjectWrite, resolveTaskPrincipal, taskOwnerId } from "./scheduled-task-acl";
import { scheduledTaskMutationLocks, scheduledTaskTargetLocks } from "./scheduled-task-admission";
import { cleanupScheduledTaskNarrators } from "./scheduled-task-cleanup";
import {
	finalizeScheduledRun,
	notifyScheduledRunAdmissionFailure,
} from "./scheduled-task-run-service";
import { nextTaskOccurrence } from "./scheduled-task-schedule-state";
import { resolveScheduledTaskTarget } from "./scheduled-task-target";

type Task = typeof scheduledTasks.$inferSelect;
type TaskRun = typeof scheduledTaskRuns.$inferSelect;
const TARGET_WAIT_LIMIT = SCHEDULED_TASK_LIMITS.maxWaitingPerNarrator;
const POLL_LIMIT = 64;
const INTERRUPT_WAIT_MS = SCHEDULED_TASK_LIMITS.interruptWaitMs;
const state = hotSafe("scheduled-tasks:waiting-v1", () => ({
	polling: undefined as Promise<void> | undefined,
	cursor: undefined as string | undefined,
	interruptAttempts: new Map<string, number>(),
	interruptMembers: new Map<string, ScheduledRunInterruptTarget[]>(),
}));
const changed = () => eventBus.emit({ type: "scheduled_task:changed" });
const conflict = () =>
	new AppError("Task changed before admission", 409, "SCHEDULED_TASK_CONFLICT");

async function taskWaitingRun(taskId: string) {
	return db.query.scheduledTaskRuns.findFirst({
		where: and(eq(scheduledTaskRuns.taskId, taskId), eq(scheduledTaskRuns.status, "waiting")),
		columns: { id: true },
	});
}

async function activeRun(task: Task, targetId: string | null) {
	return db.query.scheduledTaskRuns.findFirst({
		where: and(
			inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
			or(
				task.activeRunId ? eq(scheduledTaskRuns.id, task.activeRunId) : undefined,
				targetId ? eq(scheduledTaskRuns.narratorId, targetId) : undefined,
			),
			// An empty OR must never turn into an unbounded global active-run lookup.
			task.activeRunId || targetId ? undefined : sql`0`,
		),
		columns: { id: true, narratorId: true, logicalRunId: true },
	});
}

async function runtimeBusy(narratorId: string | null): Promise<boolean> {
	if (!narratorId) return false;
	const { isNarratorRuntimeBusy } = await import("./narrator-session-state");
	const { isLoopRunning } = await import("./narrator-session");
	return Boolean(
		getExecutionOwner(narratorId) ||
			getRunControl(narratorId) ||
			getRunHold(narratorId) ||
			isNarratorRuntimeBusy(narratorId) ||
			isLoopRunning(narratorId),
	);
}

async function queuedForTarget(narratorId: string) {
	return db
		.select({
			id: scheduledTaskRuns.id,
			interruptTarget: scheduledTaskRuns.interruptTarget,
			createdAt: scheduledTaskRuns.createdAt,
		})
		.from(scheduledTaskRuns)
		.where(
			and(eq(scheduledTaskRuns.narratorId, narratorId), eq(scheduledTaskRuns.status, "waiting")),
		)
		.orderBy(
			asc(sql`case when ${scheduledTaskRuns.interruptTarget} is not null then 0 else 1 end`),
			asc(scheduledTaskRuns.createdAt),
			asc(scheduledTaskRuns.id),
		)
		.limit(TARGET_WAIT_LIMIT);
}

/** Accepting a trigger spends its occurrence; execution clocks start only at real admission. */
export async function acceptScheduledTaskRun(
	task: Task,
	input: { manual: boolean; at: Date },
): Promise<string | undefined> {
	let targetId = task.narratorMode === "existing" ? task.targetNarratorId : task.reuseNarratorId;
	let accessError: unknown;
	try {
		const owner = await resolveTaskPrincipal(taskOwnerId(task));
		if (task.narratorMode === "existing") {
			targetId = (await resolveScheduledTaskTarget(owner, targetId ?? "")).target.id;
		} else {
			if (normalizeRunContext(task.runContext) === "project")
				await assertTaskProjectWrite(task.projectId, owner);
			if (task.narratorMode !== "reuse") targetId = null;
			if (targetId) {
				const reusable = await db.query.narrators.findFirst({ where: eq(narrators.id, targetId) });
				if (
					!reusable ||
					reusable.status === "archived" ||
					(reusable.scheduledTaskId !== null && reusable.scheduledTaskId !== task.id) ||
					!(await canWriteNarrator(reusable, owner))
				)
					targetId = null;
			}
		}
	} catch (error) {
		accessError = error;
	}
	const previous = await activeRun(task, targetId);
	// New-per-run tasks still serialize against their own preceding invocation.
	targetId ??= previous?.narratorId ?? null;
	return scheduledTaskTargetLocks.acquire(targetId ?? `task:${task.id}`, async () => {
		const pending = await taskWaitingRun(task.id);
		const queue = targetId ? await queuedForTarget(targetId) : [];
		const current = await activeRun(task, targetId);
		const occupied = !!current || (await runtimeBusy(targetId));
		let interruptTarget: ScheduledRunInterruptTarget | null = null;
		let skipped = !!pending || queue.length >= TARGET_WAIT_LIMIT;
		if ((occupied || queue.length) && task.onBusy === "skip") skipped = true;
		if (task.onBusy === "interrupt" && queue.some((run) => run.interruptTarget)) skipped = true;
		if (
			!skipped &&
			!accessError &&
			(occupied || queue.length > 0) &&
			task.onBusy === "interrupt" &&
			targetId
		) {
			const { captureScheduledInterruptTarget } = await import("./narrator-session");
			interruptTarget = await captureScheduledInterruptTarget(targetId);
			if (!occupied && !interruptTarget) {
				const last = await db.query.narrators.findFirst({
					where: eq(narrators.id, targetId),
					columns: { logicalRunId: true },
				});
				interruptTarget = {
					narratorId: targetId,
					logicalRunId: last?.logicalRunId ?? undefined,
					executionEpoch: getLastExecutionEpoch(targetId),
				};
			}
			if (current?.narratorId === targetId) {
				interruptTarget ??= {
					narratorId: targetId,
					...(current.logicalRunId ? { logicalRunId: current.logicalRunId } : {}),
					...(getScheduledRunById(current.id)?.executionEpoch
						? { executionEpoch: getScheduledRunById(current.id)?.executionEpoch }
						: {}),
				};
				interruptTarget.scheduledRunId = current.id;
			}
			// A busy admission without an identity cannot be safely interrupted.
			if (!interruptTarget?.logicalRunId && !interruptTarget?.executionEpoch) skipped = true;
		}
		const runId = generateId();
		const ts = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();
		// The target lock gives acceptance a strict order even when the clock ties.
		// Task row versions are unrelated clocks and must not reorder this queue.
		const acceptedAt = new Date(
			Math.max(Date.now(), ...queue.map((run) => Date.parse(run.createdAt) + 1)),
		).toISOString();
		const scheduledFor = input.manual ? null : task.nextRunAt;
		const firedCount = task.firedCount + (input.manual ? 0 : 1);
		const cursor = scheduledFor ?? task.scheduleCursorAt;
		const next = input.manual
			? task.nextRunAt
			: nextTaskOccurrence({ ...task, firedCount, scheduleCursorAt: cursor });
		const status = accessError ? "failed" : skipped ? "skipped" : "waiting";
		const terminal = status !== "waiting";
		const failures = task.consecutiveFailures + (accessError ? 1 : 0);
		const circuitBreaker = failures >= 5 && task.consecutiveFailures < 5;
		const busyDeadlineAt = terminal
			? null
			: new Date(
					Date.now() + (interruptTarget ? INTERRUPT_WAIT_MS : task.busyWaitMinutes * 60_000),
				).toISOString();
		db.transaction((tx) => {
			const accepted = tx
				.update(scheduledTasks)
				.set({
					firedCount,
					scheduleCursorAt: cursor,
					nextRunAt: circuitBreaker ? null : next,
					consecutiveFailures: failures,
					...(circuitBreaker ? { enabled: false, pauseReason: "circuit_breaker" as const } : {}),
					lastRunId: runId,
					lastRunAt: ts,
					lastStatus: status,
					lastOutcome: null,
					lastSummary: null,
					lastError: accessError ? String(accessError).slice(0, 2000) : null,
					completedAt: !next && terminal && !task.activeRunId && !pending ? ts : null,
					updatedAt: ts,
				})
				.where(and(eq(scheduledTasks.id, task.id), eq(scheduledTasks.updatedAt, task.updatedAt)))
				.returning({ id: scheduledTasks.id })
				.all();
			if (!accepted.length) throw conflict();
			tx.insert(scheduledTaskRuns)
				.values({
					id: runId,
					taskId: task.id,
					narratorId: targetId,
					status,
					errorKind: accessError
						? task.narratorMode === "existing" && !task.targetNarratorId
							? "target_missing"
							: "acl"
						: skipped
							? "busy"
							: null,
					error: accessError
						? String(accessError).slice(0, 2000)
						: skipped
							? "Target is busy or already has a pending reservation"
							: null,
					runContext: normalizeRunContext(task.runContext),
					requireReport: task.requireReport,
					scheduledFor,
					manual: input.manual,
					trigger: input.manual ? "manual" : "schedule",
					startedAt: null,
					deadlineAt: null,
					busyDeadlineAt,
					interruptTarget: terminal ? null : interruptTarget,
					finishedAt: terminal ? ts : null,
					createdAt: acceptedAt,
				})
				.run();
		});
		changed();
		if (accessError) await notifyScheduledRunAdmissionFailure(runId, circuitBreaker);
		return terminal ? undefined : runId;
	});
}

async function finishWaiting(
	run: TaskRun,
	errorKind: "busy_timeout" | "cancelled" | "busy" | "acl" | "target_missing",
	message: string,
) {
	state.interruptAttempts.delete(run.id);
	state.interruptMembers.delete(run.id);
	await finalizeScheduledRun(
		run.id,
		errorKind === "acl" || errorKind === "target_missing" ? "failed" : "skipped",
		{
			errorKind,
			error: message,
			expectedStatus: "waiting",
		},
	);
}

/** Requires the task+target locks; no cancel or terminal wait is performed while holding them. */
async function prepareAdvance(runId: string): Promise<ScheduledRunInterruptTarget | undefined> {
	const run = await db.query.scheduledTaskRuns.findFirst({
		where: eq(scheduledTaskRuns.id, runId),
	});
	if (!run || run.status !== "waiting") {
		state.interruptAttempts.delete(runId);
		state.interruptMembers.delete(runId);
		return;
	}
	const task = await db.query.scheduledTasks.findFirst({
		where: eq(scheduledTasks.id, run.taskId),
	});
	if (!task) return;
	if (!task.enabled && !run.manual) {
		await finishWaiting(run, "cancelled", "Task paused before dispatch");
		return;
	}
	if (!run.busyDeadlineAt || Date.parse(run.busyDeadlineAt) <= Date.now()) {
		await finishWaiting(
			run,
			"busy_timeout",
			"Target did not become available before the waiting deadline",
		);
		return;
	}
	let owner: Awaited<ReturnType<typeof resolveTaskPrincipal>>;
	try {
		owner = await resolveTaskPrincipal(taskOwnerId(task));
		if (task.narratorMode === "existing") {
			if (!task.targetNarratorId || !run.narratorId) {
				await finishWaiting(run, "target_missing", "The existing target narrator no longer exists");
				return;
			}
			if (task.targetNarratorId !== run.narratorId) {
				await finishWaiting(run, "cancelled", "Task target changed while waiting");
				return;
			}
			await resolveScheduledTaskTarget(owner, task.targetNarratorId ?? "");
		} else if (normalizeRunContext(task.runContext) === "project") {
			await assertTaskProjectWrite(task.projectId, owner);
		}
	} catch (error) {
		await finishWaiting(run, "acl", String(error));
		return;
	}
	if (run.narratorId && (await queuedForTarget(run.narratorId))[0]?.id !== run.id) return;
	const current = await activeRun(task, run.narratorId);
	const occupied = !!current || (await runtimeBusy(run.narratorId));
	if (run.interruptTarget) {
		const target = run.interruptTarget;
		const control = getRunControl(target.narratorId);
		const execution = getExecutionOwner(target.narratorId);
		if (
			(control && target.logicalRunId && control.logicalRunId !== target.logicalRunId) ||
			(execution && target.executionEpoch && execution.epoch !== target.executionEpoch) ||
			(current && target.scheduledRunId && current.id !== target.scheduledRunId)
		) {
			await finishWaiting(run, "busy", "Another run started before the reserved takeover");
			return;
		}
		if (occupied && !state.interruptAttempts.has(run.id)) {
			state.interruptAttempts.set(run.id, Date.parse(run.busyDeadlineAt));
			return target;
		}
	}
	if (occupied) {
		if (!run.interruptTarget && task.onBusy !== "wait")
			await finishWaiting(run, "busy", "Another execution obtained the target before dispatch");
		return;
	}
	for (const member of state.interruptMembers.get(run.id) ?? []) {
		const control = getRunControl(member.narratorId);
		const execution = getExecutionOwner(member.narratorId);
		if (
			(control && control.logicalRunId === member.logicalRunId) ||
			(execution && execution.epoch === member.executionEpoch)
		)
			return;
	}
	const dispatch = async () => {
		const { scheduledTaskService } = await import("./scheduled-task-service");
		let target: typeof narrators.$inferSelect;
		try {
			target = await scheduledTaskService.resolveNarrator(task, owner);
		} catch (error) {
			await finishWaiting(run, "acl", String(error));
			return;
		}
		const { withNarratorStartAdmission } = await import("./narrator-session-state");
		await withNarratorStartAdmission(target.id, async () => {
			if (!run.busyDeadlineAt || Date.parse(run.busyDeadlineAt) <= Date.now()) {
				await finishWaiting(run, "busy_timeout", "Waiting deadline elapsed before start admission");
				return;
			}
			if (await runtimeBusy(target.id)) {
				if (task.onBusy !== "wait")
					await finishWaiting(run, "busy", "Another execution obtained start admission");
				return;
			}
			const previous = getRegisteredScheduledRun(target.id);
			if (previous && previous.runId !== run.id) return;
			const ts = new Date().toISOString();
			const updatedAt = new Date(
				Math.max(Date.now(), Date.parse(task.updatedAt) + 1),
			).toISOString();
			const deadlineAt = new Date(Date.now() + task.maxRunMinutes * 60_000).toISOString();
			const claimed = db.transaction((tx) => {
				const taskRows = tx
					.update(scheduledTasks)
					.set({
						activeRunId: run.id,
						lastNarratorId: target.id,
						...(task.narratorMode === "reuse" ? { reuseNarratorId: target.id } : {}),
						completedAt: null,
						updatedAt,
					})
					.where(
						and(
							eq(scheduledTasks.id, task.id),
							isNull(scheduledTasks.activeRunId),
							eq(scheduledTasks.updatedAt, task.updatedAt),
						),
					)
					.returning({ id: scheduledTasks.id })
					.all();
				if (!taskRows.length) return false;
				const rows = tx
					.update(scheduledTaskRuns)
					.set({
						status: "running",
						narratorId: target.id,
						startedAt: ts,
						deadlineAt,
						model: task.modelPolicy === "follow" ? target.model : task.model,
					})
					.where(
						and(
							eq(scheduledTaskRuns.id, run.id),
							eq(scheduledTaskRuns.status, "waiting"),
							gt(scheduledTaskRuns.busyDeadlineAt, ts),
						),
					)
					.returning({ id: scheduledTaskRuns.id })
					.all();
				if (!rows.length) throw conflict();
				tx.update(scheduledTasks)
					.set({ lastStatus: "running" })
					.where(and(eq(scheduledTasks.id, task.id), eq(scheduledTasks.lastRunId, run.id)))
					.run();
				return true;
			});
			if (!claimed) return;
			state.interruptAttempts.delete(run.id);
			state.interruptMembers.delete(run.id);
			changed();
			try {
				registerScheduledRun({
					runId: run.id,
					taskId: task.id,
					narratorId: target.id,
					narratorMode: task.narratorMode,
					contextPolicy: task.contextPolicy,
					requireReport: run.requireReport,
					interruptTarget:
						run.interruptTarget?.narratorId === target.id ? run.interruptTarget : undefined,
					ownerUserId: owner.userId,
					onBlocked: task.onBlocked,
					blockedWaitMinutes: task.blockedWaitMinutes,
					permissionMode:
						task.narratorMode === "existing"
							? (target.permissionMode ?? "default")
							: task.permissionMode,
					systemPrompt: task.narratorMode === "existing" ? undefined : task.systemPrompt,
					modelPolicy: task.modelPolicy,
					model: task.model,
					locale: task.locale,
					deadlineAt,
				});
				const { sendScheduledTaskMessage } = await import("./narrator-session");
				await sendScheduledTaskMessage({
					runId: run.id,
					narratorId: target.id,
					prompt: task.prompt,
					userId: owner.userId,
					locale: task.locale,
				});
			} catch (error) {
				await finalizeScheduledRun(run.id, "failed", {
					errorKind:
						error instanceof ForbiddenError || error instanceof NotFoundError ? "acl" : "dispatch",
					error: String(error).slice(0, 2000),
				});
			}
		});
	};
	if (run.interruptTarget) {
		const { withNarratorStartAdmission } = await import("./narrator-session-state");
		const { assertScheduledInterruptTargetIdle } = await import("./narrator-session");
		await withNarratorStartAdmission(run.interruptTarget.narratorId, async () => {
			try {
				await assertScheduledInterruptTargetIdle(
					run.interruptTarget as ScheduledRunInterruptTarget,
				);
			} catch (error) {
				await finishWaiting(run, "busy", String(error));
				return;
			}
			await dispatch();
		});
	} else {
		await dispatch();
	}
}

async function interruptReservedTarget(runId: string, target: ScheduledRunInterruptTarget) {
	// Reservation is durable before any cancellation. Snapshot every member before
	// finalization removes the registry, and cancel only that exact runtime identity.
	const { cancelScheduledRunTarget } = await import("./narrator-session");
	const reserved = await db.query.scheduledTaskRuns.findFirst({
		where: eq(scheduledTaskRuns.id, runId),
	});
	if (!reserved || reserved.status !== "waiting") return;
	const task = await db.query.scheduledTasks.findFirst({
		where: eq(scheduledTasks.id, reserved.taskId),
	});
	if (!task) return;
	try {
		const owner = await resolveTaskPrincipal(taskOwnerId(task));
		if (task.narratorMode === "existing")
			await resolveScheduledTaskTarget(owner, target.narratorId);
		else if (normalizeRunContext(task.runContext) === "project")
			await assertTaskProjectWrite(task.projectId, owner);
	} catch (error) {
		await finishWaiting(reserved, "acl", String(error));
		return;
	}
	const execution = getExecutionOwner(target.narratorId);
	const control = getRunControl(target.narratorId);
	const root = target.scheduledRunId ? getScheduledRunById(target.scheduledRunId) : undefined;
	const isRootTarget = root?.narratorId === target.narratorId;
	const registered = isRootTarget ? root : getScheduledRunMember(target.narratorId);
	if (
		(execution && target.executionEpoch && execution.epoch !== target.executionEpoch) ||
		(control && target.logicalRunId && control.logicalRunId !== target.logicalRunId) ||
		(registered && target.executionEpoch && registered.executionEpoch !== target.executionEpoch)
	) {
		await finishWaiting(reserved, "busy", "The reserved execution changed before cancellation");
		return;
	}
	// A writable child target does not grant control over its root or siblings.
	const members =
		isRootTarget && target.scheduledRunId ? listScheduledRunMembers(target.scheduledRunId) : [];
	const memberTargets = members.map((member) => ({
		narratorId: member.narratorId,
		logicalRunId: member.logicalRunId,
		executionEpoch: member.executionEpoch,
		scheduledRunId: member.runId,
	}));
	// No await between checking the persisted reservation and the synchronous
	// cancellation helper: a pause/transfer can revoke it before, never after this fence.
	const live = db
		.select({ id: scheduledTaskRuns.id })
		.from(scheduledTaskRuns)
		.innerJoin(scheduledTasks, eq(scheduledTasks.id, scheduledTaskRuns.taskId))
		.where(
			and(
				eq(scheduledTaskRuns.id, runId),
				eq(scheduledTaskRuns.status, "waiting"),
				eq(scheduledTasks.updatedAt, task.updatedAt),
				gt(scheduledTaskRuns.busyDeadlineAt, new Date().toISOString()),
			),
		)
		.get();
	if (!live) return;
	state.interruptMembers.set(runId, memberTargets);
	const previousInterruptionReason = root?.interruptionReason;
	if (isRootTarget && root) root.interruptionReason = "scheduled_interrupt";
	const cancelled = await cancelScheduledRunTarget(target, "scheduled_interrupt");
	if (!cancelled && (getExecutionOwner(target.narratorId) || getRunControl(target.narratorId))) {
		if (isRootTarget && root && getScheduledRunById(root.runId) === root)
			root.interruptionReason = previousInterruptionReason;
		await finishWaiting(
			reserved,
			"busy",
			"The reserved execution no longer accepts this cancellation",
		);
		return;
	}
	for (const member of members) {
		if (member.narratorId === target.narratorId) continue;
		await cancelScheduledRunTarget(
			{
				narratorId: member.narratorId,
				logicalRunId: member.logicalRunId,
				executionEpoch: member.executionEpoch,
				scheduledRunId: member.runId,
			},
			"scheduled_interrupt",
		);
	}
	if (isRootTarget && target.scheduledRunId)
		await finalizeScheduledRun(target.scheduledRunId, "interrupted", {
			errorKind: "scheduled_interrupt",
			error: "A scheduled task reserved the next start and interrupted this run",
			expectedLogicalRunId: target.logicalRunId,
			expectedExecutionEpoch: target.executionEpoch,
		});
	// A cancellation may settle synchronously. Re-enter the normal admission path
	// only after all cancellation helpers have returned and all locks were released.
	await advanceScheduledTaskRun(runId);
}

export async function advanceScheduledTaskRun(runId: string): Promise<void> {
	const run = await db.query.scheduledTaskRuns.findFirst({
		where: and(eq(scheduledTaskRuns.id, runId), eq(scheduledTaskRuns.status, "waiting")),
		columns: { taskId: true, narratorId: true },
	});
	if (!run) return;
	const cancel = await scheduledTaskMutationLocks.acquire(run.taskId, () =>
		scheduledTaskTargetLocks.acquire(run.narratorId ?? `task:${run.taskId}`, () =>
			prepareAdvance(runId),
		),
	);
	if (cancel) {
		await interruptReservedTarget(runId, cancel);
		return;
	}
	const current = await db.query.scheduledTaskRuns.findFirst({
		where: eq(scheduledTaskRuns.id, runId),
		columns: { status: true },
	});
	if (current && current.status !== "waiting") {
		try {
			await cleanupScheduledTaskNarrators(run.taskId);
		} catch (error) {
			logger.warn("Scheduled task retention failed", { taskId: run.taskId, error: String(error) });
		}
	}
}

/** A bounded keyset sweep recovers waiting eligibility, never a previously dispatched message. */
export function pollScheduledWaitingRuns(): Promise<void> {
	if (state.polling) return state.polling;
	state.polling = (async () => {
		for (const [id, expiry] of state.interruptAttempts) {
			if (expiry > Date.now()) continue;
			state.interruptAttempts.delete(id);
			state.interruptMembers.delete(id);
		}
		const rows = await db
			.select({ id: scheduledTaskRuns.id })
			.from(scheduledTaskRuns)
			.where(
				and(
					eq(scheduledTaskRuns.status, "waiting"),
					state.cursor ? gt(scheduledTaskRuns.id, state.cursor) : undefined,
				),
			)
			.orderBy(asc(scheduledTaskRuns.id))
			.limit(POLL_LIMIT);
		state.cursor = rows.length === POLL_LIMIT ? rows.at(-1)?.id : undefined;
		for (const run of rows) {
			try {
				await advanceScheduledTaskRun(run.id);
			} catch (error) {
				logger.warn("Scheduled waiting admission failed", { runId: run.id, error: String(error) });
			}
		}
	})().finally(() => {
		state.polling = undefined;
	});
	return state.polling;
}
