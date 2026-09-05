import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters } from "../db/schema";
import {
	type AgentConfig,
	buildHistory,
	type RuntimeSettingsOverride,
	TODO_REMINDER_TOOL_INTERVAL,
} from "../lib/agent";
import {
	normalizeAutoContinuationMode,
	normalizeBooleanOverride,
	resolveAutoContinuationMode,
} from "../lib/boolean-override";
import { resolveInjectedDevices } from "../lib/device-injection-trait";
import { eventBus } from "../lib/event-bus";
import { resolveFastModeForUser, resolveSubagentActingUserId } from "../lib/fast-mode";
import { generateShortId } from "../lib/id";
import { InjectionCadence } from "../lib/injection-cadence";
import { logger } from "../lib/logger";
import { getBlockedSkills, getDisabledToolSet } from "../lib/narrator-custom-traits";
import { nugAvailabilityPoller } from "../lib/nug-availability-poller";
import { resolveKnownUnavailableNugModel } from "../lib/nug-model-availability";
import { markNugCachedModelUnavailable } from "../lib/nug-model-cache";
import { getToolMessage, type Locale } from "../lib/prompt-i18n";
import {
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	usesCodexModel,
} from "../lib/settings";
import { sideCarBodyWithText } from "../lib/sidecar-templates";
import { type ImageRef, saveTextFileToWorktree, type TextFileRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { CustomSubagentDef } from "./custom-subagent-service";
import { gitService } from "./git-service";
import { knowledgeService } from "./knowledge-service";
import type { EventHandlerContext, EventHooks } from "./narrator-event-handler";
import { type ExecuteLoopResult, executeAgentLoop } from "./narrator-executor";
import { deliverInjection } from "./narrator-injection";
import {
	getContextOverflowFailureError,
	getFirstTokenTimeoutMs,
	getMaxTransientRetries,
	getPipelineUnusedToolCallThreshold,
	getRetryBackoffCeilMs,
	getSilentToolCallThreshold,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
	resetContextOverflowRetriesAfterProgress,
} from "./narrator-recovery";
import { narratorService } from "./narrator-service";
import {
	buildContextManagementHooks,
	finalizeOrCleanupPartialMessage,
	handlePermission,
	pruneToolCalls,
	toBufferSummary,
} from "./narrator-session";
import {
	activeNarrators,
	activeSubagentSettings,
	registerActiveSubagent,
	unregisterActiveSubagent,
} from "./narrator-session-state";
import {
	abandonSessionTreeSnapshots,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";
import { buildSpecTaskDigestBody } from "./spec-reminder";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";
import {
	clearSubagentKnowledgeCycle,
	getSubagentKnowledgeCycle,
	scanSubagentTextForKnowledge,
	syncSubagentKnowledgeCycle,
} from "./subagent-knowledge-injection";
import { clearTeamInbox, drainTeamInbox } from "./subagent-team";
import { resolveToolFilter } from "./subagent-tools";
import { resolveEffectiveTraits } from "./trait-layer-service";
import { buildTreeSnapshotEventHooks } from "./tree-snapshot-loop-hooks";
import {
	buildSubagentContinuationPrompt,
	createSubagentContinuationState,
	interruptionContinuationLabel,
	planSubagentContinuation,
	planTurnInterruption,
	type SubagentContinuationCause,
	subagentContinuationStopNote,
	type TurnInterruptionPlan,
} from "./turn-continuation-decisions";
import type { UpdateExecutionLease } from "./update-coordinator";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SubagentBufferedMessage {
	id: string;
	text: string;
	images?: ImageRef[];
	textFiles?: File[];
	commandText?: string | null;
	createdBy?: string | null;
	prePromptBashCommand?: string;
	bufferedAt: string;
	priority?: boolean;
}

export interface SubagentExecOptions {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	model: string;
	provider: string;
	locale: string;
	signal: AbortSignal;
	/** Optional wall-clock execution timeout for a newly started run; 0/undefined means none. */
	timeoutMs?: number;
	/** Absolute execution deadline preserved across a planned-update restart. */
	executionDeadlineAt?: string | null;
	/** Original timeout used for user-facing timeout semantics after recovery. */
	executionTimeoutMs?: number | null;
	/** User that triggered this run, used for knowledge ACL checks. */
	userId?: string | null;
	systemPrompt: string;
	/** Initial history (empty for new subagents, pre-loaded for continued) */
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	/** Pre-loaded custom subagent definition (avoids redundant I/O) */
	customDef?: CustomSubagentDef | null;
	/** Rebuild system prompt callback — called after compact to regenerate with new contextSummary */
	rebuildSystemPrompt?: (contextSummary?: string | null) => Promise<string>;
	/** Lease held by the update coordinator until this execution reaches a terminal state. */
	updateLease?: UpdateExecutionLease;
}

// ---------------------------------------------------------------------------
// In-memory state: buffered messages
// ---------------------------------------------------------------------------

// Use `let` + lazy getter to avoid TDZ issues under Bun --hot reload,
// where a stale dynamic-import resolution can reference the module binding
// before the const initializer has executed.

let _subagentBufferedMessages: Map<string, SubagentBufferedMessage[]> | undefined;
export function getSubagentBufferedMessagesMap() {
	if (!_subagentBufferedMessages) _subagentBufferedMessages = new Map();
	return _subagentBufferedMessages;
}

let _subagentBufferedMessageSoftStops: Set<string> | undefined;
function getSubagentBufferedMessageSoftStops(): Set<string> {
	if (!_subagentBufferedMessageSoftStops) _subagentBufferedMessageSoftStops = new Set();
	return _subagentBufferedMessageSoftStops;
}

/** Stop the current subagent loop at the next safe post-tool boundary. */
export function requestSubagentBufferedMessageSoftStop(subagentId: string): void {
	getSubagentBufferedMessageSoftStops().add(subagentId);
}

/** Whether a queued user message should stop this loop at its next safe boundary. */
export function shouldStopSubagentForBufferedMessage(subagentId: string): boolean {
	return (
		getSubagentBufferedMessageSoftStops().has(subagentId) &&
		(getSubagentBufferedMessagesMap().get(subagentId)?.length ?? 0) > 0
	);
}

const MAX_BUFFERED_MESSAGES = 10;
export const MAX_SUBAGENT_INTERRUPTION_RETRIES = 3;

/**
 * Whether a buffered message can be folded into the CURRENT agent-loop pass at
 * the next after-tools boundary, instead of waiting for the pass to end.
 *
 * The in-pass path is the only one that makes agent-to-agent Send feel like
 * conversation: everything else waits for the subagent's whole loop to wind
 * down, which for a long task is arbitrarily far away. So the default answer
 * must be yes, and every "no" needs a concrete reason the current pass cannot
 * carry the message.
 *
 * The three reasons a message must wait for `consumeNextBufferedSubagentMessage`:
 *
 * - **Attachments** (`images` / `textFiles`). In-pass delivery contributes text
 *   only; the images path needs `persistSubagentUserMessage` with refs and a
 *   rebuilt history, and `textFiles` must be written into the worktree first.
 *   Injecting the text alone would silently drop what the sender attached.
 * - **A pre-prompt bash command.** It must run before the prompt is seen, which
 *   only the pass-restart path does.
 * - **A different acting user than the running pass.** `config.userId` is fixed
 *   when the pass starts and drives knowledge-base ACL, trait layering and fast
 *   mode. Honouring a message from another user inside this pass would evaluate
 *   it under the wrong identity, so it waits for a pass whose config is built
 *   for that user. Note this compares identities rather than merely asking
 *   whether `createdBy` is set: a Send from the parent narrator carries the same
 *   userId the subagent is already running as, so it needs no new config and has
 *   no reason to wait.
 */
export function canDeliverBufferedMessageInPass(
	message: Pick<
		SubagentBufferedMessage,
		"images" | "textFiles" | "createdBy" | "prePromptBashCommand"
	>,
	currentUserId: string | null | undefined,
): boolean {
	if (message.images?.length) return false;
	if (message.textFiles?.length) return false;
	if (message.prePromptBashCommand) return false;
	// An absent createdBy is "no particular user", which never conflicts with the
	// pass identity; only a concrete, different user forces a rebuild.
	if (message.createdBy && message.createdBy !== (currentUserId ?? null)) return false;
	return true;
}

/**
 * The `subagent_status_changed` frame to broadcast when a subagent's agent-loop
 * pass succeeds right after one or more transient-error retries.
 *
 * The retry warning the parent panel displayed (the client-only `_retryInfo` on
 * the subagent's narrator cache) is otherwise cleared only by
 * `subagent_status_changed` on completion or `subagent_conclusion_updated`, so
 * without this recovery frame a long-running subagent carries a stale
 * "retry N/M" badge for its whole remaining run. Returns null on an ordinary
 * successful pass (no retry preceded it) — no frame, no noise.
 */
export function subagentRetryRecoveredBroadcast(
	transientRetries: number,
	parentNarratorId: string,
	subagentNarratorId: string,
): {
	type: "subagent_status_changed";
	narratorId: string;
	subagentNarratorId: string;
	status: string;
} | null {
	if (transientRetries <= 0) return null;
	return {
		type: "subagent_status_changed",
		narratorId: parentNarratorId,
		subagentNarratorId,
		status: "working",
	};
}

/**
 * @deprecated Alias of the shared {@link TurnInterruptionPlan}. Kept so existing importers
 * keep compiling; new code should name the shared type directly.
 */
export type SubagentInterruptionPlan = TurnInterruptionPlan;

export type SubagentCompactRestartDecision =
	/** Rebuild history from the compact summary and drive another pass. */
	| { action: "restart" }
	/** The pass already finished its work; apply nothing further and end the run. */
	| { action: "finish"; reason: "completed_naturally" | "compact_consumed_in_loop" };

/**
 * Decide whether a completed subagent pass should be restarted after a compact.
 *
 * `needsRestart` only records that a compact finished *somewhere* during the
 * pass. It is set from `onCompactDone`, which runs at the end of a detached
 * fire-and-forget chain (`onContextUsage` → `triggerMidTurnCompact` →
 * `runCustomCompact` → `onCompactDone`) that races the loop it belongs to.
 * Treating it as "there is more work to do" is what produced spurious extra
 * turns when the compact landed after the subagent had already wrapped up.
 *
 * Kept pure so both orderings of that race are directly testable.
 */
export function planSubagentCompactRestart(input: {
	result: Pick<ExecuteLoopResult, "completedNaturally" | "contextLengthExceeded">;
	compactConsumedInLoop: boolean;
	compactDoneFlag: boolean;
}): SubagentCompactRestartDecision {
	const { result, compactConsumedInLoop, compactDoneFlag } = input;
	// A context overflow means the pass never delivered its work, so the compacted
	// history must be retried regardless of the other signals.
	if (result.contextLengthExceeded) return { action: "restart" };
	// The model stopped calling tools: the subagent is done and another request
	// could only produce a filler turn that overwrites finalText.
	if (result.completedNaturally) return { action: "finish", reason: "completed_naturally" };
	// onBeforeTurn already rebuilt history inside the loop, so needsRestart is stale.
	if (compactConsumedInLoop && !compactDoneFlag) {
		return { action: "finish", reason: "compact_consumed_in_loop" };
	}
	return { action: "restart" };
}

/**
 * What a subagent run does about an exhausted provider balance.
 *
 * Pure so the terminal-vs-retry decision is testable without standing up a loop.
 *
 * A primary narrator can park itself in a `payment_required` state and wait for the
 * user to top up. A subagent cannot: it owes its parent a `tool_result`, and a
 * parent blocked on a tool that never returns is a dead turn. So this is always
 * terminal, and it always carries a reason — the failure mode it replaces is a
 * refused request that produced no flags at all, fell through to the end-of-run
 * finalText backfill, and handed the parent a STALE previous answer as though the
 * work had completed.
 *
 * An abort wins: the run is already ending for a reason the caller owns, and the
 * recharge prompt would be noise on a session nobody is waiting for.
 */
export function planSubagentPaymentRequired(
	result: Pick<ExecuteLoopResult, "paymentRequired">,
	aborted: boolean,
): { action: "none" } | { action: "fail"; finalText: string; errorMessage: string } {
	if (!result.paymentRequired || aborted) return { action: "none" };
	return {
		action: "fail",
		finalText: `Error: ${result.paymentRequired.message}`,
		// The shape the subagent's own panel parses to show a recharge prompt rather
		// than a generic failure (see frontend error-localization).
		errorMessage: JSON.stringify({ type: "payment_required", ...result.paymentRequired }),
	};
}

/**
 * What a subagent run does about a quietly-closed upstream socket.
 *
 * A silent disconnect yields no answer AND no error, so the pass is
 * indistinguishable from an empty success unless it is handled: the previous
 * behaviour cleaned up the partial message and let the run end, which delivered
 * whatever text was lying around to the parent as the subagent's conclusion.
 *
 * `retries` is the shared transient counter, so the bound is the same one every
 * other transient failure obeys. Kept pure to pin the two properties that matter:
 * the counter ADVANCES on each disconnect (it must not be reset by the success
 * path, or the bounded retry becomes an unbounded reconnect loop), and exhaustion
 * ends the run with a stated error instead of a silent one.
 */
export function planSubagentSilentDisconnect(
	result: Pick<ExecuteLoopResult, "silentDisconnect">,
	previousRetries: number,
	maxRetries: number,
	aborted: boolean,
): { action: "none" } | { action: "retry"; retries: number } | { action: "fail"; retries: number } {
	if (!result.silentDisconnect || aborted) return { action: "none" };
	const retries = previousRetries + 1;
	// -1 means "no limit" for the transient path (Codex account failover), matching
	// handleTransientError's own contract.
	if (maxRetries !== -1 && retries > maxRetries) return { action: "fail", retries };
	return { action: "retry", retries };
}

/** The error text a subagent reports when silent-disconnect retries are exhausted. */
export const SUBAGENT_SILENT_DISCONNECT_ERROR = "Codex WebSocket silent disconnect";

/**
 * Decide how a subagent should continue after a provider-interrupted partial turn.
 *
 * Now a thin alias over the shared {@link planTurnInterruption}: the primary loop had this
 * same decision written inline, and two copies of one rule is exactly the drift this
 * refactor removes. Retained as a named export because it is the seam the subagent tests
 * address, and because the subagent's bound is its own constant.
 */
export function planSubagentInterruption(
	result: Pick<
		ExecuteLoopResult,
		"interrupted" | "interruptedReason" | "shouldReplayInterruptedToolResultTurn"
	>,
	previousRetries: number,
): SubagentInterruptionPlan {
	return planTurnInterruption(result, previousRetries, {
		maxRetries: MAX_SUBAGENT_INTERRUPTION_RETRIES,
	});
}

/**
 * Read the continuation-relevant state of a subagent's OWN Dynamic Spec.
 *
 * `narratorId` here must be the SUBAGENT's id, never its parent's. Spec files are
 * keyed by narrator (`spec_namespaces.narratorId`), so passing the parent would
 * silently continue a subagent for its parent's open tasks — which reads as a bug in
 * the model rather than in this call, since the reminder text would name a task the
 * subagent never had.
 *
 * Unlike the primary loop's `loadCompiledSpecForContinuation`, this does NOT promote a
 * `todo` task to `doing`. A promotion is a write to the spec on the subagent's behalf,
 * and it would let one run keep granting itself work it was never asked to start: the
 * parent dispatched a task, and a queue of `todo` entries the subagent wrote for itself
 * is planning, not an instruction to keep going. Only an explicit `doing` (or a
 * `blocked`, which is a task that was started) continues a run.
 *
 * Errors are swallowed to a null task: a spec that cannot be read must not extend a run.
 */
export async function readSubagentSpecContinuationState(narratorId: string): Promise<{
	openTask: { text: string; protected: boolean; status: "doing" | "blocked" } | null;
	protectedOpenCount: number;
}> {
	try {
		const file = await specVfsService.readTasksFileForNarrator(narratorId);
		const compiled = compileSpecTasks(parseSpecTasksDocument(file.content));
		const current = compiled.currentTask;
		const blocked = compiled.tasks.find((task) => task.status === "blocked") ?? null;
		// A `doing` task outranks a `blocked` one: it is the work in flight.
		const chosen = current ?? blocked;
		return {
			openTask: chosen
				? {
						text: chosen.text,
						protected: chosen.protected === true,
						status: chosen === current ? "doing" : "blocked",
					}
				: null,
			protectedOpenCount: compiled.protectedOpenCount,
		};
	} catch {
		return { openTask: null, protectedOpenCount: 0 };
	}
}

/**
 * Push a user message onto the subagent buffer queue.
 * Returns false if the queue is full.
 */
export interface SubagentBufferedMessageOptions {
	images?: ImageRef[];
	textFiles?: File[];
	commandText?: string | null;
	createdBy?: string | null;
	prePromptBashCommand?: string;
	position?: "front" | "back";
}

export function pushSubagentBufferedMessage(
	subagentId: string,
	text: string,
	options?: SubagentBufferedMessageOptions,
): { ok: boolean; bufferedAt: string; id: string; full?: boolean } {
	const queue = getSubagentBufferedMessagesMap().get(subagentId) ?? [];
	const bufferedAt = new Date().toISOString();
	const id = generateShortId();
	if (queue.length >= MAX_BUFFERED_MESSAGES) {
		return { ok: false, bufferedAt, id, full: true };
	}
	const position = options?.position ?? "back";
	const entry: SubagentBufferedMessage = {
		id,
		text,
		images: options?.images,
		textFiles: options?.textFiles,
		commandText: options?.commandText,
		createdBy: options?.createdBy,
		prePromptBashCommand: options?.prePromptBashCommand,
		bufferedAt,
		priority: position === "front" || undefined,
	};
	if (position === "front") {
		// Priority messages stay ahead of ordinary messages, but remain FIFO among
		// themselves. Repeated unshift() would reverse consecutive priority input.
		const firstOrdinaryIndex = queue.findIndex((queued) => !queued.priority);
		queue.splice(firstOrdinaryIndex < 0 ? queue.length : firstOrdinaryIndex, 0, entry);
	} else {
		queue.push(entry);
	}
	getSubagentBufferedMessagesMap().set(subagentId, queue);
	return { ok: true, bufferedAt, id };
}

/** Queue direct user feedback and optionally request the next safe stop boundary. */
export function bufferSubagentUserMessage(
	subagentId: string,
	text: string,
	options?: Omit<SubagentBufferedMessageOptions, "position"> & {
		priority?: boolean;
		requestSoftStop?: boolean;
	},
): { ok: boolean; bufferedAt: string; id: string; full?: boolean } {
	const { priority = false, requestSoftStop = true, ...messageOptions } = options ?? {};
	const result = pushSubagentBufferedMessage(subagentId, text, {
		...messageOptions,
		position: priority ? "front" : "back",
	});
	if (result.ok && requestSoftStop) requestSubagentBufferedMessageSoftStop(subagentId);
	return result;
}

/** Clear the entire subagent buffer queue and any pending post-tool stop. */
export function clearSubagentBufferedMessages(subagentId: string): void {
	getSubagentBufferedMessagesMap().delete(subagentId);
	getSubagentBufferedMessageSoftStops().delete(subagentId);
}

/** Get the full subagent buffer queue (for REST hydration). */
export function getSubagentBufferedMessages(subagentId: string): SubagentBufferedMessage[] {
	return getSubagentBufferedMessagesMap().get(subagentId) ?? [];
}

/**
 * Edit the text of one queued subagent message. Returns false when the queue or
 * message id does not exist, so callers can fall through to the primary-narrator
 * queue (the two queues live in separate maps and never share ids).
 */
export function updateSubagentBufferedMessage(
	subagentId: string,
	messageId: string,
	text: string,
	opts?: { images?: ImageRef[]; textFiles?: File[] },
): boolean {
	const queue = getSubagentBufferedMessagesMap().get(subagentId);
	const message = queue?.find((queued) => queued.id === messageId);
	if (!message) return false;
	message.text = text;
	// `undefined` means "leave this alone" so text-only callers are unaffected.
	// This queue is purely in-memory: there is no DB row to sync and no persisted
	// file to remove, so replacing the arrays is the whole update.
	if (opts?.images !== undefined) {
		message.images = opts.images.length ? opts.images : undefined;
	}
	if (opts?.textFiles !== undefined) {
		message.textFiles = opts.textFiles.length ? opts.textFiles : undefined;
	}
	message.bufferedAt = new Date().toISOString();
	return true;
}

/**
 * Remove one queued subagent message. When the queue becomes empty the pending
 * post-tool soft stop is dropped too, otherwise the running turn would stop at
 * the next tool boundary with nothing left to resume.
 */
export function removeSubagentBufferedMessage(subagentId: string, messageId: string): boolean {
	const queue = getSubagentBufferedMessagesMap().get(subagentId);
	if (!queue) return false;
	const index = queue.findIndex((queued) => queued.id === messageId);
	if (index === -1) return false;
	queue.splice(index, 1);
	if (queue.length === 0) clearSubagentBufferedMessages(subagentId);
	return true;
}

/** Reorder the subagent buffer queue by an exact list of its message ids. */
export function reorderSubagentBufferedMessages(subagentId: string, orderedIds: string[]): boolean {
	const queue = getSubagentBufferedMessagesMap().get(subagentId);
	if (!queue || queue.length === 0) return false;
	if (orderedIds.length !== queue.length) return false;
	const byId = new Map(queue.map((queued) => [queued.id, queued]));
	const reordered: SubagentBufferedMessage[] = [];
	for (const id of orderedIds) {
		const message = byId.get(id);
		if (!message) return false;
		reordered.push(message);
	}
	getSubagentBufferedMessagesMap().set(subagentId, reordered);
	return true;
}

// ---------------------------------------------------------------------------
// buildSubagentEventContext
// ---------------------------------------------------------------------------

/** Build an EventHandlerContext for a subagent. */
export function buildSubagentEventContext(
	subagentId: string,
	parentNarratorId: string,
	parentToolUseId: string,
	conversationId: string,
	subagentModel: string,
): EventHandlerContext {
	let contextUsagePct: number | undefined;
	let meterUsage: number | undefined;
	let meterUnit: string | undefined;
	let partialMessageId: string | undefined;
	let tokenUsage: import("./narrator-event-handler").TokenUsageSnapshot | undefined;

	return {
		narratorId: subagentId,
		broadcastTargetId: parentNarratorId,
		conversationId,
		parentToolUseId,
		subagentModel,
		getContextUsagePct: () => contextUsagePct,
		getMeterUsage: () => meterUsage,
		getMeterUnit: () => meterUnit,
		getPartialMessageId: () => partialMessageId,
		getTokenUsage: () => tokenUsage,
		setPartialMessageId: (id) => {
			partialMessageId = id;
		},
		setContextUsagePct: (pct) => {
			contextUsagePct = pct;
		},
		setMeterData: (u, un) => {
			meterUsage = u;
			meterUnit = un;
		},
		setTokenUsage: (u) => {
			tokenUsage = u;
		},
		toolCallIdsMap: new Map(),
	};
}

// ---------------------------------------------------------------------------
// finalizeSubagent
// ---------------------------------------------------------------------------

/** Mark subagent as done/error and broadcast completion. */
export async function finalizeSubagent(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	errorText: string | null,
	options?: { interrupted?: boolean; timedOut?: boolean },
): Promise<void> {
	// Clean up any remaining buffered messages, post-tool stop, and team inbox.
	clearSubagentBufferedMessages(subagentId);
	clearTeamInbox(subagentId);
	// The knowledge de-dup set has the same lifetime as the team inbox: it is per-run
	// state, and the durable record of what was injected is the ledger table, which the
	// next run reloads. Dropping it only keeps the map from growing.
	clearSubagentKnowledgeCycle(subagentId);

	// NOTE: file change records are intentionally NOT cleared here.
	// They remain available for sibling subagents to query via TeamStatus.file_changes
	// until the parent narrator session ends (clearTeamFileChanges is called then).

	const substatus = options?.interrupted
		? ["interrupted"]
		: options?.timedOut
			? ["timeout"]
			: hasError
				? ["error"]
				: ["unread"];
	await narratorService.updateStatus(subagentId, "idle", {
		substatus,
		errorMessage: hasError && !options?.interrupted ? (errorText ?? undefined) : undefined,
		skipErrorMessage: true,
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_status_changed",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		status: "idle",
		substatus,
	});

	eventBus.emit({
		type: "narrator:subagent_completed",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
	});
}

// ---------------------------------------------------------------------------
// loadSubagentHistory
// ---------------------------------------------------------------------------

/**
 * Load subagent messages and build history.
 * Clears parentToolUseId so buildHistory includes subagent messages.
 */
export async function loadSubagentHistory(
	narratorId: string,
	model: string,
	provider: string,
	pruneBoundaryId?: string | null,
) {
	const rawMessages = await narratorService.getModelHistorySinceLastCompact(narratorId);
	const dbMessages = rawMessages.map((msg) => ({ ...msg, parentToolUseId: null }));
	if (pruneBoundaryId) {
		pruneToolCalls(dbMessages, pruneBoundaryId);
	}
	return buildHistory(dbMessages, model, provider, narratorId);
}

// ---------------------------------------------------------------------------
// consumeNextBufferedSubagentMessage
// ---------------------------------------------------------------------------

async function saveBufferedTextFiles(cwd: string, files?: File[]): Promise<TextFileRef[]> {
	const saved: TextFileRef[] = [];
	for (const file of files ?? []) {
		saved.push(await saveTextFileToWorktree(cwd, file));
	}
	return saved;
}

export async function consumeNextBufferedSubagentMessage(opts: {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	model: string;
	provider: string;
	cwd: string;
	pruneBoundaryId?: string | null;
	/** Locale for the knowledge hint this drain may write. Defaults to English. */
	locale?: string;
}): Promise<{
	prompt: string;
	history: unknown[];
	trailingToolResults: unknown[];
	userId?: string | null;
	prePromptBashCommand?: string;
} | null> {
	const { narratorId, parentNarratorId, toolUseId, model, provider } = opts;
	let { pruneBoundaryId } = opts;
	const bufQueue = getSubagentBufferedMessagesMap().get(narratorId);
	const buffered = bufQueue?.[0];
	if (!buffered) return null;
	bufQueue?.shift();
	if (bufQueue?.length === 0) {
		getSubagentBufferedMessagesMap().delete(narratorId);
		getSubagentBufferedMessageSoftStops().delete(narratorId);
	}
	const textFiles = await saveBufferedTextFiles(opts.cwd, buffered.textFiles);
	const userMsg = await narratorService.persistSubagentUserMessage(
		narratorId,
		buffered.text,
		toolUseId,
		{
			images: buffered.images,
			textFiles,
			commandText: buffered.commandText,
			createdBy: buffered.createdBy,
		},
	);
	broadcastToNarrator(parentNarratorId, {
		type: "user_message",
		narratorId: parentNarratorId,
		message: userMsg,
	});
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: { ...userMsg, parentToolUseId: null },
	});
	const remaining = toBufferSummary(getSubagentBufferedMessagesMap().get(narratorId) ?? []);
	broadcastToNarrator(parentNarratorId, {
		type: "buffer_consumed",
		narratorId: parentNarratorId,
		messageId: buffered.id,
		remaining,
	});
	broadcastToNarrator(narratorId, {
		type: "buffer_consumed",
		narratorId,
		messageId: buffered.id,
		remaining,
	});
	// Point A for a message that could NOT be folded into the running pass (attachments, a
	// pre-prompt command, or a different acting user). Scanned here rather than at the
	// three call sites — the executor's pass restart, the runner's post-interrupt drain and
	// its takeover suspension all funnel through this function, and a per-site scan is how
	// one of them would end up forgotten.
	//
	// Write the hint BEFORE rebuilding. Some builders lift the trailing sys row out of
	// history; the rebuilt current-turn text below must carry that extracted field too.
	await deliverBufferedKnowledgeHint({
		narratorId,
		parentNarratorId,
		toolUseId,
		text: buffered.text,
		turnUserId: buffered.createdBy,
		locale: opts.locale,
	});

	if (pruneBoundaryId === undefined) {
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
	}
	const rebuilt = await loadSubagentHistory(narratorId, model, provider, pruneBoundaryId);
	// Match the primary loop's currentTurnText: only prepend context the builder
	// extracted. Official Anthropic keeps sys as system history, so replaying the
	// persisted hint itself here would inject it twice.
	const prompt = rebuilt.trailingUserText?.trim()
		? buffered.text.trim()
			? `${rebuilt.trailingUserText}\n\n${buffered.text}`
			: rebuilt.trailingUserText
		: buffered.text;
	return {
		prompt,
		history: rebuilt.history,
		trailingToolResults: rebuilt.trailingToolResults,
		userId: buffered.createdBy,
		prePromptBashCommand: buffered.prePromptBashCommand,
	};
}

/**
 * Scan a drained buffered message for relevant knowledge and persist the hint as its own
 * row, so the rebuilt request carries it.
 *
 * Unlike the in-pass drain, this path rebuilds history after writing the row. Its caller
 * must consume both history and extracted trailingUserText as the resumed turn.
 *
 * `projectId` is resolved here rather than passed in: this function is reached from call
 * sites that do not hold it, and the lookup is a single indexed read on a path that
 * already does several.
 */
async function deliverBufferedKnowledgeHint(input: {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	text: string;
	turnUserId: string | null | undefined;
	locale?: string;
}): Promise<void> {
	const { narratorId, parentNarratorId, toolUseId, text, turnUserId } = input;
	try {
		// A failed scope lookup must SKIP the scan, not proceed with an absent project:
		// `resolveInjections` reads a missing projectId as "global + every project's
		// collections", so treating the failure as null would widen the scope precisely
		// when cross-project isolation could not be verified.
		const scope = await resolveSubagentProjectId(narratorId);
		if (!scope.ok) return;
		const scan = await scanSubagentTextForKnowledge({
			narratorId,
			parentNarratorId,
			text,
			source: "buffered_message",
			turnUserId,
			projectId: scope.projectId,
			cycle: getSubagentKnowledgeCycle(narratorId),
			locale: (input.locale ?? "en") as Locale,
		});
		if (!scan) return;
		const { messageId } = await deliverInjection(narratorId, {
			content: scan.content,
			body: scan.body,
			source: "knowledge_base_hint",
			// The caller rebuilds history right after this, so the row is picked up from the
			// database; asking for `onNextTurn` text nobody would fold in would be a lie.
			schedule: "none",
			locale: (input.locale ?? "en") as Locale,
			subagent: { parentToolUseId: toolUseId, parentNarratorId },
		});
		if (messageId) {
			knowledgeService.recordInjectionEvents({
				narratorId: scan.record.narratorId,
				compactSeq: scan.record.compactSeq,
				source: "user_message",
				triggerMessageId: messageId,
				hits: scan.record.hits,
			});
		}
	} catch (err) {
		logger.warn("Failed to deliver knowledge hint for a drained subagent message", {
			narratorId,
			error: String(err),
		});
	}
}

/**
 * The project scope a subagent's knowledge scan is restricted to.
 *
 * `ok: false` means the scope could not be determined and the caller must not scan —
 * distinct from `ok: true, projectId: null`, which is a genuinely chapterless subagent
 * whose scope is the global collections only.
 */
async function resolveSubagentProjectId(
	narratorId: string,
): Promise<{ ok: true; projectId: string | null } | { ok: false }> {
	try {
		const narrator = await narratorService.getById(narratorId);
		if (!narrator.chapterId) return { ok: true, projectId: null };
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { projectId: true },
		});
		// A chapter row that cannot be read is not "no project": its entries may belong to a
		// project whose isolation we would be dropping.
		return chapter ? { ok: true, projectId: chapter.projectId } : { ok: false };
	} catch {
		return { ok: false };
	}
}

// ---------------------------------------------------------------------------
// executeSubagent
// ---------------------------------------------------------------------------

/**
 * Execute a subagent with optional compact/prune support.
 *
 * For general subagents: wraps executeAgentLoop in a while-loop that
 * restarts after compact, with prune boundary tracking and onBeforeTurn.
 *
 * For explore/plan subagents: single-pass execution (no compact/prune).
 */
export async function executeSubagent(opts: SubagentExecOptions): Promise<{
	finalText: string;
	hasError: boolean;
	contextLengthExceeded?: boolean;
	aborted?: boolean;
}> {
	// Snapshot session state is owned HERE, outside the loop, for the `finally`
	// below: a claim opened by the pre-execution hook and never closed is read as
	// "still running, so it extends to now", which makes its declared paths shadow
	// every later window in this worktree — silently turning other narrators' real
	// writes into unrevertable ones. The primary loop has the same backstop
	// (narrator-session's `finally`), and it must not depend on the loop returning
	// normally, so it cannot live inside the loop body.
	//
	// `_defaultDeviceId` is filled in by the loop once it has read the narrator row;
	// nothing captures before then.
	const treeSnapshotSession: TreeSnapshotSession = { cwd: opts.cwd };
	try {
		return await runSubagentLoop(opts, treeSnapshotSession);
	} finally {
		abandonSessionTreeSnapshots(treeSnapshotSession, opts.narratorId);
	}
}

async function runSubagentLoop(
	opts: SubagentExecOptions,
	treeSnapshotSession: TreeSnapshotSession,
): Promise<{
	finalText: string;
	hasError: boolean;
	contextLengthExceeded?: boolean;
	aborted?: boolean;
}> {
	let {
		narratorId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
	} = opts;
	model = resolveEffectiveModel(model);
	provider = resolveProvider(model);
	let currentUserId = opts.userId ?? null;

	let {
		systemPrompt,
		initialHistory: history,
		initialTrailingToolResults: trailingToolResults,
	} = opts;

	// Mutable state for compact/prune
	let pruneBoundaryId: string | null = null;
	let needsRestart = false;
	let currentConversationId = randomUUID();
	let resetUpstreamSessionOnNextRequest = false;
	let contextLengthExceeded = false;
	// Consecutive overflow recoveries since the last completed assistant turn.
	let overflowRetries = 0;

	// Transient error retry state
	let transientRetries = 0;
	// Consecutive completion-limit / resumable-error continuations.
	let interruptionRetries = 0;

	// Self-continuation budget for this RUN.
	//
	// The primary narrator keeps the equivalent counters on its `ActiveNarrator`, which
	// a subagent has no entry in. Run-local is not a workaround for that absence but the
	// tighter scope: a subagent's run is exactly the window its parent is blocked for, so
	// the budget should reset per dispatch and never leak across them. The bound itself
	// is the shared `computeContinuationStallState` plus a per-run pass cap — see
	// `planSubagentContinuation`.
	const continuationState = createSubagentContinuationState();
	// Set when the bound stopped a continuation, so the run's final text can say so.
	// A parent that receives a partial answer with no explanation reads it as complete.
	let continuationStopNote: string | null = null;

	// Compact-done flag: set by onCompactDone, consumed by onBeforeTurn to
	// rebuild history/systemPrompt within the same agent loop (inner path).
	// The outer needsRestart flag is a fallback for when compact finishes
	// after the agent loop has already returned.
	let compactDoneFlag = false;
	let compactConsumedInLoop = false;

	// Build context management hooks (prune + compact) for all subagent types
	const ctxMgmt = buildContextManagementHooks({
		narratorId,
		locale: locale as Locale,
		getModel: () => model,
		getProvider: () => provider,
		isSubagent: true,
		getPruneBoundary: () => pruneBoundaryId,
		setPruneBoundary: (id) => {
			pruneBoundaryId = id;
		},
		onCompactDone: () => {
			needsRestart = true;
			currentConversationId = randomUUID();
			resetUpstreamSessionOnNextRequest = true;
			compactDoneFlag = true;
		},
		isCompactDone: () => compactDoneFlag,
		clearCompactDone: () => {
			compactDoneFlag = false;
			compactConsumedInLoop = true;
		},
		rebuildSystemPrompt: async () => {
			const freshNarrator = await narratorService.getById(narratorId);
			if (opts.rebuildSystemPrompt) {
				return opts.rebuildSystemPrompt(freshNarrator.contextSummary);
			}
			return null;
		},
	});

	let finalText = "";
	let hasError = false;
	let aborted = false;
	const initialNarrator = await narratorService.getById(narratorId);
	const projectId = initialNarrator.chapterId
		? ((
				await db.query.chapters.findFirst({
					where: eq(chapters.id, initialNarrator.chapterId),
					columns: { projectId: true },
				})
			)?.projectId ?? null)
		: null;
	const authorizedDevices = await import("./device-connection-service")
		.then(({ getSessionDevices }) =>
			getSessionDevices(
				projectId,
				resolveSubagentActingUserId(
					opts.userId ?? null,
					activeNarrators.get(parentNarratorId)?._currentUserId,
				),
			),
		)
		.catch(() => []);
	const defaultDeviceId = initialNarrator.defaultDeviceId ?? null;

	// --- Workspace tree snapshot boundaries ---
	//
	// A subagent writes to a real worktree with the same tools as its parent, so its
	// tool calls need the same content-addressed boundaries: without them
	// `narrator_tool_calls.treeHashBefore/After` stay null and a rollback of that call
	// degrades to per-file replay (which cannot see Bash or external writes at all).
	//
	// The session object is owned by `executeSubagent` (per RUN, not per pass): the
	// staged `before` hashes and the reused `_lastTreeHash` cache live on it and must
	// survive a compact restart in the middle of a tool pair, and its `finally` needs
	// it to seal leaked claims.
	//
	// A subagent has no `activeNarrators` entry, so the field the hooks read for the
	// execution target is resolved from its own narrator row here — a remote-targeted
	// subagent is then skipped exactly like a remote primary session.
	treeSnapshotSession._defaultDeviceId = defaultDeviceId;
	// Same rule as a primary session: a chapter always has a worktree; a chapterless
	// subagent's cwd has to be probed once. Failure counts as "not a repo", which only
	// costs snapshots rather than failing the run.
	let subagentIsInGitRepo = !!initialNarrator.chapterId;
	if (!initialNarrator.chapterId) {
		try {
			subagentIsInGitRepo = await gitService.isGitRepo(cwd);
		} catch {
			subagentIsInGitRepo = false;
		}
	}
	const treeSnapshotHooks = buildTreeSnapshotEventHooks({
		session: treeSnapshotSession,
		narratorId,
		isInGitRepo: subagentIsInGitRepo,
	});

	let narratorReasoningEffort = initialNarrator.reasoningEffort ?? undefined;
	let narratorFastModeOverride = normalizeBooleanOverride(initialNarrator.fastModeOverride);
	// Layered traits: the parent narrator is an upper layer relative to a subagent,
	// so an enforced restriction on the parent (or on the project/user above it)
	// cannot be escaped here. `currentUserId` may be absent on recovery/detached
	// paths, matching how fast mode falls back to the parent's acting user.
	const subagentTraits = await resolveEffectiveTraits({
		narratorTraits: initialNarrator.traits,
		projectId,
		actingUserId: resolveSubagentActingUserId(
			currentUserId,
			activeNarrators.get(parentNarratorId)?._currentUserId,
		),
	});
	const disabledTools = getDisabledToolSet(subagentTraits.traits);
	const blockedSkills = getBlockedSkills(subagentTraits.traits);
	// Same narrowing as a primary session: authorization decides what may be used,
	// the injection policy decides what the model is told about.
	const availableDevices = resolveInjectedDevices(
		authorizedDevices,
		subagentTraits.deviceInjection,
	);

	// Register in the active subagent settings map so that model/reasoningEffort
	// updates from the UI are picked up via getRuntimeSettingsOverride.
	registerActiveSubagent(narratorId, model, narratorReasoningEffort);

	// Passive knowledge-injection de-dup, scoped to the current compact cycle and shared
	// by both scan points: the tool-output scan inside the loop (point B) and the
	// incoming-text scan below (point A). One set is what makes the two points de-dup
	// against each other; a per-point set would inject the same entry twice for a message
	// whose keyword also appears in the next tool's output.
	//
	// Keyed by narrator id rather than owned by this invocation: a subagent's turns are
	// also driven by the runner's post-interrupt drain and by `resumeSubagent`, each of
	// which re-enters `executeSubagent`, and a per-invocation set would re-inject
	// everything on the next continuation. Re-aligned against the ledger by
	// `syncSubagentKnowledgeCycle` whenever the compact boundary moves.
	const knowledgeCycle = getSubagentKnowledgeCycle(narratorId);

	/**
	 * Scan one piece of incoming text for relevant knowledge and, if anything hit, write
	 * the hint as its own row; returns the text to fold into this turn (or null).
	 *
	 * A row of its own rather than an addition to somebody else's: the hint is about the
	 * incoming request, and appending it to the message's text would make a reader unable
	 * to tell the sender's words from the platform's.
	 *
	 * The ledger write happens only after the row is durable, for the same reason point B
	 * defers it — a record whose content never landed would suppress that entry for the
	 * rest of the compact cycle.
	 */
	const deliverKnowledgeHint = async (
		text: string,
		source: "buffered_message" | "team_message",
		turnUserId: string | null | undefined,
	): Promise<string | null> => {
		const scan = await scanSubagentTextForKnowledge({
			narratorId,
			parentNarratorId,
			text,
			source,
			// A message with its own author is evaluated as that author; everything else
			// falls back to the run's user and then the parent session's.
			turnUserId: turnUserId ?? currentUserId,
			projectId,
			cycle: knowledgeCycle,
			locale: locale as Locale,
		});
		if (!scan) return null;
		try {
			const { messageId, turnText } = await deliverInjection(narratorId, {
				content: scan.content,
				body: scan.body,
				source: "knowledge_base_hint",
				schedule: "onNextTurn",
				locale: locale as Locale,
				subagent: { parentToolUseId: toolUseId, parentNarratorId },
			});
			if (messageId) {
				knowledgeService.recordInjectionEvents({
					narratorId: scan.record.narratorId,
					compactSeq: scan.record.compactSeq,
					source: "user_message",
					triggerMessageId: messageId,
					hits: scan.record.hits,
				});
			}
			return turnText ?? null;
		} catch (err) {
			logger.warn("Failed to deliver subagent knowledge hint", {
				narratorId,
				source,
				error: String(err),
			});
			return null;
		}
	};

	// Resolve tool filter for this subagent type using pre-loaded customDef
	const baseToolFilter = resolveToolFilter(subagentType, opts.customDef);
	const toolFilter = (tool: import("../lib/agent").ToolDefinition) =>
		!disabledTools.has(tool.name) &&
		!(tool.name === "Skill" && blockedSkills.all) &&
		(!baseToolFilter || baseToolFilter(tool));

	while (true) {
		const eventContext = buildSubagentEventContext(
			narratorId,
			parentNarratorId,
			toolUseId,
			currentConversationId,
			model,
		);

		const hooks: EventHooks = {
			...treeSnapshotHooks,
			onContextUsage: ctxMgmt.onContextUsage,
		};

		const resolvedProvider = resolveProvider(model);
		// "inherit" resolves against the acting user's fastModeDefault on every loop,
		// so changing that preference affects running sessions from the next turn.
		// A subagent has no user of its own: recovery/detached paths may start it
		// without one, so fall back to the parent session's triggering user rather
		// than silently degrading "inherit" to disabled.
		const resolvedFastMode = await resolveFastModeForUser(
			narratorFastModeOverride,
			resolveSubagentActingUserId(
				currentUserId,
				activeNarrators.get(parentNarratorId)?._currentUserId,
			),
		);
		const resolvedServiceTier =
			resolvedFastMode && usesCodexModel(resolvedProvider, model) ? "priority" : undefined;
		let todoReminderCompletedToolCount = 0;
		// Gates buildSpecTaskDigestBody to a fixed cadence so we don't hit SQLite on
		// every tool result. Shared helper rather than a local counter: the previous
		// inline version advanced its marker only after a SUCCESSFUL build, so a
		// subagent whose spec had no open tasks stayed permanently due and re-read the
		// spec file on every subsequent tool call. `InjectionCadence.due` spends the
		// tick when asked, which is the behaviour narrator-session already had.
		const tasksCadence = new InjectionCadence(() => TODO_REMINDER_TOOL_INTERVAL);
		const resetUpstreamSessionForThisLoop = resetUpstreamSessionOnNextRequest;
		resetUpstreamSessionOnNextRequest = false;
		// Align the de-dup set with this pass's compact cycle BEFORE the config captures the
		// seq: a compact that landed during the previous pass invalidates the old set (its
		// entries are now only in the summary), and the ledger seq the loop stamps its
		// point-B records with has to be the same one the set was rebuilt for.
		const knowledgeCycleSeq = await syncSubagentKnowledgeCycle(narratorId, knowledgeCycle);
		const config: AgentConfig = {
			narratorId,
			conversationId: currentConversationId,
			model,
			provider: resolvedProvider,
			cwd,
			systemPrompt,
			locale,
			signal,
			chapterId: initialNarrator.chapterId ?? undefined,
			parentNarratorId,
			parentToolUseId: toolUseId,
			reviewReadOnlyBash: subagentType === "review",
			userId: currentUserId,
			projectId,
			defaultDeviceId,
			availableDevices,
			reasoningEffort:
				narratorReasoningEffort ?? resolveDefaultReasoningEffort(resolvedProvider, model),
			serviceTier: resolvedServiceTier,
			maxTransientRetries: getMaxTransientRetries(),
			silentToolCallThreshold: getSilentToolCallThreshold(),
			pipelineUnusedToolCallThreshold: getPipelineUnusedToolCallThreshold(),
			retryBackoffCeilMs: getRetryBackoffCeilMs(),
			firstTokenTimeoutMs: getFirstTokenTimeoutMs(),
			metadata: isAnthropicProvider(resolvedProvider)
				? { user_id: `user_${narratorId}_account__session_${currentConversationId}` }
				: undefined,
			resetUpstreamSessionOnFirstRequest: resetUpstreamSessionForThisLoop,
			disabledTools,
			blockedSkills: { all: blockedSkills.all, names: [...blockedSkills.names] },
			toolFilter,
			onExecutionTargetResolved: (resolvedToolUseId, target) =>
				narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
			onExecutionPlanResolved: (resolvedToolUseId, plan) =>
				narratorService.updateToolCallExecutionPlan(narratorId, resolvedToolUseId, plan),
			// Share the compact-cycle de-dup set so the loop's tool-output scan (point B)
			// de-dups against the incoming-text injections (point A) and vice versa — the
			// same wiring the primary session does. Without these two fields the loop falls
			// back to a per-call set and stamps its ledger rows with -1, so a subagent could
			// be told about the same entry once per pass.
			knowledgeInjectedEntryIds: knowledgeCycle.ids,
			knowledgeInjectionCompactSeq: knowledgeCycleSeq,
			deferEagerToolsForSafeStop: true,
			shouldStop: () => shouldStopSubagentForBufferedMessage(narratorId),
			permissionHandler: (toolName, permInput, permToolUseId, options) =>
				handlePermission(
					narratorId,
					signal,
					toolName,
					permInput,
					permToolUseId,
					cwd,
					locale as Locale,
					parentNarratorId,
					options,
					toolUseId,
					undefined,
					config.reviewReadOnlyBash,
				),
			onBeforeTurn: ctxMgmt.onBeforeTurn,
			getContextUsagePercentage: eventContext.getContextUsagePct,
			onReasoningOnlyHighContext: ctxMgmt.onReasoningOnlyHighContext,
			getRuntimeSettingsOverride: () => {
				const sa = activeSubagentSettings.get(narratorId);
				if (!sa) return null;
				const override: RuntimeSettingsOverride = {};
				if (sa.model !== config.model) {
					override.model = sa.model;
				}
				const effectiveReasoningEffort =
					sa.reasoningEffort ?? resolveDefaultReasoningEffort(resolvedProvider, sa.model);
				if (effectiveReasoningEffort !== (config.reasoningEffort ?? null)) {
					override.reasoningEffort = effectiveReasoningEffort;
				}
				return Object.keys(override).length > 0 ? override : null;
			},
			initialCompletedToolCount: todoReminderCompletedToolCount,
			onCompletedToolCount: (count: number) => {
				todoReminderCompletedToolCount = count;
			},
			deliverInjectionRow: async (injection) => {
				const { messageId, turnText } = await deliverInjection(narratorId, {
					content: injection.content,
					body: injection.body,
					source: injection.source,
					schedule: "onNextTurn",
					locale: locale as Locale,
					subagent: { parentToolUseId: toolUseId, parentNarratorId },
				});
				// Point-B hits are recorded only AFTER the row is durable, for the reason the
				// primary session states: the de-dup key `(narratorId, compactSeq, entryId)`
				// is reloaded from this table after a compact, so recording a hit whose
				// content never landed would suppress that entry permanently.
				if (messageId && injection.knowledgeInjection) {
					const record = injection.knowledgeInjection;
					try {
						knowledgeService.recordInjectionEvents({
							narratorId: record.narratorId,
							compactSeq: record.compactSeq,
							source: "tool_output",
							triggerToolCallId: record.triggerToolCallId,
							hits: record.hits,
						});
					} catch (err) {
						logger.warn("Failed to record subagent knowledge injection events", {
							narratorId,
							error: String(err),
						});
					}
				}
				return turnText ?? "";
			},
			getAfterToolsInjections: async () => {
				const parts: string[] = [];

				// 0. The Dynamic Spec digest, on its cadence.
				//
				// Previously appended inside a tool result's string (hence the `toolUseId`);
				// it is session-level information, not about any one call, so it now lands at
				// the turn boundary as its own row. The tick is still the loop's completed-tool
				// count, so the cadence is unchanged — a turn that ran several tools now yields
				// at most one reminder instead of one per tool.
				if (tasksCadence.due(todoReminderCompletedToolCount)) {
					const tasksBody = await buildSpecTaskDigestBody(narratorId);
					if (tasksBody) {
						const { body, content } = sideCarBodyWithText(
							"living_work_spec",
							tasksBody,
							locale as Locale,
						);
						const { turnText } = await deliverInjection(narratorId, {
							content,
							body,
							source: "living_work_spec",
							schedule: "onNextTurn",
							locale: locale as Locale,
						});
						if (turnText) parts.push(turnText);
					}
				}

				// 1. A message queued for this subagent — typed by the user on the subagent
				// page, or sent by the parent narrator / a sibling through Send.
				//
				// This is the boundary that makes Send feel like conversation: the message
				// lands in the very next request instead of waiting for this whole pass to
				// finish. See `canDeliverBufferedMessageInPass` for the cases that cannot be
				// carried here and must fall through to the pass-restart path.
				//
				// Text only, no `deliverInjection`: the row is written just below by
				// `persistSubagentUserMessage` as a real `role: "user"` turn (which is what
				// it is — somebody addressed this subagent). Injecting again would duplicate
				// it. The text is still needed because the loop built its in-memory history
				// at pass start.
				const queue = getSubagentBufferedMessagesMap().get(narratorId);
				const buf = queue?.[0];
				// A pending soft stop means this pass is already ending for the sake of the
				// queue (direct user feedback asks for that). Draining here would be worse
				// than waiting: the loop sets `gracefulStopRequested` back in the tool loop
				// and returns right after this drain, discarding the `nextTurnContent` we
				// would have contributed — while the queue is now empty, so the restart path
				// finds nothing and the subagent finalizes with the message unanswered.
				// Leave those to `consumeNextBufferedSubagentMessage`, which rebuilds history.
				const softStopPending = shouldStopSubagentForBufferedMessage(narratorId);
				if (buf && !softStopPending && canDeliverBufferedMessageInPass(buf, currentUserId)) {
					queue?.shift();
					if (queue?.length === 0) {
						getSubagentBufferedMessagesMap().delete(narratorId);
						getSubagentBufferedMessageSoftStops().delete(narratorId);
					}
					// Persist user message in the background (fire-and-forget).
					narratorService
						.persistSubagentUserMessage(narratorId, buf.text, toolUseId, {
							commandText: buf.commandText,
							createdBy: buf.createdBy,
						})
						.then((userMsg) => {
							broadcastToNarrator(parentNarratorId, {
								type: "user_message",
								narratorId: parentNarratorId,
								message: userMsg,
							});
							broadcastToNarrator(narratorId, {
								type: "user_message",
								narratorId,
								message: { ...userMsg, parentToolUseId: null },
							});
						})
						.catch((err) => {
							logger.error("Failed to persist injected subagent user message", {
								narratorId,
								error: String(err),
							});
						});
					const remaining = toBufferSummary(getSubagentBufferedMessagesMap().get(narratorId) ?? []);
					broadcastToNarrator(parentNarratorId, {
						type: "buffer_consumed",
						narratorId: parentNarratorId,
						messageId: buf.id,
						remaining,
					});
					broadcastToNarrator(narratorId, {
						type: "buffer_consumed",
						narratorId,
						messageId: buf.id,
						remaining,
					});
					parts.push(buf.text);
					// Point A for a LIVE subagent: this text was typed on the subagent's own
					// page or sent by the parent/a sibling, so nobody has scanned it. The ACL
					// identity is the message's own `createdBy` when it has one, else the
					// chain's acting user — never the sending agent.
					const hint = await deliverKnowledgeHint(buf.text, "buffered_message", buf.createdBy);
					if (hint) parts.push(hint);
				}

				// 2. Messages a sibling sent through TeamStatus, delivered as this subagent's
				// own message row rather than as a side-car attached to somebody else's: a
				// teammate's words belong in the transcript on their own line.
				//
				// One injection row PER message: a row that fans out into N bubbles has no
				// per-bubble address, which is what made delete/rollback impossible to aim
				// at one of them. A single message per row gives every bubble its own
				// blockIndex and its own context-menu target.
				//
				// Undelivered mail is still dropped when the subagent finishes
				// (`clearTeamInbox` in finalizeSubagent) — that is unchanged, and correct: a
				// message that never reached a turn was never part of the conversation.
				const teamMessages = drainTeamInbox(narratorId);
				for (const m of teamMessages) {
					const { body, content } = sideCarBodyWithText(
						"team_message",
						{
							kind: "messages",
							items: [
								{
									fromId: m.fromId,
									// The renderer applies the `fromTitle → fromLabel → fromId` fallback, so
									// passing all three keeps the text right AND gives the UI every part. The
									// label matters because an untitled sender used to be named by its nanoid.
									fromTitle: m.fromTitle ?? null,
									fromLabel: m.fromLabel ?? null,
									fromType: m.fromType ?? null,
									// Reader-only navigation target into the sender's own session;
									// omitted when the sender had written nothing yet.
									...(m.fromMessageId ? { fromMessageId: m.fromMessageId } : {}),
									...(m.isBroadcast ? { isBroadcast: true } : {}),
									text: m.text,
								},
							],
						},
						locale as Locale,
					);
					const { turnText } = await deliverInjection(narratorId, {
						content,
						body,
						source: "team_message",
						schedule: "onNextTurn",
						locale: locale as Locale,
					});
					if (turnText) parts.push(turnText);
					// A sibling's words are new prose no point-A pass has seen: the sender was
					// scanned on what it RECEIVED, not on what it wrote, so it can name a term
					// it was never injected for. Resolved as the chain's acting user (a team
					// message carries no user of its own), which cannot escalate — the parent's
					// own point A already ran under that identity.
					const teamHint = await deliverKnowledgeHint(m.text, "team_message", null);
					if (teamHint) parts.push(teamHint);
				}

				return parts.join("\n\n");
			},
		};

		needsRestart = false;
		compactConsumedInLoop = false;

		/**
		 * Decide whether this pass should be followed by a self-continuation, and if so
		 * inject the prompt for it.
		 *
		 * Serves BOTH end-of-pass causes (`spec-continuation` and
		 * `max-turns-spec-continuation`): the decision, the bound and the counter writes
		 * are identical, only the wording differs, and duplicating the branch is how the
		 * two loops drifted in the first place.
		 *
		 * What it does NOT do, on purpose:
		 *
		 *  - It never parks. A primary narrator may sit idle waiting for an external
		 *    condition; a subagent owes its parent a `tool_result`, so every path here
		 *    either drives another pass or lets the run finish.
		 *  - It never marks the run as an error. The bound stopping a run is not a
		 *    failure — the work that happened is real, and `hasError` would discard an
		 *    explore/plan subagent's conclusion file. The reason travels as text.
		 *
		 * ⚠️ Called at most ONCE per pass, and only from an end-of-pass branch. The
		 * `grantedKind` handoff assumes it: it says "the pass that just ran was a
		 * continuation of this kind", so calling it twice for one pass would judge that
		 * pass twice and advance the stall counter at double rate. The two call sites are
		 * mutually exclusive in practice (`maxTurnsExceeded` continues the loop, so the
		 * spec branch below is not reached on that pass).
		 *
		 * @returns true when the caller should `continue` the loop.
		 */
		const maybeContinueForSpec = async (
			cause: SubagentContinuationCause,
			suppressed: boolean,
		): Promise<boolean> => {
			const spec = await readSubagentSpecContinuationState(narratorId);
			// Re-read the row rather than reusing `initialNarrator`: the setting can be
			// changed from the UI while a pass is in flight, and the primary loop applies
			// such a change at the very next turn boundary (`maybeStartContinuation` does
			// its own re-read for exactly this reason). A failed read degrades to the
			// global default rather than to "continue anyway".
			const freshOverride = await narratorService
				.getById(narratorId)
				.then((row) => row.autoContinuationOverride)
				.catch(() => null);
			const plan = planSubagentContinuation({
				cause,
				mode: resolveAutoContinuationMode(
					freshOverride,
					normalizeAutoContinuationMode(settings.agent.autoContinuationMode),
				),
				openTask: spec.openTask,
				protectedOpenCount: spec.protectedOpenCount,
				previous: continuationState,
				result,
				suppressed,
			});
			// Both fields are written back unconditionally, mirroring the primary loop: the
			// stall classification is the whole bound, and `grantedKind` is what lets the NEXT
			// pass be judged as a continuation (or, when absent, not judged at all).
			continuationState.stall = plan.stall;
			continuationState.grantedKind = plan.grantedKind;
			if (plan.action === "none") return false;
			if (plan.action === "stop") {
				continuationStopNote = subagentContinuationStopNote(plan, locale as Locale);
				logger.warn("Subagent self-continuation stopped by its bound", {
					narratorId,
					parentNarratorId,
					cause: plan.cause,
					reason: plan.reason,
					passes: plan.passes,
					stallCount: plan.stall.count,
				});
				return false;
			}
			continuationState.passes = plan.passes;

			// A continuation that started is progress of its own kind: clear any note left
			// by an earlier stop so a run that recovers does not report a stale reason.
			continuationStopNote = null;

			const content = buildSubagentContinuationPrompt({
				cause: plan.cause,
				task: plan.task,
				passes: plan.passes,
				locale: locale as Locale,
			});
			// `schedule: "none"`: this loop drives the pass itself. The sys row is either
			// retained as system history or extracted as this pass's CURRENT turn text.
			//
			// `subagent: {...}` is what puts the row in the parent's tool-card subtree AND on
			// the subagent's own page — without it the card would be a top-level row on the
			// parent, attributed to nobody.
			await deliverInjection(narratorId, {
				content,
				source: plan.task.status === "blocked" ? "spec_blocked_continuation" : "spec_continuation",
				schedule: "none",
				locale: locale as Locale,
				originSource: "autoContinuation",
				subagent: { parentToolUseId: toolUseId, parentNarratorId },
			});

			logger.info("Subagent self-continuation started", {
				narratorId,
				parentNarratorId,
				cause: plan.cause,
				passes: plan.passes,
				taskStatus: plan.task.status,
			});

			// Start a fresh turn rather than replaying the dispatched prompt. Compatible
			// Anthropic (including NUG delegates) extracts the trailing sys rows; official
			// Anthropic retains them as system history and returns no trailing text.
			const rebuilt = await loadSubagentHistory(
				narratorId,
				model,
				resolvedProvider,
				pruneBoundaryId,
			);
			history = rebuilt.history;
			trailingToolResults = rebuilt.trailingToolResults;
			prompt = rebuilt.trailingUserText ?? "";
			hasError = false;
			finalText = "";
			await narratorService.updateStatus(narratorId, "working").catch(() => {});
			return true;
		};

		/**
		 * Suspend this subagent until a NUG model becomes available again, then
		 * report whether the loop may continue.
		 *
		 * Shared by the pre-flight check below (the catalog already recorded an
		 * outage) and the post-request `modelUnavailable` branch (the gateway just
		 * refused), so both park on the shared availability poller — which polls
		 * only the lightweight `/v1/models` list — with identical status, broadcast
		 * and history-rebuild behaviour.
		 *
		 * @returns true when the model recovered and the caller should `continue`;
		 * false when the wait was aborted and the caller must `break`.
		 */
		const suspendUntilNugModelAvailable = async (
			mu: Omit<NonNullable<ExecuteLoopResult["modelUnavailable"]>, "provider">,
		): Promise<boolean> => {
			// Finalize/clean up the partial message from the failed turn.
			const partialId = eventContext.getPartialMessageId();
			let keptPartial = false;
			if (partialId) {
				keptPartial = await finalizeOrCleanupPartialMessage(partialId, narratorId);
				eventContext.setPartialMessageId(undefined);
			}

			await narratorService.updateStatus(narratorId, "waiting", {
				substatus: ["model_unavailable"],
			});
			broadcastToNarrator(parentNarratorId, {
				type: "subagent_model_unavailable_waiting",
				narratorId: parentNarratorId,
				subagentNarratorId: narratorId,
				message: mu.message,
				model: mu.model,
				nugModelId: mu.nugModelId,
				diagnostics: mu.diagnostics,
			});

			const outcome =
				mu.providerId && mu.nugModelId
					? await nugAvailabilityPoller.waitForModelAvailable({
							providerId: mu.providerId,
							nugModelId: mu.nugModelId,
							signal,
						})
					: "aborted";

			if (signal.aborted || outcome === "aborted") return false;

			broadcastToNarrator(parentNarratorId, {
				type: "subagent_model_unavailable_recovered",
				narratorId: parentNarratorId,
				subagentNarratorId: narratorId,
				model: mu.model,
				nugModelId: mu.nugModelId,
			});
			await narratorService.updateStatus(narratorId, "working");
			if (keptPartial) {
				prompt = "";
			}
			const rebuilt = await loadSubagentHistory(
				narratorId,
				model,
				resolvedProvider,
				pruneBoundaryId,
			);
			history = rebuilt.history;
			trailingToolResults = rebuilt.trailingToolResults;
			currentConversationId = randomUUID();
			resetUpstreamSessionOnNextRequest = true;
			return true;
		};

		// --- Pre-flight: the model is already known to be unavailable ---
		// A subagent's model comes from settings or its parent, so it can point at a
		// model whose outage is already recorded. Waiting here rather than sending
		// the request avoids uploading the whole history just to be refused, and it
		// does not depend on the gateway's error text being recognized. An unknown
		// model counts as usable, so a working model is never held back.
		{
			const known = resolveKnownUnavailableNugModel(model, resolvedProvider);
			if (known && !signal.aborted) {
				const resumed = await suspendUntilNugModelAvailable({
					message: `Model ${known.model} is recorded as temporarily unavailable; waiting for it to recover before sending the request.`,
					model: known.model,
					providerId: known.providerId,
					providerPrefix: known.providerPrefix,
					nugModelId: known.nugModelId,
				});
				if (!resumed) {
					aborted = true;
					break;
				}
				transientRetries = 0;
				continue;
			}
		}

		const baselineCompactSeq = await narratorService.getLatestCompactSeq(narratorId);
		const result = await executeAgentLoop({
			config,
			userText: prompt,
			history,
			trailingToolResults,
			eventContext,
			hooks,
		});
		overflowRetries = resetContextOverflowRetriesAfterProgress(
			overflowRetries,
			result.completedAssistantTurn,
		);

		finalText = result.contextLengthExceeded
			? "Error: context length exceeded"
			: result.maxTurnsExceeded
				? result.finalText || "Error: max turns exceeded"
				: result.finalText;
		hasError = result.hasError || result.maxTurnsExceeded === true;
		aborted = aborted || result.aborted === true || signal.aborted;
		if (result.retryableError && !result.hasError) {
			// Don't mark as error yet — try transient retry below
		}

		// --- Payment required: the balance is exhausted, so stop with a real reason ---
		//
		// The provider refused the request outright; no amount of retrying or history
		// rebuilding changes that, only the user topping up does. Handled explicitly
		// because `paymentRequired` sets none of the other result flags: without this
		// branch the pass looked like an ordinary empty completion, fell through to the
		// finalText backfill at the end of the run, and delivered the subagent's
		// PREVIOUS answer (or "(no output)") to the parent as if the work had finished.
		//
		// Unlike the primary narrator, this cannot merely park the session in a
		// `payment_required` state and wait: a subagent owes its parent a tool_result,
		// and a parent blocked on a tool that never returns is a dead turn. So the run
		// ends as an error whose text names the cause — the parent can then decide (and
		// can re-run the subagent once the balance is restored).
		//
		// The narrator row still carries the `payment_required` substatus + errorCode so
		// the subagent's own panel shows the recharge prompt rather than a generic
		// failure, while the parent-facing outcome is carried by finalText.
		// `signal.aborted` is this loop's spelling of the abort-before-recovery rule: an
		// already-stopped run must not spend a recovery branch on itself. Every branch below
		// carries the same guard, which is why the marker sits here.
		// [continuation-source: abort-before-recovery]
		// [continuation-source: payment-required]
		const paymentPlan = planSubagentPaymentRequired(result, signal.aborted);
		if (paymentPlan.action === "fail" && result.paymentRequired) {
			const partialId = eventContext.getPartialMessageId();
			eventContext.setPartialMessageId(undefined);
			if (partialId) {
				await finalizeOrCleanupPartialMessage(partialId, narratorId);
			}
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["payment_required"],
				errorCode: "payment_required",
				errorMessage: paymentPlan.errorMessage,
			});
			// The subagent's own page renders this like a primary narrator's.
			broadcastToNarrator(narratorId, {
				type: "payment_required",
				narratorId,
				providerId: result.paymentRequired.providerId,
				providerPrefix: result.paymentRequired.providerPrefix,
				balance: result.paymentRequired.balance,
				required: result.paymentRequired.required,
				resumeAction: result.paymentRequired.resumeAction,
			});
			// Also surfaced on the parent's subagent card, which otherwise shows only a
			// generic error and gives the user no idea a top-up would fix it.
			broadcastToNarrator(parentNarratorId, {
				type: "payment_required",
				narratorId: parentNarratorId,
				providerId: result.paymentRequired.providerId,
				providerPrefix: result.paymentRequired.providerPrefix,
				balance: result.paymentRequired.balance,
				required: result.paymentRequired.required,
				resumeAction: result.paymentRequired.resumeAction,
			});
			logger.warn("Subagent stopped: provider balance exhausted", {
				narratorId,
				parentNarratorId,
				providerId: result.paymentRequired.providerId,
			});
			hasError = true;
			finalText = paymentPlan.finalText;
			break;
		}

		// --- Context length exceeded: aggressive prune (Codex) then compact/retry ---
		// [continuation-source: context-overflow]
		if (result.contextLengthExceeded) {
			if (signal.aborted) {
				aborted = true;
				hasError = true;
				contextLengthExceeded = true;
				finalText = "Error: context length exceeded";
				break;
			}

			// Finalize or clean up partial message from the failed turn before retry.
			// If tools were already executed, the message is kept so the retry
			// includes them in history.
			const partialId = eventContext.getPartialMessageId();
			if (partialId) {
				await finalizeOrCleanupPartialMessage(partialId, narratorId);
				eventContext.setPartialMessageId(undefined);
			}

			const overflow = await handleContextOverflow({
				narratorId,
				locale: locale as Locale,
				provider: resolvedProvider,
				model,
				overflowRetries,
				maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
				baselineCompactSeq,
				signal,
			});
			overflowRetries = overflow.overflowRetries;

			if (overflow.action === "retry_pruned") {
				pruneBoundaryId = overflow.boundaryMessageId;
				resetUpstreamSessionOnNextRequest = true;
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;
				transientRetries = 0;
				continue;
			}
			if (overflow.action === "retry_compacted") {
				needsRestart = true;
				currentConversationId = overflow.newConversationId;
				resetUpstreamSessionOnNextRequest = true;
				transientRetries = 0;
				// Continue to the restart-after-compact flow below
			} else {
				const failure = getContextOverflowFailureError(overflow.reason);
				hasError = true;
				contextLengthExceeded = true;
				finalText = `Error: ${failure.message}`;
				break;
			}
		}

		// --- Model temporarily unavailable: suspend and wait for recovery ---
		// The NUG model's whole credential pool is disabled (recoverable
		// exhaustion). Suspend this subagent and register with the shared
		// instance-level availability poller (only fetches the lightweight
		// `/v1/models` list, no history). On recovery, rebuild history from the DB
		// and resume with one fresh request.
		// [continuation-source: model-unavailable]
		if (result.modelUnavailable && !signal.aborted) {
			const mu = result.modelUnavailable;
			// Record the refusal before waiting: the poller decides recovery from
			// the model cache, so a pre-outage `available: true` snapshot would
			// otherwise resume this subagent immediately and fail again.
			if (mu.providerId && mu.nugModelId) {
				markNugCachedModelUnavailable(mu.providerId, mu.nugModelId);
			}
			if (!(await suspendUntilNugModelAvailable(mu))) {
				aborted = true;
				break;
			}
			transientRetries = 0;
			continue;
		}

		// --- Transient API error: retry with exponential backoff ---
		// [continuation-source: transient-error]
		if (result.retryableError && !signal.aborted) {
			transientRetries++;
			const { shouldRetry } = await handleTransientError({
				narratorId,
				error: result.retryableError,
				retryCount: transientRetries,
				maxRetries: result.bypassRetryLimit ? -1 : getMaxTransientRetries(),
				signal,
			});
			if (shouldRetry) {
				// Finalize or clean up partial message from the failed turn.
				// If tools were already executed, the message is kept so the
				// rebuilt history includes them.
				const partialId = eventContext.getPartialMessageId();
				let keptPartial = false;
				if (partialId) {
					keptPartial = await finalizeOrCleanupPartialMessage(partialId, narratorId);
					eventContext.setPartialMessageId(undefined);
				}
				if (keptPartial) {
					prompt = "";
				}
				// Rebuild history from DB so the retry includes any tool calls
				// that were persisted before the API error occurred. Without this,
				// the retry would use stale history and the model would repeat
				// the same tool calls it already executed.
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;
				currentConversationId = randomUUID();
				resetUpstreamSessionOnNextRequest = true;
				continue;
			}
			// If aborted during backoff sleep, don't mark as error — the
			// caller will handle the abort status.
			if (signal.aborted) {
				aborted = true;
				break;
			}
			hasError = true;
			finalText = `Error: ${result.retryableError}`;
			break;
		}

		// --- Codex WebSocket silent disconnect: retry with the transient backoff ---
		//
		// The upstream socket closed quietly, so the turn produced no answer and no
		// error either. This used to only clean up the partial message and fall through
		// to the end of the run, which delivered whatever text happened to be lying
		// around (or nothing) to the parent as the subagent's conclusion — a dropped
		// connection silently became "the work is done".
		//
		// Same treatment as the primary loop: it counts against `transientRetries` and
		// goes through `handleTransientError`, which applies the backoff and warns the
		// parent panel. Placed BEFORE the success reset below, because that reset would
		// otherwise zero the counter every pass and turn the bounded retry into an
		// unbounded reconnect loop.
		// [continuation-source: silent-disconnect]
		const disconnectPlan = planSubagentSilentDisconnect(
			result,
			transientRetries,
			getMaxTransientRetries(),
			signal.aborted,
		);
		if (disconnectPlan.action !== "none") {
			transientRetries = disconnectPlan.retries;
			// Runs for both outcomes: it applies the backoff and warns the parent panel,
			// and on the exhausted path it is what logs the final give-up.
			const { shouldRetry } = await handleTransientError({
				narratorId,
				error: SUBAGENT_SILENT_DISCONNECT_ERROR,
				retryCount: transientRetries,
				maxRetries: getMaxTransientRetries(),
				signal,
			});

			// The partial turn is finalized either way: on retry it becomes history the
			// rebuilt request includes (so the model does not repeat executed tools), and
			// on giving up it is the transcript of what did happen.
			const partialId = eventContext.getPartialMessageId();
			let keptPartial = false;
			if (partialId) {
				keptPartial = await finalizeOrCleanupPartialMessage(partialId, narratorId);
				eventContext.setPartialMessageId(undefined);
			}

			// Aborted during the backoff sleep: not an error, the caller owns the status.
			if (signal.aborted) {
				aborted = true;
				break;
			}
			if (shouldRetry && disconnectPlan.action === "retry") {
				if (keptPartial) prompt = "";
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;
				currentConversationId = randomUUID();
				resetUpstreamSessionOnNextRequest = true;
				continue;
			}
			// Retries exhausted. The parent must be told the turn died rather than
			// receiving a stale or empty conclusion as if it had succeeded.
			logger.warn("Subagent stopped: upstream socket kept closing silently", {
				narratorId,
				parentNarratorId,
				retries: transientRetries,
			});
			hasError = true;
			finalText = `Error: ${SUBAGENT_SILENT_DISCONNECT_ERROR}`;
			break;
		}

		// A successful pass right after transient retries: tell the parent panel
		// the subagent has recovered (see subagentRetryRecoveredBroadcast).
		const retryRecovered = subagentRetryRecoveredBroadcast(
			transientRetries,
			parentNarratorId,
			narratorId,
		);
		if (retryRecovered) {
			broadcastToNarrator(parentNarratorId, retryRecovered);
		}
		// Reset transient retry counter on success
		transientRetries = 0;

		// --- Turn budget spent while the spec still has open work ---
		//
		// A pass that exhausts `maxTurns` is not a failed pass: it did real work and was
		// cut off by a per-pass budget. Treating it as terminal (which this loop used to
		// do) means a subagent doing exactly what it was told loses its remaining work at
		// an arbitrary boundary, and the parent receives "Error: max turns exceeded" as
		// the answer.
		//
		// ⚠️ The bound CANNOT come from turn counts. Each continuation pass is granted a
		// fresh budget, so "how many turns has this run used" is unbounded by construction.
		// The only thing that bounds it is progress plus a per-run pass cap, which is what
		// `planSubagentContinuation` applies — see its own note.
		//
		// Placed before the interruption branch (and thus before anything that would end
		// the run) for the same reason as on the primary side: max-turns marks the result
		// as an error, so a continuation attempt has to come first or the run ends instead.
		// [continuation-source: max-turns-spec-continuation]
		if (result.maxTurnsExceeded && !signal.aborted && !aborted) {
			if (await maybeContinueForSpec("maxTurns", false)) continue;
		}

		// Completion-limit and resumable stream interruptions both leave a valid partial
		// assistant turn in the DB. Rebuild history and continue instead of returning that
		// partial text as the subagent's terminal result.
		// [continuation-source: interruption-continuation]
		const interruptionPlan = planTurnInterruption(result, interruptionRetries, {
			suppressed: signal.aborted,
			maxRetries: MAX_SUBAGENT_INTERRUPTION_RETRIES,
		});
		interruptionRetries = interruptionPlan.retries;
		if (interruptionPlan.action !== "none") {
			const continuationLogLabel = interruptionContinuationLabel(
				interruptionPlan.reason,
				"subagent",
			);
			if (interruptionPlan.action === "stop") {
				logger.warn(`${continuationLogLabel}: max retries reached, stopping`, {
					narratorId,
					parentNarratorId,
					retries: interruptionPlan.retries,
				});
			} else {
				// The interrupted pass already flushed its partial assistant content. Reload it
				// before the next request so continuation starts from the persisted transcript.
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;

				if (interruptionPlan.action === "replay") {
					logger.info(`${continuationLogLabel}: replaying interrupted tool-result turn`, {
						narratorId,
						parentNarratorId,
						retries: interruptionPlan.retries,
					});
					prompt = "";
				} else {
					const continueText = getToolMessage(interruptionPlan.promptKey, locale as Locale);
					const userMsg = await narratorService.persistSubagentUserMessage(
						narratorId,
						continueText,
						toolUseId,
					);
					broadcastToNarrator(parentNarratorId, {
						type: "user_message",
						narratorId: parentNarratorId,
						message: userMsg,
					});
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: { ...userMsg, parentToolUseId: null },
					});
					prompt = continueText;
				}
				continue;
			}
		}

		// A silent disconnect on an ALREADY-ABORTED run: the retry branch above skips
		// those (there is nothing to retry into), so the partial turn is finalized here
		// instead. Retained rather than folded into that branch because an abort must
		// not pay for a backoff sleep before its transcript is written.
		if (result.silentDisconnect) {
			const partialId = eventContext.getPartialMessageId();
			eventContext.setPartialMessageId(undefined);
			if (partialId) {
				await finalizeOrCleanupPartialMessage(partialId, narratorId);
			}
		}

		// --- Check for buffered user message (sent from subagent page) ---
		// [continuation-source: buffered-message]
		if (!signal.aborted && !hasError) {
			const consumedBuffered = await consumeNextBufferedSubagentMessage({
				narratorId,
				parentNarratorId,
				toolUseId,
				model,
				provider: resolveProvider(model),
				cwd,
				pruneBoundaryId,
				locale,
			});
			if (consumedBuffered) {
				prompt = consumedBuffered.prompt;
				history = consumedBuffered.history;
				trailingToolResults = consumedBuffered.trailingToolResults;
				currentUserId = consumedBuffered.userId ?? null;
				currentConversationId = randomUUID();
				resetUpstreamSessionOnNextRequest = true;
				continue;
			}
		}

		// --- The subagent's OWN Dynamic Spec still has open work ---
		//
		// The digest already reaches a subagent (`getAfterToolsInjections` builds it on a
		// cadence), so it was being told about its open tasks and then the run ended with
		// them still `doing`: the reminder existed, the loop that closes it did not.
		//
		// Deliberately AFTER the buffered-message consumer, matching the primary order:
		// real input outranks the loop's own self-continuation. A message someone just sent
		// this subagent is more current than a task it wrote for itself earlier.
		//
		// `hasError` suppresses it: a run already ending in a stated failure must not be
		// extended, or the error text is replaced by whatever the extra pass produces.
		// [continuation-source: spec-continuation]
		if (!signal.aborted && !aborted && !hasError) {
			if (await maybeContinueForSpec("spec", false)) continue;
		}

		if (!needsRestart || signal.aborted || hasError) break;

		// Do not key this decision on finalText: it is filled in after the loop, so an
		// empty value here does not mean the subagent produced nothing.
		// [continuation-source: compact-restart]
		const restartDecision = planSubagentCompactRestart({
			result,
			compactConsumedInLoop,
			compactDoneFlag,
		});
		if (restartDecision.action === "finish") {
			logger.info("Subagent skipping restart after compact", {
				narratorId,
				parentNarratorId,
				reason: restartDecision.reason,
				finalTextLength: finalText.length,
			});
			needsRestart = false;
			compactDoneFlag = false;
			break;
		}
		compactDoneFlag = false;

		// Compact completed mid-turn — restart with fresh history
		logger.info("Subagent restarting after compact", { narratorId, parentNarratorId });

		// Reload fresh state — compact clears prune boundary
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
		narratorReasoningEffort = freshNarrator.reasoningEffort ?? undefined;
		narratorFastModeOverride = normalizeBooleanOverride(freshNarrator.fastModeOverride);

		// Sync model from the active subagent settings map (may have been changed via UI)
		const saSettings = activeSubagentSettings.get(narratorId);
		if (saSettings && saSettings.model !== model) {
			model = saSettings.model;
			provider = resolveProvider(model);
		}

		// Rebuild system prompt with new contextSummary
		if (opts.rebuildSystemPrompt) {
			systemPrompt = await opts.rebuildSystemPrompt(freshNarrator.contextSummary);
		}

		// Reload history from post-compact messages (no prune after compact)
		const rebuilt = await loadSubagentHistory(narratorId, model, resolvedProvider, null);
		history = rebuilt.history;
		trailingToolResults = rebuilt.trailingToolResults;
	}

	// Backfill an empty result when the run ended cleanly but left no in-memory
	// final text. This happens when a compact completes and the restarted turn
	// ends before producing a new assistant_message (the compact marker is now at
	// the tail, so the last real answer sits just before the boundary). Recover it
	// from history so the parent's Await / background result is not "(no output)".
	if (!finalText.trim() && !hasError && !aborted && !signal.aborted && !contextLengthExceeded) {
		const latest = await narratorService.getLatestAssistantTextAndId(narratorId).catch(() => null);
		if (latest?.text.trim()) {
			finalText = latest.text;
		} else {
			const compactSummary = await narratorService
				.getLatestSuccessfulCompactSummary(narratorId)
				.catch(() => null);
			if (compactSummary?.summary.trim()) finalText = compactSummary.summary;
		}
	}

	// The continuation bound stopped this run with spec work still open. Say so in the
	// text the parent receives: the run ends normally (the work that happened is real,
	// and flagging `hasError` would discard an explore/plan conclusion), so without this
	// note a truncated answer is indistinguishable from a finished one.
	//
	// APPENDED rather than substituted, and only after the backfill above, so the
	// subagent's own conclusion stays the primary content. An aborted run is skipped:
	// its ending was decided by the abort, not by this bound.
	if (continuationStopNote && !aborted && !signal.aborted) {
		finalText = finalText.trim()
			? `${finalText.trim()}\n\n${continuationStopNote}`
			: continuationStopNote;
	}

	unregisterActiveSubagent(narratorId);
	return { finalText, hasError, contextLengthExceeded, aborted: aborted || signal.aborted };
}
