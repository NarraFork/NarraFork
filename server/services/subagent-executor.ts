import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type FileReferenceSnapshot, fileReferenceMessageForDisplay } from "@shared/file-reference";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators } from "../db/schema";
import { projectFileReferenceText } from "../lib/agent/file-reference-projection";
import { buildAttachedFilesHint } from "../lib/attached-files";
import { AppError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { resolveEffectiveModel, resolveProvider } from "../lib/settings";
import {
	type ImageRef,
	imageRefToContentBlock,
	saveTextFileToWorktree,
	type TextFileRef,
} from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	agentMessageDeliveryBody,
	type MailboxDeliveryConsumption,
} from "./agent-message-delivery";
import { buildAgentMessageOrigin } from "./agent-message-origin";
import { createRuntimeEventContext } from "./agent-runtime/context";
import { buildRuntimeHistory } from "./agent-runtime/history";
import {
	claimInboxHead,
	enqueueInboxAgent,
	hasQueuedInboxRowSync,
	type InboxAgentMetadata,
	inboxAgentText,
	inboxClaim,
	inboxConsumption,
	inboxDelivery,
	inboxMetadata,
	type MaterializedInboxUserMessage,
	materializeClaimedInboxUserMessage,
	peekInbox,
	releaseInboxClaim,
	withInboxOwner,
} from "./agent-runtime/inbox";
import type { RuntimeForegroundControl } from "./agent-runtime/input";
import type { MailboxClaim } from "./agent-runtime/mailbox-types";
import { runAgentLoopUnlocked } from "./agent-runtime/orchestrator";
import {
	claimExecutionPass,
	clearRuntimeBufferSoftStop,
	type ExecutionOwner,
	hasRuntimeBufferSoftStop,
	requestRuntimeBufferSoftStop,
	tryClaimExecution,
} from "./agent-runtime/ownership";
import { getRuntimeQueuePort, type RuntimeMailboxRow } from "./agent-runtime/runtime-queue-port";
import type { CustomSubagentDef } from "./custom-subagent-service";
import { knowledgeService } from "./knowledge-service";
import {
	cleanupBufferedTextFilesAsync,
	clearBufferedMessages,
	deleteBufferedTextFile,
	enqueueBufferedMessage,
	getBufferedMessages,
	getBufferedMessagesAsync,
	persistAdditionalBufferedTextFiles,
	projectMailboxUserMessage,
	removeBufferedMessage,
	reorderBufferedMessages,
	updateBufferedMessage,
} from "./narrator-buffer";
import type { EventHandlerContext } from "./narrator-event-handler";
import type { ExecuteLoopResult } from "./narrator-executor";
import { buildSystemInjectionBlock, deliverInjection } from "./narrator-injection";
import { getNarratorMessageRefsPort } from "./narrator-refs/store";
import { narratorService } from "./narrator-service";
import { toBufferSummary } from "./narrator-session";
import {
	type ActiveNarrator,
	activeNarrators,
	knowledgeInjectionCycleStates,
	registerActiveSubagent,
	unregisterActiveSubagent,
	withNarratorStartAdmission,
	withNarratorWorkAdmission,
} from "./narrator-session-state";
import { abandonSessionTreeSnapshots } from "./narrator-tree-snapshot-hooks";
import { projectPendingInjection } from "./parent-injection-queue";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";
import {
	clearSubagentKnowledgeCycle,
	getSubagentKnowledgeCycle,
	scanSubagentTextForKnowledge,
} from "./subagent-knowledge-injection";
import { planTurnInterruption, type TurnInterruptionPlan } from "./turn-continuation-decisions";
import type { UpdateExecutionLease } from "./update-coordinator";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SubagentBufferedMessage {
	state?: "queued" | "failed";
	error?: string | null;
	_mailboxClaim?: MailboxClaim;
	_mailboxConsumption?: MailboxDeliveryConsumption;
	_stagingId?: string;
	delivery?: import("./agent-message-delivery").AgentMessageDelivery;
	id: string;
	text: string;
	images?: ImageRef[];
	textFiles?: File[];
	fileReferences?: FileReferenceSnapshot[];
	commandText?: string | null;
	createdBy?: string | null;
	prePromptBashCommand?: string;
	bufferedAt: string;
	priority?: boolean;
}

export interface SubagentExecOptions {
	control?: RuntimeForegroundControl;
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
	/** Stable across passes of one run; a legacy attribution filter, not an attempt receipt. */
	fileChangeStartedAt?: string;
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
	initialPrePromptBashCommand?: string;
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

function projectSubagentInboxMessage(row: RuntimeMailboxRow): SubagentBufferedMessage {
	if (row.kind === "user_input") {
		const user = projectMailboxUserMessage(row);
		return {
			...user,
			prePromptBashCommand: user.bashCommand ?? undefined,
			_mailboxConsumption: inboxConsumption(row),
		};
	}
	return {
		id: row.id,
		text: inboxAgentText(row),
		delivery: inboxDelivery(row),
		createdBy: row.createdBy,
		bufferedAt: row.bufferedAt,
		...(row.state === "claimed" ? { _mailboxClaim: inboxClaim(row) } : {}),
	};
}
function acceptsBufferedSubagentInput(
	row: Pick<RuntimeMailboxRow, "kind" | "metadataJson">,
): boolean {
	return (
		row.kind === "user_input" ||
		(row.kind === "agent_message" && inboxMetadata<InboxAgentMetadata>(row).channel === "buffer")
	);
}
async function peekSubagentBufferedMessage(
	narratorId: string,
): Promise<SubagentBufferedMessage | undefined> {
	const row = await peekInbox(narratorId);
	return row && acceptsBufferedSubagentInput(row) ? projectSubagentInboxMessage(row) : undefined;
}
/** Read-only legacy inspection; this object owns no queue or mutable arrays. */
export function getSubagentBufferedMessagesMap() {
	return {
		get: (id: string) => getSubagentBufferedMessages(id),
		has: (id: string) => getSubagentBufferedMessages(id).length > 0,
	};
}

/** Stop the current subagent loop at the next safe post-tool boundary. */
export function requestSubagentBufferedMessageSoftStop(subagentId: string): void {
	requestRuntimeBufferSoftStop(subagentId);
}

/** Whether a queued user message should stop this loop at its next safe boundary. */
export async function shouldStopSubagentForBufferedMessage(subagentId: string): Promise<boolean> {
	return hasRuntimeBufferSoftStop(subagentId) && !!(await peekInbox(subagentId));
}

/**
 * The synchronous loop-boundary form of {@link shouldStopSubagentForBufferedMessage}.
 * The agent loop's `shouldStop` callback cannot await; on SQLite the queue re-check
 * reads the mailbox synchronously. On PostgreSQL the subagent loop is not wired this
 * phase, so the in-memory soft-stop flag — set by the queue producer itself — is the
 * whole answer (there is no running loop to stop).
 */
export function shouldStopSubagentForBufferedMessageSync(subagentId: string): boolean {
	if (!hasRuntimeBufferSoftStop(subagentId)) return false;
	if (getRuntimeQueuePort()) return true;
	return hasQueuedInboxRowSync(subagentId);
}

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
		"images" | "textFiles" | "fileReferences" | "createdBy" | "prePromptBashCommand"
	>,
	currentUserId: string | null | undefined,
): boolean {
	if (message.images?.length) return false;
	if (message.textFiles?.length) return false;
	// Accepted snapshots must commit before consuming; the in-pass legacy path
	// persists fire-and-forget. Restart at the safe boundary like other attachments.
	if (message.fileReferences?.length) return false;
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
	delivery?: import("./agent-message-delivery").AgentMessageDelivery;
	images?: ImageRef[];
	textFiles?: File[];
	fileReferences?: FileReferenceSnapshot[];
	commandText?: string | null;
	createdBy?: string | null;
	prePromptBashCommand?: string;
	position?: "front" | "back";
}

export async function pushSubagentBufferedMessage(
	subagentId: string,
	text: string,
	options?: SubagentBufferedMessageOptions,
): Promise<{ ok: boolean; bufferedAt: string; id: string; full?: boolean; duplicate?: boolean }> {
	if (options?.delivery) {
		const result = await enqueueInboxAgent(options.delivery, text, {
			createdBy: options.createdBy,
		});
		if (result.delivery.state === "cancelled" || result.delivery.state === "failed")
			throw new Error(`Previous delivery is ${result.delivery.state}; explicit retry is required`);
		return {
			ok: true,
			bufferedAt: result.delivery.bufferedAt,
			id: result.delivery.id,
			duplicate: result.status === "duplicate",
		};
	}
	return enqueueBufferedMessage(
		subagentId,
		text,
		options?.images,
		options?.commandText,
		options?.createdBy,
		null,
		options?.textFiles,
		options?.position,
		options?.prePromptBashCommand,
		options?.fileReferences,
		"fifo",
	);
}

/** Queue direct user feedback and optionally request the next safe stop boundary. */
export async function bufferSubagentUserMessage(
	subagentId: string,
	text: string,
	options?: Omit<SubagentBufferedMessageOptions, "position"> & {
		priority?: boolean;
		requestSoftStop?: boolean;
	},
): Promise<{ ok: boolean; bufferedAt: string; id: string; full?: boolean }> {
	const { priority = false, requestSoftStop = true, ...messageOptions } = options ?? {};
	const result = await pushSubagentBufferedMessage(subagentId, text, {
		...messageOptions,
		position: priority ? "front" : "back",
	});
	if (result.ok && requestSoftStop) requestSubagentBufferedMessageSoftStop(subagentId);
	return result;
}

/** Clear the entire subagent buffer queue and any pending post-tool stop. */
export async function clearSubagentBufferedMessages(subagentId: string): Promise<void> {
	await clearBufferedMessages(subagentId);
	clearRuntimeBufferSoftStop(subagentId);
}

/** Get the full subagent buffer queue (for REST hydration). */
export function getSubagentBufferedMessages(subagentId: string): SubagentBufferedMessage[] {
	return getBufferedMessages(subagentId).map((message) => ({
		...message,
		prePromptBashCommand: message.bashCommand ?? undefined,
	}));
}

export async function getSubagentBufferedMessagesAsync(
	subagentId: string,
): Promise<SubagentBufferedMessage[]> {
	return (await getBufferedMessagesAsync(subagentId)).map((message) => ({
		...message,
		prePromptBashCommand: message.bashCommand ?? undefined,
	}));
}

/**
 * Edit the text of one queued subagent message. Returns false when the queue or
 * message id does not exist, so callers can fall through to the primary-narrator
 * queue (the two queues live in separate maps and never share ids).
 */
export async function updateSubagentBufferedMessage(
	subagentId: string,
	messageId: string,
	text: string,
	opts?: { images?: ImageRef[]; textFiles?: File[]; fileReferences?: FileReferenceSnapshot[] },
): Promise<boolean> {
	if (!(await getBufferedMessagesAsync(subagentId)).some((message) => message.id === messageId))
		return false;
	const savedFiles =
		opts?.textFiles === undefined
			? undefined
			: await persistAdditionalBufferedTextFiles(messageId, opts.textFiles, []);
	let updated = false;
	try {
		updated = await updateBufferedMessage(subagentId, messageId, text, { ...opts, savedFiles });
		return updated;
	} finally {
		if (!updated) for (const file of savedFiles ?? []) deleteBufferedTextFile(file);
	}
}

/**
 * Remove one queued subagent message. When the queue becomes empty the pending
 * post-tool soft stop is dropped too, otherwise the running turn would stop at
 * the next tool boundary with nothing left to resume.
 */
export async function removeSubagentBufferedMessage(
	subagentId: string,
	messageId: string,
): Promise<boolean> {
	const removed = await removeBufferedMessage(subagentId, messageId);
	if (!(await peekInbox(subagentId))) clearRuntimeBufferSoftStop(subagentId);
	return removed;
}

/** Reorder the subagent buffer queue by an exact list of its message ids. */
export async function reorderSubagentBufferedMessages(
	subagentId: string,
	orderedIds: string[],
): Promise<boolean> {
	return reorderBufferedMessages(subagentId, orderedIds);
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
	provider = resolveProvider(subagentModel),
	locale: string = "en",
	userId: string | null = null,
): EventHandlerContext {
	return createRuntimeEventContext({
		narratorId: subagentId,
		broadcastTargetId: parentNarratorId,
		conversationId,
		parentToolUseId,
		subagentModel,
		model: subagentModel,
		provider,
		locale,
		userId,
	});
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
	options?: { interrupted?: boolean; timedOut?: boolean; owner?: ExecutionOwner },
): Promise<void> {
	if (options?.owner && !options.owner.isCurrent()) return;
	// Accepted mailbox entries survive the terminal window for the next eligible run.
	clearRuntimeBufferSoftStop(subagentId);
	// The knowledge de-dup set has the same lifetime as the team inbox: it is per-run
	// state, and the durable record of what was injected is the ledger table, which the
	// next run reloads. Dropping it only keeps the map from growing.
	clearSubagentKnowledgeCycle(subagentId);
	knowledgeInjectionCycleStates.delete(subagentId);

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
	if (options?.owner && !options.owner.isCurrent()) return;
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
	currentInput?: string,
): Promise<import("../lib/agent/provider").BuiltHistory> {
	return buildRuntimeHistory({
		narratorId,
		model,
		provider,
		profile: "subagent",
		currentInput,
	});
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

async function persistNextBufferedSubagentMessage(opts: {
	expectedMessageId?: string;
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	cwd: string;
}): Promise<{
	buffered: SubagentBufferedMessage;
	userMsg:
		| Awaited<ReturnType<typeof narratorService.persistSubagentUserMessage>>
		| MaterializedInboxUserMessage;
} | null> {
	const { narratorId, parentNarratorId, toolUseId } = opts;
	const row = await claimInboxHead(
		narratorId,
		(head) =>
			acceptsBufferedSubagentInput(head) &&
			(opts.expectedMessageId === undefined || head.id === opts.expectedMessageId),
	);
	if (!row) return null;
	let buffered: SubagentBufferedMessage;
	try {
		buffered = projectSubagentInboxMessage(row);
	} catch (error) {
		await releaseInboxClaim(row, error);
		throw error;
	}
	const hadSoftStop = await shouldStopSubagentForBufferedMessage(narratorId);
	let userMsg:
		| Awaited<ReturnType<typeof narratorService.persistSubagentUserMessage>>
		| MaterializedInboxUserMessage;
	try {
		const textFiles = await saveBufferedTextFiles(opts.cwd, buffered.textFiles);
		if (getNarratorMessageRefsPort()) {
			// PostgreSQL: the queue's materialize section commits message + ref + mailbox flip
			// atomically. The block assembly mirrors narratorService.persistSubagentUserMessage
			// exactly — the SQLite placement path below stays the reference implementation.
			const delivery = buffered.delivery;
			if (delivery && delivery.recipientNarratorId !== narratorId)
				throw new ValidationError("Agent delivery recipient does not match message recipient");
			const origin = delivery ? buildAgentMessageOrigin(delivery.sender) : undefined;
			const contentJson: unknown[] = [
				...(buffered.images ?? []).map((image) => imageRefToContentBlock(image)),
				...textFiles.map((file) => ({
					type: "text_file" as const,
					filename: file.filename,
					size: file.size,
					filePath: file.filePath,
				})),
				...(buffered.fileReferences ?? []),
				{ type: "text", text: buffered.text },
				...(delivery
					? [buildSystemInjectionBlock("subagent_message", agentMessageDeliveryBody(delivery))]
					: []),
			];
			const effectiveText =
				(!buffered.text.trim() && (buffered.images?.length ?? 0) > 0
					? "[user sent image(s)]"
					: buffered.text) + buildAttachedFilesHint(textFiles);
			const persisted = await materializeClaimedInboxUserMessage({
				claim: inboxClaim(row),
				reservedMessageId: delivery?.recipientMessageId ?? row.recipientMessageId,
				narratorId,
				text: effectiveText,
				contentBlocks: contentJson,
				commandText: buffered.commandText,
				createdBy: buffered.createdBy,
				origin,
				parentToolUseId: toolUseId,
			});
			// Withhold the creator for machine-authored text, as persistSubagentUserMessage does.
			userMsg = (origin?.origin ?? "user") === "user" ? persisted : { ...persisted, creator: null };
		} else {
			userMsg = await narratorService.persistSubagentUserMessage(
				narratorId,
				buffered.text,
				toolUseId,
				{
					mailboxClaim: inboxClaim(row),
					images: buffered.images,
					textFiles,
					fileReferences: buffered.fileReferences,
					delivery: buffered.delivery,
					commandText: buffered.commandText,
					createdBy: buffered.createdBy,
				},
			);
		}
	} catch (error) {
		await releaseInboxClaim(row, error);
		if (hadSoftStop) requestSubagentBufferedMessageSoftStop(narratorId);
		throw error;
	}
	try {
		broadcastToNarrator(parentNarratorId, {
			type: "user_message",
			narratorId: parentNarratorId,
			message: fileReferenceMessageForDisplay(userMsg),
		});
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: fileReferenceMessageForDisplay({ ...userMsg, parentToolUseId: null }),
		});
		if (buffered._stagingId) await cleanupBufferedTextFilesAsync(buffered._stagingId);
		if (!(await getBufferedMessagesAsync(narratorId)).length)
			clearRuntimeBufferSoftStop(narratorId);
		const remaining = toBufferSummary(await getSubagentBufferedMessagesAsync(narratorId));
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
	} catch (error) {
		logger.warn("Mailbox user message committed; broadcast deferred", {
			narratorId,
			error: String(error),
		});
	}
	return { buffered, userMsg };
}

/** The running-pass path shares the same durable claim/restore boundary as restarts. */
export async function consumeBufferedSubagentMessageInPass(opts: {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	cwd: string;
	currentUserId?: string | null;
}): Promise<{ buffered: SubagentBufferedMessage; text: string } | null> {
	const buffered = await peekSubagentBufferedMessage(opts.narratorId);
	if (
		!buffered ||
		(await shouldStopSubagentForBufferedMessage(opts.narratorId)) ||
		!canDeliverBufferedMessageInPass(buffered, opts.currentUserId)
	)
		return null;
	try {
		const claimed = await persistNextBufferedSubagentMessage({
			...opts,
			expectedMessageId: buffered.id,
		});
		if (!claimed) return null;
		const hint = await deliverBufferedKnowledgeHint({
			narratorId: opts.narratorId,
			parentNarratorId: opts.parentNarratorId,
			toolUseId: opts.toolUseId,
			text: claimed.buffered.text,
			turnUserId: opts.currentUserId,
			locale: activeNarrators.get(opts.narratorId)?.locale,
			inPass: true,
		});
		const text = projectFileReferenceText(claimed.buffered.text, claimed.buffered.fileReferences);
		return { buffered: claimed.buffered, text: hint ? `${text}\n\n${hint}` : text };
	} catch (error) {
		logger.error("Failed to persist injected subagent user message; retained for retry", {
			narratorId: opts.narratorId,
			error: String(error),
		});
		return null;
	}
}

export async function consumeNextBufferedSubagentMessage(opts: {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	model: string;
	provider: string;
	cwd: string;
	locale?: string;
}): Promise<{
	prompt: string;
	/** Raw current input for an orchestrator that will rebuild history itself. */
	currentInput?: string;
	history: unknown[];
	trailingToolResults: unknown[];
	userId?: string | null;
	preservePrincipal?: boolean;
	prePromptBashCommand?: string;
} | null> {
	return withInboxOwner(opts.narratorId, async () => {
		const head = await peekInbox(opts.narratorId);
		if (head && !acceptsBufferedSubagentInput(head)) {
			const row = await claimInboxHead(
				opts.narratorId,
				(candidate) => candidate.kind !== "user_input",
			);
			if (!row) return null;
			try {
				const { deliverPendingInjection } = await import("./narrator-session");
				const text = await deliverPendingInjection(
					opts.narratorId,
					(opts.locale ?? "en") as Locale,
					"idle",
					"none",
					{
						...projectPendingInjection(row),
						mailboxClaim: inboxClaim(row),
						recipientMessageId: row.recipientMessageId ?? undefined,
					},
					{ parentNarratorId: opts.parentNarratorId, parentToolUseId: opts.toolUseId },
				);
				const rebuilt = await loadSubagentHistory(
					opts.narratorId,
					opts.model,
					opts.provider,
					text ?? undefined,
				);
				return {
					prompt: rebuilt.trailingUserText ?? text ?? "",
					currentInput: "",
					history: rebuilt.history,
					trailingToolResults: rebuilt.trailingToolResults,
					userId: row.createdBy,
					preservePrincipal: true,
				};
			} catch (error) {
				await releaseInboxClaim(row, error);
				throw error;
			}
		}
		const claimed = await persistNextBufferedSubagentMessage(opts);
		if (!claimed) return null;
		const { buffered, userMsg } = claimed;
		const { narratorId, parentNarratorId, toolUseId, model, provider } = opts;
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

		const modelText = projectFileReferenceText(
			userMsg.contentText ?? buffered.text,
			buffered.fileReferences,
		);
		const rebuilt = await loadSubagentHistory(narratorId, model, provider, modelText);
		// Match the primary loop's currentTurnText: only prepend context the builder
		// extracted. Official Anthropic keeps sys as system history, so replaying the
		// persisted hint itself here would inject it twice.
		const prompt = rebuilt.trailingUserText?.trim()
			? modelText.trim()
				? `${rebuilt.trailingUserText}\n\n${modelText}`
				: rebuilt.trailingUserText
			: modelText;
		return {
			prompt,
			currentInput: modelText,
			history: rebuilt.history,
			trailingToolResults: rebuilt.trailingToolResults,
			userId: buffered.createdBy,
			prePromptBashCommand: buffered.prePromptBashCommand,
		};
	});
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
	inPass?: boolean;
}): Promise<string | undefined> {
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
		const { messageId, turnText } = await deliverInjection(narratorId, {
			content: scan.content,
			body: scan.body,
			source: "knowledge_base_hint",
			// The caller rebuilds history right after this, so the row is picked up from the
			// database; asking for `onNextTurn` text nobody would fold in would be a lie.
			schedule: input.inPass ? "onNextTurn" : "none",
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
		return input.inPass ? (turnText ?? scan.content) : undefined;
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

/** Admit one invocation of the shared runtime; a runner may lend its terminal-lifetime owner. */
export async function executeSubagent(
	opts: SubagentExecOptions,
	borrowedOwner?: ExecutionOwner,
): ReturnType<typeof executeSubagentOwned> {
	const launch = await withNarratorStartAdmission(opts.narratorId, async () => {
		const owner = borrowedOwner ?? tryClaimExecution(opts.narratorId, "subagent");
		if (!owner || owner.narratorId !== opts.narratorId || owner.kind !== "subagent") {
			throw new AppError("Narrator already has an execution owner", 409, "NARRATOR_EXECUTION_BUSY");
		}
		const releasePass = claimExecutionPass(owner);
		if (!releasePass) {
			if (!borrowedOwner) owner.release();
			throw new AppError(
				"Narrator executor is already active or suspended",
				409,
				"NARRATOR_EXECUTION_BUSY",
			);
		}
		// The model and all asynchronous preparation run OUTSIDE the short mutex.
		const completion = withNarratorWorkAdmission(opts.narratorId, () =>
			executeSubagentOwned(opts, owner),
		).finally(() => {
			if (owner.isCurrent()) unregisterActiveSubagent(opts.narratorId);
			releasePass();
			if (!borrowedOwner) owner.release();
		});
		return { completion };
	});
	return launch.completion;
}

async function executeSubagentOwned(
	opts: SubagentExecOptions,
	owner: ExecutionOwner,
): Promise<{
	finalText: string;
	hasError: boolean;
	allowInboxWake: boolean;
	finalUserId: string | null;
	contextLengthExceeded?: boolean;
	aborted?: boolean;
}> {
	// Replays/conclusion updates need the same bounded legacy window as the live
	// result. Reuse an existing timing column; never treat it as v2 attempt evidence.
	if (opts.fileChangeStartedAt) {
		try {
			await db
				.update(narrators)
				.set({ turnStartedAt: opts.fileChangeStartedAt })
				.where(eq(narrators.id, opts.narratorId));
		} catch (error) {
			logger.debug("Failed to persist subagent attribution window", {
				narratorId: opts.narratorId,
				error: String(error),
			});
		}
	}
	// The runtime session below owns both the mandatory hooks and their finalizer.
	return runSubagentRuntime(opts, owner);
}

async function runSubagentRuntime(
	opts: SubagentExecOptions,
	owner: ExecutionOwner,
): Promise<{
	finalText: string;
	hasError: boolean;
	allowInboxWake: boolean;
	finalUserId: string | null;
	contextLengthExceeded?: boolean;
	aborted?: boolean;
}> {
	// The owner is already admitted. Do not call ensureNarrator here: it holds a
	// start transaction while creating its session and would serialize async preparation.
	const row = await narratorService.getById(opts.narratorId);
	const chapter = row.chapterId
		? await db.query.chapters.findFirst({
				where: eq(chapters.id, row.chapterId),
				columns: { projectId: true },
			})
		: null;
	const model = resolveEffectiveModel(opts.model);
	const active: ActiveNarrator = {
		narratorId: opts.narratorId,
		conversationId: randomUUID(),
		cwd: opts.cwd,
		model,
		provider: resolveProvider(model),
		systemPrompt: opts.systemPrompt,
		events: new EventEmitter(),
		alive: true,
		locale: opts.locale as Locale,
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
		// Freeze a legacy omitted principal at run admission. Explicit null is anonymous.
		_currentUserId:
			opts.userId !== undefined
				? opts.userId
				: (activeNarrators.get(opts.parentNarratorId)?._currentUserId ?? null),
		_defaultDeviceId: row.defaultDeviceId,
		_chapterId: row.chapterId ?? undefined,
		_projectId: chapter?.projectId ?? undefined,
		reasoningEffort: row.reasoningEffort,
		_reasoningEffortRef: row.reasoningEffort,
		_modelRef: row.model ?? opts.model,
		_turnStartedAt: opts.fileChangeStartedAt ?? new Date().toISOString(),
	};
	active._isInGitRepo =
		!!row.chapterId ||
		(await import("./git-service")
			.then(({ gitService }) => gitService.isGitRepo(opts.cwd))
			.catch(() => false));
	if (!owner.isCurrent())
		throw new AppError("Subagent execution owner expired", 409, "NARRATOR_EXECUTION_BUSY");
	activeNarrators.set(opts.narratorId, active);
	// Legacy child scan helpers and the shared pass use the same compact-cycle object.
	knowledgeInjectionCycleStates.set(opts.narratorId, getSubagentKnowledgeCycle(opts.narratorId));
	const initialController = active.abortController;
	const abort = () => initialController.abort(opts.signal.reason);
	opts.signal.addEventListener("abort", abort, { once: true });
	if (opts.signal.aborted) abort();
	registerActiveSubagent(opts.narratorId, active.model, active.reasoningEffort);
	try {
		const result = await runAgentLoopUnlocked(active, owner, opts.prompt, undefined, {
			kind: "subagent",
			parentNarratorId: opts.parentNarratorId,
			parentToolUseId: opts.toolUseId,
			subagentType: opts.subagentType,
			customDefinition: opts.customDef,
			systemPrompt: opts.systemPrompt,
			initialModel: opts.model,
			rebuildSystemPrompt: opts.rebuildSystemPrompt,
			initialHistory: opts.initialHistory,
			initialTrailingToolResults: opts.initialTrailingToolResults,
			initialPrePromptBashCommand: opts.initialPrePromptBashCommand,
			control: opts.control,
		});
		return {
			finalText: result.finalText ?? "",
			hasError: result.hasError ?? false,
			allowInboxWake: result.allowInboxWake === true,
			// Executor may consume another user's message internally. Null is authoritative.
			finalUserId: active._currentUserId ?? null,
			contextLengthExceeded: result.contextLengthExceeded,
			aborted:
				result.aborted || (opts.control ? opts.control.proxy.signal.aborted : opts.signal.aborted),
		};
	} finally {
		opts.signal.removeEventListener("abort", abort);
		opts.control?.cleanupTurnAbort?.();
		if (owner.isCurrent()) {
			abandonSessionTreeSnapshots(active, opts.narratorId);
			active._loopRunning = false;
			active.alive = false;
			if (activeNarrators.get(opts.narratorId) === active) activeNarrators.delete(opts.narratorId);
		}
	}
}
