import type { FileReferenceSnapshot } from "@shared/file-reference";
import { FOLLOW_PARENT_MODEL, type SubagentModelInheritance } from "@shared/model-inheritance";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import {
	createOptionalExecutionTimeout,
	normalizeOptionalExecutionTimeout,
	resolveOptionalExecutionTimeout,
} from "../lib/agent/execution-timeout";
import {
	freezeFileReferenceSnapshots,
	projectFileReferenceText,
} from "../lib/agent/file-reference-projection";
import type { ToolCallBinding, ToolUpdateExecutionLease } from "../lib/agent/types";
import { withDbRetry } from "../lib/db-resilience";
import { AppError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	DISABLED_TOOLS_TRAIT_PREFIX,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
} from "../lib/narrator-custom-traits";
import { getSubagentType, hasTrait, isSubagentVariant, parseTraits } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import {
	expandAllowedPoolForDisplay,
	FOLLOW_DEFAULT_MODEL,
	resolveDefaultReasoningEffort,
	resolveProvider,
	settings,
} from "../lib/settings";
import { type ImageRef, saveTextFileToWorktree, type TextFileRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { RuntimeForegroundControl } from "./agent-runtime/input";
import {
	createRuntimeMapView,
	type ExecutionOwner,
	setExecutionSuspended,
	tryClaimExecution,
} from "./agent-runtime/ownership";
import { resolveRuntimePolicy } from "./agent-runtime/policy";
import {
	getRuntimePublicationService,
	publicationEvent,
	runtimePublication,
} from "./agent-runtime/publication";
import type { PublicationRun } from "./agent-runtime/publication-outbox";
import { resolveRuntimeQueueBackend } from "./agent-runtime/runtime-queue-port";
import { runAtomicWrite } from "./agent-runtime/runtime-write";
import { backgroundTaskService, getBackgroundTaskTerminalVersion } from "./background-task-service";
import { pushBgCompletionNotification } from "./bg-completion-queue";
import { customSubagentService } from "./custom-subagent-service";
import { narratorService } from "./narrator-service";
import { getSubagentResultMessageId } from "./narrator-session";
import { withNarratorStartAdmission, withNarratorWorkAdmission } from "./narrator-session-state";
import { registerAndPersistSubagentAlias, registerTaskAlias } from "./subagent-alias";
import {
	attachSubagent,
	consumeForegroundSubagentHardInterrupt,
	type DetachSetupResult,
	getAttachWaitersMap,
	getBackgroundAbortControllers,
	getDetachableMap,
	getForegroundAbortControllers,
	ProxyAbortController,
} from "./subagent-detach";
import {
	consumeNextBufferedSubagentMessage,
	executeSubagent,
	finalizeSubagent,
	loadSubagentHistory,
	type SubagentExecOptions,
} from "./subagent-executor";
import { appendSubagentFileChanges } from "./subagent-file-changes";
import { agentLabelFromNarrator, agentResultTag, resolveAgentLabel } from "./subagent-label";
import {
	formatSubagentModelFallbackNote,
	resolveSubagentModelForRun,
	subagentRunReasoningEffort,
	subagentStoredModelReference,
} from "./subagent-model";
import {
	clearTakenOver,
	consumePendingBackgroundFinalize,
	isBackgroundTakenOver,
	isTakenOver,
} from "./subagent-takeover";
import { broadcastSubagentTakeoverChanged } from "./subagent-takeover-broadcast";
import { clearTeamInbox } from "./subagent-team";
import { buildSubagentSystemPrompt } from "./subagent-tools";
import { resolveEffectiveTraits, resolveNarratorProjectId } from "./trait-layer-service";
import { tryAcquireFinalUpdateExecution, type UpdateExecutionLease } from "./update-coordinator";

/** Default wall-clock execution time for background Agent tasks (5 hours). */
export const BACKGROUND_TASK_TIMEOUT_MS = 5 * 60 * 60 * 1000;

/** Stable Agent tool result emitted once a background runner is mounted. */
export function buildBackgroundAgentStartOutput(taskIdOrAlias: string): string {
	// update-recovery-service recognizes the exact "Background task started." sentence.
	return (
		`<background_task_id>${taskIdOrAlias}</background_task_id>\n\n` +
		`Background task started. Await({ type: "agent", id: "${taskIdOrAlias}" })`
	);
}

export type BackgroundCompletionOutcome = "completed" | "failed" | "timeout";

export interface RunningSubagentExecutionSnapshot {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	startedAt: number;
	timeoutMs: number | null;
	executionDeadlineAt: string | null;
	background: boolean;
	logicalRunId?: string;
}

interface RunningSubagentExecutionEntry extends RunningSubagentExecutionSnapshot {
	token: string;
}

const runningSubagentExecutions = createRuntimeMapView("subagentExecution");
runtimePublication.setLegacyRuntimeAdmissionReader("agent", (source) => {
	const admitted = runningSubagentExecutions.get(source.taskId);
	if (!admitted || admitted.parentNarratorId !== source.recipientId) return undefined;
	return { ...source, startedAtMs: admitted.startedAt };
});

export function listRunningSubagentExecutions(): RunningSubagentExecutionSnapshot[] {
	return [...runningSubagentExecutions.values()].map(({ token: _token, ...entry }) => entry);
}

export function registerRunningSubagentExecution(
	entry: Omit<RunningSubagentExecutionSnapshot, "startedAt"> & { startedAt?: number },
): () => void {
	const token = generateId();
	const registered: RunningSubagentExecutionEntry = {
		...entry,
		startedAt: entry.startedAt ?? Date.now(),
		token,
	};
	runningSubagentExecutions.set(entry.subagentId, registered);
	return () => {
		if (runningSubagentExecutions.get(entry.subagentId)?.token === token) {
			runningSubagentExecutions.delete(entry.subagentId);
		}
	};
}

function parseExecutionDeadline(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function resolveSubagentExecutionTiming(input: {
	now?: number;
	timeoutMs?: number;
	executionDeadlineAt?: string | null;
	executionTimeoutMs?: number | null;
	defaultTimeoutMs?: number;
}): {
	remainingTimeoutMs: number | undefined;
	timeoutLabelMs: number | undefined;
	executionDeadlineAt: string | null;
	expiredAtMount: boolean;
} {
	const now = input.now ?? Date.now();
	const persistedDeadlineMs = parseExecutionDeadline(input.executionDeadlineAt);
	const resolvedRequestedTimeout =
		input.defaultTimeoutMs === undefined
			? normalizeOptionalExecutionTimeout(input.timeoutMs)
			: resolveOptionalExecutionTimeout(input.timeoutMs, input.defaultTimeoutMs);
	const remainingTimeoutMs =
		persistedDeadlineMs === null
			? resolvedRequestedTimeout
			: Math.max(persistedDeadlineMs - now, 0);
	const timeoutLabelMs = input.executionTimeoutMs ?? resolvedRequestedTimeout ?? remainingTimeoutMs;
	return {
		remainingTimeoutMs,
		timeoutLabelMs,
		executionDeadlineAt:
			persistedDeadlineMs !== null
				? new Date(persistedDeadlineMs).toISOString()
				: resolvedRequestedTimeout
					? new Date(now + resolvedRequestedTimeout).toISOString()
					: null,
		expiredAtMount: persistedDeadlineMs !== null && remainingTimeoutMs === 0,
	};
}

export type SubagentUpdateExecutionLease = UpdateExecutionLease | ToolUpdateExecutionLease;

export function claimSubagentUpdateExecutionLease(
	existingLease: SubagentUpdateExecutionLease | undefined,
	kind: "ordinary" | "resumable",
	narratorId: string,
): UpdateExecutionLease | null {
	if (!existingLease) {
		return tryAcquireFinalUpdateExecution(kind, narratorId);
	}

	if ("transfer" in existingLease && !existingLease.transfer()) {
		throw new ValidationError("Agent could not transfer its update execution lease");
	}
	existingLease.setNarratorId(narratorId);
	if ("token" in existingLease) return existingLease;

	return {
		kind: existingLease.kind,
		token: `transferred:${narratorId}`,
		setNarratorId: (id) => existingLease.setNarratorId(id),
		release: () => existingLease.release(),
	};
}

export function combineSubagentAbortSignals(
	...signals: Array<AbortSignal | undefined>
): AbortSignal {
	const distinctSignals = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
	if (distinctSignals.length === 0) return new AbortController().signal;
	if (distinctSignals.length === 1) return distinctSignals[0];
	return AbortSignal.any(distinctSignals);
}

async function restorePendingSubagentModel(narratorId: string): Promise<void> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { pendingModelRestore: true },
	});
	if (!narrator?.pendingModelRestore) return;
	const model = narrator.pendingModelRestore;
	await db
		.update(narrators)
		.set({ model, pendingModelRestore: null, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, narratorId));
	broadcastToNarrator(narratorId, { type: "model_changed", narratorId, model });
}

export function resolveBackgroundCompletionOutcome(input: {
	timedOut: boolean;
	hasError: boolean;
	contextLengthExceeded?: boolean;
	aborted?: boolean;
}): BackgroundCompletionOutcome {
	if (input.timedOut) return "timeout";
	if (input.hasError || input.contextLengthExceeded || input.aborted) return "failed";
	return "completed";
}

/**
 * Shared helper: update narrator background fields, emit events, broadcast WS,
 * push notification, and mark in backgroundTaskService.
 * Used by both executeBackgroundTask and runForegroundLoop (detach path).
 */
async function finalizeBackgroundCompletion(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
	outcome: BackgroundCompletionOutcome,
	finalText: string,
	locale: Locale = "en",
	timeoutMs?: number,
	expectedAbortController?: AbortController,
	deferPublication = false,
	finalUserId: string | null = null,
): Promise<void> {
	// Await/event waiters are part of terminal publication too. Keep the task running
	// until the outer exact-origin transaction commits, not only its mailbox notice.
	const { recordTaskNoticeUser } = await import("./parent-injection-queue");
	recordTaskNoticeUser(narratorId, finalUserId);
	if (deferPublication) return;
	const timeoutText = timeoutMs
		? `Background task timed out after ${timeoutMs}ms`
		: "Background task timed out";
	const storedText =
		finalText ||
		(outcome === "timeout" ? timeoutText : outcome === "failed" ? "Unknown error" : "(no output)");
	const task = await backgroundTaskService.getById(narratorId).catch(() => null);
	if (task) {
		const transitioned =
			outcome === "timeout"
				? await backgroundTaskService.markTimedOut(
						narratorId,
						storedText,
						undefined,
						expectedAbortController,
						{ deferPublication },
					)
				: outcome === "failed"
					? await backgroundTaskService.markFailed(
							narratorId,
							storedText,
							undefined,
							expectedAbortController,
							{ deferPublication },
						)
					: await backgroundTaskService.markCompleted(
							narratorId,
							storedText,
							undefined,
							expectedAbortController,
							{ deferPublication },
						);
		if (!transitioned) return;
	}

	const now = new Date().toISOString();
	if (resolveRuntimeQueueBackend() === "postgres") {
		// B5 fix: use the named PG composite — narrator update + publication
		// commit in one withPgRetry transaction. No direct db.update(narrators).
		const pub = getRuntimePublicationService();
		await pub.updateNarratorBackground({
			narratorId,
			parentNarratorId,
			backgroundStatus: outcome === "completed" ? "completed" : "failed",
			backgroundResult: storedText,
			backgroundCompletedAt: now,
			updatedAt: now,
			deferPublication: !!task || deferPublication,
		});
		if (!task && !deferPublication) pub.schedule();
	} else {
		runAtomicWrite(db, "subagent-runner.finalizeBackgroundCompletion", (tx) => {
			tx.update(narrators)
				.set({
					backgroundStatus: outcome === "completed" ? "completed" : "failed",
					backgroundResult: storedText,
					backgroundCompletedAt: now,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			if (!task && !deferPublication) {
				const run = runtimePublication.getAgentRun(narratorId, parentNarratorId, tx);
				runtimePublication.commit(
					{
						...run,
						eventKind: publicationEvent(outcome),
						resultRef: runtimePublication.persistResult(run, storedText, tx),
						summary: `[System] Background agent (ID: ${narratorId}) ${outcome}. Use Await({ type: "agent", id: "${narratorId}" }) to read its stored result.`,
					},
					tx,
				);
			}
		});
	}

	const subNarrator = await narratorService.getById(narratorId).catch(() => null);
	const title = subNarrator?.title ?? narratorId;
	// The notification tells the model how to Await/Send this agent, so it carries
	// the readable alias rather than the raw nanoid.
	const alias = subNarrator
		? agentLabelFromNarrator(subNarrator, parentNarratorId)
		: await resolveAgentLabel(parentNarratorId, narratorId);
	const resultPreview = storedText.slice(0, 500);
	// Where in the AGENT's own session this result was produced, so the reader can
	// jump there from the completion bubble. Best-effort by design: a run that
	// produced no assistant text has nothing to point at, and the notification is
	// worth delivering regardless — the panel then opens at the session tail.
	const resultMessageId = await getSubagentResultMessageId(narratorId).catch(() => undefined);

	if (outcome !== "completed") {
		eventBus.emit({
			type: "narrator:background_task_failed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: storedText,
		});
		if (!task) {
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_failed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				error: storedText,
			});
		}
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			alias,
			title,
			status: outcome === "timeout" ? "timed out" : "failed",
			resultPreview,
			result: storedText,
			resultMessageId,
			userId: finalUserId,
		});
	} else {
		eventBus.emit({
			type: "narrator:background_task_completed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			resultPreview,
		});
		if (!task) {
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_completed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				resultPreview,
			});
		}
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			alias,
			title,
			status: "completed",
			resultPreview,
			result: storedText,
			resultMessageId,
			userId: finalUserId,
		});
	}

	void locale;
	runtimePublication.schedule();
}

async function isBackgroundTaskCancelled(taskId: string): Promise<boolean> {
	const task = await backgroundTaskService.getById(taskId).catch(() => null);
	return task?.status === "cancelled";
}

type ResumedBackgroundTaskNotice = {
	subagentId: string;
	parentNarratorId: string;
	subagent: Awaited<ReturnType<typeof narratorService.getById>>;
	locale: Locale;
};

/** How a resumed background continuation's ending is recorded and announced. */
export interface ResumedBackgroundTaskNoticePlan {
	/** Terminal status written to the task row. Always decided, whoever announces it. */
	status: "completed" | "failed" | "cancelled" | "timeout";
	/** False when another producer already owns the delivery. */
	deliver: boolean;
	/** May a turn be started for it? Meaningless when `deliver` is false. */
	wakeParent: boolean;
}

/** What the resume path needs to announce an ended continuation, once it is safe to. */
export interface ResumedBackgroundTaskAnnouncement {
	logicalRunId?: string;
	subagentId: string;
	parentNarratorId: string;
	status: ResumedBackgroundTaskNoticePlan["status"];
	wakeParent: boolean;
	locale: Locale;
	/** Initiating user of the completed execution, never inferred from its parent. */
	userId?: string | null;
	/** B2 fix: narrator fields carried from construction site to avoid PG SQLite read. */
	subagentTraits?: string[] | null;
	subagentTitle?: string | null;
}

/**
 * Decide how the END of a resumed background continuation is recorded, whether the
 * parent is told, and whether telling it may start a turn.
 *
 * Pure because every wrong answer here is SILENT in a live run: a duplicate delivery
 * reads as the model being told twice, a missing one as it never learning at all, and
 * an unwanted wake as the agent deciding on its own to keep going. None raises an
 * error anywhere, so the decision is pinned by tests rather than by observation.
 *
 * ## What each flag rules out
 *
 * - `preserveBackground` runs already went through `finalizeBackgroundCompletion`,
 *   which notifies AND wakes; announcing again hands the model the same event twice.
 *   The row is still reconciled by the caller, hence `status` regardless of `deliver`.
 * - `skipConclusionDelivery` runs leave the historical Agent tool result untouched,
 *   which today only ever happens together with `preserveBackground`. It is consulted
 *   separately anyway: the two are independent inputs, and a run that preserved
 *   background while still publishing a conclusion would otherwise be announced by
 *   both producers with nothing to signal the collision.
 * - A user interrupt still delivers (the "restarted" notice has to be closed out, and
 *   a cancelled row is the honest outcome) but must not wake: spending a parent turn
 *   on work the user just stopped is the opposite of what they asked for.
 *
 * ## Why the notice is a POINTER, and why it fires from the resume path
 *
 * The remaining case — every user-driven resume — does publish the result:
 * `deliverCompletedResume` rewrites the historical Agent `tool_result`, and NarraFork
 * rebuilds the whole history from rows on every request (`outputToText(tc.outputJson)`
 * in each provider's buildHistory), so the parent reads the new output on its next
 * turn. What it does NOT have is a next turn — it is idle, and nothing else wakes it.
 *
 * So `deliver` means "wake the parent to read the conclusion it already has", not
 * "hand it the result". Carrying the text as well would put the same output in one
 * request twice, once as the rewritten tool result and once as an injected row.
 *
 * ⚠️ That also fixes the ORDER: this runner's terminal chain completes BEFORE
 * `deliverCompletedResume` runs, so waking from here would hand the parent a request
 * built from the SUPERSEDED tool result — the exact confusion the notice exists to
 * prevent, and invisible because the row would look correct. The plan is therefore
 * returned to the resume path (`announceResumedBackgroundTask`), which fires it after
 * the conclusion is persisted.
 */
export function planResumedBackgroundTaskNotice(input: {
	preserveBackground?: boolean;
	/** True when this run does NOT rewrite the historical Agent tool result. */
	skipConclusionDelivery?: boolean;
	/** Result publication is owned by the outer exact-origin conclusion transaction. */
	deferCompletionPublication?: boolean;
	timedOut: boolean;
	interrupted: boolean;
	hasError: boolean;
}): ResumedBackgroundTaskNoticePlan {
	const status = input.timedOut
		? "timeout"
		: input.interrupted
			? "cancelled"
			: input.hasError
				? "failed"
				: "completed";
	return {
		status,
		deliver:
			(input.preserveBackground !== true || input.deferCompletionPublication === true) &&
			input.skipConclusionDelivery !== true,
		wakeParent: !input.interrupted,
	};
}

/**
 * Tell the parent that a task it already collected a result for is running again,
 * because somebody resumed it by hand.
 *
 * The parent's transcript holds a settled `<background_task_id>` tool result for this
 * task, and every later write lands AFTER the run ends: `finalizeResumedAgentTask`
 * rewrites the task row, `updateToolCallConclusion` rewrites the historical tool
 * result. Both are read on the parent's next turn (history is rebuilt from rows), but
 * neither exists WHILE the continuation is in flight — so without this row a parent
 * that takes a turn mid-continuation still reasons from the superseded result, and an
 * `Await` it issues looks like it is waiting on something already finished.
 *
 * `schedule: "none"` on purpose: "a run restarted" carries nothing to act on, so an
 * idle parent is left alone and a running one reads the row on its next pass. The
 * result itself arrives through the rewritten tool result, or through the completion
 * notice when this run does not rewrite one.
 */
async function notifyParentOfResumedBackgroundTask(
	notice: ResumedBackgroundTaskNotice,
): Promise<void> {
	const { subagentId, parentNarratorId, subagent, locale } = notice;
	{
		const alias = agentLabelFromNarrator(subagent, parentNarratorId);
		const title = subagent.title?.trim() || alias;
		const isZh = locale === "zh-CN";
		const content = isZh
			? `[系统] 后台代理"${title}"（ID: ${alias}）已被重新启动，正在再次运行。` +
				`它先前的结果已经作废；请用 Await({ type: "agent", id: "${alias}" }) 获取新的结果。`
			: `[System] Background agent "${title}" (ID: ${alias}) has been restarted and is running again. ` +
				`Its earlier result is superseded; use Await({ type: "agent", id: "${alias}" }) for the new one.`;
		if (resolveRuntimeQueueBackend() === "postgres") {
			const pub = getRuntimePublicationService();
			const run = await pub.getAgentRun(subagentId, parentNarratorId);
			await pub.commit({
				...run,
				eventKind: "started",
				resultRef: `narrator:${subagentId}:${run.logicalRunId}`,
				summary: content,
			});
			pub.schedule();
		} else {
			const run = runtimePublication.getAgentRun(subagentId, parentNarratorId);
			runAtomicWrite(db, "subagent-runner.notifyResumedBackgroundTask", (tx) =>
				runtimePublication.commit(
					{
						...run,
						eventKind: "started",
						resultRef: `narrator:${subagentId}:${run.logicalRunId}`,
						summary: content,
					},
					tx,
				),
			);
			runtimePublication.schedule();
		}
	}
}

/**
 * Tell the parent that a manually resumed background task has ENDED, and wake it to
 * read the conclusion.
 *
 * ⚠️ Call this only AFTER the run's conclusion is persisted. It carries no result on
 * purpose — `deliverCompletedResume` has already rewritten the historical Agent
 * `tool_result`, which the parent re-reads on its next turn because history is rebuilt
 * from rows. What was missing is that next turn: an idle parent had nothing to wake it,
 * so a task the user resumed by hand ended silently as far as the agent was concerned.
 * Waking before the rewrite lands would build that turn from the superseded result.
 *
 * Hence a pointer: this row says the run ended and how, and the model reads the output
 * from the tool result it already holds. Repeating the text would put the same output
 * in one request twice, and the previous `<background_task_id>` result would then have
 * two contradictory-looking successors.
 *
 * `schedule: "wakeIfIdle"` is what makes it a wake rather than a broadcast: a running
 * parent picks the row up on its next pass, and the gating (continuation lock, idle in
 * both senses, never in plan mode) lives in `deliverInjection` — one copy of the rules
 * rather than a second set to keep in sync.
 */
export async function announceResumedBackgroundTask(
	notice: ResumedBackgroundTaskAnnouncement,
): Promise<void> {
	// Both task status/control waiters and the content notice follow the same commit.
	const { recordTaskNoticeUser } = await import("./parent-injection-queue");
	recordTaskNoticeUser(notice.subagentId, notice.userId ?? null);
	try {
		await backgroundTaskService.announcePersistedAgentTerminal(
			notice.subagentId,
			notice.logicalRunId,
		);
	} finally {
		runtimePublication.schedule();
	}
}

export function commitResumedBackgroundTaskAnnouncement(
	notice: ResumedBackgroundTaskAnnouncement,
	finalText: string,
	tx?: import("./agent-runtime/mailbox-types").RuntimeTx,
): void | Promise<void> {
	if (resolveRuntimeQueueBackend() === "postgres") {
		return commitPgResumedBackgroundTaskAnnouncement(notice, finalText);
	}
	// SQLite callbacks must return synchronously, including when publication fails.
	if (!tx) throw new ValidationError("SQLite resumed task publication requires a transaction");
	commitSqliteResumedBackgroundTaskAnnouncement(notice, finalText, tx);
}

async function commitPgResumedBackgroundTaskAnnouncement(
	notice: ResumedBackgroundTaskAnnouncement,
	finalText: string,
): Promise<void> {
	const pub = getRuntimePublicationService();
	const run = await pub.getAgentRun(notice.subagentId, notice.parentNarratorId);
	if (notice.logicalRunId && notice.logicalRunId !== run.logicalRunId) {
		throw new ValidationError("Stale resumed task publication");
	}
	// B2 fix: use carried narrator fields instead of direct db.select(narrators).
	// The fields were captured at announcement construction time from the narrator
	// that was already loaded, so no SQLite touch is needed on the PG path.
	const source =
		notice.subagentTraits !== undefined
			? { id: notice.subagentId, traits: notice.subagentTraits, title: notice.subagentTitle }
			: undefined;
	const alias = source
		? agentLabelFromNarrator(source, notice.parentNarratorId)
		: notice.subagentId;
	const title = source?.title?.slice(0, 80) ?? alias;
	const eventKind = publicationEvent(notice.status) as
		| "completed"
		| "failed"
		| "timed_out"
		| "cancelled";
	await pub.commitAgentTerminal({
		run,
		eventKind,
		text: finalText,
		summary: `[System] Agent "${title}" (ID: ${alias}) ${notice.status}. Its restarted run has ended; use Await({ type: "agent", id: "${alias}" }) for the stored result.`,
	});
}

function commitSqliteResumedBackgroundTaskAnnouncement(
	notice: ResumedBackgroundTaskAnnouncement,
	finalText: string,
	tx: import("./agent-runtime/mailbox-types").RuntimeTx,
): void {
	const run = runtimePublication.getAgentRun(notice.subagentId, notice.parentNarratorId, tx);
	if (notice.logicalRunId && notice.logicalRunId !== run.logicalRunId) {
		throw new ValidationError("Stale resumed task publication");
	}
	const source = tx
		.select({ id: narrators.id, traits: narrators.traits, title: narrators.title })
		.from(narrators)
		.where(eq(narrators.id, notice.subagentId))
		.get();
	const alias = source
		? agentLabelFromNarrator(source, notice.parentNarratorId)
		: notice.subagentId;
	const title = source?.title?.slice(0, 80) ?? alias;
	backgroundTaskService.commitResumedPublicationTask(
		notice.subagentId,
		run.logicalRunId,
		notice.status,
		finalText,
		tx,
	);
	runtimePublication.commit(
		{
			...run,
			eventKind: publicationEvent(notice.status),
			resultRef: `conclusion:${runtimePublication.persistResult(run, finalText, tx)}`,
			summary: `[System] Agent "${title}" (ID: ${alias}) ${notice.status}. Its restarted run has ended; use Await({ type: "agent", id: "${alias}" }) for the stored result.`,
		},
		tx,
	);
}

/**
 * Finalize a subagent that was taken over while it had been a background task.
 * Restores background completion semantics so the parent (which holds the
 * background_task_id) can retrieve the result via Await / completion sidecar.
 * Pushes the completion notification directly (the background task row was
 * silently ended during takeover, so the normal task-row transition is skipped).
 */
export async function finalizeTakenOverBackgroundSubagent(
	...args: Parameters<typeof finalizeTakenOverBackgroundSubagentUnlocked>
): ReturnType<typeof finalizeTakenOverBackgroundSubagentUnlocked> {
	return withNarratorWorkAdmission(args[0], () =>
		finalizeTakenOverBackgroundSubagentUnlocked(...args),
	);
}

async function finalizeTakenOverBackgroundSubagentUnlocked(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	finalText: string,
	locale: Locale = "en",
	userId: string | null = null,
): Promise<void> {
	const { recordTaskNoticeUser } = await import("./parent-injection-queue");
	recordTaskNoticeUser(narratorId, userId ?? null);
	const now = new Date().toISOString();
	if (resolveRuntimeQueueBackend() === "postgres") {
		// B3 fix: use the named PG composite — narrator update + publication
		// commit in one withPgRetry transaction. No direct db.update(narrators).
		const pub = getRuntimePublicationService();
		await pub.updateNarratorBackground({
			narratorId,
			parentNarratorId,
			backgroundStatus: hasError ? "failed" : "completed",
			backgroundResult: finalText || "(no output)",
			backgroundCompletedAt: now,
			updatedAt: now,
			isBackground: true,
		});
		pub.schedule();
	} else {
		runAtomicWrite(db, "subagent-runner.finalizeTakenOverBackgroundSubagent", (tx) => {
			tx.update(narrators)
				.set({
					isBackground: true,
					backgroundStatus: hasError ? "failed" : "completed",
					backgroundResult: finalText || "(no output)",
					backgroundCompletedAt: now,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			const run = runtimePublication.getAgentRun(narratorId, parentNarratorId, tx);
			runtimePublication.commit(
				{
					...run,
					eventKind: hasError ? "failed" : "completed",
					resultRef: runtimePublication.persistResult(run, finalText || "(no output)", tx),
					summary: `[System] Background agent (ID: ${narratorId}) ${hasError ? "failed" : "completed"}. Use Await({ type: "agent", id: "${narratorId}" }) to read the stored result.`,
				},
				tx,
			);
		});
	}

	// Restore the background task row (set to "cancelled" during takeover) to its
	// real terminal result so the parent's Await path returns the actual output
	// instead of a stale cancellation. The task id equals the subagent narrator id.
	await backgroundTaskService.finalizeTakenOver(narratorId, hasError, finalText || "(no output)");

	const subNarrator = await narratorService.getById(narratorId).catch(() => null);
	const title = subNarrator?.title ?? narratorId;
	const alias = subNarrator
		? agentLabelFromNarrator(subNarrator, parentNarratorId)
		: await resolveAgentLabel(parentNarratorId, narratorId);
	const resultPreview = (finalText || "").slice(0, 500);
	// Same navigation target as the ordinary completion path; see that call site.
	const resultMessageId = await getSubagentResultMessageId(narratorId).catch(() => undefined);

	if (hasError) {
		eventBus.emit({
			type: "narrator:background_task_failed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: finalText,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_failed",
			narratorId: parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: finalText,
		});
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			alias,
			title,
			status: "failed",
			resultPreview,
			result: finalText,
			resultMessageId,
		});
	} else {
		eventBus.emit({
			type: "narrator:background_task_completed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			resultPreview,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_completed",
			narratorId: parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			resultPreview,
		});
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			alias,
			title,
			status: "completed",
			resultPreview,
			result: finalText,
			resultMessageId,
		});
	}

	void locale;
	runtimePublication.schedule();
}

/**
 * Transition a background subagent that was just taken over into the idle
 * takeover state: leave background mode (so the user can operate it via the
 * normal narrator-session engine), keep the taken_over substatus, and stop
 * tracking it as a background task. The parent is NOT notified of completion —
 * results are returned only when the user stops takeover.
 */
async function transitionBackgroundTakenOverToIdle(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
	expectedAbortController?: AbortController,
): Promise<void> {
	const now = new Date().toISOString();
	const subNarrator = await narratorService.getById(narratorId).catch(() => null);
	const updatedTraits = subNarrator
		? parseTraits(subNarrator.traits).filter((t) => t !== "background")
		: undefined;
	await db
		.update(narrators)
		.set({
			isBackground: false,
			backgroundStatus: null,
			backgroundResult: null,
			backgroundCompletedAt: null,
			...(updatedTraits ? { traits: updatedTraits } : {}),
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

	// idle[taken_over] — preserveTakenOverSubstatus keeps the tag because the
	// in-memory takeover Set is still set.
	await narratorService.updateStatus(narratorId, "idle", {
		substatus: ["taken_over"],
		skipErrorMessage: true,
	});

	// Stop tracking as a background task (silently — no cancellation broadcast).
	await backgroundTaskService.markTakenOver(narratorId, expectedAbortController).catch(() => {});
	if (getBackgroundAbortControllers().get(narratorId) === expectedAbortController) {
		getBackgroundAbortControllers().delete(narratorId);
	}
	if (expectedAbortController) {
		backgroundTaskService.unregisterAbortController(narratorId, expectedAbortController);
	}

	// Notify the parent's SubagentCard + the subagent page that it is now taken over.
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_suspended",
		narratorId: parentNarratorId,
		subagentNarratorId: narratorId,
		toolUseId,
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_status_changed",
		narratorId: parentNarratorId,
		subagentNarratorId: narratorId,
		status: "idle",
		substatus: ["taken_over"],
	});
	broadcastToNarrator(narratorId, {
		type: "status_change",
		narratorId,
		status: "idle",
		substatus: ["taken_over"],
	});
	// The parent's Agent/Task CARD is a separate consumer from the panel status
	// chip above: the `subagent_status_changed` frame is excluded from the message
	// subscription, so without this the card never learns about the takeover.
	// `toolUseId` is already in hand here, so no lookup is needed.
	await broadcastSubagentTakeoverChanged({
		parentNarratorId,
		subagentNarratorId: narratorId,
		takenOver: true,
		...(toolUseId ? { toolUseId } : {}),
	});
}

/** Broadcast subagent_started event. */
export function broadcastSubagentStarted(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	subagentType: string,
	model?: string,
	reasoningEffort?: string | null,
	inheritance?: SubagentModelInheritance,
): void {
	eventBus.emit({
		type: "narrator:subagent_started",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		...(model && { model }),
		...(reasoningEffort && { reasoningEffort }),
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_started",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		subagentType,
		...(model && { model }),
		...(reasoningEffort && { reasoningEffort }),
		...(inheritance && { modelInheritance: inheritance }),
	});
	backgroundTaskService.notifyDerivedStatusChanged(parentNarratorId, subagentId);
}

/**
 * Execute a background task (fire-and-forget).
 * Updates narrator status and broadcasts events on completion/failure.
 */
export async function executeBackgroundTask(opts: SubagentExecOptions): Promise<void> {
	const launch = await withNarratorStartAdmission(opts.narratorId, async () => {
		const owner = claimSubagentExecution(opts.narratorId);
		const wakePolicy = { allowInboxWake: false };
		return {
			completion: withNarratorWorkAdmission(opts.narratorId, () =>
				executeBackgroundTaskUnlocked(opts, owner, wakePolicy),
			).finally(() => releaseSubagentPublicationOwner(owner, wakePolicy.allowInboxWake)),
		};
	});
	return launch.completion;
}

function releaseSubagentPublicationOwner(owner: ExecutionOwner, allowInboxWake: boolean): void {
	const narratorId = owner.narratorId;
	if (!owner.isCurrent()) return;
	owner.release();
	// Failed/runtime-paused turns retain queued input until an explicit retry.
	if (!allowInboxWake) return;
	void import("./agent-runtime/inbox")
		.then(({ wakeInboxIfEligible }) => wakeInboxIfEligible(narratorId))
		.catch((error) =>
			logger.warn("Deferred subagent inbox wake after publication", {
				narratorId,
				error: String(error),
			}),
		);
}

/** Reject before installing runner controls or entering error-to-publication handling. */
function claimSubagentExecution(narratorId: string): ExecutionOwner {
	const owner = tryClaimExecution(narratorId, "subagent");
	if (!owner) {
		throw new AppError("Narrator already has an execution owner", 409, "NARRATOR_EXECUTION_BUSY");
	}
	return owner;
}

async function executeBackgroundTaskUnlocked(
	opts: SubagentExecOptions,
	owner: ExecutionOwner,
	wakePolicy: { allowInboxWake: boolean },
): Promise<void> {
	const { narratorId, parentNarratorId, toolUseId, locale, updateLease } = opts;
	const pub = getRuntimePublicationService();
	const publicationRun = await pub.getAgentRun(narratorId, parentNarratorId);
	const backgroundAbortController = getBackgroundAbortControllers().get(narratorId);
	const executionStartedAt = Date.now();
	const {
		remainingTimeoutMs: timeoutMs,
		timeoutLabelMs,
		executionDeadlineAt,
		expiredAtMount,
	} = resolveSubagentExecutionTiming({
		now: executionStartedAt,
		timeoutMs: opts.timeoutMs,
		executionDeadlineAt: opts.executionDeadlineAt,
		executionTimeoutMs: opts.executionTimeoutMs,
		defaultTimeoutMs: BACKGROUND_TASK_TIMEOUT_MS,
	});
	const executionTimeout = expiredAtMount
		? {
				signal: AbortSignal.abort("Background task timeout"),
				timeoutMs: 0,
				didTimeout: () => true,
				dispose: () => {},
			}
		: createOptionalExecutionTimeout(timeoutMs, "Background task timeout");
	const unregisterRunningExecution = registerRunningSubagentExecution({
		subagentId: narratorId,
		parentNarratorId,
		toolUseId,
		startedAt: executionStartedAt,
		timeoutMs: timeoutLabelMs ?? null,
		executionDeadlineAt,
		background: true,
		logicalRunId: publicationRun.logicalRunId,
	});
	let timedOut = false;
	const onTimeout = () => {
		timedOut = true;
		backgroundAbortController?.abort("Background task timeout");
	};
	executionTimeout?.signal.addEventListener("abort", onTimeout, { once: true });
	if (executionTimeout?.signal.aborted) onTimeout();
	let finalUserId: string | null = opts.userId ?? null;

	try {
		const result = await executeSubagent(
			{
				...opts,
				fileChangeStartedAt: new Date(executionStartedAt).toISOString(),
			},
			owner,
		);
		finalUserId = result.finalUserId ?? null;

		wakePolicy.allowInboxWake = result.allowInboxWake;
		const timeoutText = timeoutLabelMs
			? `Background task timed out after ${timeoutLabelMs}ms`
			: "Background task timed out";
		const finalText = timedOut
			? result.finalText.trim()
				? `${timeoutText}\n\nLast output:\n${result.finalText}`
				: timeoutText
			: result.contextLengthExceeded
				? "Error: context length exceeded"
				: result.aborted && !result.finalText.trim()
					? "Background task was aborted"
					: result.finalText;
		const outcome = resolveBackgroundCompletionOutcome({
			timedOut,
			hasError: result.hasError,
			contextLengthExceeded: result.contextLengthExceeded,
			aborted: result.aborted,
		});
		const hasError = outcome !== "completed";

		if ((await isBackgroundTaskCancelled(narratorId)) || !owner.isCurrent()) return;

		// Background takeover: the user claimed this task's result. Do NOT
		// finalize/notify as completed/failed — transition to the idle takeover
		// state so the user can operate the subagent directly.
		//
		// Reached whether the turn ended normally or was aborted: taking over does
		// not stop the turn, so the ordinary arrival here is a run that finished on
		// its own while the hold was already recorded.
		if (isBackgroundTakenOver(narratorId)) {
			// Unless the user already let go while this turn was running. Since taking
			// over no longer stops the turn, that is an ordinary sequence (take over →
			// watch it finish → release), and parking the subagent instead would strand
			// the parent's Await forever with no badge left on screen to release it.
			if (consumePendingBackgroundFinalize(narratorId)) {
				clearTakenOver(narratorId);
			} else {
				await transitionBackgroundTakenOverToIdle(
					narratorId,
					parentNarratorId,
					toolUseId,
					backgroundAbortController,
				);
				return;
			}
		}

		// Finalize the subagent narrator status
		await finalizeSubagent(
			narratorId,
			parentNarratorId,
			toolUseId,
			hasError,
			hasError ? finalText : null,
			{ timedOut, owner },
		);

		if (!owner.isCurrent()) return;
		await finalizeBackgroundCompletion(
			narratorId,
			parentNarratorId,
			toolUseId,
			outcome,
			finalText,
			locale as Locale,
			timeoutLabelMs ?? undefined,
			backgroundAbortController,
			false,
			finalUserId,
		);
	} catch (err) {
		wakePolicy.allowInboxWake = false;
		if ((await isBackgroundTaskCancelled(narratorId)) || !owner.isCurrent()) return;

		// Background takeover during execution — same as above, including the
		// already-released case.
		if (isBackgroundTakenOver(narratorId)) {
			if (consumePendingBackgroundFinalize(narratorId)) {
				clearTakenOver(narratorId);
			} else {
				await transitionBackgroundTakenOverToIdle(
					narratorId,
					parentNarratorId,
					toolUseId,
					backgroundAbortController,
				);
				return;
			}
		}

		const caughtError = err instanceof Error ? err.message : String(err);
		const errorText = timedOut
			? timeoutLabelMs
				? `Background task timed out after ${timeoutLabelMs}ms`
				: "Background task timed out"
			: caughtError;
		logger.error("Background task execution failed", {
			narratorId,
			error: errorText,
			timedOut,
		});

		await finalizeSubagent(narratorId, parentNarratorId, toolUseId, true, errorText, {
			timedOut,
			owner,
		});
		if (!owner.isCurrent()) return;
		await finalizeBackgroundCompletion(
			narratorId,
			parentNarratorId,
			toolUseId,
			timedOut ? "timeout" : "failed",
			errorText,
			locale as Locale,
			timeoutLabelMs ?? undefined,
			backgroundAbortController,
			false,
			finalUserId,
		);
	} finally {
		executionTimeout?.signal.removeEventListener("abort", onTimeout);
		executionTimeout?.dispose();
		unregisterRunningExecution();
		if (getBackgroundAbortControllers().get(narratorId) === backgroundAbortController) {
			getBackgroundAbortControllers().delete(narratorId);
		}
		if (backgroundAbortController) {
			backgroundTaskService.unregisterAbortController(narratorId, backgroundAbortController);
		}

		// Resolve attach waiter if any (legacy attach path for a run_in_background task)
		const attachWaiter = getAttachWaitersMap().get(narratorId);
		if (attachWaiter && owner.isCurrent()) {
			// Determine final result — on success path use the outer scope vars,
			// on catch path the DB was already updated so read from there.
			const nar = await narratorService.getById(narratorId).catch(() => null);
			const status = nar?.backgroundStatus ?? "failed";
			const result = nar?.backgroundResult ?? "(no output)";
			attachWaiter.resolve({
				finalText: result,
				hasError: status === "failed",
			});
			getAttachWaitersMap().delete(narratorId);
		}
		updateLease?.release();
	}
}

/**
 * Cancel a running background task.
 * Returns true if the task was found and cancelled.
 */
export async function cancelBackgroundTask(taskNarratorId: string): Promise<boolean> {
	const ctrl = getBackgroundAbortControllers().get(taskNarratorId);
	if (!ctrl) return false;

	ctrl.abort("Cancelled by user");

	const narrator = await narratorService.getById(taskNarratorId);
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			backgroundStatus: "cancelled",
			backgroundCompletedAt: now,
			updatedAt: now,
		})
		.where(eq(narrators.id, taskNarratorId));
	await narratorService.updateStatus(taskNarratorId, "idle", {
		substatus: ["interrupted"],
		skipErrorMessage: true,
	});

	const parentNarratorId = narrator.parentNarratorId;
	if (parentNarratorId) {
		eventBus.emit({
			type: "narrator:background_task_cancelled",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_cancelled",
			narratorId: parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
	}

	if (getBackgroundAbortControllers().get(taskNarratorId) === ctrl) {
		getBackgroundAbortControllers().delete(taskNarratorId);
	}
	await backgroundTaskService.markCancelled(taskNarratorId, ctrl).catch(() => {});
	return true;
}

/**
 * Get the status of a background task.
 */
export async function getBackgroundTaskStatus(taskNarratorId: string): Promise<{
	status: string;
	result: string | null;
	completedAt: string | null;
	isRunning: boolean;
} | null> {
	const narrator = await narratorService.getById(taskNarratorId);
	if (!hasTrait(parseTraits(narrator.traits), "background")) return null;

	return {
		status: narrator.backgroundStatus ?? "unknown",
		result: narrator.backgroundResult ?? null,
		completedAt: narrator.backgroundCompletedAt ?? null,
		isRunning: getBackgroundAbortControllers().has(taskNarratorId),
	};
}

/**
 * Wait for a background task to complete (with timeout).
 * Returns the task status when done or when timeout expires.
 * An optional signal ends the wait early with status "aborted" when it fires
 * (used by Await to support extendable timeouts and parent interrupts).
 */
export function waitForBackgroundTask(
	taskNarratorId: string,
	timeoutMs = 30000,
	signal?: AbortSignal,
): Promise<{ status: string; result: string | null }> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve({ status: "running", result: null });
		}, timeoutMs);

		const WATCHED_EVENTS = new Set([
			"narrator:background_task_completed",
			"narrator:background_task_failed",
			"narrator:background_task_cancelled",
		]);

		const handler = (event: import("../lib/event-bus").NarraForkEvent) => {
			if (!WATCHED_EVENTS.has(event.type)) return;
			if (!("taskNarratorId" in event) || event.taskNarratorId !== taskNarratorId) return;
			cleanup();
			getBackgroundTaskStatus(taskNarratorId).then((s) => {
				resolve({ status: s?.status ?? "unknown", result: s?.result ?? null });
			});
		};

		const onAbort = () => {
			cleanup();
			resolve({ status: "aborted", result: null });
		};

		const cleanup = () => {
			clearTimeout(timeout);
			eventBus.offAny(handler);
			signal?.removeEventListener("abort", onAbort);
		};

		if (signal?.aborted) {
			clearTimeout(timeout);
			resolve({ status: "aborted", result: null });
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		// Subscribed BEFORE the status read, not inside its `.then`. A completion event
		// emitted while that read was in flight had no listener, so awaiting a task that
		// finished right then blocked for the full timeout and then reported "running"
		// for a task that was already done. Subscribing first can only make both paths
		// resolve, and a settled promise ignores the second.
		eventBus.onAny(handler);

		// Already finished before we started listening.
		getBackgroundTaskStatus(taskNarratorId).then((s) => {
			if (s && s.status !== "running") {
				cleanup();
				resolve({ status: s.status, result: s.result });
			}
		});
	});
}

// === Foreground subagent execution loop ===

interface ForegroundLoopInput {
	deferCompletionPublication?: boolean;
	prePromptBashCommand?: string;
	publicationRun?: PublicationRun;
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	model: string;
	provider: string;
	locale: string;
	signal: AbortSignal;
	/** Optional wall-clock timeout for a newly started foreground run; 0/undefined means none. */
	timeoutMs?: number;
	/** Absolute deadline preserved across a planned-update restart. */
	executionDeadlineAt?: string | null;
	/** Original timeout used for user-facing timeout semantics after recovery. */
	executionTimeoutMs?: number | null;
	userId?: string | null;
	systemPrompt: string;
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	customDef: Awaited<ReturnType<typeof customSubagentService.loadByName>> | null;
	rebuildSystemPrompt?: (contextSummary?: string | null) => Promise<string>;
	updateLease?: UpdateExecutionLease;
}

export interface ForegroundRunTerminal {
	runId: string;
	allowInboxWake: boolean;
	output: string;
	finalText: string;
	hasError: boolean;
	interrupted: boolean;
	timedOut: boolean;
	/** Principal that produced the terminal result; null is authoritative unattributed. */
	finalUserId: string | null;
}

export type ForegroundRunPublication =
	| { kind: "handoff"; runId: string; output: string }
	| ({ kind: "terminal" } & ForegroundRunTerminal);

export interface ForegroundRunHandle {
	runId: string;
	/** Settles on detach handoff or terminal completion, whichever is published first. */
	foreground: Promise<ForegroundRunPublication>;
	/** Settles only after the underlying runner truly reaches a terminal state. */
	terminal: Promise<ForegroundRunTerminal>;
}

/**
 * Start the shared foreground execution loop for initial and resumed subagent runs.
 * The foreground publication and terminal completion are deliberately separate:
 * detach may hand control back to the parent without pretending the run finished.
 */
export function startForegroundRun(
	input: ForegroundLoopInput,
	borrowedOwner?: ExecutionOwner,
): ForegroundRunHandle {
	const runId = generateId();
	const admitted = withNarratorStartAdmission(input.subagentId, async () => {
		const owner = borrowedOwner ?? claimSubagentExecution(input.subagentId);
		if (owner.narratorId !== input.subagentId || owner.kind !== "subagent" || !owner.isCurrent()) {
			throw new AppError("Subagent execution owner expired", 409, "NARRATOR_EXECUTION_BUSY");
		}
		return withNarratorWorkAdmission(
			input.subagentId,
			async () => startForegroundRunUnlocked(input, runId, owner, !borrowedOwner),
			(run) => run.terminal,
		).catch((error) => {
			if (!borrowedOwner) owner.release();
			throw error;
		});
	});
	const terminal = admitted.then((run) => run.terminal);
	// Legacy callers only await foreground; admission rejection must not leave an
	// unobserved second rejection, while terminal still rejects for structured callers.
	void terminal.catch(() => {});
	return { runId, foreground: admitted.then((run) => run.foreground), terminal };
}

function startForegroundRunUnlocked(
	input: ForegroundLoopInput,
	runId: string,
	owner: ExecutionOwner,
	releaseOnTerminal: boolean,
): ForegroundRunHandle {
	const publicationRun =
		input.publicationRun ??
		(resolveRuntimeQueueBackend() === "postgres"
			? (() => {
					throw new Error(
						"PG backend requires callers to provide publicationRun via async startAgentRun",
					);
				})()
			: runtimePublication.startAgentRun({
					narratorId: input.subagentId,
					parentNarratorId: input.parentNarratorId,
				}));
	const {
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		cwd,
		model,
		provider,
		locale,
		signal,
		timeoutMs: requestedTimeoutMs,
		executionDeadlineAt: requestedExecutionDeadlineAt,
		executionTimeoutMs: requestedExecutionTimeoutMs,
		systemPrompt,
		customDef,
		rebuildSystemPrompt,
		updateLease,
	} = input;

	let finalText = "";
	let hasError = false;
	let wasInterrupted = false;
	const currentPrompt = input.prompt;
	const currentPrePromptBashCommand = input.prePromptBashCommand;
	const currentHistory: unknown[] = input.initialHistory;
	const currentTrailingToolResults: unknown[] | undefined = input.initialTrailingToolResults;
	let currentUserId = input.userId ?? null;
	const currentModel = model;
	const currentProvider = provider;
	const currentSystemPrompt = systemPrompt;
	const executionStartedAt = Date.now();
	const { remainingTimeoutMs, timeoutLabelMs, executionDeadlineAt, expiredAtMount } =
		resolveSubagentExecutionTiming({
			now: executionStartedAt,
			timeoutMs: requestedTimeoutMs,
			executionDeadlineAt: requestedExecutionDeadlineAt,
			executionTimeoutMs: requestedExecutionTimeoutMs,
		});
	const executionTimeout = expiredAtMount
		? {
				signal: AbortSignal.abort("Subagent execution timeout"),
				timeoutMs: 0,
				didTimeout: () => true,
				dispose: () => {},
			}
		: createOptionalExecutionTimeout(remainingTimeoutMs, "Subagent execution timeout");
	const unregisterRunningExecution = registerRunningSubagentExecution({
		subagentId,
		parentNarratorId,
		toolUseId,
		startedAt: executionStartedAt,
		timeoutMs: timeoutLabelMs ?? null,
		executionDeadlineAt,
		background: false,
		logicalRunId: publicationRun.logicalRunId,
	});
	let timedOut = false;
	const timeoutMessage = timeoutLabelMs
		? `Subagent execution timed out after ${timeoutLabelMs}ms`
		: "Subagent execution timed out";
	const markTimedOut = () => {
		timedOut = true;
		finalText = timeoutMessage;
		hasError = true;
	};
	const _controlSignal = executionTimeout
		? AbortSignal.any([signal, executionTimeout.signal])
		: signal;

	const {
		promise: foregroundPromise,
		resolve: resolveForeground,
		reject: rejectForeground,
	} = Promise.withResolvers<ForegroundRunPublication>();
	const {
		promise: terminalPromise,
		resolve: resolveTerminal,
		reject: rejectTerminal,
	} = Promise.withResolvers<ForegroundRunTerminal>();
	let allowInboxWake = false;
	let publicationCommitError: unknown;
	let foregroundPublished = false;
	let terminalPublished = false;
	const publishHandoff = (output: string): boolean => {
		if (foregroundPublished) return false;
		foregroundPublished = true;
		resolveForeground({ kind: "handoff", runId, output });
		return true;
	};
	const publishTerminal = async (
		terminal: Omit<ForegroundRunTerminal, "runId" | "allowInboxWake">,
	): Promise<boolean> => {
		if (terminalPublished) return false;
		terminalPublished = true;
		// All async cleanup/publication above has settled; detach handoffs never release.
		// A continued runner has an additional publication chain that owns the release.
		if (releaseOnTerminal) {
			// A foreground run reserved capacity in case it detached. Await the backend-neutral,
			// idempotent release before resolving terminal publication; PG release is a real
			// transaction and fire-and-forget here leaks slots until the next cleanup pass.
			try {
				await getRuntimePublicationService().releaseUnusedRunSlots(publicationRun);
			} catch (error) {
				logger.warn("Failed to release unused subagent publication slots", {
					subagentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			releaseSubagentPublicationOwner(owner, allowInboxWake);
		}
		const publication: ForegroundRunTerminal = { runId, allowInboxWake, ...terminal };
		resolveTerminal(publication);
		if (!foregroundPublished) {
			foregroundPublished = true;
			resolveForeground({ kind: "terminal", ...publication });
		}
		return true;
	};

	// Track whether we've been detached (set by detachSubagent) and wait for setup if needed.
	let detached = false;
	let detachReadyPromise: Promise<DetachSetupResult> | undefined;
	let currentForegroundAbortController: AbortController | undefined;

	const runLoop = async () => {
		const proxy = new ProxyAbortController();
		const runtimeControl: RuntimeForegroundControl = {
			proxy,
			parentSignal: signal,
			timeoutSignal: executionTimeout?.signal,
			turnAbort: new AbortController(),
			detached: false,
		};

		try {
			// Register detach entry so the API can detach this subagent
			getDetachableMap().set(subagentId, {
				runId,
				markDetached: (setup) => {
					detached = true;
					runtimeControl.detached = true;
					detachReadyPromise = setup;
				},
				publishHandoff,
				proxy,
				parentSignal: signal,
				fgAbort: new AbortController(), // placeholder, updated in loop
				toolUseId,
				parentNarratorId,
				subagentId,
			});

			const fgAbort = runtimeControl.turnAbort;
			currentForegroundAbortController = fgAbort;
			getForegroundAbortControllers().set(subagentId, fgAbort);
			const detachEntry = getDetachableMap().get(subagentId);
			if (detachEntry) detachEntry.fgAbort = fgAbort;
			proxy.listenTo(signal, fgAbort.signal);
			if (executionTimeout) proxy.listenTo(executionTimeout.signal);
			const result = await executeSubagent(
				{
					initialPrePromptBashCommand: currentPrePromptBashCommand,
					narratorId: subagentId,
					parentNarratorId,
					toolUseId,
					subagentType,
					prompt: currentPrompt,
					cwd,
					model: currentModel,
					provider: currentProvider,
					locale,
					signal: proxy.signal,
					control: runtimeControl,
					fileChangeStartedAt: new Date(executionStartedAt).toISOString(),
					timeoutMs: remainingTimeoutMs,
					userId: currentUserId,
					systemPrompt: currentSystemPrompt,
					initialHistory: currentHistory,
					initialTrailingToolResults: currentTrailingToolResults,
					customDef,
					rebuildSystemPrompt,
					updateLease,
				},
				owner,
			);
			allowInboxWake = result.allowInboxWake;
			// Null is authoritative too: never fall back to the dispatch user.
			currentUserId = result.finalUserId ?? currentUserId;
			finalText = result.contextLengthExceeded
				? "Error: context length exceeded"
				: result.finalText;
			hasError = result.hasError || !!result.contextLengthExceeded;
			if (executionTimeout?.didTimeout() && !signal.aborted) markTimedOut();
			else if (result.aborted) {
				wasInterrupted = true;
				if (signal.aborted)
					finalText = "Subagent interrupted because parent narrator was interrupted";
				hasError = false;
			}
		} catch (err) {
			allowInboxWake = false;
			if (executionTimeout?.didTimeout() && !signal.aborted) {
				markTimedOut();
			} else {
				hasError = true;
				finalText = `Subagent error: ${err instanceof Error ? err.message : String(err)}`;
			}
			logger.error("Foreground subagent loop failed", {
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			currentForegroundAbortController = runtimeControl.turnAbort;
			runtimeControl.cleanupTurnAbort?.();
			setExecutionSuspended(owner, false);
			const registeredDetach = getDetachableMap().get(subagentId);
			if (registeredDetach?.runId === runId) getDetachableMap().delete(subagentId);
			proxy.dispose();
			if (
				currentForegroundAbortController &&
				getForegroundAbortControllers().get(subagentId) === currentForegroundAbortController
			) {
				getForegroundAbortControllers().delete(subagentId);
			}
			if (owner.isCurrent()) consumeForegroundSubagentHardInterrupt(subagentId);

			let detachSetupSucceeded = detached;
			if (detached) {
				if (!detachReadyPromise) {
					detachSetupSucceeded = false;
					logger.warn("Detached subagent setup promise missing", { subagentId });
				} else {
					try {
						await detachReadyPromise;
					} catch (err) {
						detachSetupSucceeded = false;
						logger.warn("Detached subagent setup failed before completion", {
							subagentId,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
			const detachedAbortController = detachSetupSucceeded
				? getBackgroundAbortControllers().get(subagentId)
				: undefined;

			if (owner.isCurrent()) {
				// The shared runtime returns only after control is settled. Terminal
				// publication must not preserve a takeover tag from an earlier pass.
				//
				// Every control exit that SETTLES a takeover (released, stop-takeover
				// handoff, manual-override answer) clears it itself. So a takeover still
				// held here, with no parent/timeout/detach cause, means the runtime left
				// through a path that bypassed the control transition — the class of bug
				// where a direct session abort ended a takeover. Nothing can re-suspend
				// once the loop has returned, so the clear stays; the warning makes a
				// regression visible instead of silent.
				if (isTakenOver(subagentId) && !signal.aborted && !timedOut && !detached) {
					logger.warn("Foreground takeover ended without a control settlement", {
						subagentId,
						parentNarratorId,
						wasInterrupted,
					});
				}
				clearTakenOver(subagentId);
				try {
					await finalizeSubagent(
						subagentId,
						parentNarratorId,
						toolUseId,
						hasError,
						hasError ? finalText : null,
						{ interrupted: wasInterrupted, timedOut, owner },
					);

					// Bind the result to the subagent's last assistant message
					const resultMsgId = await getSubagentResultMessageId(subagentId);
					if (resultMsgId) {
						const { narratorPersistence } = await import("./narrator-persistence");
						const reference = await narratorPersistence.resolveSubagentConclusionReference(
							subagentId,
							parentNarratorId,
							toolUseId,
						);
						await db
							.update(narratorToolCalls)
							.set({ resultMessageId: resultMsgId })
							.where(eq(narratorToolCalls.id, reference.toolCallId));
					}
				} catch {
					// Non-critical — don't fail the whole flow
				}
				await restorePendingSubagentModel(subagentId).catch((err) => {
					logger.warn("Failed to restore temporary subagent model", {
						subagentId,
						error: err instanceof Error ? err.message : String(err),
					});
				});

				if (detachSetupSucceeded) {
					try {
						// Background completion path — use shared helper
						try {
							await withDbRetry(
								async () =>
									finalizeBackgroundCompletion(
										subagentId,
										parentNarratorId,
										toolUseId,
										timedOut ? "timeout" : hasError ? "failed" : "completed",
										finalText,
										locale as Locale,
										timeoutLabelMs ?? undefined,
										detachedAbortController,
										input.deferCompletionPublication,
										currentUserId,
									),
								{ label: "detached_task_publication", maxRetries: 3 },
							);
						} catch (error) {
							// This is source+intent persistence, not a best-effort WS notification.
							// Finish every lease/timer cleanup below, then reject the terminal handle.
							publicationCommitError = error;
						}

						// Notify attach waiter if any (background → foreground transition)
						const attachWaiter = getAttachWaitersMap().get(subagentId);
						if (attachWaiter) {
							attachWaiter.resolve({
								finalText: publicationCommitError
									? `Result publication failed: ${String(publicationCommitError)}`
									: finalText,
								hasError: !!publicationCommitError || hasError,
							});
							getAttachWaitersMap().delete(subagentId);
						}

						// Clean up team tracking
						clearTeamInbox(subagentId);
					} finally {
						if (getBackgroundAbortControllers().get(subagentId) === detachedAbortController) {
							getBackgroundAbortControllers().delete(subagentId);
						}
						if (detachedAbortController) {
							backgroundTaskService.unregisterAbortController(subagentId, detachedAbortController);
						}
					}
				}
			}
			updateLease?.release();
			executionTimeout?.dispose();
			unregisterRunningExecution();
			backgroundTaskService.notifyDerivedStatusChanged(parentNarratorId, subagentId);
			if (publicationCommitError) {
				terminalPublished = true;
				if (releaseOnTerminal) releaseSubagentPublicationOwner(owner, false);
				rejectTerminal(publicationCommitError);
				if (!foregroundPublished) rejectForeground(publicationCommitError);
			} else
				await publishTerminal({
					output: await appendSubagentFileChanges(
						{
							parentNarratorId,
							childNarratorId: subagentId,
							scope: {
								sourceToolUseId: toolUseId,
								startedAt: new Date(executionStartedAt).toISOString(),
								completedAt: new Date().toISOString(),
							},
						},
						agentResultTag(await resolveAgentLabel(parentNarratorId, subagentId)) +
							(finalText || "(no output)"),
					),
					finalText: finalText || "(no output)",
					hasError,
					interrupted: wasInterrupted,
					timedOut,
					finalUserId: currentUserId,
				});
		}
	};

	// Start the loop without awaiting: foreground may publish a detach handoff first,
	// while terminal remains pending until all finalization is complete.
	runLoop().catch(async (err) => {
		allowInboxWake = false;
		if (publicationCommitError) {
			terminalPublished = true;
			if (releaseOnTerminal) releaseSubagentPublicationOwner(owner, false);
			rejectTerminal(err);
			if (!foregroundPublished) rejectForeground(err);
			return;
		}
		const finalText = `Subagent error: ${err instanceof Error ? err.message : String(err)}`;
		await publishTerminal({
			// The CRASH outlet needs the file summary most: a subagent that died partway
			// has very likely already written some of its files, and this is precisely the
			// moment the parent would otherwise carry on against a stale view of the disk.
			// `appendSubagentFileChanges` returns the text unchanged if aggregation fails,
			// so the error message itself can never be lost to a failed summary.
			output: await appendSubagentFileChanges(
				{
					parentNarratorId,
					childNarratorId: subagentId,
					scope: {
						sourceToolUseId: toolUseId,
						startedAt: new Date(executionStartedAt).toISOString(),
						completedAt: new Date().toISOString(),
					},
				},
				agentResultTag(await resolveAgentLabel(parentNarratorId, subagentId)) + finalText,
			),
			finalText,
			hasError: true,
			interrupted: false,
			timedOut: false,
			finalUserId: currentUserId,
		});
	});

	return { runId, foreground: foregroundPromise, terminal: terminalPromise };
}

/** Compatibility wrapper that preserves the legacy model-tool text boundary. */
export async function runForegroundLoop(input: ForegroundLoopInput): Promise<string> {
	return (await startForegroundRun(input).foreground).output;
}

// === Subagent runner ===

export interface RunSubagentInput {
	/** Exact spawning Agent attempt, supplied by executeTool, never resolved by provider id. */
	toolCallBinding?: ToolCallBinding;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	title?: string;
	signal: AbortSignal;
	locale: string;
	/** Optional wall-clock deadline; 0/undefined means no deadline. */
	timeoutMs?: number;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	background?: boolean;
	alias?: string;
	/**
	 * User who triggered the parent turn that spawned this subagent. Flows into
	 * knowledge ACL and fast-mode ("inherit") resolution, which would otherwise
	 * degrade to anonymous/disabled for every tool-spawned subagent.
	 */
	userId?: string | null;
	/** Existing tool/coordinator lease; tool leases are transferred into the runner lifecycle. */
	updateExecutionLease?: SubagentUpdateExecutionLease;
}

/**
 * Run a subagent synchronously (from the parent narrator's perspective),
 * or in background mode (fire-and-forget, returns immediately with a task ID).
 *
 * Creates a subagent narrator, runs the agent loop, persists all messages,
 * and returns the final text result.
 */
export async function runSubagent(input: RunSubagentInput): Promise<string> {
	return withNarratorWorkAdmission(input.parentNarratorId, () => runSubagentUnlocked(input));
}

async function runSubagentUnlocked(input: RunSubagentInput): Promise<string> {
	const {
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		title,
		signal,
		locale,
		timeoutMs: requestedTimeoutMs,
		model: explicitModel,
		reasoningEffort,
		background,
		alias,
		userId,
		updateExecutionLease,
	} = input;
	const timeoutMs =
		requestedTimeoutMs === 0 ? 0 : normalizeOptionalExecutionTimeout(requestedTimeoutMs);

	// Load custom subagent definition once for non-builtin types
	const isBuiltin =
		subagentType === "explore" ||
		subagentType === "plan" ||
		subagentType === "search" ||
		subagentType === "review" ||
		subagentType === "general";
	const customDef = isBuiltin ? null : await customSubagentService.loadByName(subagentType);

	const rebuildSystemPrompt = (contextSummary?: string | null) =>
		buildSubagentSystemPrompt(
			subagentType,
			cwd,
			locale as Locale,
			contextSummary,
			customDef?.prompt,
			// Only background subagents can report progress to the parent; a
			// foreground subagent blocks the parent until it finishes.
			background ?? false,
			resolveRuntimePolicy({ variant: "subagent", subagentType, customDefinition: customDef }),
		);
	const systemPrompt = await rebuildSystemPrompt();

	// Resolve model: explicit param > per-type setting / custom default > parent model > global default
	let subagentPref: string | undefined;
	if (
		subagentType === "explore" ||
		subagentType === "plan" ||
		subagentType === "search" ||
		subagentType === "review"
	) {
		subagentPref = settings.agent.subagentModels?.[subagentType] || undefined;
	} else if (customDef) {
		subagentPref = customDef.defaultModel || undefined;
	}

	// Apply effective per-narrator subagent model policy. Custom narrator traits override
	// global settings.agent.subagentAllowedModels.
	const parent = await narratorService.getById(parentNarratorId);
	// Model pools are a grant, so layering can only narrow them: a narrator cannot
	// widen its subagent pool past what the project/user layers allow.
	const parentTraits = await resolveEffectiveTraits({
		narratorTraits: parent.traits,
		projectId: await resolveNarratorProjectId(parent),
		actingUserId: userId ?? null,
	});
	const modelPolicy = resolveEffectiveSubagentModelPolicy(parentTraits.traits, subagentType);
	// No global-default step: a pooled fallback must be the pool's own first entry,
	// matching resolveSubagentModelInheritance so creation and later runs agree.
	const candidateModels = [subagentPref, parent.model || FOLLOW_DEFAULT_MODEL];
	const modelSelection = resolveSubagentModelSelectionFromPolicy({
		policy: modelPolicy,
		explicitModel,
		candidates: candidateModels,
	});
	const resolvedModelInput = modelSelection?.model;
	// A preference only pins the child if it actually won selection. A preference
	// rejected by the pool must not turn a parent/pool fallback into a frozen pin.
	const preferenceSelection =
		!explicitModel && subagentPref
			? resolveSubagentModelSelectionFromPolicy({
					policy: modelPolicy,
					explicitModel: subagentPref,
					candidates: [],
				})
			: undefined;
	const storedModelInput = subagentStoredModelReference({
		explicitModel,
		preferenceSelection,
		selection: modelSelection,
	});
	// No configured tier means the original explicit/parent/global inheritance stays intact.
	const configuredReasoningEffort = modelSelection?.poolEntry?.reasoningEffort ?? reasoningEffort;
	if (modelPolicy.source !== "none" && !resolvedModelInput) {
		const allowedModels = expandAllowedPoolForDisplay(
			modelPolicy.models.map((entry) => entry.model),
		);
		throw new ValidationError(
			modelPolicy.isExplicitEmpty
				? `No models are allowed for "${modelPolicy.poolKey}" subagents by this narrator's custom trait.`
				: `No candidate model is in the allowed pool for "${modelPolicy.poolKey}" subagents. ` +
						`Allowed models: ${allowedModels.join(", ")}. Please specify one of these models explicitly.`,
		);
	}

	// 1. Create subagent narrator. Tool entry points transfer their already-admitted
	// lease here; direct/non-tool callers perform final admission themselves.
	const updateLease = claimSubagentUpdateExecutionLease(
		updateExecutionLease,
		"resumable",
		parentNarratorId,
	);
	if (!updateLease) {
		throw new ValidationError(
			"Subagent execution deferred because a NarraFork update is scheduled.",
		);
	}

	const inheritedTraits = parseTraits(parent.traits).filter(
		(trait) =>
			trait.startsWith(DISABLED_TOOLS_TRAIT_PREFIX) ||
			trait.startsWith(BLOCKED_SKILLS_TRAIT_PREFIX),
	);
	let subagent: Awaited<ReturnType<typeof narratorService.createSubagent>>;
	try {
		if (input.toolCallBinding) {
			const { narratorPersistence } = await import("./narrator-persistence");
			await narratorPersistence.validateToolCallBinding(
				parentNarratorId,
				toolUseId,
				input.toolCallBinding,
			);
		}
		subagent = await narratorService.createSubagent({
			parentNarratorId,
			originToolCallId: input.toolCallBinding?.toolCallId,
			subagentType,
			title,
			cwd,
			systemPrompt,
			model: storedModelInput,
			reasoningEffort: configuredReasoningEffort,
			inheritedTraits,
		});
	} catch (error) {
		updateLease.release();
		throw error;
	}

	const subagentId = subagent.id;
	updateLease.setNarratorId(subagentId);
	const {
		model,
		reasoningEffort: fixedPoolEffort,
		parentReasoningEffort,
		inheritance,
	} = await resolveSubagentModelForRun(subagent, userId).catch((error) => {
		updateLease.release();
		throw error;
	});
	const provider = resolveProvider(model);
	let aliasRegistration: { alias: string; conflicted: boolean };
	try {
		aliasRegistration = await registerAndPersistSubagentAlias(
			parentNarratorId,
			subagentId,
			alias || title,
		);
	} catch (err) {
		aliasRegistration = registerTaskAlias(parentNarratorId, subagentId, alias || title);
		logger.warn("Failed to persist subagent alias", {
			subagentId,
			alias: aliasRegistration.alias,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 2. Persist subagent's user message (linked to parent's tool_use)
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId).catch((error) => {
		updateLease.release();
		throw error;
	});

	// Broadcast subagent_started after persist so the frontend only sees it
	// when the subagent record is fully consistent (narrator + user message).
	broadcastSubagentStarted(
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		subagent.model === FOLLOW_PARENT_MODEL ? FOLLOW_PARENT_MODEL : model,
		subagentRunReasoningEffort(
			{ reasoningEffort: fixedPoolEffort, parentReasoningEffort },
			subagent.reasoningEffort,
			resolveDefaultReasoningEffort(provider, model),
		),
		inheritance,
	);

	if (background) {
		let bgAbort: AbortController;
		try {
			// --- Background mode: fire-and-forget ---

			// Mark narrator and tool_call as background
			const now = new Date().toISOString();
			const subNarrator = await narratorService.getById(subagentId);
			const updatedTraits = [...new Set([...parseTraits(subNarrator.traits), "background"])];
			await db
				.update(narrators)
				.set({
					isBackground: true,
					backgroundStatus: "running",
					traits: updatedTraits,
					updatedAt: now,
				})
				.where(eq(narrators.id, subagentId));
			eventBus.emit({
				type: "narrator:background_task_started",
				narratorId: parentNarratorId,
				parentNarratorId,
				taskNarratorId: subagentId,
				toolUseId,
				subagentType,
			});
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_started",
				narratorId: parentNarratorId,
				taskNarratorId: subagentId,
				toolUseId,
				subagentType,
			});

			// Create an independent AbortController for the background task
			// (parent's signal should not cancel background tasks)
			bgAbort = new AbortController();

			// Store the abort controller for later cancellation
			getBackgroundAbortControllers().set(subagentId, bgAbort);
			backgroundTaskService.registerAbortController(subagentId, bgAbort);

			await backgroundTaskService.createAgentTask({
				id: subagentId,
				parentNarratorId,
				subagentNarratorId: subagentId,
				subagentType,
				toolUseId,
				alias: aliasRegistration.alias,
				title,
			});
		} catch (error) {
			updateLease.release();
			throw error;
		}

		// Resolve the child's trusted root before handing off the startup lease.
		await withNarratorWorkAdmission(subagentId, async () => {
			void executeBackgroundTask({
				narratorId: subagentId,
				parentNarratorId,
				toolUseId,
				subagentType,
				prompt,
				cwd,
				model,
				provider,
				locale,
				signal: bgAbort.signal,
				timeoutMs,
				userId: userId ?? null,
				systemPrompt,
				initialHistory: [],
				customDef,
				rebuildSystemPrompt,
				updateLease,
			}).catch((err) => {
				logger.error("Background task unexpected error", {
					subagentId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		});

		let output =
			buildBackgroundAgentStartOutput(aliasRegistration.alias) +
			formatSubagentModelFallbackNote(inheritance);
		if (aliasRegistration.conflicted) {
			output +=
				`\n\nNote: The requested alias "${alias || title}" was already taken. ` +
				`This agent was assigned "${aliasRegistration.alias}" instead.`;
		}
		return output;
	}

	// --- Foreground mode ---

	let output = await runForegroundLoop({
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
		timeoutMs,
		userId: userId ?? null,
		systemPrompt,
		initialHistory: [],
		customDef,
		rebuildSystemPrompt,
		updateLease,
	});
	output += formatSubagentModelFallbackNote(inheritance);
	if (aliasRegistration.conflicted) {
		const requestedAliasLabel = alias || title || subagentId;
		output +=
			`\n\nNote: The requested alias "${requestedAliasLabel}" was already taken. ` +
			`This agent was assigned "${aliasRegistration.alias}" instead. ` +
			`Use this alias with Await or Send to reference this agent.`;
	}
	return output;
}

// === Continue subagent ===

export interface ContinueSubagentInput {
	mailboxInput?: boolean;
	/** The resume adapter owns the final exact-origin publication chain. */
	deferPublicationRelease?: boolean;
	/** Planned-update recovery alone reuses the persisted logical run. */
	resumeLogicalRunId?: string;
	delivery?: import("./agent-message-delivery").AgentMessageDelivery;
	fileReferences?: FileReferenceSnapshot[];
	subagentId: string;
	parentNarratorId: string;
	/** Stable tool call that originally created this subagent. */
	toolUseId: string;
	prompt?: string;
	images?: ImageRef[];
	textFiles?: File[];
	commandText?: string | null;
	createdBy?: string | null;
	userId?: string | null;
	canReportToParent?: boolean;
	signal: AbortSignal;
	locale: string;
	/** Skip user-message persistence for retry/tool-result continuation. */
	persistPrompt?: boolean;
	/** Prebuilt history for retry/tool-result continuation. */
	initialHistory?: unknown[];
	initialTrailingToolResults?: unknown[];
	/** Effective model used to build the prepared history; never reuse it after a switch. */
	initialHistoryModel?: string;
	allowRunningRestart?: boolean;
	skipStaleAttach?: boolean;
	preserveBackground?: boolean;
	/**
	 * The caller will NOT rewrite the historical Agent tool result for this run.
	 *
	 * Forwarded from `resumeSubagent` purely so the resumed-task notice can tell
	 * whether the parent model has any other way to learn the new result: a
	 * rewritten tool result is re-read on the parent's next turn (history is rebuilt
	 * from rows), so announcing on top of it would be a double delivery. See
	 * `planResumedBackgroundTaskNotice`.
	 */
	skipConclusionDelivery?: boolean;
	resumableUpdateLease?: boolean;
	/** Remaining execution timeout passed by planned-update recovery. */
	timeoutMs?: number;
	/** Absolute execution deadline preserved by planned-update recovery. */
	executionDeadlineAt?: string | null;
	/** Original timeout used for timeout result formatting after recovery. */
	executionTimeoutMs?: number | null;
	/** Existing tool/coordinator lease; tool leases are transferred into the runner lifecycle. */
	updateExecutionLease?: SubagentUpdateExecutionLease;
	/** Persistent controller used to cancel a recovered background Agent. */
	abortController?: AbortController;
}

export interface StartedSubagentContinuation {
	/** Idempotent release after the caller's exact-origin publication has settled. */
	releasePublication?: () => void;
	runId: string;
	/** Legacy foreground boundary: may settle with a detach handoff. */
	completion: Promise<string>;
	/** True terminal boundary: never settles for a detach handoff. */
	terminalCompletion: Promise<string>;
	userMessage?: Awaited<ReturnType<typeof narratorService.persistSubagentUserMessage>>;
	/**
	 * Claim the "this resumed background task ended" notice, if one is owed.
	 *
	 * Returns undefined until `terminalCompletion` settles, and only once — the caller
	 * passes it to `announceResumedBackgroundTask` AFTER persisting the conclusion,
	 * because the notice wakes the parent and a turn started before the rewrite lands
	 * would read the superseded tool result.
	 *
	 * Optional so a caller (or a test double) that predates it degrades to the old
	 * behaviour — no notice — instead of throwing inside a terminal-completion chain,
	 * where the rejection surfaces as "the resumed run failed" long after the run
	 * actually succeeded.
	 */
	takeResumedBackgroundAnnouncement?: () => ResumedBackgroundTaskAnnouncement | undefined;
}

/**
 * Continue a previously completed/errored subagent in-place.
 *
 * Instead of forking, we directly continue the original subagent narrator:
 * persist a new user message (with the caller toolUseId as parentToolUseId),
 * reload the full history, and run the agent loop.
 * The subagent keeps its single narrator record and accumulates a
 * continuous conversation visible on the subagent page.
 */
export async function startContinuedSubagent(
	input: ContinueSubagentInput,
): Promise<StartedSubagentContinuation> {
	return withNarratorStartAdmission(input.subagentId, () =>
		withNarratorWorkAdmission(
			input.subagentId,
			() => startContinuedSubagentUnlocked(input),
			(result) => result.terminalCompletion,
		),
	);
}

async function startContinuedSubagentUnlocked(
	input: ContinueSubagentInput,
): Promise<StartedSubagentContinuation> {
	const { subagentId, parentNarratorId, toolUseId, prompt, signal, locale } = input;
	const acceptedReferences = freezeFileReferenceSnapshots(input.fileReferences);
	const backgroundAbortController = input.preserveBackground
		? (input.abortController ?? new AbortController())
		: undefined;
	const runSignal = combineSubagentAbortSignals(backgroundAbortController?.signal, signal);

	// 1. Validate original subagent
	const original = await narratorService.getById(subagentId);
	if (!isSubagentVariant(original.variant)) {
		throw new ValidationError("Target narrator is not a subagent");
	}
	if (original.parentNarratorId !== parentNarratorId) {
		throw new ValidationError("Subagent does not belong to the calling narrator");
	}

	// Neither early exit below starts a continuation, so neither owes a resumed-task
	// notice: the attach path joins a run that still owns its own completion, and the
	// status-only path merely replays a result the parent already has.
	const noAnnouncement = () => undefined;

	// --- Attach path for a RUNNING background task (legacy pull-to-foreground path) ---
	if (original.isBackground && original.backgroundStatus === "running" && !input.skipStaleAttach) {
		const completion = attachSubagent(subagentId, parentNarratorId, toolUseId, signal);
		return {
			runId: generateId(),
			completion,
			terminalCompletion: completion,
			takeResumedBackgroundAnnouncement: noAnnouncement,
		};
	}

	// --- Return completed background task result directly when Await requests status only ---
	if (
		!prompt &&
		input.persistPrompt !== false &&
		original.isBackground &&
		(original.backgroundStatus === "completed" || original.backgroundStatus === "failed")
	) {
		const resultPrefix = agentResultTag(agentLabelFromNarrator(original, parentNarratorId));
		// Reuse the stored execution window, not replay time and not sibling history.
		// Legacy rows still lack an operation/attempt receipt even within this window.
		const completion = appendSubagentFileChanges(
			{
				parentNarratorId,
				childNarratorId: subagentId,
				scope: {
					sourceToolUseId: toolUseId,
					startedAt: original.turnStartedAt ?? null,
					completedAt: original.backgroundCompletedAt ?? null,
				},
			},
			resultPrefix + (original.backgroundResult ?? "(no output)"),
		);
		return {
			runId: generateId(),
			completion,
			terminalCompletion: completion,
			takeResumedBackgroundAnnouncement: noAnnouncement,
		};
	}

	// --- Standard continue path: idle subagent ---
	if (input.persistPrompt !== false && prompt === undefined) {
		throw new ValidationError("prompt is required to continue an idle subagent");
	}
	// Any idle subagent is "settled and ready to resume" — regardless of whether
	// its result was already read (the transient unread/error/interrupted tags are
	// not preconditions for continuing). archived/working/waiting and taken-over
	// subagents are handled upstream (agent-communication) before reaching here;
	// reject them defensively for any other direct caller. The stale substatus
	// tags are cleared by updateStatus("working") below.
	if (
		original.status !== "idle" &&
		!((original.status === "working" || original.status === "waiting") && input.allowRunningRestart)
	) {
		throw new ValidationError(`Cannot continue subagent in status "${original.status}"`);
	}

	// A previously terminal background row belongs to this logical subagent and
	// must be updated when the foreground continuation reaches its own terminal
	// boundary. Capture its version so a later background run cannot be clobbered.
	const priorTask = await backgroundTaskService.getById(subagentId).catch(() => null);
	const priorTaskVersion = getBackgroundTaskTerminalVersion(priorTask);

	const subagentType = getSubagentType(original.variant) ?? original.subagentType ?? "general";
	const {
		model,
		reasoningEffort: fixedPoolEffort,
		parentReasoningEffort,
		inheritance,
	} = await resolveSubagentModelForRun(original, input.userId);
	const provider = resolveProvider(model);
	const cwd = original.cwd ?? ".";

	// Load custom subagent definition once for non-builtin types
	const isBuiltinContinue =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltinContinue ? null : await customSubagentService.loadByName(subagentType);
	const rebuildSystemPrompt = (contextSummary?: string | null) =>
		buildSubagentSystemPrompt(
			subagentType,
			cwd,
			locale as Locale,
			contextSummary,
			customDef?.prompt,
			// Parent-agent Send continuations run asynchronously and may reply through
			// Send({ id: "parent" }); user/manual-override continuations keep the
			// original foreground semantics.
			input.canReportToParent ?? false,
			resolveRuntimePolicy({ variant: "subagent", subagentType, customDefinition: customDef }),
		);
	const systemPrompt = await rebuildSystemPrompt(original.contextSummary);

	const updateLease = claimSubagentUpdateExecutionLease(
		input.updateExecutionLease,
		input.resumableUpdateLease ? "resumable" : "ordinary",
		subagentId,
	);
	if (!updateLease) {
		throw new ValidationError(
			"Subagent execution deferred because a NarraFork update is scheduled.",
		);
	}

	let run: ReturnType<typeof startForegroundRun>;
	let publicationRun!: PublicationRun;
	let executionOwner: ExecutionOwner | undefined;
	let userMessage: StartedSubagentContinuation["userMessage"];
	let leaseTransferred = false;
	let continuationRegistered = false;
	let backgroundAbortRegistered = false;
	const unregisterBackgroundAbort = () => {
		if (!backgroundAbortController || !backgroundAbortRegistered) return;
		backgroundAbortRegistered = false;
		if (getBackgroundAbortControllers().get(subagentId) === backgroundAbortController) {
			getBackgroundAbortControllers().delete(subagentId);
		}
		backgroundTaskService.unregisterAbortController(subagentId, backgroundAbortController);
	};
	try {
		executionOwner = claimSubagentExecution(subagentId);
		publicationRun = await getRuntimePublicationService().startAgentRun({
			narratorId: subagentId,
			parentNarratorId,
			resumeRunId: input.resumeLogicalRunId,
			started: !!priorTaskVersion,
		});
		// 2. Mark subagent as working (in-place, no fork)
		if (original.isBackground && !input.preserveBackground) {
			const now = new Date().toISOString();
			const updatedTraits = parseTraits(original.traits).filter((trait) => trait !== "background");
			await db
				.update(narrators)
				.set({
					isBackground: false,
					backgroundStatus: null,
					backgroundResult: null,
					backgroundCompletedAt: null,
					traits: updatedTraits,
					updatedAt: now,
				})
				.where(eq(narrators.id, subagentId));
		}
		await narratorService.updateStatus(subagentId, "working");

		// 3. Persist the follow-up before broadcasting/starting so the narrator and
		// parent card always observe a consistent linked transcript.
		if (input.persistPrompt !== false) {
			const savedTextFiles: TextFileRef[] = [];
			for (const file of input.textFiles ?? []) {
				savedTextFiles.push(await saveTextFileToWorktree(cwd, file));
			}
			userMessage = await narratorService.persistSubagentUserMessage(
				subagentId,
				prompt ?? "",
				toolUseId,
				{
					images: input.images,
					textFiles: savedTextFiles,
					fileReferences: acceptedReferences,
					delivery: input.delivery,
					commandText: input.commandText,
					createdBy: input.createdBy,
				},
			);
		}

		// 4. Broadcast subagent_started (same subagentId)
		broadcastSubagentStarted(
			subagentId,
			parentNarratorId,
			toolUseId,
			subagentType,
			original.model === FOLLOW_PARENT_MODEL ? FOLLOW_PARENT_MODEL : model,
			subagentRunReasoningEffort(
				{ reasoningEffort: fixedPoolEffort, parentReasoningEffort },
				original.reasoningEffort,
				resolveDefaultReasoningEffort(provider, model),
			),
			inheritance,
		);

		const mailboxInput = input.mailboxInput
			? await consumeNextBufferedSubagentMessage({
					narratorId: subagentId,
					parentNarratorId,
					toolUseId,
					model,
					provider,
					cwd,
					locale,
				})
			: null;
		if (input.mailboxInput && !mailboxInput)
			throw new ValidationError("Mailbox head is not available for this wake");
		const currentInput =
			mailboxInput?.prompt ??
			projectFileReferenceText(
				userMessage?.contentText ?? prompt ?? "",
				input.persistPrompt !== false ? acceptedReferences : [],
			);
		// 5. Load full subagent history unless the resume service already prepared it.
		const rebuilt =
			mailboxInput ??
			(input.initialHistory &&
			input.initialTrailingToolResults &&
			(input.initialHistoryModel === undefined
				? original.model !== FOLLOW_PARENT_MODEL
				: input.initialHistoryModel === model)
				? {
						history: input.initialHistory,
						trailingToolResults: input.initialTrailingToolResults,
					}
				: await loadSubagentHistory(subagentId, model, provider, currentInput));

		// 6. Run via the structured foreground handle (same subagentId).
		if (priorTaskVersion) {
			backgroundTaskService.beginAgentContinuation(subagentId);
			continuationRegistered = true;
			// The row itself stays at its terminal status on purpose (the version guard
			// below depends on it), so nothing else pushes a list delta here. Without
			// this frame the task panel renders the STORED status for the whole
			// continuation — a taken-over task keeps reading "cancelled" while the user
			// is watching it run.
			backgroundTaskService.notifyDerivedStatusChanged(parentNarratorId, subagentId);
			// The parent agent is a separate audience from the panel: it holds a finished
			// `<background_task_id>` tool result and has no way to learn that the task is
			// running again. Told without waking it — "someone took this over" is not
			// actionable, so spending a turn on it would be noise.
			await notifyParentOfResumedBackgroundTask({
				subagentId,
				parentNarratorId,
				subagent: original,
				locale: locale as Locale,
			});
		}
		if (backgroundAbortController) {
			getBackgroundAbortControllers().set(subagentId, backgroundAbortController);
			backgroundTaskService.registerAbortController(subagentId, backgroundAbortController);
			backgroundAbortRegistered = true;
		}
		run = startForegroundRun(
			{
				publicationRun,
				deferCompletionPublication: input.skipConclusionDelivery !== true,
				prePromptBashCommand: mailboxInput?.prePromptBashCommand,
				subagentId,
				parentNarratorId,
				toolUseId,
				subagentType,
				prompt: currentInput,
				cwd,
				model,
				provider,
				locale,
				signal: runSignal,
				timeoutMs: input.timeoutMs,
				executionDeadlineAt: input.executionDeadlineAt,
				executionTimeoutMs: input.executionTimeoutMs,
				userId:
					mailboxInput && !mailboxInput.preservePrincipal
						? (mailboxInput.userId ?? null)
						: input.userId !== undefined
							? input.userId
							: (input.createdBy ?? null),
				systemPrompt,
				initialHistory: rebuilt.history,
				initialTrailingToolResults: rebuilt.trailingToolResults,
				customDef,
				rebuildSystemPrompt,
				updateLease,
			},
			executionOwner,
		);
		leaseTransferred = true;
	} catch (err) {
		unregisterBackgroundAbort();
		if (continuationRegistered) backgroundTaskService.endAgentContinuation(subagentId);
		try {
			// Until startForegroundRun returns, this scope owns the reservations.
			// Release only unused slots: persisted publication events must survive.
			if (!leaseTransferred && publicationRun)
				try {
					await getRuntimePublicationService().releaseUnusedRunSlots(publicationRun);
				} catch (error) {
					logger.warn("Failed to release unused resumed publication slots", {
						subagentId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
		} finally {
			executionOwner?.release();
		}
		throw err;
	} finally {
		if (!leaseTransferred) updateLease.release();
	}
	/**
	 * Set when this continuation ended and the parent still has to be told.
	 *
	 * Read by the caller through `takeResumedBackgroundAnnouncement` once it has
	 * persisted the conclusion; see that function for why the ordering matters.
	 */
	let pendingAnnouncement: ResumedBackgroundTaskAnnouncement | undefined;
	let allowInboxWake = false;
	const terminalCompletion = run.terminal
		.then(async (terminal) => {
			allowInboxWake = terminal.allowInboxWake;
			if (!executionOwner?.isCurrent()) return terminal.output;
			if (input.preserveBackground) {
				await finalizeBackgroundCompletion(
					subagentId,
					parentNarratorId,
					toolUseId,
					terminal.timedOut ? "timeout" : terminal.hasError ? "failed" : "completed",
					terminal.finalText,
					locale as Locale,
					input.executionTimeoutMs ?? undefined,
					backgroundAbortController,
					input.skipConclusionDelivery !== true,
					terminal.finalUserId ?? input.userId ?? null,
				);
			}
			// Notification ownership is independent of the optional task projection:
			// foreground children never had one, and old background rows may be reaped.
			const plan = planResumedBackgroundTaskNotice({
				preserveBackground: input.preserveBackground,
				skipConclusionDelivery: input.skipConclusionDelivery,
				deferCompletionPublication:
					input.preserveBackground && input.skipConclusionDelivery !== true,
				timedOut: terminal.timedOut,
				interrupted: terminal.interrupted,
				hasError: terminal.hasError,
			});
			if (priorTaskVersion) {
				// The ROW is reconciled regardless of who notifies: it is what `Await` and
				// the task panel read, so leaving it terminal-but-stale would outlive the run.
				await backgroundTaskService
					.finalizeResumedAgentTask({
						taskId: subagentId,
						version: priorTaskVersion,
						status: plan.status,
						output: terminal.finalText || "(no output)",
					})
					.catch((err) => {
						logger.warn("Failed to reconcile resumed background task", {
							subagentId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}
			// Handed to the caller instead of fired here: only wake AFTER it has
			// persisted the conclusion, even when there was no background task row.
			if (plan.deliver) {
				pendingAnnouncement = {
					logicalRunId: publicationRun.logicalRunId,
					subagentId,
					parentNarratorId,
					status: plan.status,
					wakeParent: plan.wakeParent,
					locale: locale as Locale,
					userId: terminal.finalUserId ?? input.userId ?? null,
					// B2 fix: carry narrator fields to avoid PG direct SQLite read.
					subagentTraits: original.traits,
					subagentTitle: original.title,
				};
			}
			return terminal.output;
		})
		.finally(async () => {
			try {
				if (input.skipConclusionDelivery && !input.preserveBackground)
					try {
						await getRuntimePublicationService().releaseUnusedRunSlots(publicationRun);
					} catch (error) {
						logger.warn("Failed to release unused continuation publication slots", {
							subagentId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				unregisterBackgroundAbort();
				if (!input.deferPublicationRelease && priorTaskVersion && executionOwner?.isCurrent())
					backgroundTaskService.endAgentContinuation(subagentId);
			} finally {
				if (!input.deferPublicationRelease && executionOwner)
					releaseSubagentPublicationOwner(executionOwner, allowInboxWake);
			}
		});
	return {
		releasePublication: () => {
			if (executionOwner?.isCurrent()) {
				if (priorTaskVersion) backgroundTaskService.endAgentContinuation(subagentId);
				releaseSubagentPublicationOwner(executionOwner, allowInboxWake);
			}
		},
		runId: run.runId,
		completion: run.foreground.then((publication) =>
			publication.kind === "terminal" ? terminalCompletion : publication.output,
		),
		terminalCompletion,
		userMessage,
		takeResumedBackgroundAnnouncement: () => {
			const announcement = pendingAnnouncement;
			// Consumed once: a second call must not re-wake the parent for the same run.
			pendingAnnouncement = undefined;
			return announcement;
		},
	};
}
