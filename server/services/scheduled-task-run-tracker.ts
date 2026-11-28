import { ACTIVE_RUN_STATUSES, type RunBlockReason } from "@shared/scheduled-task-status";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db";
import {
	narratorQuestions,
	narrators,
	outlineQuestions,
	scheduledTaskRuns,
	scheduledTasks,
} from "../db/schema";
import { readQuery } from "../db/worker-read";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getExecutionOwner, getRunControl } from "./agent-runtime/ownership";
import {
	bindScheduledRunMember,
	getRegisteredScheduledRun,
	getScheduledRunById,
	getScheduledRunMember,
	listScheduledRunMembers,
	registerScheduledRun,
	type ScheduledRunRegistration,
} from "./scheduled-run-registry";
import {
	claimScheduledRunNudge,
	finalizeScheduledRun,
	markScheduledRunBlocked,
} from "./scheduled-task-run-service";

const PAGE_SIZE = 64;
const SETTLE_GRACE_MS = 2000;
const RESTART_GRACE_MS = 30_000;
const state = hotSafe("narrafork.scheduled-run-tracker.v1", () => ({
	polling: undefined as Promise<void> | undefined,
	cursor: undefined as string | undefined,
}));

/** No replay: recover only trusted identities, retaining the original absolute deadlines. */
export async function recoverScheduledRuns(): Promise<Set<string>> {
	const blockedRecovery = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		const rows = await readQuery(
			db
				.select({ run: scheduledTaskRuns, task: scheduledTasks })
				.from(scheduledTaskRuns)
				.innerJoin(scheduledTasks, eq(scheduledTasks.id, scheduledTaskRuns.taskId))
				.where(
					and(
						inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
						cursor ? gt(scheduledTaskRuns.id, cursor) : undefined,
					),
				)
				.orderBy(asc(scheduledTaskRuns.id))
				.limit(PAGE_SIZE),
			{ executionPolicy: "worker-required" },
		);
		for (const { run, task } of rows) {
			if (!run.narratorId) {
				await finalizeScheduledRun(run.id, "interrupted", {
					errorKind: "restart",
					error: "Restart interrupted dispatch before a target was bound",
				});
				continue;
			}
			const runtimeWasBound = !!run.logicalRunId;
			// A crash between message persistence and runtime attachment has no run
			// receipt yet. Preserve a conservative recovery fence for that session's
			// persisted identity too; never let a later restart replay the queued input.
			if (!run.logicalRunId) {
				const narrator = await readQuery(
					db.query.narrators.findFirst({
						where: eq(narrators.id, run.narratorId),
						columns: { logicalRunId: true },
					}),
					{ executionPolicy: "worker-required" },
				);
				if (narrator?.logicalRunId) {
					run.logicalRunId = narrator.logicalRunId;
					const changed = await db
						.update(scheduledTaskRuns)
						.set({ logicalRunId: run.logicalRunId })
						.where(
							and(
								eq(scheduledTaskRuns.id, run.id),
								isNull(scheduledTaskRuns.logicalRunId),
								inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
							),
						)
						.returning({ id: scheduledTaskRuns.id });
					if (!changed.length) continue;
				}
			}
			const current = getRunControl(run.narratorId);
			const live = runtimeWasBound && !!current && current.logicalRunId === run.logicalRunId;
			if (!live) blockedRecovery.add(run.narratorId);
			registerScheduledRun({
				runId: run.id,
				taskId: run.taskId,
				narratorId: run.narratorId,
				ownerUserId: task.ownerUserId,
				onBlocked: task.onBlocked,
				blockedWaitMinutes: task.blockedWaitMinutes,
				deadlineAt: run.deadlineAt,
				permissionMode: task.permissionMode,
				systemPrompt: task.systemPrompt,
				modelPolicy: task.modelPolicy,
				model: run.model,
				locale: task.locale,
				narratorMode: task.narratorMode,
				contextPolicy: task.contextPolicy,
				contextPrepared: true,
				requireReport: run.requireReport,
				interruptTarget: run.interruptTarget ?? undefined,
				logicalRunId: run.logicalRunId ?? undefined,
				executionEpoch: live ? getExecutionOwner(run.narratorId)?.epoch : undefined,
				triggerMessageId: run.triggerMessageId ?? undefined,
				...(!live ? { recoveredAt: Date.now() } : {}),
			});
			if (live && run.logicalRunId && !getScheduledRunMember(run.narratorId))
				bindScheduledRunMember({
					runId: run.id,
					narratorId: run.narratorId,
					logicalRunId: run.logicalRunId,
					executionEpoch: getExecutionOwner(run.narratorId)?.epoch,
				});
		}
		if (rows.length < PAGE_SIZE) break;
		cursor = rows.at(-1)?.run.id;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return blockedRecovery;
}

/**
 * Filter automatic recovery, including tool replay, before mounting its queue.
 * Every persisted terminal is also a fence on later server restarts; a new
 * human logical run changes the identity and is not mistaken for that old run.
 */
export async function filterScheduledRecoveryNarrators(
	ids: Iterable<string>,
): Promise<Set<string>> {
	const allowed = new Set<string>();
	const cache = new Map<string, boolean>();
	for (const originalId of ids) {
		let id: string | null = originalId;
		const visited = new Set<string>();
		let blocked = false;
		while (id && !visited.has(id) && visited.size < 32) {
			visited.add(id);
			if (cache.has(id)) {
				blocked = cache.get(id) === true;
				break;
			}
			const registered = getRegisteredScheduledRun(id);
			if (registered?.recoveredAt) {
				blocked = true;
				break;
			}
			const row: { parentNarratorId: string | null; logicalRunId: string | null } | undefined =
				await readQuery(
					db.query.narrators.findFirst({
						where: eq(narrators.id, id),
						columns: { parentNarratorId: true, logicalRunId: true },
					}),
					{ executionPolicy: "worker-required" },
				);
			if (!row) break;
			const terminal = await readQuery(
				db
					.select({ id: scheduledTaskRuns.id })
					.from(scheduledTaskRuns)
					.where(
						and(
							eq(scheduledTaskRuns.narratorId, id),
							// A terminal waiting occurrence never owned this conversation.
							isNotNull(scheduledTaskRuns.startedAt),
							row.logicalRunId
								? eq(scheduledTaskRuns.logicalRunId, row.logicalRunId)
								: isNull(scheduledTaskRuns.logicalRunId),
							inArray(scheduledTaskRuns.status, [
								"completed",
								"failed",
								"interrupted",
								"timed_out",
							]),
						),
					)
					.limit(1),
				{ executionPolicy: "worker-required" },
			);
			if (terminal.length) {
				blocked = true;
				break;
			}
			id = row.parentNarratorId;
		}
		// A malformed/deeper ancestry fails closed for automatic recovery only.
		if (id && (visited.size >= 32 || (visited.has(id) && !cache.has(id) && !blocked)))
			blocked = true;
		cache.set(originalId, blocked);
		if (!blocked) allowed.add(originalId);
	}
	return allowed;
}

/** The only completion evidence is the terminal promise of the exact logical run. */
export function scheduledRunDeadlineReason(
	input: { deadlineAt: string | null; blockedAt: string | null; blockedWaitMinutes: number },
	now: number,
): "timeout" | "blocked_timeout" | undefined {
	if (input.deadlineAt && Date.parse(input.deadlineAt) <= now) return "timeout";
	if (input.blockedAt && Date.parse(input.blockedAt) + input.blockedWaitMinutes * 60_000 <= now)
		return "blocked_timeout";
	return undefined;
}

async function currentBlock(
	registration: ScheduledRunRegistration,
	startedAt: string,
): Promise<RunBlockReason | null> {
	const { pendingPermissions, pendingDangerReflections } = await import("./narrator-session-state");
	const { scheduledBlockReason } = await import("./scheduled-run-registry");
	const members = listScheduledRunMembers(registration.runId);
	const ids = new Set([registration.narratorId, ...members.map((member) => member.narratorId)]);
	const ownsLiveWait = (id: string) => {
		const member = members.find((item) => item.narratorId === id);
		const expected = member ?? (id === registration.narratorId ? registration : undefined);
		return (
			expected?.logicalRunId !== undefined &&
			getRunControl(id)?.logicalRunId === expected.logicalRunId &&
			(expected.executionEpoch === undefined ||
				getExecutionOwner(id)?.epoch === expected.executionEpoch)
		);
	};
	for (const pending of pendingPermissions.values()) {
		if (ids.has(pending.narratorId) && ownsLiveWait(pending.narratorId))
			return scheduledBlockReason(pending.toolName);
	}
	for (const pending of pendingDangerReflections.values()) {
		if (
			ids.has(pending.narratorId) &&
			ownsLiveWait(pending.narratorId) &&
			pending.reflectionStoppedByUser
		)
			return "permission";
	}
	// Async questions live outside the permission promise. Restrict to this run's
	// attribution window and bound each indexed lookup; do not load question bodies.
	for (const id of ids) {
		const member = members.find((item) => item.narratorId === id);
		const expected = member?.logicalRunId ?? registration.logicalRunId;
		const narrator = await readQuery(
			db.query.narrators.findFirst({
				where: eq(narrators.id, id),
				columns: { logicalRunId: true, substatus: true },
			}),
			{ executionPolicy: "worker-required" },
		);
		if (!expected || narrator?.logicalRunId !== expected) continue;
		if (getRunControl(id) && !ownsLiveWait(id)) continue;
		if (
			narrator.substatus?.includes("model_unavailable") ||
			narrator.substatus?.includes("quota_exhausted")
		)
			return "provider_wait";
		const question = await readQuery(
			db
				.select({ id: narratorQuestions.id })
				.from(narratorQuestions)
				.where(
					and(
						eq(narratorQuestions.narratorId, id),
						eq(narratorQuestions.status, "open"),
						gte(narratorQuestions.createdAt, startedAt),
					),
				)
				.limit(1),
			{ executionPolicy: "worker-required" },
		);
		if (question.length) return "question";
		const outline = await readQuery(
			db
				.select({ id: outlineQuestions.blockId })
				.from(outlineQuestions)
				.where(
					and(
						eq(outlineQuestions.askerNarratorId, id),
						eq(outlineQuestions.state, "open"),
						gte(outlineQuestions.createdAt, startedAt),
					),
				)
				.limit(1),
			{ executionPolicy: "worker-required" },
		);
		if (outline.length) return "question";
	}
	return null;
}

async function cancelExactRun(
	registration: ScheduledRunRegistration,
	reason: "timeout" | "blocked_timeout",
): Promise<void> {
	const members = listScheduledRunMembers(registration.runId);
	const { cancelScheduledRunTarget } = await import("./narrator-session");
	for (const member of members) {
		const control = getRunControl(member.narratorId);
		if (
			control?.logicalRunId !== member.logicalRunId ||
			(member.executionEpoch !== undefined &&
				getExecutionOwner(member.narratorId)?.epoch !== member.executionEpoch) ||
			getScheduledRunMember(member.narratorId) !== member
		)
			continue;
		// Only this timeout path marks timedOut; the session helper also releases
		// held runs and pending permission promises for the same exact execution.
		control.timedOut = true;
		await cancelScheduledRunTarget(
			{
				narratorId: member.narratorId,
				logicalRunId: member.logicalRunId,
				executionEpoch: member.executionEpoch,
				scheduledRunId: registration.runId,
			},
			reason,
		);
	}
}

async function pollOne(run: typeof scheduledTaskRuns.$inferSelect): Promise<void> {
	const registration = getScheduledRunById(run.id);
	if (!registration || registration.narratorId !== run.narratorId) return;
	const executionEpoch = registration.executionEpoch;
	const logicalRunId = registration.logicalRunId;
	const matchesExecution = () =>
		getScheduledRunById(run.id) === registration &&
		registration.logicalRunId === logicalRunId &&
		registration.executionEpoch === executionEpoch;
	// The page is only an observation: attachment may have advanced while the Worker read it.
	if ((logicalRunId ?? null) !== run.logicalRunId) return;
	const now = Date.now();
	const deadline = scheduledRunDeadlineReason(
		{ ...run, blockedWaitMinutes: registration.blockedWaitMinutes },
		now,
	);
	if (deadline) {
		await cancelExactRun(registration, deadline);
		await finalizeScheduledRun(run.id, "timed_out", {
			errorKind: deadline,
			error:
				deadline === "blocked_timeout"
					? "Scheduled run exceeded its blocked-wait limit"
					: "Scheduled run exceeded its deadline",
			expectedLogicalRunId: run.logicalRunId ?? undefined,
			expectedExecutionEpoch: executionEpoch,
		});
		return;
	}
	if (registration.recoveredAt) {
		if (now - registration.recoveredAt >= RESTART_GRACE_MS)
			await finalizeScheduledRun(run.id, "interrupted", {
				errorKind: "restart",
				error: "Server restarted without a verified terminal receipt; the task was not replayed",
				expectedLogicalRunId: run.logicalRunId ?? undefined,
			});
		return;
	}
	const terminal = registration.terminal;
	if (terminal && terminal.executionEpoch !== executionEpoch) return;
	if (terminal && terminal.logicalRunId === run.logicalRunId && terminal.status !== "completed") {
		await finalizeScheduledRun(run.id, terminal.status, {
			error: terminal.error,
			errorKind:
				terminal.status === "timed_out"
					? "timeout"
					: terminal.status === "interrupted"
						? (registration.interruptionReason ?? "user_interrupt")
						: "provider",
			expectedLogicalRunId: terminal.logicalRunId,
			expectedExecutionEpoch: terminal.executionEpoch,
		});
		return;
	}
	const block = await currentBlock(registration, run.startedAt ?? run.createdAt);
	if (!matchesExecution()) return;
	await markScheduledRunBlocked(run.id, block);
	if (!matchesExecution() || block || !terminal || terminal.logicalRunId !== run.logicalRunId)
		return;
	if (now - terminal.settledAt < SETTLE_GRACE_MS) return;
	const { backgroundOccupancyStore } = await import("./background-occupancy-store");
	await backgroundOccupancyStore.flush();
	if (backgroundOccupancyStore.countActiveWakeWork(registration.narratorId) > 0) return;
	const { peekInbox, flushInboxPublicationBarrier } = await import("./agent-runtime/inbox");
	for (const member of listScheduledRunMembers(run.id)) {
		if (backgroundOccupancyStore.countActiveWakeWork(member.narratorId) > 0) return;
		const control = getRunControl(member.narratorId);
		// Admission installs a control before async preparation assigns its identity.
		// That window is not evidence that the previous run's continuation is idle.
		if (control && (!control.logicalRunId || control.logicalRunId === member.logicalRunId)) return;
		await flushInboxPublicationBarrier(member.narratorId);
		if (await peekInbox(member.narratorId)) return;
	}
	if (!matchesExecution() || registration.terminal !== terminal) return;
	if (run.requireReport && !run.outcome && !run.nudged && (await claimScheduledRunNudge(run.id))) {
		const { sendScheduledTaskMessage } = await import("./narrator-session");
		try {
			await sendScheduledTaskMessage({
				runId: run.id,
				narratorId: registration.narratorId,
				userId: registration.ownerUserId,
				locale: registration.locale,
				nudge: true,
				prompt:
					registration.locale === "zh-CN"
						? "本次计划任务的业务执行已经结束。不要重做、重试或继续任何业务操作；仅根据已经完成的工作调用 ScheduledTaskReport 汇报 done、partial、blocked 或 no_change 并附简短摘要。如果无法确认结果，请如实汇报 partial。"
						: "The scheduled task's business execution has ended. Do not redo, retry, or continue any business operation. Only call ScheduledTaskReport with done, partial, blocked, or no_change and a short summary of work already performed. Report partial if the result is uncertain.",
			});
			return;
		} catch (error) {
			// The durable nudge reservation is deliberately not cleared or retried.
			logger.warn("Scheduled outcome reminder was not dispatched", {
				runId: run.id,
				error: String(error),
			});
		}
	}
	await finalizeScheduledRun(run.id, "completed", {
		expectedLogicalRunId: terminal.logicalRunId,
		expectedExecutionEpoch: terminal.executionEpoch,
	});
}

/** One bounded page per tick. Concurrent/hot-reloaded callers share the same sweep. */
export function pollScheduledRuns(): Promise<void> {
	if (state.polling) return state.polling;
	state.polling = (async () => {
		const rows = await readQuery(
			db
				.select()
				.from(scheduledTaskRuns)
				.where(
					and(
						inArray(scheduledTaskRuns.status, ACTIVE_RUN_STATUSES),
						state.cursor ? gt(scheduledTaskRuns.id, state.cursor) : undefined,
					),
				)
				.orderBy(asc(scheduledTaskRuns.id))
				.limit(PAGE_SIZE),
			{ executionPolicy: "worker-required" },
		);
		state.cursor = rows.length === PAGE_SIZE ? rows.at(-1)?.id : undefined;
		for (const row of rows) {
			try {
				await pollOne(row);
			} catch (error) {
				logger.warn("Scheduled run poll failed", { runId: row.id, error: String(error) });
			}
		}
		const { pollScheduledWaitingRuns } = await import("./scheduled-task-waiting");
		await pollScheduledWaitingRuns();
	})().finally(() => {
		state.polling = undefined;
	});
	return state.polling;
}
