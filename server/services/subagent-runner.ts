import type { FileReferenceSnapshot } from "@shared/file-reference";
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
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
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
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { type ImageRef, saveTextFileToWorktree, type TextFileRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService, getBackgroundTaskTerminalVersion } from "./background-task-service";
import { pushBgCompletionNotification } from "./bg-completion-queue";
import { customSubagentService } from "./custom-subagent-service";
import { narratorService } from "./narrator-service";
import {
	getSubagentResultMessageId,
	startBackgroundCompletionContinuationIfPossible,
} from "./narrator-session";
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
import { resumeManualOverride, waitForManualOverride } from "./subagent-manual-override";
import {
	beginSubagentInterruptSuspension,
	clearTakenOver,
	consumePendingBackgroundFinalize,
	consumePendingStopTakeover,
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

const BACKGROUND_AGENT_STARTED_MESSAGE =
	'Background task started. Use Await({ type: "agent", id }) with this ID to get results, or Send({ id, message }) to continue.';

/** Stable Agent tool result emitted once a background runner is mounted. */
export function buildBackgroundAgentStartOutput(taskIdOrAlias: string): string {
	return `<background_task_id>${taskIdOrAlias}</background_task_id>\n\n${BACKGROUND_AGENT_STARTED_MESSAGE}`;
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
}

interface RunningSubagentExecutionEntry extends RunningSubagentExecutionSnapshot {
	token: string;
}

const runningSubagentExecutions = hotSafe<Map<string, RunningSubagentExecutionEntry>>(
	"narrafork:runningSubagentExecutions",
	() => new Map(),
);

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
): Promise<void> {
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
					)
				: outcome === "failed"
					? await backgroundTaskService.markFailed(
							narratorId,
							storedText,
							undefined,
							expectedAbortController,
						)
					: await backgroundTaskService.markCompleted(
							narratorId,
							storedText,
							undefined,
							expectedAbortController,
						);
		if (!transitioned) return;
	}

	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			backgroundStatus: outcome === "completed" ? "completed" : "failed",
			backgroundResult: storedText,
			backgroundCompletedAt: now,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

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
		});
	}

	startBackgroundCompletionContinuationIfPossible(parentNarratorId, locale).catch((err) => {
		logger.warn("Failed to start parent narrator for background task completion", {
			parentNarratorId,
			taskNarratorId: narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
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
	subagentId: string;
	parentNarratorId: string;
	status: ResumedBackgroundTaskNoticePlan["status"];
	wakeParent: boolean;
	locale: Locale;
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
		deliver: input.preserveBackground !== true && input.skipConclusionDelivery !== true,
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
	try {
		const alias = agentLabelFromNarrator(subagent, parentNarratorId);
		const title = subagent.title?.trim() || alias;
		const isZh = locale === "zh-CN";
		const content = isZh
			? `[系统] 后台代理"${title}"（ID: ${alias}）已被重新启动，正在再次运行。` +
				`它先前的结果已经作废；请用 Await({ type: "agent", id: "${alias}" }) 获取新的结果。`
			: `[System] Background agent "${title}" (ID: ${alias}) has been restarted and is running again. ` +
				`Its earlier result is superseded; use Await({ type: "agent", id: "${alias}" }) for the new one.`;
		const { deliverInjection } = await import("./narrator-injection");
		await deliverInjection(parentNarratorId, {
			content,
			// Same producer tag as the completion notice: to a reader this row belongs to
			// the same background-agent stream, and reusing the tag means no new copy and
			// no new card path.
			source: "bg_agent",
			body: { kind: "prose", text: content },
			schedule: "none",
			locale,
		});
	} catch (err) {
		logger.warn("Failed to notify parent about a resumed background task", {
			parentNarratorId,
			subagentId,
			error: err instanceof Error ? err.message : String(err),
		});
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
	const { subagentId, parentNarratorId, status, wakeParent, locale } = notice;
	try {
		const subNarrator = await narratorService.getById(subagentId).catch(() => null);
		const alias = subNarrator
			? agentLabelFromNarrator(subNarrator, parentNarratorId)
			: await resolveAgentLabel(parentNarratorId, subagentId);
		const title = subNarrator?.title?.trim() || alias;
		// Same vocabulary the background path uses, so the model reads one wording for
		// "this background agent ended this way" regardless of who drove the run.
		const statusWord = status === "timeout" ? "timed out" : status;
		const content =
			locale === "zh-CN"
				? `[系统] 子代理"${title}"（ID: ${alias}）的重新运行已结束（${statusWord}）。` +
					`它的结果已写回原来的 Agent 工具调用结果中；如需完整内容可用 ` +
					`Await({ type: "agent", id: "${alias}" }) 查看。`
				: `[System] Subagent "${title}" (ID: ${alias}) finished its restarted run (${statusWord}). ` +
					`Its result has been written back into the original Agent tool result; use ` +
					`Await({ type: "agent", id: "${alias}" }) for the stored output.`;
		const { deliverInjection } = await import("./narrator-injection");
		await deliverInjection(parentNarratorId, {
			// Same producer tag as the restart notice and the ordinary completion path, so
			// this row reads as part of one background-agent stream.
			source: "bg_agent",
			content,
			body: { kind: "prose", text: content },
			schedule: wakeParent ? "wakeIfIdle" : "none",
			locale,
		});
	} catch (err) {
		logger.warn("Failed to deliver a resumed background task result to the parent", {
			parentNarratorId,
			subagentId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Finalize a subagent that was taken over while it had been a background task.
 * Restores background completion semantics so the parent (which holds the
 * background_task_id) can retrieve the result via Await / completion sidecar.
 * Pushes the completion notification directly (the background task row was
 * silently ended during takeover, so the normal task-row transition is skipped).
 */
export async function finalizeTakenOverBackgroundSubagent(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	finalText: string,
	locale: Locale = "en",
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			isBackground: true,
			backgroundStatus: hasError ? "failed" : "completed",
			backgroundResult: finalText || "(no output)",
			backgroundCompletedAt: now,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

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

	startBackgroundCompletionContinuationIfPossible(parentNarratorId, locale).catch((err) => {
		logger.warn("Failed to start parent narrator for taken-over background completion", {
			parentNarratorId,
			taskNarratorId: narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
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
	});
	backgroundTaskService.notifyDerivedStatusChanged(parentNarratorId, subagentId);
}

/**
 * Execute a background task (fire-and-forget).
 * Updates narrator status and broadcasts events on completion/failure.
 */
export async function executeBackgroundTask(opts: SubagentExecOptions): Promise<void> {
	const { narratorId, parentNarratorId, toolUseId, locale, updateLease } = opts;
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
	});
	let timedOut = false;
	const onTimeout = () => {
		timedOut = true;
		backgroundAbortController?.abort("Background task timeout");
	};
	executionTimeout?.signal.addEventListener("abort", onTimeout, { once: true });
	if (executionTimeout?.signal.aborted) onTimeout();

	try {
		const result = await executeSubagent({
			...opts,
			fileChangeStartedAt: new Date(executionStartedAt).toISOString(),
		});

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

		if (await isBackgroundTaskCancelled(narratorId)) return;

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
			{ timedOut },
		);

		await finalizeBackgroundCompletion(
			narratorId,
			parentNarratorId,
			toolUseId,
			outcome,
			finalText,
			locale as Locale,
			timeoutLabelMs ?? undefined,
			backgroundAbortController,
		);
	} catch (err) {
		if (await isBackgroundTaskCancelled(narratorId)) return;

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

		await finalizeSubagent(narratorId, parentNarratorId, toolUseId, true, errorText, { timedOut });
		await finalizeBackgroundCompletion(
			narratorId,
			parentNarratorId,
			toolUseId,
			timedOut ? "timeout" : "failed",
			errorText,
			locale as Locale,
			timeoutLabelMs ?? undefined,
			backgroundAbortController,
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
		if (attachWaiter) {
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
	output: string;
	finalText: string;
	hasError: boolean;
	interrupted: boolean;
	timedOut: boolean;
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
export function startForegroundRun(input: ForegroundLoopInput): ForegroundRunHandle {
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
	let currentPrompt = input.prompt;
	let currentHistory: unknown[] = input.initialHistory;
	let currentTrailingToolResults: unknown[] | undefined = input.initialTrailingToolResults;
	let currentUserId = input.userId ?? null;
	let currentModel = model;
	let currentProvider = provider;
	let currentSystemPrompt = systemPrompt;
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
	const controlSignal = executionTimeout
		? AbortSignal.any([signal, executionTimeout.signal])
		: signal;

	const runId = generateId();
	const { promise: foregroundPromise, resolve: resolveForeground } =
		Promise.withResolvers<ForegroundRunPublication>();
	const { promise: terminalPromise, resolve: resolveTerminal } =
		Promise.withResolvers<ForegroundRunTerminal>();
	let foregroundPublished = false;
	let terminalPublished = false;
	const publishHandoff = (output: string): boolean => {
		if (foregroundPublished) return false;
		foregroundPublished = true;
		resolveForeground({ kind: "handoff", runId, output });
		return true;
	};
	const publishTerminal = (terminal: Omit<ForegroundRunTerminal, "runId">): boolean => {
		if (terminalPublished) return false;
		terminalPublished = true;
		const publication: ForegroundRunTerminal = { runId, ...terminal };
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

	/**
	 * Hand a still-queued user message to the suspension we just registered.
	 *
	 * A taken-over subagent is driven by the user, so its queued messages are
	 * pushed WITHOUT a soft-stop request — interrupting the user's own turn would
	 * be wrong. That leaves nobody to drain the queue: the loop reaches the
	 * takeover suspension and blocks in waitForManualOverride, which only wakes on
	 * an HTTP action and never inspects the buffer. A message sent during the turn
	 * would be stranded forever: never persisted, never displayed, never answered.
	 *
	 * The drain must run AFTER the manual-override entry is registered, not before.
	 * Draining first leaves a window where a concurrent send sees a non-blocked
	 * subagent and starts a second, competing run. Resolving the registered entry
	 * instead reuses the ordinary resume path, so the queued message becomes the
	 * next turn through exactly the same plumbing as an interactive send.
	 */
	const feedQueuedMessageIntoSuspension = async (): Promise<void> => {
		const queued = await consumeNextBufferedSubagentMessage({
			narratorId: subagentId,
			parentNarratorId,
			toolUseId,
			model: currentModel,
			provider: currentProvider,
			cwd,
		});
		if (!queued) return;
		// A user action may have settled the suspension while the drain was in
		// flight; resumeManualOverride then returns false and the message stays in
		// the persisted history, to be picked up by the resumed turn's context.
		resumeManualOverride(subagentId, {
			prompt: queued.prompt,
			history: queued.history,
			trailingToolResults: queued.trailingToolResults,
			userId: queued.userId ?? null,
		});
	};

	const suspendForUserControl = async (substatus: string[]) => {
		await narratorService.updateStatus(subagentId, "idle", { substatus });
		broadcastToNarrator(parentNarratorId, {
			type: "subagent_suspended",
			narratorId: parentNarratorId,
			subagentNarratorId: subagentId,
			toolUseId,
		});
		broadcastToNarrator(subagentId, {
			type: "status_change",
			narratorId: subagentId,
			status: "idle",
			substatus,
		});
		// waitForManualOverride registers its entry synchronously, so the drain
		// below can never observe an unregistered suspension.
		const control = waitForManualOverride(subagentId, controlSignal, parentNarratorId, toolUseId);
		await feedQueuedMessageIntoSuspension().catch((err) => {
			logger.warn("Failed to consume queued subagent message on suspend", {
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
		return control;
	};

	const applyControlResult = async (
		result: Awaited<ReturnType<typeof waitForManualOverride>>,
	): Promise<"resume" | "finish"> => {
		if (result.action === "resume") {
			currentPrompt = result.prompt;
			currentHistory = result.history;
			currentTrailingToolResults = result.trailingToolResults;
			currentUserId = result.userId ?? null;
			const fresh = await narratorService.getById(subagentId);
			currentModel = resolveEffectiveModel(fresh.model);
			currentProvider = resolveProvider(currentModel);
			if (rebuildSystemPrompt) {
				currentSystemPrompt = await rebuildSystemPrompt(fresh.contextSummary);
			}
			finalText = "";
			hasError = false;
			await narratorService.updateStatus(subagentId, "working");
			broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, currentModel);
			return "resume";
		}
		finalText = result.finalText;
		hasError = result.hasError;
		if (result.interrupted) {
			wasInterrupted = true;
			hasError = false;
		}
		return "finish";
	};

	const runLoop = async () => {
		const proxy = new ProxyAbortController();

		try {
			// Register detach entry so the API can detach this subagent
			getDetachableMap().set(subagentId, {
				runId,
				markDetached: (setup) => {
					detached = true;
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

			while (true) {
				const fgAbort = new AbortController();
				currentForegroundAbortController = fgAbort;
				getForegroundAbortControllers().set(subagentId, fgAbort);

				// Update detach entry's fgAbort reference
				const detachEntry = getDetachableMap().get(subagentId);
				if (detachEntry) detachEntry.fgAbort = fgAbort;

				// Keep the execution deadline separate from the swappable parent source so
				// detach can replace parent cancellation without losing the deadline.
				proxy.dispose();
				proxy.listenTo(signal, fgAbort.signal);
				if (executionTimeout) proxy.listenTo(executionTimeout.signal);

				const result = await executeSubagent({
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
					fileChangeStartedAt: new Date(executionStartedAt).toISOString(),
					timeoutMs: remainingTimeoutMs,
					userId: currentUserId,
					systemPrompt: currentSystemPrompt,
					initialHistory: currentHistory,
					initialTrailingToolResults: currentTrailingToolResults,
					customDef,
					rebuildSystemPrompt,
					updateLease,
				});
				finalText = result.contextLengthExceeded
					? "Error: context length exceeded"
					: result.finalText;
				hasError = result.hasError || !!result.contextLengthExceeded;
				if (executionTimeout?.didTimeout() && !signal.aborted) {
					markTimedOut();
				} else if (result.aborted && signal.aborted) {
					wasInterrupted = true;
					finalText = "Subagent interrupted because parent narrator was interrupted";
					hasError = false;
				}
				if (getForegroundAbortControllers().get(subagentId) === fgAbort) {
					getForegroundAbortControllers().delete(subagentId);
				}

				if (timedOut) break;

				const hardSubagentInterrupt = consumeForegroundSubagentHardInterrupt(subagentId);

				// Check if we were detached during execution
				if (detached) {
					// Loop continues running in background mode.
					// The foreground handoff was already published by detachSubagent().
					// Continue to finally block for background completion.
					break;
				}

				if (hardSubagentInterrupt && fgAbort.signal.aborted && !signal.aborted) {
					wasInterrupted = true;
					finalText = "Subagent interrupted by user";
					hasError = false;
					break;
				}

				const continueAfterInterrupt =
					!hasError &&
					fgAbort.signal.aborted &&
					!signal.aborted &&
					(await consumeNextBufferedSubagentMessage({
						narratorId: subagentId,
						parentNarratorId,
						toolUseId,
						model: currentModel,
						provider: currentProvider,
						cwd,
					}));
				if (continueAfterInterrupt) {
					currentPrompt = continueAfterInterrupt.prompt;
					currentHistory = continueAfterInterrupt.history;
					currentTrailingToolResults = continueAfterInterrupt.trailingToolResults;
					currentUserId = continueAfterInterrupt.userId ?? null;
					finalText = "";
					continue;
				}
				// Detect subagent-only interrupt (not parent abort)
				if (!hasError && fgAbort.signal.aborted && !signal.aborted) {
					// --- Suspend: block until the user resolves (Update Conclusion)
					// or, for an explicit takeover, until the user stops takeover. ---
					// An interrupt arriving inside a takeover is the user stopping a turn
					// they are driving themselves, so it must suspend as `taken_over`; a
					// plain `manual_override` here would make the takeover UI vanish while
					// the hold is still in force, leaving the parent blocked with no
					// visible way to release it.
					const { heldByTakeover } = beginSubagentInterruptSuspension(subagentId);

					// The user may have clicked "Stop takeover" while this turn was still
					// running; the route records a pending marker rather than failing.
					// Consume it here: skip the manual-override wait entirely and let the
					// finalizer hand this turn's result straight back to the blocked
					// parent. clearTakenOver must run before finalizeSubagent so
					// preserveTakenOverSubstatus does not re-inject the taken_over tag.
					if (
						heldByTakeover &&
						(consumePendingStopTakeover(subagentId) || consumePendingBackgroundFinalize(subagentId))
					) {
						clearTakenOver(subagentId);
						break;
					}

					const control = await suspendForUserControl(
						heldByTakeover ? ["taken_over"] : ["manual_override"],
					);
					if ((await applyControlResult(control)) === "resume") continue;
					if (executionTimeout?.didTimeout() && !signal.aborted) {
						markTimedOut();
						break;
					}
					if (signal.aborted) {
						wasInterrupted = true;
						finalText = "Subagent interrupted because parent narrator was interrupted";
						hasError = false;
					}
				} else if (isTakenOver(subagentId) && !hasError && !signal.aborted) {
					// A turn that ENDED NORMALLY while the subagent is taken over. This is
					// the ordinary entry into the hold — taking over does not stop the turn,
					// so the very first hold of a takeover arrives here, as does every later
					// turn the user drives to completion themselves. Keep this foreground
					// runner alive and wait for the next user command instead of handing the
					// result to the parent or switching to the generic session engine.
					// A background takeover can resume inside this foreground driver.
					// Accept a release recorded during that engine's settling window too.
					if (
						consumePendingStopTakeover(subagentId) ||
						consumePendingBackgroundFinalize(subagentId)
					) {
						clearTakenOver(subagentId);
						break;
					}
					const control = await suspendForUserControl(["taken_over"]);
					if ((await applyControlResult(control)) === "resume") continue;
					if (executionTimeout?.didTimeout() && !signal.aborted) {
						markTimedOut();
					}
					clearTakenOver(subagentId);
				} else if (isTakenOver(subagentId)) {
					// Taken over, but this turn ended in an error or a parent abort: there is
					// nothing left to hold, so release the takeover rather than parking the
					// subagent in a state the user cannot act on.
					clearTakenOver(subagentId);
				}
				break;
			}
		} catch (err) {
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
			const registeredDetach = getDetachableMap().get(subagentId);
			if (registeredDetach?.runId === runId) getDetachableMap().delete(subagentId);
			proxy.dispose();
			if (
				currentForegroundAbortController &&
				getForegroundAbortControllers().get(subagentId) === currentForegroundAbortController
			) {
				getForegroundAbortControllers().delete(subagentId);
			}
			consumeForegroundSubagentHardInterrupt(subagentId);

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

			try {
				await finalizeSubagent(
					subagentId,
					parentNarratorId,
					toolUseId,
					hasError,
					hasError ? finalText : null,
					{ interrupted: wasInterrupted, timedOut },
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
						await finalizeBackgroundCompletion(
							subagentId,
							parentNarratorId,
							toolUseId,
							timedOut ? "timeout" : hasError ? "failed" : "completed",
							finalText,
							locale as Locale,
							timeoutLabelMs ?? undefined,
							detachedAbortController,
						);
					} catch {
						// Non-critical
					}

					// Notify attach waiter if any (background → foreground transition)
					const attachWaiter = getAttachWaitersMap().get(subagentId);
					if (attachWaiter) {
						attachWaiter.resolve({ finalText, hasError });
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

			updateLease?.release();
			executionTimeout?.dispose();
			unregisterRunningExecution();
			backgroundTaskService.notifyDerivedStatusChanged(parentNarratorId, subagentId);
			publishTerminal({
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
			});
		}
	};

	// Start the loop without awaiting: foreground may publish a detach handoff first,
	// while terminal remains pending until all finalization is complete.
	runLoop().catch(async (err) => {
		const finalText = `Subagent error: ${err instanceof Error ? err.message : String(err)}`;
		publishTerminal({
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
	const candidateModels = [
		subagentPref,
		parent.model ?? FOLLOW_DEFAULT_MODEL,
		settings.agent.defaultModel,
	];
	const modelSelection = resolveSubagentModelSelectionFromPolicy({
		policy: modelPolicy,
		explicitModel,
		candidates: candidateModels,
	});
	const resolvedModelInput = modelSelection?.model;
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
			model: resolvedModelInput,
			reasoningEffort: configuredReasoningEffort,
			inheritedTraits,
		});
	} catch (error) {
		updateLease.release();
		throw error;
	}

	const subagentId = subagent.id;
	updateLease.setNarratorId(subagentId);
	const model = resolveEffectiveModel(subagent.model);
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
		model,
		subagent.reasoningEffort ?? resolveDefaultReasoningEffort(provider, model),
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

			await backgroundTaskService
				.createAgentTask({
					id: subagentId,
					parentNarratorId,
					subagentNarratorId: subagentId,
					subagentType,
					toolUseId,
					alias: aliasRegistration.alias,
					title,
				})
				.catch((err) => {
					logger.warn("Failed to register background task in DB", {
						narratorId: subagentId,
						error: err instanceof Error ? err.message : String(err),
					});
				});
		} catch (error) {
			updateLease.release();
			throw error;
		}

		// Fire-and-forget execution
		executeBackgroundTask({
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

		let output = buildBackgroundAgentStartOutput(aliasRegistration.alias);
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
	const model = resolveEffectiveModel(original.model);
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
			model,
			original.reasoningEffort ?? resolveDefaultReasoningEffort(provider, model),
		);

		const currentInput = projectFileReferenceText(
			userMessage?.contentText ?? prompt ?? "",
			input.persistPrompt !== false ? acceptedReferences : [],
		);
		// 5. Load full subagent history unless the resume service already prepared it.
		const rebuilt =
			input.initialHistory && input.initialTrailingToolResults
				? {
						history: input.initialHistory,
						trailingToolResults: input.initialTrailingToolResults,
					}
				: await loadSubagentHistory(subagentId, model, provider, undefined, currentInput);

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
			void notifyParentOfResumedBackgroundTask({
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
		run = startForegroundRun({
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
			userId: input.userId ?? input.createdBy ?? null,
			systemPrompt,
			initialHistory: rebuilt.history,
			initialTrailingToolResults: rebuilt.trailingToolResults,
			customDef,
			rebuildSystemPrompt,
			updateLease,
		});
		leaseTransferred = true;
	} catch (err) {
		unregisterBackgroundAbort();
		if (continuationRegistered) backgroundTaskService.endAgentContinuation(subagentId);
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
	const terminalCompletion = run.terminal
		.then(async (terminal) => {
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
				);
			}
			// Notification ownership is independent of the optional task projection:
			// foreground children never had one, and old background rows may be reaped.
			const plan = planResumedBackgroundTaskNotice({
				preserveBackground: input.preserveBackground,
				skipConclusionDelivery: input.skipConclusionDelivery,
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
					subagentId,
					parentNarratorId,
					status: plan.status,
					wakeParent: plan.wakeParent,
					locale: locale as Locale,
				};
			}
			return terminal.output;
		})
		.finally(() => {
			unregisterBackgroundAbort();
			if (priorTaskVersion) backgroundTaskService.endAgentContinuation(subagentId);
		});
	return {
		runId: run.runId,
		completion: run.foreground.then((publication) => publication.output),
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
