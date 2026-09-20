import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { FileReferenceContext } from "@shared/file-reference";
import {
	projectSubagentToolInputSummary,
	type SubagentToolInputSummary,
} from "@shared/subagent-tool-summary";
import type { ToolProgressPayload } from "@shared/tool-progress";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
	apiRequests,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import type { AgentEvent } from "../lib/agent";
import { summaryGenerate } from "../lib/agent";
import {
	cleanupPartialImageGenerationResults,
	saveImageGenerationResult,
} from "../lib/agent/image-generation";
import {
	type ApiRequestHandle,
	finishApiRequest,
	startApiRequest,
} from "../lib/api-request-tracker";
import { updateCustomApiQuotaByPrefix } from "../lib/custom-api-quota-cache";
import { withDbRetry } from "../lib/db-resilience";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import {
	DEFAULT_CONTEXT_THRESHOLDS,
	LARGE_CONTEXT_BOUNDARY,
	resolveTranslationModelOverride,
	settings,
} from "../lib/settings";
import { buildUsageDataFromSnapshot, updateMessageUsage } from "../lib/usage-tracking";
import { dualBroadcastToNarrator } from "../websocket/narrator-dual-broadcast";
import { broadcastToNarrator, type NarratorServerMessage } from "../websocket/narrator-ws";
import { FileReferenceContextTracker } from "./file-reference-context";
import { bumpNarratorMessageVersion, narratorPersistence } from "./narrator-persistence";
import type { EnterPlanModeToolResultCommit } from "./narrator-plan-mode";
import {
	enrichToolUseBlocks,
	narratorService,
	truncateJson,
	truncateToolIO,
} from "./narrator-service";
import { recordOutputChunk } from "./output-stats";

/**
 * Finish an already-started tool after its loop has drained/aborted. This intentionally
 * takes no EventHandlerContext: a newer turn may own the streaming snapshot and hooks.
 * Only the original execution receipt can update history; never recover it by provider id.
 */
export async function persistDetachedToolResult(
	narratorId: string,
	event: Extract<AgentEvent, { type: "tool_result" }>,
): Promise<void> {
	const binding = event.toolCallBinding;
	if (!binding) {
		throw new CriticalEventPersistenceError("Detached tool result has no execution receipt");
	}
	// The generator is already gone, so a transient lock cannot rely on its normal
	// tool_result retry path. Retry asynchronously and retain the same CAS authority.
	const affected = await withDbRetry(
		() =>
			narratorPersistence.updateToolCallResult(event.toolUseId, {
				expectedBinding: { ...binding, narratorId },
				output: event.metadata ? { _text: event.output, _metadata: event.metadata } : event.output,
				input: event.brokenInputOverride ?? event.updatedInput ?? event.input,
				status: event.isError ? "fail" : "success",
				errorMessage: event.isError ? event.output : undefined,
				durationMs: event.durationMs,
				permissionStartedAt: event.permissionStartedAt,
				executionStartedAt: event.executionStartedAt,
				completedAt: event.completedAt,
			}),
		{ label: "persistDetachedToolResult", maxRetries: 3 },
	);
	if (!affected) return;

	// Refresh persisted history, not tool_completed (which mutates live streaming
	// state by toolUseId). Project the current row so a newer attempt remains visible.
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, affected.messageId),
		with: { toolCalls: true },
	});
	const ref = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, affected.messageId),
		),
		columns: { seq: true },
	});
	if (!message || !ref) return;
	const owner = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { type: true, parentNarratorId: true },
	});
	const broadcastTargetId =
		owner?.type === "subagent" ? (owner.parentNarratorId ?? narratorId) : narratorId;
	const projected = enrichToolUseBlocks(truncateToolIO([{ ...message, seq: ref.seq }]))[0];
	dualBroadcastToNarrator(
		{ narratorId, broadcastTargetId, parentToolUseId: message.parentToolUseId },
		{ type: "message_updated", narratorId: broadcastTargetId, message: projected },
	);
}

// === Context types ===

/**
 * Shared context for event processing — configures broadcast targets,
 * persistence options, and mutable state accessors.
 *
 * Both main narrators and subagents provide this; the differences are:
 * - Main narrator: broadcastTargetId === narratorId, has sseEmitter
 * - Subagent: broadcastTargetId === parentNarratorId, has parentToolUseId/subagentModel
 */
export interface TokenUsageSnapshot {
	promptTokens?: number;
	inputTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheCreation5mTokens?: number;
	cacheCreation1hTokens?: number;
	contextWindow?: number;
	isEstimated?: boolean;
}

export interface EventHandlerContext {
	/** Production runners require durable receipts; standalone display adapters may omit them. */
	requireToolCallBinding?: boolean;
	/** Narrator ID that owns the messages (subagent's own ID) */
	narratorId: string;
	/** WebSocket broadcast target (subagent → parentNarratorId) */
	broadcastTargetId: string;
	/** SSE emitter for HTTP streaming (main narrator only) */
	sseEmitter?: EventEmitter;
	/** Conversation/session ID for message persistence */
	conversationId: string;
	/** Locale for the narrator session (used for reasoning translation) */
	locale?: string;
	/** Provider prefix (e.g. "nug", "anthropic") for the current session */
	providerPrefix?: string;
	/** Resolved provider for the current turn */
	provider?: string;
	/** Resolved model for the current turn */
	model?: string;

	// --- Mutable state accessors ---
	getContextUsagePct: () => number | undefined;
	getMeterUsage: () => number | undefined;
	getMeterUnit: () => string | undefined;
	getPartialMessageId: () => string | undefined;
	getTokenUsage: () => TokenUsageSnapshot | undefined;
	getTurnStartedAt?: () => string | undefined;
	/** Trusted in-memory execution location, sampled once at the start of each text block. */
	getFileReferenceContext?: () => FileReferenceContext | null | undefined;
	/** Text-lane contexts survive device switches until their own block_complete. */
	fileReferenceContexts?: FileReferenceContextTracker;
	getTtftMs?: () => number | undefined;
	setPartialMessageId: (id: string | undefined) => void;
	setContextUsagePct: (pct: number) => void;
	setMeterData: (usage: number, unit: string) => void;
	setTokenUsage: (usage: TokenUsageSnapshot | undefined) => void;
	setTtftMs?: (ttftMs: number | undefined) => void;

	// --- Substatus management ---
	/** Get current substatus tags for this narrator */
	getSubstatus?: () => Set<string>;
	/** Add a substatus tag and persist+broadcast the change */
	addSubstatus?: (tag: string) => Promise<void>;
	/** Remove a substatus tag and persist+broadcast the change */
	removeSubstatus?: (tag: string) => Promise<void>;

	// --- Subagent-specific ---
	/** Parent tool_use ID that spawned this subagent */
	parentToolUseId?: string;
	/** Subagent's resolved model name (attached to broadcast messages) */
	subagentModel?: string;

	// --- Mutable tracking ---
	/** Tracks cumulative inputCharsTotal per tool_use for delta computation */
	toolUseCharsMap?: Map<string, number>;
	/** Exact narrator_tool_calls row id for each persisted tool_use block. */
	toolCallIdsMap?: Map<string, string>;
	/** Receipts created by this consumer, scoped to the actual message (not inherited maps). */
	toolExecutionReceipts?: Map<
		string,
		{ messageId: string; binding: import("../lib/agent/types").ToolCallBinding }
	>;
	/** Tracks API requests in progress (requestId → request info) */
	apiRequestsMap?: Map<string, ApiRequestHandle>;
	/**
	 * Per-attempt block baselines: requestId → how many blocks the partial assistant
	 * message held when that attempt started writing. `attempt_discarded` truncates
	 * back to its own entry.
	 *
	 * Keyed by requestId rather than kept as a single "current" value because
	 * `api_request_start` is emitted LAZILY by the loop (on the first stream event,
	 * or during request teardown). An attempt that dies before producing anything
	 * therefore emits `attempt_discarded` BEFORE its own `api_request_start`, so a
	 * single mutable baseline would be the previous attempt's — and truncating to it
	 * could delete blocks an earlier, successful attempt committed. Recording the
	 * baseline the first time this attempt is seen (whichever of the two events
	 * arrives first) makes the pairing order-independent.
	 *
	 * Holding it here rather than in the loop keeps the loop free of any knowledge
	 * of how blocks are stored.
	 */
	attemptBlockBaselines?: Map<string, number>;
	/** API requests inserted during this turn and awaiting assistant-message binding */
	pendingApiRequestIds?: string[];
	/** Exact persisted tool-call row ids prepared for EnterPlanMode in this turn. */
	preparedPlanModeToolCalls?: Map<string, string>;
	/** Idempotency guard for already atomically committed EnterPlanMode results. */
	committedPlanModeToolUseIds?: Set<string>;
	/**
	 * Leaked XML tool-call diagnostics buffered by loop requestId until the matching
	 * api_request_end persists the row and yields the real api_requests.id, which the
	 * frontend needs to download the raw SSE dump.
	 */
	pendingLeakedToolCalls?: Map<
		string,
		Array<{
			phase: "stream_captured" | "recovered" | "unrecovered";
			toolUseIds?: string[];
			toolNames?: string[];
			snippet?: string;
		}>
	>;
}

/**
 * Optional hooks for main-narrator-specific behavior.
 * Subagents simply don't provide these.
 */
export class CriticalEventPersistenceError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CriticalEventPersistenceError";
	}
}

export interface EventHooks {
	/** Title tracking after assistant_message */
	onTitleCheck?: (savedId: string) => Promise<{ titleUpdate?: boolean } | null>;
	/** Prepare EnterPlanMode after its assistant message is persisted, without committing state. */
	onPrepareEnterPlanMode?: (
		toolCallId: string,
		toolUseId: string,
		input?: Record<string, unknown>,
	) => Promise<void>;
	/** Atomically commit a prepared EnterPlanMode tool_result and narrator plan state. */
	onEnterPlanMode?: (
		toolCallId: string,
		toolUseId: string,
		result: EnterPlanModeToolResultCommit,
	) => Promise<void>;
	/** Discard a prepared EnterPlanMode call after failure, denial, or abort. */
	onEnterPlanModeFailed?: (toolCallId: string, toolUseId: string) => Promise<void>;
	/** ExitPlanMode completed successfully */
	onExitPlanMode?: (toolUseId: string) => Promise<void>;
	/** Clear compact summary after first response */
	onClearCompactSummary?: () => Promise<void>;
	/** Git status tracking after file-mutating tools and completed Bash commands */
	onGitTrack?: (toolName: string, toolUseId: string, input?: Record<string, unknown>) => void;
	/** Legacy direct-call adapter only; processEvent never triggers workspace captures. */
	onSnapshotBefore?: (toolUseId: string, toolName: string, input: unknown) => Promise<void> | void;
	/** Snapshot: record the workspace tree hash after a file-mutating tool completes */
	onSnapshotAfter?: (toolUseId: string, toolName: string) => Promise<void> | void;
	/** Completed tool result, after persistence and broadcast. */
	onToolResult?: (event: Extract<AgentEvent, { type: "tool_result" }>) => Promise<void> | void;
	/** Context usage event (compact trigger) */
	onContextUsage?: (percentage: number) => void;
	/** Error cleanup (partial message removal, orphaned tool calls) */
	onErrorCleanup?: (
		message: string,
		diagnostics?: import("../lib/agent/types").ApiRequestDiagnostics,
	) => Promise<void>;
}

// === Streaming snapshot: track in-progress streaming state per narrator ===
// Allows newly-subscribing clients to restore tool_use_chunk / text streaming
// state when switching between narrator sessions.

export interface ToolChunkSnapshot {
	toolCallId: string | null;
	toolUseId: string;
	toolName: string;
	inputCharsTotal: number;
	parentToolUseId?: string;
	subagentNarratorId?: string;
	extractedFilePath?: string;
	contentCharsReceived?: number;
	extractedFields?: Record<string, string>;
	metadata?: Record<string, unknown>;
	/**
	 * Whether `tool_started` has fired — i.e. the tool's INPUT finished parsing.
	 *
	 * ⚠️ NOT "the tool is executing", which is what this comment used to claim. The
	 * permission prompt, any reflection gate and the final admission wait all sit after
	 * this point; `executing` below is the flag that means execution actually began.
	 */
	started?: boolean;
	/**
	 * Whether `tool_executing` has fired — permission granted, execution under way.
	 *
	 * Kept on the snapshot so a client reconnecting mid-tool can distinguish "waiting on
	 * a human" from "running" instead of inferring it from `started`.
	 */
	executing?: boolean;
	/** Input payload from tool_started */
	input?: unknown;
	/** Timestamp from tool_started */
	streamStartedAt?: number;
	/** Timestamp sampled when the provider finished streaming tool input. */
	streamCompletedAt?: number;
	/** Latest streaming output from bash tool */
	streamingOutput?: string;
	/**
	 * Latest determinate progress measurement (TransferFile).
	 *
	 * On the snapshot for the same reason `streamingOutput` is: a client that opens
	 * the page mid-transfer receives only this catch-up, so without it the bar would
	 * be missing until the NEXT frame — which for the tail of a slow transfer can be
	 * the rest of the wait.
	 */
	structuredProgress?: ToolProgressPayload;
	/**
	 * Short whitelisted input keys, kept for SUBAGENT chunks only — those omit
	 * `input` entirely (see {@link ToolChunkSnapshot.input}), so without this a
	 * client that reconnects mid-tool has no way to label the parent card's row.
	 */
	inputSummary?: SubagentToolInputSummary;
}

/** A streaming block tracked in temporal order (by event arrival / provider output order). */
export type SnapshotStreamingBlock =
	| { type: "reasoning"; id?: string; outputIndex?: number; text: string }
	| {
			type: "web_search";
			id: string;
			status: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
			action?: import("../lib/agent/provider").WebSearchAction;
	  }
	| {
			type: "image_generation";
			id: string;
			status: string;
			revisedPrompt?: string;
			result?: string;
			partialImageIndex?: number;
			partialSavedPath?: string;
			savedPath?: string;
			width?: number;
			height?: number;
			outputIndex?: number;
	  }
	| {
			type: "text";
			text: string;
			id?: string;
			outputIndex?: number;
			fileReferenceContext?: FileReferenceContext | null;
	  };

export interface StreamingSnapshot {
	/** Ordered streaming blocks — preserves temporal order of reasoning, web_search, and text. */
	streamingBlocks: SnapshotStreamingBlock[];
	toolChunks: Map<string, ToolChunkSnapshot>;
	/** Cached gateway queue position (> 0 means queued). */
	queuePosition?: number;
	/** Cached gateway queue depth. */
	queueDepth?: number;
	/** Cached generic gateway queue message. */
	queueMessage?: string;
}

const streamingSnapshots = hotSafe<Map<string, StreamingSnapshot>>(
	"narrafork.streamingSnapshots",
	() => new Map(),
);

function getOrCreateSnapshot(narratorId: string): StreamingSnapshot {
	let snap = streamingSnapshots.get(narratorId);
	if (!snap) {
		snap = { streamingBlocks: [], toolChunks: new Map() };
		streamingSnapshots.set(narratorId, snap);
	}
	return snap;
}

function getSnapshotBlockOutputIndex(block: SnapshotStreamingBlock): number | undefined {
	return "outputIndex" in block && typeof block.outputIndex === "number"
		? block.outputIndex
		: undefined;
}

function findOrderedSnapshotInsertIndex(
	blocks: SnapshotStreamingBlock[],
	outputIndex: number | undefined,
): number {
	if (outputIndex == null) return blocks.length;
	for (let i = 0; i < blocks.length; i++) {
		const currentOrder = getSnapshotBlockOutputIndex(blocks[i]);
		if (currentOrder != null && currentOrder > outputIndex) return i;
	}
	return blocks.length;
}

function partialImageGenerationArtifactId(imageId: string, partialImageIndex?: number): string {
	return `${imageId}_partial_${partialImageIndex ?? "latest"}`;
}

function cleanupPartialImageGenerationArtifacts(ctx: EventHandlerContext, imageId: string): void {
	void cleanupPartialImageGenerationResults(ctx.conversationId ?? "unknown", imageId).catch(
		(err) => {
			logger.warn("Failed to clean up partial generated image artifacts", {
				error: err,
				imageId,
			});
		},
	);
}

/** Retrieve the current streaming snapshot for a narrator (if any). */
export function getStreamingSnapshot(narratorId: string): StreamingSnapshot | undefined {
	return streamingSnapshots.get(narratorId);
}

/** Clear the streaming snapshot for a narrator (session end / error). */
export function clearStreamingSnapshot(narratorId: string): void {
	streamingSnapshots.delete(narratorId);
}

// === Dual broadcast for subagent self-subscription ===

/**
 * Broadcast a message to the primary target (parent narrator for subagents)
 * AND, when the sender is a subagent, also broadcast a "self" copy to the
 * subagent's own narratorId so that clients viewing the subagent page
 * directly can receive streaming events.
 *
 * A thin adapter over {@link dualBroadcastToNarrator}: the stripping rules now live
 * in the websocket layer so producers outside this event loop (structured injection)
 * use the same ones instead of keeping a second copy. This wrapper exists only to
 * keep the ~30 call sites below reading in terms of the context they already hold.
 */
function dualBroadcast(
	ctx: EventHandlerContext,
	message: NarratorServerMessage,
	parentMessage: NarratorServerMessage = message,
): void {
	dualBroadcastToNarrator(ctx, message, parentMessage);
}

function subagentToolRouting(ctx: EventHandlerContext, toolUseId: string) {
	return {
		toolCallId: ctx.toolCallIdsMap?.get(toolUseId) ?? null,
		...(ctx.parentToolUseId
			? {
					parentToolUseId: ctx.parentToolUseId,
					subagentNarratorId: ctx.narratorId,
				}
			: {}),
	};
}

/**
 * The child-row label for a subagent tool event, as a spreadable `{ inputSummary }`
 * (or `{}`).
 *
 * WHY IT IS NOT JUST `input`
 * A parent page renders a subagent's calls as one-line rows, so the reduced parent
 * copy of every tool event deliberately drops `input`: for Write/Edit that field can
 * be an entire file (observed max 180KB), and CLAUDE.md forbids putting payloads
 * like that on a high-frequency WS path. The row was therefore left showing only the
 * bare tool name until the next REST fetch — which is what
 * {@link projectSubagentToolInputSummary} fixes, by keeping the 10 whitelisted short
 * keys (≤200 chars each) and nothing else.
 *
 * Cost is O(number of whitelisted keys), NOT O(input size): the projection indexes
 * the 10 keys directly instead of walking or cloning the object, so a multi-MB
 * `content` field is never touched. Safe to call per event on the hot path.
 *
 * Returns `{}` for a main narrator (its own page already receives the full `input`)
 * and for an input with none of the keys, so `...` adds nothing to the frame.
 */
function subagentToolSummaryField(
	ctx: EventHandlerContext,
	input: unknown,
): { inputSummary?: SubagentToolInputSummary } {
	if (!ctx.parentToolUseId) return {};
	const summary = projectSubagentToolInputSummary(input);
	return summary ? { inputSummary: summary } : {};
}

function broadcastToolCompleted(
	ctx: EventHandlerContext,
	message: Extract<NarratorServerMessage, { type: "tool_completed" }>,
): void {
	if (!ctx.parentToolUseId) {
		dualBroadcast(ctx, message);
		return;
	}
	dualBroadcast(ctx, message, {
		type: "tool_completed",
		narratorId: ctx.broadcastTargetId,
		toolCallId: message.toolCallId,
		toolUseId: message.toolUseId,
		toolName: message.toolName,
		status: message.status,
		durationMs: message.durationMs,
		parentToolUseId: ctx.parentToolUseId,
		subagentNarratorId: ctx.narratorId,
		// Only `updatedInput` exists here (a post-permission redirect: a rewritten
		// file path, an edited command). Absent for an ordinary call, in which case
		// no summary is sent and the row keeps the one `tool_started` already
		// delivered — the merge in `upsertSubagentToolCallHeader` spreads the
		// incoming header over the existing one, so an absent key never erases it.
		...subagentToolSummaryField(ctx, message.updatedInput),
	});
}

/**
 * Reconcile tool-use blocks that were appended as stop events. Parallel tools can
 * stop in completion order, while the final assistant event carries the stable
 * model/start order. Keep non-tool blocks in their existing slots and reorder only
 * the tool blocks before broadcasting/finalizing the partial message.
 */
function reorderPersistedToolUseBlocks(
	contentJson: unknown,
	orderedToolUses: ReadonlyArray<{ toolUseId: string; outputIndex?: number }>,
): unknown[] | undefined {
	if (!Array.isArray(contentJson) || orderedToolUses.length < 2) return undefined;

	const stableToolUses = orderedToolUses
		.map((toolUse, index) => ({ toolUse, index }))
		.sort((a, b) => {
			if (a.toolUse.outputIndex != null && b.toolUse.outputIndex != null) {
				const outputOrder = a.toolUse.outputIndex - b.toolUse.outputIndex;
				if (outputOrder !== 0) return outputOrder;
			} else if (a.toolUse.outputIndex != null) {
				return -1;
			} else if (b.toolUse.outputIndex != null) {
				return 1;
			}
			return a.index - b.index;
		});
	const orderByToolUseId = new Map(
		stableToolUses.map(({ toolUse }, index) => [toolUse.toolUseId, index]),
	);
	const toolEntries = contentJson.flatMap((block, index) => {
		if (!block || typeof block !== "object") return [];
		const record = block as Record<string, unknown>;
		if (record.type !== "tool_use" || typeof record.id !== "string") return [];
		return [{ index, block, order: orderByToolUseId.get(record.id) }];
	});
	if (toolEntries.length < 2) return undefined;

	const sorted = [...toolEntries].sort((a, b) => {
		const aOrder = a.order ?? Number.POSITIVE_INFINITY;
		const bOrder = b.order ?? Number.POSITIVE_INFINITY;
		return aOrder === bOrder ? a.index - b.index : aOrder - bOrder;
	});
	const changed = sorted.some((entry, index) => entry.block !== toolEntries[index]?.block);
	if (!changed) return undefined;

	const reordered = [...contentJson];
	for (let i = 0; i < toolEntries.length; i++) {
		reordered[toolEntries[i].index] = sorted[i].block;
	}
	return reordered;
}

// === Discarded attempt cleanup ===

/** Block count of a partial assistant message, or 0 when there is no partial row yet. */
async function countPersistedBlocks(partialMessageId: string | undefined): Promise<number> {
	if (!partialMessageId) return 0;
	const row = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, partialMessageId),
		columns: { contentJson: true },
	});
	return Array.isArray(row?.contentJson) ? row.contentJson.length : 0;
}

/**
 * Record where `requestId` starts writing into the partial assistant message, and
 * return that baseline.
 *
 * Idempotent per requestId, which is what makes the pairing order-independent: both
 * `api_request_start` and `attempt_discarded` call this, and whichever arrives first
 * establishes the baseline. The loop flushes `api_request_start` lazily, so for an
 * attempt that failed before producing any stream event the discard genuinely comes
 * first — and at that moment the block count still reflects the state before this
 * attempt wrote anything, so it is the correct baseline either way.
 *
 * Entries are dropped once consumed (or when the turn's message is finalized), so the
 * map cannot grow past the attempts of the current turn.
 */
async function recordAttemptBlockBaseline(
	ctx: EventHandlerContext,
	requestId: string,
): Promise<number> {
	ctx.attemptBlockBaselines ??= new Map();
	const existing = ctx.attemptBlockBaselines.get(requestId);
	if (existing != null) return existing;
	const baseline = await countPersistedBlocks(ctx.getPartialMessageId());
	ctx.attemptBlockBaselines.set(requestId, baseline);
	return baseline;
}

/**
 * Undo everything a discarded provider attempt wrote into the partial assistant message.
 *
 * Blocks are persisted the moment they complete, so an attempt that is replayed leaves
 * its reasoning/text/tool_use behind. Repeated replays therefore stack several copies of
 * near-identical content onto one message — the visible half of "history keeps growing
 * while the request never changes".
 *
 * Truncation is anchored to the baseline recorded for THIS attempt's requestId, so only
 * blocks this attempt appended are removed and anything committed by an earlier,
 * successful attempt in the same turn survives.
 *
 * Tool-call rows are deleted only when the tool never executed (`initializing`/`pending`).
 * A tool that reached `running`/`success`/`fail` has real side effects and its row must be
 * kept, matching `finalizeOrCleanupPartialMessage`. In that case its `tool_use` block is
 * kept as well: dropping the block while keeping the row would leave a result with no call.
 */
async function discardAttemptPersistedBlocks(
	ctx: EventHandlerContext,
	narratorId: string,
	broadcastTargetId: string,
	requestId: string,
): Promise<void> {
	// The live view is showing content that is about to be deleted, so it has to be
	// told — clearing only the server-side reconnect snapshot would leave an attached
	// client rendering blocks that no longer exist until something else happens to
	// retire them. Done regardless of whether a partial row exists: the streaming
	// blocks are client state and are not conditional on persistence.
	clearStreamingSnapshot(broadcastTargetId);
	if (ctx.parentToolUseId) clearStreamingSnapshot(narratorId);
	ctx.fileReferenceContexts?.clear();
	dualBroadcast(ctx, {
		type: "streaming_reset",
		narratorId: broadcastTargetId,
		...(ctx.parentToolUseId ? { parentToolUseId: ctx.parentToolUseId } : {}),
	});
	ctx.sseEmitter?.emit("event", { type: "streaming_reset" });

	const partialId = ctx.getPartialMessageId();
	// Correlated by requestId, not by "the most recent api_request_start": that event
	// is flushed lazily, so an attempt that produced nothing emits its discard first.
	// Recording here (idempotently) yields this attempt's own starting block count.
	// Deliberately NOT deleted afterwards: this attempt's `api_request_start` may still
	// be flushed after the discard, and finding its entry already present is what stops
	// it from re-recording a baseline against the ALREADY-truncated message. The map is
	// cleared when the turn's assistant message is finalized.
	const baseline = await recordAttemptBlockBaseline(ctx, requestId);
	if (!partialId) return;

	try {
		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, partialId),
			columns: { contentJson: true },
		});
		const blocks = Array.isArray(message?.contentJson)
			? (message.contentJson as Array<Record<string, unknown>>)
			: [];
		if (blocks.length <= baseline) return;

		const discarded = blocks.slice(baseline);
		const discardedToolUseIds = discarded.flatMap((block) =>
			block.type === "tool_use" && typeof block.id === "string" ? [block.id] : [],
		);

		// Which of those tool calls never ran — only these may be removed.
		const executedToolUseIds = new Set<string>();
		if (discardedToolUseIds.length > 0) {
			const rows = await db.query.narratorToolCalls.findMany({
				where: and(
					eq(narratorToolCalls.messageId, partialId),
					inArray(narratorToolCalls.toolUseId, discardedToolUseIds),
				),
				columns: { id: true, toolUseId: true, status: true },
			});
			const removableRowIds: string[] = [];
			for (const row of rows) {
				if (row.status === "initializing" || row.status === "pending") {
					removableRowIds.push(row.id);
				} else {
					executedToolUseIds.add(row.toolUseId);
				}
			}
			if (removableRowIds.length > 0) {
				await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.id, removableRowIds));
				for (const toolUseId of discardedToolUseIds) {
					if (!executedToolUseIds.has(toolUseId)) ctx.toolCallIdsMap?.delete(toolUseId);
				}
			}
		}

		// Keep the blocks of tools that actually executed, drop the rest. Order is
		// preserved by filtering the whole array rather than concatenating the survivors
		// after the baseline slice: `appendBlockToMessage` maintains blocks in
		// `outputIndex` order, and `reorderPersistedToolUseBlocks` (run at
		// `assistant_message`) reads tool positions, so both rely on that invariant.
		const isRetainedBlock = (block: Record<string, unknown>, index: number): boolean =>
			index < baseline ||
			(block.type === "tool_use" &&
				typeof block.id === "string" &&
				executedToolUseIds.has(block.id));
		const nextBlocks = blocks.filter(isRetainedBlock);
		const retainedFromAttempt = nextBlocks.length - baseline;
		const contentText = nextBlocks
			.flatMap((block) =>
				block.type === "text" && typeof block.text === "string" ? [block.text] : [],
			)
			.join("\n");

		await db
			.update(narratorMessages)
			.set({ contentJson: nextBlocks, contentText: contentText || null })
			.where(eq(narratorMessages.id, partialId));

		logger.info("Discarded persisted blocks of a replayed attempt", {
			narratorId,
			partialId,
			baseline,
			discardedBlocks: discarded.length - retainedFromAttempt,
			retainedExecutedToolCalls: retainedFromAttempt,
		});

		// `streaming_reset` above only drops LIVE streaming blocks. Blocks that already
		// completed were served to clients from this partial row, so they sit in the
		// message cache and nothing else would retire them until the turn's
		// `assistant_message` arrives — which is many seconds and several retries away.
		// Publish the truncated row (and bump the sync version, mirroring every other
		// message mutation) so an attached client and a reconnecting one agree.
		await bumpNarratorMessageVersion(narratorId);
		const updated = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, partialId),
			with: { toolCalls: true },
		});
		if (updated) {
			const ref = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, partialId),
				),
				columns: { seq: true },
			});
			const processed = enrichToolUseBlocks(truncateToolIO([{ ...updated, seq: ref?.seq }]))[0];
			dualBroadcast(ctx, {
				type: "message_updated",
				narratorId: broadcastTargetId,
				message: processed,
			});
			ctx.sseEmitter?.emit("event", { type: "message_updated", data: processed });
		}
	} catch (err) {
		// Cleanup is best-effort: failing it must not abort the replay. The remnants are
		// invisible to the model (an unexecuted tool call is never replayed into history),
		// so the cost of a miss is a longer transcript, not a corrupted one.
		logger.warn("Failed to discard persisted blocks of a replayed attempt", {
			narratorId,
			partialId,
			error: String(err),
		});
	}
}

// === Reasoning translation ===

const LOCALE_NAMES: Record<string, string> = {
	en: "English",
	"zh-CN": "简体中文",
	zh: "中文",
	es: "Español",
	fr: "Français",
	de: "Deutsch",
	ja: "日本語",
	ko: "한국어",
};

type PersistedReasoningBlock = {
	type?: string;
	text?: string;
	outputIndex?: number;
	providerMetadata?: import("../lib/agent/types").ReasoningProviderMetadata;
};

function getReasoningItemId(
	metadata?: import("../lib/agent/types").ReasoningProviderMetadata,
): string | undefined {
	const itemId = metadata?.openai?.itemId;
	return typeof itemId === "string" && itemId.length > 0 ? itemId : undefined;
}

function findReasoningBlockIndex(
	blocks: unknown[],
	locator: {
		reasoningText: string;
		providerMetadata?: import("../lib/agent/types").ReasoningProviderMetadata;
		outputIndex?: number;
	},
): number {
	const targetItemId = getReasoningItemId(locator.providerMetadata);
	if (targetItemId) {
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i] as PersistedReasoningBlock;
			if (
				block.type === "reasoning" &&
				getReasoningItemId(block.providerMetadata) === targetItemId
			) {
				return i;
			}
		}
	}

	if (locator.outputIndex != null) {
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i] as PersistedReasoningBlock;
			if (block.type === "reasoning" && block.outputIndex === locator.outputIndex) {
				return i;
			}
		}
	}

	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i] as PersistedReasoningBlock;
		if (block.type === "reasoning" && block.text === locator.reasoningText) {
			return i;
		}
	}

	return -1;
}

/**
 * Whether a resolved reasoning index still points at the block that was translated.
 *
 * Translation is fire-and-forget and settles long after the request that produced
 * the block, so in between the attempt can be discarded and replayed
 * (`attempt_discarded` truncates the blocks that attempt persisted). Neither
 * locator key is attempt-scoped: `outputIndex` in particular is reproduced by the
 * replay, so the index can resolve to the NEW attempt's reasoning — a different
 * thought wearing the same coordinates.
 *
 * The text is the discriminator: `appendBlockToMessage` stores it verbatim and
 * `patchReasoningTranslation` only ever adds `translatedText`, so an exact match
 * means the target is still the same block.
 */
export function isSameReasoningBlock(block: unknown, reasoningText: string): boolean {
	const candidate = block as PersistedReasoningBlock | undefined;
	return candidate?.type === "reasoning" && candidate.text === reasoningText;
}

/**
 * Translate a reasoning block's text via `agent.translationModel`, then patch
 * the message in DB and broadcast the updated message to connected clients.
 * Runs as fire-and-forget — errors are logged but never propagate.
 *
 * The model comes from `resolveTranslationModelOverride()`, which returns
 * `undefined` while the setting follows the summary model. That is the only
 * reason translation ever runs on the summary model: it must be the *fallback*,
 * not the hardcoded target. Passing no override at all — as this did before —
 * makes the user's translation-model setting silently inert.
 *
 * `reportSummaryModelErrors` is false because a failure here belongs to the
 * translation model, and the summary-model picker modal it would otherwise open
 * saves to `agent.summaryModel` — pointing the user at the wrong setting and
 * changing a model that was working.
 */
function translateReasoningBlock(
	messageId: string,
	narratorId: string,
	broadcastTargetId: string,
	reasoningText: string,
	ctx: EventHandlerContext,
	locator?: {
		providerMetadata?: import("../lib/agent/types").ReasoningProviderMetadata;
		outputIndex?: number;
	},
): void {
	const locale = ctx.locale || "en";
	// Skip translation for English content when locale is English
	if (locale === "en") return;

	const langName = LOCALE_NAMES[locale] || locale;

	(async () => {
		try {
			const result = await summaryGenerate(
				reasoningText,
				`You are a translator. Translate the following AI reasoning/thinking content into ${langName}. Preserve the original meaning, technical terms, and markdown formatting. Output ONLY the translation, no explanations.`,
				{ narratorId, kind: "reasoning_translation" },
				undefined,
				undefined,
				resolveTranslationModelOverride(),
				undefined,
				false,
			);
			const translated = result.text?.trim();
			if (!translated) return;

			// Find the exact reasoning block in the message.
			// Prefer stable identifiers (OpenAI itemId, then outputIndex), and only
			// fall back to text matching for older persisted messages.
			const msg = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { contentJson: true },
			});
			if (!msg) return;
			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const targetIdx = findReasoningBlockIndex(blocks, {
				reasoningText,
				providerMetadata: locator?.providerMetadata,
				outputIndex: locator?.outputIndex,
			});
			if (targetIdx === -1) return;
			// The resolved block must still BE the one that was translated: a discarded
			// and replayed attempt can put different reasoning at the same coordinates.
			// See isSameReasoningBlock.
			if (!isSameReasoningBlock(blocks[targetIdx], reasoningText)) return;

			await narratorService.patchReasoningTranslation(messageId, targetIdx, translated);

			// Broadcast updated message so frontend picks up the translation
			const fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				with: { toolCalls: true },
			});
			if (fullMessage) {
				const ref = await db.query.narratorMessageRefs.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
					columns: { seq: true },
				});
				const processed = enrichToolUseBlocks(
					truncateToolIO([{ ...fullMessage, seq: ref?.seq }]),
				)[0];
				dualBroadcast(ctx, {
					type: "message",
					narratorId: broadcastTargetId,
					message: processed,
				});
			}
		} catch (err) {
			logger.warn("Reasoning translation failed", {
				narratorId,
				messageId,
				error: String(err),
			});
		}
	})();
}

// === Unified event processor ===

/**
 * Process a single agent event — shared by main narrators and subagents.
 *
 * Core logic (broadcast, persistence) is always executed.
 * Main-narrator-specific behavior is injected via optional hooks.
 */
export async function processEvent(
	event: AgentEvent,
	ctx: EventHandlerContext,
	hooks?: EventHooks,
): Promise<{ titleUpdate?: boolean } | null> {
	const { narratorId, broadcastTargetId } = ctx;

	switch (event.type) {
		case "stream_text": {
			ctx.fileReferenceContexts ??= new FileReferenceContextTracker();
			const fileReferenceContext = ctx.fileReferenceContexts.capture(
				event.outputIndex,
				ctx.getFileReferenceContext,
			);
			const textBlockId = ctx.fileReferenceContexts.blockId(event.outputIndex);
			// Clear "reasoning" substatus when text starts (reasoning phase ended)
			if (ctx.removeSubstatus && ctx.getSubstatus?.().has("reasoning")) {
				ctx.removeSubstatus("reasoning").catch(() => {});
			}
			// First text token latency (TTFT)
			if (ctx.getTtftMs && ctx.setTtftMs && ctx.getTtftMs() == null) {
				const startedAt = ctx.getTurnStartedAt?.();
				if (startedAt) {
					const ttftMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
					ctx.setTtftMs(ttftMs);
				}
			}
			// Track AI output character rate
			recordOutputChunk(event.text.length);

			// Text snapshots belong to the actual author (also on a subagent's own
			// page), never to a different narrator sharing the parent's subscription.
			const snap = getOrCreateSnapshot(ctx.parentToolUseId ? narratorId : broadcastTargetId);
			const existing = snap.streamingBlocks.find((b) => b.type === "text" && b.id === textBlockId);
			if (existing?.type === "text") {
				existing.text += event.text;
			} else {
				snap.streamingBlocks.splice(
					findOrderedSnapshotInsertIndex(snap.streamingBlocks, event.outputIndex),
					0,
					{
						type: "text",
						id: textBlockId,
						text: event.text,
						outputIndex: event.outputIndex,
						fileReferenceContext,
					},
				);
			}

			const streamEvent: Record<string, unknown> = {
				type: "content_block_delta",
				delta: { type: "text_delta", text: event.text, id: textBlockId },
				fileReferenceContext,
				...(event.outputIndex != null ? { outputIndex: event.outputIndex } : {}),
			};
			// Subagent: attach linking info so frontend knows which tool_use this belongs to
			if (ctx.parentToolUseId) {
				streamEvent.subagentToolUseId = ctx.parentToolUseId;
				streamEvent.subagentNarratorId = narratorId;
			}
			dualBroadcast(ctx, {
				type: "stream_event",
				narratorId: broadcastTargetId,
				event: streamEvent,
			});
			ctx.sseEmitter?.emit("event", {
				type: "stream_event",
				data: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: event.text, id: textBlockId },
					fileReferenceContext,
					...(event.outputIndex != null ? { outputIndex: event.outputIndex } : {}),
				},
			});
			return null;
		}

		case "tool_call": {
			// Workspace captures belong to executeTool's awaited lifecycle, not UI events.
			const routing = subagentToolRouting(ctx, event.toolUseId);
			// The child row's label. Computed once and reused by both the snapshot and
			// the reduced parent frame — `input` is complete here, so this is the
			// EARLIEST point the row can show anything beyond the tool name.
			const summaryField = subagentToolSummaryField(ctx, event.input);
			// Snapshot: mark tool as started (executing). Parent snapshots for
			// subagents intentionally omit the complete input payload.
			{
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existing = snap.toolChunks.get(event.toolUseId);
				snap.toolChunks.set(event.toolUseId, {
					...existing,
					...routing,
					toolUseId: event.toolUseId,
					toolName: event.toolName,
					inputCharsTotal: existing?.inputCharsTotal ?? 0,
					started: true,
					...(!ctx.parentToolUseId && { input: event.input }),
					...summaryField,
					streamStartedAt: event.streamStartedAt,
					streamCompletedAt: event.streamCompletedAt,
				});
			}
			const selfMessage: NarratorServerMessage = {
				type: "tool_started",
				narratorId: broadcastTargetId,
				...routing,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				input: event.input,
				streamStartedAt: event.streamStartedAt,
				streamCompletedAt: event.streamCompletedAt,
			};
			dualBroadcast(
				ctx,
				selfMessage,
				ctx.parentToolUseId
					? {
							type: "tool_started",
							narratorId: broadcastTargetId,
							...routing,
							toolUseId: event.toolUseId,
							toolName: event.toolName,
							streamStartedAt: event.streamStartedAt,
							streamCompletedAt: event.streamCompletedAt,
							...summaryField,
						}
					: selfMessage,
			);
			return null;
		}

		case "tool_use_chunk": {
			// Clear "reasoning" substatus when tool use starts
			if (ctx.removeSubstatus && ctx.getSubstatus?.().has("reasoning")) {
				ctx.removeSubstatus("reasoning").catch(() => {});
			}
			if (ctx.getTtftMs && ctx.setTtftMs && ctx.getTtftMs() == null) {
				const startedAt = ctx.getTurnStartedAt?.();
				if (startedAt) {
					const ttftMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
					ctx.setTtftMs(ttftMs);
				}
			}
			// Track tool input streaming chars (inputCharsTotal is cumulative,
			// so compute the delta from the last seen value for this tool)
			if (event.inputCharsTotal > 0) {
				const prev = ctx.toolUseCharsMap?.get(event.toolUseId) ?? 0;
				const delta = event.inputCharsTotal - prev;
				if (delta > 0) {
					recordOutputChunk(delta);
					if (!ctx.toolUseCharsMap) ctx.toolUseCharsMap = new Map();
					ctx.toolUseCharsMap.set(event.toolUseId, event.inputCharsTotal);
				}
			}
			const routing = subagentToolRouting(ctx, event.toolUseId);
			// The child row's label WHILE the input is still streaming. `extractedFields`
			// is what the streaming JSON parser has completed so far (Bash's
			// `description` lands long before its `command` finishes), and it is capped
			// at short fields by construction — so labelling from it costs nothing and
			// beats waiting for `tool_started`. `extractedFilePath` is folded in because
			// the parser reports it separately from the field map.
			const chunkSummaryField = subagentToolSummaryField(ctx, {
				...event.extractedFields,
				...(event.extractedFilePath ? { file_path: event.extractedFilePath } : {}),
			});
			// Snapshot: track active tool chunk.
			{
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existing = snap.toolChunks.get(event.toolUseId);
				snap.toolChunks.set(event.toolUseId, {
					...existing,
					...routing,
					toolUseId: event.toolUseId,
					toolName: event.toolName,
					inputCharsTotal: event.inputCharsTotal,
					...(event.extractedFilePath && { extractedFilePath: event.extractedFilePath }),
					...(event.contentCharsReceived != null && {
						contentCharsReceived: event.contentCharsReceived,
					}),
					...(!ctx.parentToolUseId && event.extractedFields
						? { extractedFields: event.extractedFields }
						: {}),
					...(!ctx.parentToolUseId && event.metadata ? { metadata: event.metadata } : {}),
					...chunkSummaryField,
				});
			}
			const selfMessage: NarratorServerMessage = {
				type: "tool_use_chunk",
				narratorId: broadcastTargetId,
				...routing,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				inputCharsTotal: event.inputCharsTotal,
				...(event.extractedFilePath && { extractedFilePath: event.extractedFilePath }),
				...(event.contentCharsReceived != null && {
					contentCharsReceived: event.contentCharsReceived,
				}),
				...(event.extractedFields && { extractedFields: event.extractedFields }),
				...(event.metadata && { metadata: event.metadata }),
				...(event.streamingField && { streamingField: event.streamingField }),
			};
			dualBroadcast(
				ctx,
				selfMessage,
				ctx.parentToolUseId
					? {
							type: "tool_use_chunk",
							narratorId: broadcastTargetId,
							...routing,
							toolUseId: event.toolUseId,
							toolName: event.toolName,
							inputCharsTotal: event.inputCharsTotal,
							...(event.extractedFilePath ? { extractedFilePath: event.extractedFilePath } : {}),
							...(event.contentCharsReceived != null
								? { contentCharsReceived: event.contentCharsReceived }
								: {}),
							...chunkSummaryField,
						}
					: selfMessage,
			);
			return null;
		}

		case "block_complete": {
			const { block } = event;
			const textBlockId =
				block.type === "text" ? ctx.fileReferenceContexts?.blockId(block.outputIndex) : undefined;
			const mixedTextSources =
				block.type === "text" && ctx.fileReferenceContexts?.hasDifferentContexts();
			let fileReferenceContext =
				block.type === "text"
					? (ctx.fileReferenceContexts?.complete(block.outputIndex) ?? null)
					: null;
			if (mixedTextSources && block.type === "text") {
				// The loop can combine multiple output items into one block_complete.
				// Unless this is provably the exact lane, a mixed-device body has no
				// single trustworthy base. Keep the text; only disable inferred links.
				const streamed = streamingSnapshots
					.get(ctx.parentToolUseId ? narratorId : broadcastTargetId)
					?.streamingBlocks.find(
						(candidate) => candidate.type === "text" && candidate.id === textBlockId,
					);
				if (streamed?.type !== "text" || streamed.text !== block.text) fileReferenceContext = null;
			}

			// Snapshot: remove the completed block from the ordered streaming blocks.
			// The completed block will be served via the partial message from the
			// database, so the snapshot should only contain blocks still being streamed.
			if (block.type === "text" || !ctx.parentToolUseId) {
				const snap = streamingSnapshots.get(ctx.parentToolUseId ? narratorId : broadcastTargetId);
				if (snap) {
					if (block.type === "text") {
						// Remove the completed text block (prefer exact provider outputIndex).
						const idx =
							block.outputIndex != null
								? snap.streamingBlocks.findIndex(
										(b) => b.type === "text" && b.outputIndex === block.outputIndex,
									)
								: (() => {
										for (let i = snap.streamingBlocks.length - 1; i >= 0; i--) {
											if (snap.streamingBlocks[i].type === "text") return i;
										}
										return -1;
									})();
						if (idx !== -1) snap.streamingBlocks.splice(idx, 1);
					} else if (block.type === "reasoning") {
						const idx =
							block.outputIndex != null
								? snap.streamingBlocks.findIndex(
										(b) => b.type === "reasoning" && b.outputIndex === block.outputIndex,
									)
								: snap.streamingBlocks.findIndex((b) => b.type === "reasoning");
						if (idx !== -1) snap.streamingBlocks.splice(idx, 1);
					} else if (block.type === "web_search") {
						const idx = snap.streamingBlocks.findIndex(
							(b) => b.type === "web_search" && b.id === block.id,
						);
						if (idx !== -1) snap.streamingBlocks.splice(idx, 1);
					} else if (block.type === "image_generation") {
						const idx = snap.streamingBlocks.findIndex(
							(b) => b.type === "image_generation" && b.id === block.id,
						);
						if (idx !== -1) snap.streamingBlocks.splice(idx, 1);
					}
				}
			}

			// Ensure a partial message exists for incremental persistence
			if (!ctx.getPartialMessageId()) {
				const tokenUsage = ctx.getTokenUsage();
				const partial = await narratorService.createPartialAssistantMessage(narratorId, {
					uuid: randomUUID(),
					session_id: ctx.conversationId,
					parent_tool_use_id: ctx.parentToolUseId,
					contextPercent: ctx.getContextUsagePct(),
					meterUsage: ctx.getMeterUsage(),
					meterUnit: ctx.getMeterUnit(),
					tokensIn: tokenUsage?.inputTokens ?? tokenUsage?.promptTokens,
					provider: ctx.provider,
					model: ctx.model,
					outputTokens: tokenUsage?.completionTokens,
					cachedInputTokens: tokenUsage?.cachedInputTokens,
					cacheCreationInputTokens: tokenUsage?.cacheCreationInputTokens,
					cacheCreation5mTokens: tokenUsage?.cacheCreation5mTokens,
					cacheCreation1hTokens: tokenUsage?.cacheCreation1hTokens,
					reasoningTokens: tokenUsage?.reasoningTokens,
					ttftMs: ctx.getTtftMs?.(),
					// 不在 block_complete 时设置 durationMs，等到 assistant_message 时再设置
					durationMs: undefined,
					turnUsage: tokenUsage
						? {
								input_tokens: tokenUsage.inputTokens ?? tokenUsage.promptTokens,
								...(tokenUsage.promptTokens != null && {
									prompt_tokens: tokenUsage.promptTokens,
								}),
								...(tokenUsage.completionTokens != null && {
									output_tokens: tokenUsage.completionTokens,
								}),
								...(tokenUsage.reasoningTokens != null && {
									reasoning_tokens: tokenUsage.reasoningTokens,
								}),
								...(tokenUsage.cachedInputTokens != null && {
									cached_input_tokens: tokenUsage.cachedInputTokens,
								}),
								...(tokenUsage.cacheCreationInputTokens != null && {
									cache_creation_input_tokens: tokenUsage.cacheCreationInputTokens,
								}),
								...(tokenUsage.cacheCreation5mTokens != null && {
									cache_creation_5m_tokens: tokenUsage.cacheCreation5mTokens,
								}),
								...(tokenUsage.cacheCreation1hTokens != null && {
									cache_creation_1h_tokens: tokenUsage.cacheCreation1hTokens,
								}),
								...(tokenUsage.contextWindow != null && {
									context_window: tokenUsage.contextWindow,
								}),
								...(tokenUsage.isEstimated && { is_estimated: true }),
							}
						: undefined,
				});
				ctx.setPartialMessageId(partial.id);
			}

			// Persist the completed block
			const partialId = ctx.getPartialMessageId() as string;
			if (block.type === "text") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "text",
					text: block.text,
					outputIndex: block.outputIndex,
					...(textBlockId ? { id: textBlockId } : {}),
					...(fileReferenceContext ? { fileReferenceContext } : {}),
					...(block.citations?.length ? { citations: block.citations } : {}),
				});
			} else if (block.type === "reasoning") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "reasoning",
					text: block.text,
					providerMetadata: block.providerMetadata,
					outputIndex: block.outputIndex,
				});
				// Fire-and-forget reasoning translation
				if (settings.agent.translateReasoning && block.text) {
					translateReasoningBlock(partialId, narratorId, broadcastTargetId, block.text, ctx, {
						providerMetadata: block.providerMetadata,
						outputIndex: block.outputIndex,
					});
				}
			} else if (block.type === "redacted_thinking") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "redacted_thinking",
					data: block.data,
					outputIndex: block.outputIndex,
					signatureSource: block.signatureSource,
				});
			} else if (block.type === "tool_use") {
				const toolCallId = await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "tool_use",
					id: block.toolUseId,
					name: block.name,
					input: block.input,
					streamStartedAt: block.streamStartedAt,
					streamCompletedAt: block.streamCompletedAt,
					outputIndex: block.outputIndex,
					...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
				});
				if (!toolCallId)
					throw new CriticalEventPersistenceError("Tool block did not produce a persisted row");
				const binding = await narratorPersistence.getToolCallBinding(
					narratorId,
					partialId,
					block.toolUseId,
					toolCallId,
				);
				ctx.toolCallIdsMap ??= new Map();
				ctx.toolCallIdsMap.set(block.toolUseId, toolCallId);
				ctx.toolExecutionReceipts ??= new Map();
				ctx.toolExecutionReceipts.set(block.toolUseId, { messageId: partialId, binding });
				event.onToolPersisted?.(binding);
			} else if (block.type === "web_search") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "web_search",
					id: block.id,
					query: block.query,
					queries: block.queries,
					outputIndex: block.outputIndex,
					...(block.action ? { action: block.action } : {}),
				});
			} else if (block.type === "image_generation") {
				// Save base64 image to filesystem. If saving fails, keep the raw result
				// in the persisted block so the UI/history replay can still recover it.
				let savedPath: string | undefined;
				let imageWidth: number | undefined;
				let imageHeight: number | undefined;
				let shouldPersistInlineResult = false;
				if (block.result) {
					try {
						const saved = await saveImageGenerationResult(
							ctx.conversationId ?? "unknown",
							block.id,
							block.result,
						);
						savedPath = saved.filePath;
						imageWidth = saved.width;
						imageHeight = saved.height;
					} catch (err) {
						shouldPersistInlineResult = true;
						logger.warn("Failed to save generated image to disk", {
							error: err,
							imageId: block.id,
						});
					}
				}
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "image_generation",
					id: block.id,
					revisedPrompt: block.revisedPrompt,
					outputIndex: block.outputIndex,
					...(savedPath ? { savedPath } : {}),
					...(imageWidth != null && imageHeight != null
						? { width: imageWidth, height: imageHeight }
						: {}),
					...(shouldPersistInlineResult && block.result ? { result: block.result } : {}),
				});
				if (savedPath) {
					if (!ctx.parentToolUseId) {
						const snap = getOrCreateSnapshot(broadcastTargetId);
						const existingIdx = snap.streamingBlocks.findIndex(
							(b) => b.type === "image_generation" && b.id === block.id,
						);
						const finalBlock: SnapshotStreamingBlock = {
							type: "image_generation",
							id: block.id,
							status: "completed",
							revisedPrompt: block.revisedPrompt,
							savedPath,
							...(imageWidth != null && imageHeight != null
								? { width: imageWidth, height: imageHeight }
								: {}),
							...(block.outputIndex != null ? { outputIndex: block.outputIndex } : {}),
						};
						if (existingIdx !== -1) snap.streamingBlocks[existingIdx] = finalBlock;
						else {
							snap.streamingBlocks.splice(
								findOrderedSnapshotInsertIndex(snap.streamingBlocks, block.outputIndex),
								0,
								finalBlock,
							);
						}
					}
					dualBroadcast(ctx, {
						type: "image_generation",
						narratorId: broadcastTargetId,
						id: block.id,
						status: "completed",
						revisedPrompt: block.revisedPrompt,
						outputIndex: block.outputIndex,
						...(savedPath ? { savedPath } : {}),
						...(imageWidth != null && imageHeight != null
							? { width: imageWidth, height: imageHeight }
							: {}),
						...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
					});
					cleanupPartialImageGenerationArtifacts(ctx, block.id);
				}
			}
			return null;
		}

		case "assistant_message": {
			const fileReferenceContext = ctx.fileReferenceContexts?.fallback() ?? null;
			ctx.fileReferenceContexts?.clear();
			// Snapshot: clear streaming state — this turn's text + tools are done
			clearStreamingSnapshot(broadcastTargetId);
			if (ctx.parentToolUseId) clearStreamingSnapshot(narratorId);
			// The turn is settled, so no attempt of it can be discarded any more. Drop the
			// per-attempt baselines rather than letting them accumulate across a long
			// session (each retry adds one entry).
			ctx.attemptBlockBaselines?.clear();

			const tokenUsage = ctx.getTokenUsage();
			const turnUsage = tokenUsage
				? {
						input_tokens: tokenUsage.inputTokens ?? tokenUsage.promptTokens,
						...(tokenUsage.promptTokens != null && {
							prompt_tokens: tokenUsage.promptTokens,
						}),
						...(tokenUsage.completionTokens != null && {
							output_tokens: tokenUsage.completionTokens,
						}),
						...(tokenUsage.reasoningTokens != null && {
							reasoning_tokens: tokenUsage.reasoningTokens,
						}),
						...(tokenUsage.cachedInputTokens != null && {
							cached_input_tokens: tokenUsage.cachedInputTokens,
						}),
						...(tokenUsage.cacheCreationInputTokens != null && {
							cache_creation_input_tokens: tokenUsage.cacheCreationInputTokens,
						}),
						...(tokenUsage.cacheCreation5mTokens != null && {
							cache_creation_5m_tokens: tokenUsage.cacheCreation5mTokens,
						}),
						...(tokenUsage.cacheCreation1hTokens != null && {
							cache_creation_1h_tokens: tokenUsage.cacheCreation1hTokens,
						}),
						...(tokenUsage.contextWindow != null && {
							context_window: tokenUsage.contextWindow,
						}),
						...(tokenUsage.isEstimated && { is_estimated: true }),
					}
				: undefined;
			let savedId: string;
			const partialId = ctx.getPartialMessageId();

			if (partialId) {
				// Partial message was already created incrementally via block_complete —
				// just update final metadata (messageUuid + token usage).
				savedId = partialId;
				const updates: Record<string, unknown> = {};
				if (event.messageId) updates.messageUuid = event.messageId;
				if (event.credentialId) updates.credentialId = event.credentialId;
				if (turnUsage) updates.turnUsageJson = turnUsage;

				if (Object.keys(updates).length > 0) {
					await db.update(narratorMessages).set(updates).where(eq(narratorMessages.id, savedId));
				}
				const usageData = buildUsageDataFromSnapshot(tokenUsage);
				if (usageData && ctx.provider && ctx.model) {
					await updateMessageUsage(savedId, usageData, ctx.provider, ctx.model);
				}
				ctx.setPartialMessageId(undefined);
			} else {
				// No partial message — fallback to full persistence
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const content: any[] = [];
				if (event.text) {
					content.push({
						type: "text",
						text: event.text,
						...(fileReferenceContext ? { fileReferenceContext } : {}),
						...(event.citations?.length ? { citations: event.citations } : {}),
					});
				}
				for (const tu of event.toolUses) {
					content.push({
						type: "tool_use",
						id: tu.toolUseId,
						name: tu.name,
						input: tu.input,
						...(tu.outputIndex != null ? { outputIndex: tu.outputIndex } : {}),
						...(tu.thoughtSignature ? { thoughtSignature: tu.thoughtSignature } : {}),
					});
				}

				const usageData = buildUsageDataFromSnapshot(tokenUsage);
				const saved = await narratorService.persistAssistantMessage(narratorId, {
					uuid: event.messageId ?? randomUUID(),
					session_id: ctx.conversationId,
					parent_tool_use_id: ctx.parentToolUseId,
					message: {
						content,
						usage:
							tokenUsage?.inputTokens != null || tokenUsage?.promptTokens != null
								? {
										input_tokens: tokenUsage.inputTokens ?? tokenUsage.promptTokens,
										...(tokenUsage.completionTokens != null && {
											output_tokens: tokenUsage.completionTokens,
										}),
									}
								: undefined,
					},
					contextPercent: ctx.getContextUsagePct(),
					meterUsage: ctx.getMeterUsage(),
					meterUnit: ctx.getMeterUnit(),
					provider: ctx.provider,
					credentialId: event.credentialId,
					model: ctx.model,
					outputTokens: tokenUsage?.completionTokens,
					cachedInputTokens: tokenUsage?.cachedInputTokens,
					cacheCreationInputTokens: tokenUsage?.cacheCreationInputTokens,
					cacheCreation5mTokens: tokenUsage?.cacheCreation5mTokens,
					cacheCreation1hTokens: tokenUsage?.cacheCreation1hTokens,
					reasoningTokens: tokenUsage?.reasoningTokens,
					ttftMs: ctx.getTtftMs?.(),
					durationMs: ctx.getTurnStartedAt?.()
						? Math.max(0, Date.now() - new Date(ctx.getTurnStartedAt?.() ?? 0).getTime())
						: undefined,
				});
				savedId = saved.id;
				if (usageData && ctx.provider && ctx.model) {
					await updateMessageUsage(savedId, usageData, ctx.provider, ctx.model);
				}
			}

			// Load full message with tool calls for broadcast and exact EnterPlanMode row identity.
			let fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, savedId),
				with: { toolCalls: true },
			});

			// Tool blocks may have been appended by block_complete in stop/completion order.
			// The final event's toolUses is already in stable model/start order, so reconcile
			// the partial row before both the final DB view and message broadcast are observed.
			if (partialId && fullMessage) {
				const reorderedContent = reorderPersistedToolUseBlocks(
					fullMessage.contentJson,
					event.toolUses,
				);
				if (reorderedContent) {
					await db
						.update(narratorMessages)
						.set({ contentJson: reorderedContent })
						.where(eq(narratorMessages.id, savedId));
					fullMessage = { ...fullMessage, contentJson: reorderedContent };
				}
			}
			if (fullMessage) {
				ctx.toolCallIdsMap ??= new Map();
				ctx.toolExecutionReceipts ??= new Map();
				for (const tu of event.toolUses) {
					const receipt = ctx.toolExecutionReceipts.get(tu.toolUseId);
					let binding = receipt?.messageId === savedId ? receipt.binding : undefined;
					if (!binding) {
						const rows = fullMessage.toolCalls.filter((tc) => tc.toolUseId === tu.toolUseId);
						if (
							rows.length !== 1 ||
							rows[0].narratorId !== narratorId ||
							rows[0].executionAttempt !== 1 ||
							rows[0].fileChangeOperationId
						) {
							throw new CriticalEventPersistenceError(
								"Cannot bind a tool to ambiguous or historical execution rows",
							);
						}
						binding = await narratorPersistence.getToolCallBinding(
							narratorId,
							savedId,
							tu.toolUseId,
							rows[0].id,
						);
					}
					ctx.toolCallIdsMap.set(tu.toolUseId, binding.toolCallId);
					ctx.toolExecutionReceipts.set(tu.toolUseId, { messageId: savedId, binding });
					event.onToolPersisted?.(tu.toolUseId, binding);
				}
			}

			if (
				hooks?.onPrepareEnterPlanMode &&
				event.toolUses.some((toolUse) => toolUse.name === "EnterPlanMode")
			) {
				if (!fullMessage) {
					throw new Error(
						`Cannot prepare EnterPlanMode: persisted message ${savedId} was not found.`,
					);
				}
				for (const tu of event.toolUses) {
					if (tu.name !== "EnterPlanMode") continue;
					const toolCall = fullMessage.toolCalls.find((tc) => tc.toolUseId === tu.toolUseId);
					if (!toolCall?.id) {
						throw new Error(
							`Cannot prepare EnterPlanMode without an exact tool-call row for ${tu.toolUseId}.`,
						);
					}
					ctx.preparedPlanModeToolCalls ??= new Map();
					ctx.preparedPlanModeToolCalls.set(tu.toolUseId, toolCall.id);
					await hooks.onPrepareEnterPlanMode(toolCall.id, tu.toolUseId, tu.input);
				}
			}

			const ref = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, savedId),
				),
				columns: { seq: true },
			});

			// Apply the same truncation and enrichment as the HTTP API so WS and REST
			// clients receive identically shaped messages.
			const processed = fullMessage
				? enrichToolUseBlocks(truncateToolIO([{ ...fullMessage, seq: ref?.seq }]))[0]
				: fullMessage;

			dualBroadcast(ctx, {
				type: "message",
				narratorId: broadcastTargetId,
				message: processed,
			});
			eventBus.emit({ type: "narrator:message", narratorId, role: "assistant" });

			// Main narrator: clear compact summary after first response
			if (hooks?.onClearCompactSummary) {
				await hooks.onClearCompactSummary();
			}

			// Bind this assistant message to the exact API request row created in this turn.
			const pendingApiRequestId = ctx.pendingApiRequestIds?.shift();
			if (pendingApiRequestId) {
				try {
					await db
						.update(apiRequests)
						.set({ messageId: savedId })
						.where(eq(apiRequests.id, pendingApiRequestId));
				} catch (error) {
					logger.warn("Failed to update API request messageId", {
						narratorId,
						savedId,
						apiRequestId: pendingApiRequestId,
						error,
					});
				}
			}

			const savedMsg = fullMessage ?? { id: savedId };
			ctx.sseEmitter?.emit("event", { type: "assistant_message", data: savedMsg });

			// Main narrator: title tracking
			if (hooks?.onTitleCheck) {
				return hooks.onTitleCheck(savedId);
			}
			return null;
		}

		case "tool_result": {
			// Only a receipt returned by this consumer (or the loop's exact receipt) may settle a row.
			const receipt = ctx.toolExecutionReceipts?.get(event.toolUseId);
			const binding = event.toolCallBinding ?? receipt?.binding;
			if (!binding && ctx.requireToolCallBinding)
				throw new CriticalEventPersistenceError("Tool result has no persisted execution receipt");
			if (binding) {
				const resultMessageId = await narratorPersistence.validateToolCallBinding(
					narratorId,
					event.toolUseId,
					binding,
				);
				if (receipt?.binding.toolCallId === binding.toolCallId) {
					ctx.toolExecutionReceipts?.set(event.toolUseId, { messageId: resultMessageId, binding });
				}
			}
			// A bare display event is not execution authority and must never perform a fuzzy write.
			const resultToolCallId =
				binding?.toolCallId ?? ctx.preparedPlanModeToolCalls?.get(event.toolUseId);
			// Snapshot: remove completed tool from active chunks
			streamingSnapshots.get(broadcastTargetId)?.toolChunks.delete(event.toolUseId);

			const status = event.isError ? "fail" : "success";
			const preparedPlanToolCallId = ctx.preparedPlanModeToolCalls?.get(event.toolUseId);
			if (binding && preparedPlanToolCallId && preparedPlanToolCallId !== binding.toolCallId) {
				throw new CriticalEventPersistenceError(
					"Prepared plan state belongs to another tool attempt",
				);
			}
			const persistedOutput = event.metadata
				? { _text: event.output, _metadata: event.metadata }
				: event.output;
			const isSuccessfulEnterPlanMode = event.toolName === "EnterPlanMode" && !event.isError;
			if (isSuccessfulEnterPlanMode && ctx.committedPlanModeToolUseIds?.has(event.toolUseId)) {
				return null;
			}
			if (isSuccessfulEnterPlanMode && (!preparedPlanToolCallId || !hooks?.onEnterPlanMode)) {
				ctx.preparedPlanModeToolCalls?.delete(event.toolUseId);
				if (preparedPlanToolCallId) {
					try {
						await hooks?.onEnterPlanModeFailed?.(preparedPlanToolCallId, event.toolUseId);
					} catch (cleanupError) {
						logger.error("Failed to discard uncommittable EnterPlanMode state", {
							narratorId,
							toolCallId: preparedPlanToolCallId,
							toolUseId: event.toolUseId,
							error: String(cleanupError),
						});
					}
				}
				const message = preparedPlanToolCallId
					? "Refusing successful EnterPlanMode without an atomic commit hook."
					: "Refusing successful EnterPlanMode without prepared persisted state.";
				try {
					if (resultToolCallId)
						await narratorService.updateToolCallResult(
							event.toolUseId,
							{ output: message, status: "fail", errorMessage: message },
							undefined,
							resultToolCallId,
						);
				} catch (persistError) {
					logger.error("Failed to persist EnterPlanMode fail-closed result", {
						narratorId,
						toolUseId: event.toolUseId,
						error: String(persistError),
					});
				}
				broadcastToolCompleted(ctx, {
					type: "tool_completed",
					narratorId: broadcastTargetId,
					...subagentToolRouting(ctx, event.toolUseId),
					toolUseId: event.toolUseId,
					toolName: event.toolName,
					status: "fail",
					output: truncateJson(message, 2000),
				});
				throw new CriticalEventPersistenceError(message);
			}
			const shouldCommitEnterPlanModeAtomically =
				!!preparedPlanToolCallId && isSuccessfulEnterPlanMode && !!hooks?.onEnterPlanMode;
			let toolResultPersisted = false;

			if (shouldCommitEnterPlanModeAtomically && preparedPlanToolCallId) {
				let commitError: unknown;
				for (let attempt = 0; attempt < 2 && !toolResultPersisted; attempt++) {
					try {
						await hooks.onEnterPlanMode?.(preparedPlanToolCallId, event.toolUseId, {
							output: persistedOutput,
							durationMs: event.durationMs,
							permissionStartedAt: event.permissionStartedAt,
							executionStartedAt: event.executionStartedAt,
							completedAt: event.completedAt,
							brokenInputOverride: event.brokenInputOverride,
							updatedInput: event.updatedInput,
						});
						toolResultPersisted = true;
					} catch (error) {
						commitError = error;
					}
				}
				ctx.preparedPlanModeToolCalls?.delete(event.toolUseId);
				if (toolResultPersisted) {
					ctx.committedPlanModeToolUseIds ??= new Set();
					ctx.committedPlanModeToolUseIds.add(event.toolUseId);
				}
				if (!toolResultPersisted) {
					try {
						await hooks.onEnterPlanModeFailed?.(preparedPlanToolCallId, event.toolUseId);
					} catch (cleanupError) {
						logger.error("Failed to discard EnterPlanMode after atomic commit failure", {
							narratorId,
							toolCallId: preparedPlanToolCallId,
							toolUseId: event.toolUseId,
							error: String(cleanupError),
						});
					}
					const message = `Failed to atomically commit EnterPlanMode: ${String(commitError)}`;
					try {
						await narratorService.updateToolCallResult(
							event.toolUseId,
							{ output: message, status: "fail", errorMessage: message },
							undefined,
							resultToolCallId,
						);
					} catch (persistError) {
						logger.error("Failed to persist EnterPlanMode atomic commit failure", {
							narratorId,
							toolUseId: event.toolUseId,
							error: String(persistError),
						});
					}
					broadcastToolCompleted(ctx, {
						type: "tool_completed",
						narratorId: broadcastTargetId,
						...subagentToolRouting(ctx, event.toolUseId),
						toolUseId: event.toolUseId,
						toolName: event.toolName,
						status: "fail",
						output: truncateJson(message, 2000),
					});
					throw new CriticalEventPersistenceError(message, { cause: commitError });
				}
			}

			if (!shouldCommitEnterPlanModeAtomically && resultToolCallId) {
				try {
					await narratorService.updateToolCallResult(
						event.toolUseId,
						{
							output: persistedOutput,
							status,
							errorMessage: event.isError ? event.output : undefined,
							durationMs: event.durationMs,
							permissionStartedAt: event.permissionStartedAt,
							executionStartedAt: event.executionStartedAt,
							completedAt: event.completedAt,
						},
						undefined,
						resultToolCallId,
					);
					// Broken tool call: overwrite the persisted inputJson with a sanitized
					// version (large content fields replaced with a short placeholder).
					if (event.brokenInputOverride) {
						await narratorService.overwriteToolCallInput(
							event.toolUseId,
							event.brokenInputOverride,
							resultToolCallId,
						);
					}
					// Permission-level input redirect (e.g. plan-mode file path):
					// update the persisted inputJson to reflect the actual path used.
					else if (event.updatedInput) {
						await narratorService.overwriteToolCallInput(
							event.toolUseId,
							event.updatedInput,
							resultToolCallId,
						);
					}
					toolResultPersisted = true;
				} catch (err) {
					logger.error("Failed to persist tool result", {
						narratorId,
						toolUseId: event.toolUseId,
						error: String(err),
					});
					// Retry once — transient DB lock / busy errors are common with SQLite
					try {
						await narratorService.updateToolCallResult(
							event.toolUseId,
							{
								output: event.metadata
									? { _text: event.output, _metadata: event.metadata }
									: event.output,
								status,
								errorMessage: event.isError ? event.output : undefined,
								durationMs: event.durationMs,
								permissionStartedAt: event.permissionStartedAt,
								executionStartedAt: event.executionStartedAt,
								completedAt: event.completedAt,
							},
							undefined,
							resultToolCallId,
						);
						if (event.brokenInputOverride) {
							await narratorService.overwriteToolCallInput(
								event.toolUseId,
								event.brokenInputOverride,
								resultToolCallId,
							);
						} else if (event.updatedInput) {
							await narratorService.overwriteToolCallInput(
								event.toolUseId,
								event.updatedInput,
								resultToolCallId,
							);
						}
						toolResultPersisted = true;
					} catch (retryErr) {
						logger.error("CRITICAL: tool_result persist failed after retry", {
							narratorId,
							toolUseId: event.toolUseId,
							error: String(retryErr),
						});
						throw new CriticalEventPersistenceError("Tool result could not be persisted", {
							cause: retryErr,
						});
					}
				}
			}

			if (preparedPlanToolCallId && !shouldCommitEnterPlanModeAtomically) {
				ctx.preparedPlanModeToolCalls?.delete(event.toolUseId);
				try {
					await hooks?.onEnterPlanModeFailed?.(preparedPlanToolCallId, event.toolUseId);
				} catch (err) {
					logger.error("Failed to discard prepared EnterPlanMode state", {
						narratorId,
						toolCallId: preparedPlanToolCallId,
						toolUseId: event.toolUseId,
						error: String(err),
					});
				}
			}

			broadcastToolCompleted(ctx, {
				type: "tool_completed",
				narratorId: broadcastTargetId,
				...subagentToolRouting(ctx, event.toolUseId),
				...(resultToolCallId ? { toolCallId: resultToolCallId } : {}),
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				status,
				output: truncateJson(event.output, 2000),
				durationMs: event.durationMs,
				...(event.updatedInput && { updatedInput: event.updatedInput }),
				...(event.metadata && { metadata: event.metadata }),
			});

			if (hooks?.onToolResult) {
				await hooks.onToolResult(event);
			}

			// Main narrator: git tracking
			if (hooks?.onGitTrack) {
				hooks.onGitTrack(event.toolName, event.toolUseId, event.input);
			}

			// Main narrator: ExitPlanMode
			if (!event.isError && event.toolName === "ExitPlanMode" && hooks?.onExitPlanMode) {
				await hooks.onExitPlanMode(event.toolUseId);
			}
			return null;
		}

		case "tool_output": {
			// Store latest output in snapshot for reconnecting clients
			const snap = getOrCreateSnapshot(broadcastTargetId);
			const chunk = snap.toolChunks.get(event.toolUseId);
			if (chunk) {
				chunk.streamingOutput = event.output;
			}
			dualBroadcast(ctx, {
				type: "tool_output",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				output: event.output,
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		/**
		 * Execution actually began (permission granted + final admission acquired).
		 *
		 * This is the frame that lets a client stop GUESSING. `tool_started` only means
		 * the input finished parsing, so before this event existed the UI had to treat it
		 * as "executing" and consequently painted a card that was waiting on a human
		 * approval as though work were under way.
		 *
		 * Also recorded on the snapshot: a client that reconnects mid-execution must
		 * learn the tool is running rather than inferring it from `started`.
		 */
		case "tool_executing": {
			{
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existing = snap.toolChunks.get(event.toolUseId);
				if (existing) {
					snap.toolChunks.set(event.toolUseId, { ...existing, executing: true });
				}
			}
			dualBroadcast(ctx, {
				type: "tool_executing",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				executionStartedAt: event.executionStartedAt,
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "tool_progress": {
			dualBroadcast(ctx, {
				type: "tool_progress",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				elapsed: event.elapsed,
			});
			return null;
		}

		case "tool_structured_progress": {
			// Recorded on the snapshot before broadcasting, so a client that connects
			// between two frames still gets the current bar from its catch-up.
			const snap = getOrCreateSnapshot(broadcastTargetId);
			const chunk = snap.toolChunks.get(event.toolUseId);
			if (chunk) chunk.structuredProgress = event.progress;
			dualBroadcast(ctx, {
				type: "tool_structured_progress",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				progress: event.progress,
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		// 转发看门狗的长时间运行通知到 WS，前端收到后在 ToolCallCard 上显示终止按钮
		case "tool_long_running": {
			dualBroadcast(ctx, {
				type: "tool_long_running",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				elapsed: event.elapsed,
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "error": {
			// Snapshot: clear streaming state on error
			clearStreamingSnapshot(broadcastTargetId);
			if (ctx.parentToolUseId) clearStreamingSnapshot(narratorId);
			ctx.fileReferenceContexts?.clear();

			if (hooks?.onErrorCleanup) {
				await hooks.onErrorCleanup(event.message, event.diagnostics);
			} else if (event.message !== "Aborted") {
				// Default: just log for subagents
				logger.error("Agent loop error", { narratorId, error: event.message });
			}
			return null;
		}

		case "retryable_error": {
			// Transient errors are handled by the caller's retry logic —
			// do NOT call onErrorCleanup (which would set status to "error").
			logger.warn("Retryable API error", { narratorId, error: event.message });
			return null;
		}

		case "payment_required": {
			logger.warn("NUG payment required", {
				narratorId,
				providerId: event.providerId,
				providerPrefix: event.providerPrefix,
				resumeAction: event.resumeAction,
			});
			dualBroadcast(ctx, {
				type: "payment_required",
				narratorId: broadcastTargetId,
				providerId: event.providerId,
				providerPrefix: event.providerPrefix,
				balance: event.balance,
				required: event.required,
				resumeAction: event.resumeAction,
			});
			return null;
		}

		case "retrying": {
			// In-loop transient retry — notify frontend via WS warning so the
			// status bar can show retry progress.  No DB state changes needed.
			logger.warn("Retrying transient API error in-loop", {
				narratorId,
				error: event.message,
				attempt: event.attempt,
				maxRetries: event.maxRetries,
				delayMs: event.delayMs,
			});
			broadcastToNarrator(broadcastTargetId, {
				type: "warning",
				narratorId: broadcastTargetId,
				message: event.message,
				retryCount: event.attempt,
				maxRetries: event.maxRetries,
				delayMs: event.delayMs,
				diagnostics: event.diagnostics,
			});
			return null;
		}

		case "stream_reset": {
			// A reasoning-only dead turn was discarded. Clear the streaming snapshot
			// (which still holds the live reasoning that will not be persisted) and
			// tell the frontend to drop the streaming blocks it is currently showing.
			clearStreamingSnapshot(broadcastTargetId);
			if (ctx.parentToolUseId) clearStreamingSnapshot(narratorId);
			ctx.fileReferenceContexts?.clear();
			dualBroadcast(ctx, {
				type: "streaming_reset",
				narratorId: broadcastTargetId,
				...(ctx.parentToolUseId ? { parentToolUseId: ctx.parentToolUseId } : {}),
			});
			ctx.sseEmitter?.emit("event", { type: "streaming_reset" });
			return null;
		}

		case "tool_use_discarded": {
			// A retried attempt abandoned tool ids whose arguments never finished
			// streaming. Those cards exist only on the client (no tool-call row was
			// ever created), and no later event would retire them — without this they
			// stay "running" forever with a live elapsed timer. Drop them from the
			// reconnect snapshot too, so a client that reconnects after the retry does
			// not receive the ghosts all over again.
			const snap = streamingSnapshots.get(broadcastTargetId);
			if (snap) {
				for (const toolUseId of event.toolUseIds) snap.toolChunks.delete(toolUseId);
			}
			dualBroadcast(ctx, {
				type: "tool_use_discarded",
				narratorId: broadcastTargetId,
				toolUseIds: event.toolUseIds,
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "stream_reasoning": {
			// Add "reasoning" substatus on first reasoning chunk
			if (ctx.addSubstatus && ctx.getSubstatus && !ctx.getSubstatus().has("reasoning")) {
				ctx.addSubstatus("reasoning").catch(() => {});
			}
			// First visible token latency (reasoning may arrive before text)
			if (ctx.getTtftMs && ctx.setTtftMs && ctx.getTtftMs() == null) {
				const startedAt = ctx.getTurnStartedAt?.();
				if (startedAt) {
					const ttftMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
					ctx.setTtftMs(ttftMs);
				}
			}
			// Track AI reasoning output character rate
			recordOutputChunk(event.text.length);

			const reasoningId = event.providerMetadata?.openai?.itemId;
			const reasoningOutputIndex = event.outputIndex;

			// Snapshot: accumulate streaming reasoning blocks in provider order.
			if (!ctx.parentToolUseId) {
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existingIdx = snap.streamingBlocks.findIndex((b) => {
					if (b.type !== "reasoning") return false;
					if (reasoningId) return b.id === reasoningId;
					if (reasoningOutputIndex != null) return b.outputIndex === reasoningOutputIndex;
					return !b.id && b.outputIndex == null;
				});
				if (existingIdx !== -1) {
					const existing = snap.streamingBlocks[existingIdx];
					if (existing.type === "reasoning") {
						existing.text += event.text;
						if (reasoningId) existing.id = reasoningId;
						if (reasoningOutputIndex != null) existing.outputIndex = reasoningOutputIndex;
					}
				} else {
					snap.streamingBlocks.splice(
						findOrderedSnapshotInsertIndex(snap.streamingBlocks, reasoningOutputIndex),
						0,
						{
							type: "reasoning",
							text: event.text,
							...(reasoningId ? { id: reasoningId } : {}),
							...(reasoningOutputIndex != null ? { outputIndex: reasoningOutputIndex } : {}),
						},
					);
				}
			}

			const reasoningStreamEvent: Record<string, unknown> = {
				type: "content_block_delta",
				delta: {
					type: "reasoning_delta",
					text: event.text,
					...(reasoningId ? { id: reasoningId } : {}),
					...(reasoningOutputIndex != null ? { outputIndex: reasoningOutputIndex } : {}),
				},
			};
			// Subagent: attach linking info so frontend knows which tool_use this belongs to
			if (ctx.parentToolUseId) {
				reasoningStreamEvent.subagentToolUseId = ctx.parentToolUseId;
				reasoningStreamEvent.subagentNarratorId = narratorId;
			}
			dualBroadcast(ctx, {
				type: "stream_event",
				narratorId: broadcastTargetId,
				event: reasoningStreamEvent,
			});
			ctx.sseEmitter?.emit("event", {
				type: "stream_event",
				data: {
					type: "content_block_delta",
					delta: {
						type: "reasoning_delta",
						text: event.text,
						...(reasoningId ? { id: reasoningId } : {}),
						...(reasoningOutputIndex != null ? { outputIndex: reasoningOutputIndex } : {}),
					},
				},
			});
			return null;
		}

		case "context_usage": {
			ctx.setContextUsagePct(event.percentage);
			const previousUsage = ctx.getTokenUsage() ?? {};
			ctx.setTokenUsage({
				...previousUsage,
				...(event.promptTokens != null && { promptTokens: event.promptTokens }),
				...(event.inputTokens != null && { inputTokens: event.inputTokens }),
				...(event.completionTokens != null && { completionTokens: event.completionTokens }),
				...(event.reasoningTokens != null && { reasoningTokens: event.reasoningTokens }),
				...(event.cachedInputTokens != null && { cachedInputTokens: event.cachedInputTokens }),
				...(event.cacheCreationInputTokens != null && {
					cacheCreationInputTokens: event.cacheCreationInputTokens,
				}),
				...(event.cacheCreation5mTokens != null && {
					cacheCreation5mTokens: event.cacheCreation5mTokens,
				}),
				...(event.cacheCreation1hTokens != null && {
					cacheCreation1hTokens: event.cacheCreation1hTokens,
				}),
				...(event.contextWindow != null && { contextWindow: event.contextWindow }),
				...(event.isEstimated && { isEstimated: true }),
			});

			// Resolve active thresholds based on context window size
			const ctxWin = event.contextWindow ?? 128_000;
			const tier = ctxWin > LARGE_CONTEXT_BOUNDARY ? "large" : "standard";
			const activeThresholds =
				settings.agent.contextThresholds?.[tier] ?? DEFAULT_CONTEXT_THRESHOLDS[tier];

			const isSubagent = !!ctx.parentToolUseId;
			dualBroadcast(ctx, {
				type: "context_usage",
				narratorId: broadcastTargetId,
				percentage: event.percentage,
				...(event.promptTokens != null && { promptTokens: event.promptTokens }),
				...(event.contextWindow != null && { contextWindow: event.contextWindow }),
				...(event.isEstimated && { isEstimated: true }),
				...(isSubagent && { isSubagent: true }),
				compactStart:
					activeThresholds.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].compactStart,
			});
			ctx.sseEmitter?.emit("event", {
				type: "context_usage",
				data: {
					percentage: event.percentage,
					...(event.promptTokens != null && { promptTokens: event.promptTokens }),
					...(event.contextWindow != null && { contextWindow: event.contextWindow }),
					...(event.isEstimated && { isEstimated: true }),
					compactStart:
						activeThresholds.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].compactStart,
				},
			});

			// Main narrator: compact trigger
			if (hooks?.onContextUsage) {
				hooks.onContextUsage(event.percentage);
			}
			return null;
		}

		case "metering": {
			ctx.setMeterData(event.usage, event.unit);
			const isSubagent = !!ctx.parentToolUseId;
			dualBroadcast(ctx, {
				type: "metering",
				narratorId: broadcastTargetId,
				unit: event.unit,
				unitPlural: event.unitPlural,
				usage: event.usage,
				...(isSubagent && { isSubagent: true }),
			});
			return null;
		}

		// Generic gateway-injected queue/quota events (providers via unified gateway).
		case "queue_status": {
			const qsSnap = getOrCreateSnapshot(narratorId);
			// Queue events are snapshots, not patches. Empty/zero ends queueing.
			const cleared = event.position === 0 || (event.position == null && !event.queueMessage);
			qsSnap.queuePosition = cleared ? undefined : event.position;
			qsSnap.queueDepth = cleared ? undefined : event.queueDepth;
			qsSnap.queueMessage = cleared ? undefined : event.queueMessage;
			// Queue state belongs to this session, not its parent's status bar.
			broadcastToNarrator(narratorId, {
				type: "queue_status",
				narratorId,
				position: event.position,
				queueDepth: event.queueDepth,
				queueMessage: event.queueMessage,
			});
			return null;
		}

		case "quota_balance": {
			dualBroadcast(ctx, {
				type: "quota_balance",
				narratorId: broadcastTargetId,
				quotaBalance: event.quotaBalance,
				detailedQuotaBalance: event.detailedQuotaBalance,
			});
			if (ctx.providerPrefix) {
				updateCustomApiQuotaByPrefix(
					ctx.providerPrefix,
					event.quotaBalance,
					event.detailedQuotaBalance,
				);
				try {
					const { updateNugQuotaByPrefix } = await import("../routes/nug");
					if (event.quotaBalance != null) {
						const numericBalance = Number(event.quotaBalance);
						if (Number.isFinite(numericBalance)) {
							updateNugQuotaByPrefix(
								ctx.providerPrefix,
								numericBalance,
								event.detailedQuotaBalance ?? null,
							);
						}
					}
				} catch {
					// nug module not loaded — ignore
				}
			}
			return null;
		}

		case "invalid_state": {
			logger.warn("Agent invalid state event", {
				narratorId,
				reason: event.reason,
				message: event.message,
			});
				type: "error",
				error: {
					type: "invalid_state",
					reason: event.reason,
					message: event.message,
					diagnostics: event.diagnostics,
				},
			};
			dualBroadcast(ctx, {
				type: "stream_event",
				narratorId: broadcastTargetId,
			});
			ctx.sseEmitter?.emit("event", {
				type: "stream_event",
			});
			return null;
		}

		case "output_truncated": {
			logger.info("Agent output truncated by completion token limit", {
				narratorId,
				message: event.message,
			});
			return null;
		}

		case "resumable_recovered": {
			// A transient upstream interruption was recovered inside the loop (the turn
			// continues normally). Surface it as a warning notice so the status bar can
			// show that a recovery happened; no DB or run-state change.
			logger.warn("Recovered resumable stream interruption in-loop", {
				narratorId,
				strategy: event.strategy,
				message: event.message,
			});
			broadcastToNarrator(broadcastTargetId, {
				type: "warning",
				narratorId: broadcastTargetId,
				message: event.message,
				diagnostics: event.diagnostics,
			});
			return null;
		}

		case "context_length_exceeded": {
			logger.warn("Context length exceeded by API", {
				narratorId,
				message: event.message,
			});
			return null;
		}

		case "web_search": {
			// Snapshot: track web_search in provider order (top-level only)
			if (!ctx.parentToolUseId) {
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existingIdx = snap.streamingBlocks.findIndex(
					(b) => b.type === "web_search" && b.id === event.id,
				);

				if (existingIdx !== -1) {
					const existing = snap.streamingBlocks[existingIdx];
					if (existing.type === "web_search") {
						existing.status = event.status;
						if (event.query) existing.query = event.query;
						if (event.queries) existing.queries = event.queries;
						if (event.outputIndex != null) existing.outputIndex = event.outputIndex;
					}
				} else {
					snap.streamingBlocks.splice(
						findOrderedSnapshotInsertIndex(snap.streamingBlocks, event.outputIndex),
						0,
						{
							type: "web_search",
							id: event.id,
							status: event.status,
							query: event.query,
							queries: event.queries,
							...(event.outputIndex != null ? { outputIndex: event.outputIndex } : {}),
						},
					);
				}
			}
			dualBroadcast(ctx, {
				type: "web_search",
				narratorId: broadcastTargetId,
				id: event.id,
				status: event.status as "in_progress" | "searching" | "completed",
				query: event.query,
				queries: event.queries,
				...(event.outputIndex != null ? { outputIndex: event.outputIndex } : {}),
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "image_generation": {
			let partialSavedPath = event.partialSavedPath;
			let imageWidth = event.width;
			let imageHeight = event.height;
			if (event.partialImageB64) {
				try {
					const saved = await saveImageGenerationResult(
						ctx.conversationId ?? "unknown",
						partialImageGenerationArtifactId(event.id, event.partialImageIndex),
						event.partialImageB64,
					);
					partialSavedPath = saved.filePath;
					imageWidth = saved.width;
					imageHeight = saved.height;
				} catch (err) {
					logger.warn("Failed to save partial generated image to disk", {
						error: err,
						imageId: event.id,
						partialImageIndex: event.partialImageIndex,
					});
				}
			}

			// Snapshot: track image_generation in provider order (top-level only)
			if (!ctx.parentToolUseId) {
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existingIdx = snap.streamingBlocks.findIndex(
					(b) => b.type === "image_generation" && b.id === event.id,
				);

				if (existingIdx !== -1) {
					const existing = snap.streamingBlocks[existingIdx];
					if (existing.type === "image_generation") {
						existing.status = event.status;
						if (event.revisedPrompt) existing.revisedPrompt = event.revisedPrompt;
						if (event.outputIndex != null) existing.outputIndex = event.outputIndex;
						if (event.partialImageIndex != null)
							existing.partialImageIndex = event.partialImageIndex;
						if (partialSavedPath) existing.partialSavedPath = partialSavedPath;
						if (event.savedPath) existing.savedPath = event.savedPath;
						if (imageWidth != null && imageHeight != null) {
							existing.width = imageWidth;
							existing.height = imageHeight;
						}
					}
				} else {
					snap.streamingBlocks.splice(
						findOrderedSnapshotInsertIndex(snap.streamingBlocks, event.outputIndex),
						0,
						{
							type: "image_generation",
							id: event.id,
							status: event.status,
							revisedPrompt: event.revisedPrompt,
							...(event.partialImageIndex != null
								? { partialImageIndex: event.partialImageIndex }
								: {}),
							...(partialSavedPath ? { partialSavedPath } : {}),
							...(event.savedPath ? { savedPath: event.savedPath } : {}),
							...(imageWidth != null && imageHeight != null
								? { width: imageWidth, height: imageHeight }
								: {}),
							...(event.outputIndex != null ? { outputIndex: event.outputIndex } : {}),
						},
					);
				}
			}
			// Omit raw base64 image data from WS broadcasts.  Partial previews and
			// final images are loaded by the frontend via /api/fs/preview and saved paths.
			dualBroadcast(ctx, {
				type: "image_generation",
				narratorId: broadcastTargetId,
				id: event.id,
				status: event.status as "in_progress" | "generating" | "completed",
				revisedPrompt: event.revisedPrompt,
				outputIndex: event.outputIndex,
				...(event.partialImageIndex != null ? { partialImageIndex: event.partialImageIndex } : {}),
				...(partialSavedPath ? { partialSavedPath } : {}),
				...(event.savedPath ? { savedPath: event.savedPath } : {}),
				...(imageWidth != null && imageHeight != null
					? { width: imageWidth, height: imageHeight }
					: {}),
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "model_switched": {
			ctx.provider = event.provider;
			ctx.providerPrefix = event.provider;
			ctx.model = event.model;
			dualBroadcast(ctx, {
				type: "model_switched",
				narratorId: broadcastTargetId,
				model: event.model,
				provider: event.provider,
				reasoningEffort: event.reasoningEffort,
			});
			dualBroadcast(ctx, {
				type: "model_settings_applied",
				narratorId: broadcastTargetId,
				model: event.model,
				provider: event.provider,
				reasoningEffort: event.reasoningEffort,
			});
			return null;
		}

		case "api_request_start": {
			// Store request start info in context for later use
			if (!ctx.apiRequestsMap) ctx.apiRequestsMap = new Map();
			ctx.apiRequestsMap.set(
				event.requestId,
				startApiRequest({
					narratorId,
					provider: event.provider,
					model: event.model,
					credentialId: event.credentialId,
					kind: "narrator",
				}),
			);
			// Mark where this attempt starts writing, keyed by its requestId. Idempotent:
			// if the attempt was already discarded (this event is flushed lazily and can
			// arrive after that), the existing baseline is kept rather than re-measured
			// against the already-truncated message.
			await recordAttemptBlockBaseline(ctx, event.requestId);
			return null;
		}

		case "attempt_discarded": {
			// The loop is about to replay the identical request. Everything this attempt
			// persisted must go: blocks are written as they complete, so leaving them
			// would stack a near-identical copy of the reasoning and tool calls onto the
			// same assistant message on every replay — the transcript grows while the
			// outgoing request never changes.
			await discardAttemptPersistedBlocks(ctx, narratorId, broadcastTargetId, event.requestId);
			return null;
		}

		case "leaked_tool_call": {
			// Buffer the diagnostic keyed by loop requestId. It is broadcast (with the real
			// persisted api_requests.id) once api_request_end records the row, so the frontend
			// download endpoint can resolve the raw SSE dump.
			if (!ctx.pendingLeakedToolCalls) ctx.pendingLeakedToolCalls = new Map();
			const list = ctx.pendingLeakedToolCalls.get(event.requestId) ?? [];
			list.push({
				phase: event.phase,
				toolUseIds: event.toolUseIds,
				toolNames: event.toolNames,
				snippet: event.snippet,
			});
			ctx.pendingLeakedToolCalls.set(event.requestId, list);
			return null;
		}

		case "api_request_end": {
			// Create API request record in database
			const requestInfo = ctx.apiRequestsMap?.get(event.requestId);
			if (!requestInfo) {
				logger.warn("API request end without start", { narratorId, requestId: event.requestId });
				return null;
			}

			const usageData = event.usage
				? {
						inputTokens: event.usage.inputTokens ?? event.usage.promptTokens ?? 0,
						outputTokens: event.usage.completionTokens ?? 0,
						cachedInputTokens: event.usage.cachedInputTokens ?? 0,
						cacheCreationInputTokens: event.usage.cacheCreationInputTokens ?? 0,
						cacheCreation5mInputTokens: event.usage.cacheCreation5mTokens ?? 0,
						cacheCreation1hInputTokens: event.usage.cacheCreation1hTokens ?? 0,
						reasoningTokens: event.usage.reasoningTokens ?? 0,
					}
				: null;

			try {
				const apiRequestId = await finishApiRequest(requestInfo, {
					usage: usageData,
					credentialId: event.credentialId,
					ttftMs: event.ttftMs ?? null,
					durationMs: event.durationMs ?? null,
					contextPercent: event.contextPercent ?? null,
					meterUsage: event.meterUsage ?? null,
					meterUnit: event.meterUnit ?? null,
					errorMessage: event.errorMessage ?? null,
					diagnostics: event.diagnostics,
					rawDump: event.rawDump,
					// Leaked-tool detection forces the raw SSE dump to persist so it stays
					// downloadable even when error-only dumping is enabled. We intentionally do
					// NOT synthesize an errorMessage here: that would mark a successful request
					// as errored and skip assistant-message binding. The notice below carries
					// the apiRequestId for the download endpoint instead.
					forceDumpPersist: event.forceDumpPersist,
					// Replays of one rejected request share a spill file rather than each writing
					// a near-identical multi-MB copy that prunes other captures away.
					dumpSpillReuseToken: event.dumpSpillReuseToken,
				});
				if (!event.errorMessage) {
					if (!ctx.pendingApiRequestIds) ctx.pendingApiRequestIds = [];
					ctx.pendingApiRequestIds.push(apiRequestId);
				}

				// Flush buffered leaked-tool diagnostics now that the persisted api_requests.id
				// is known. The notice is transient (not persisted) — the frontend uses it to
				// mark stream-captured tool calls or prompt downloading the raw dump.
				const leaked = ctx.pendingLeakedToolCalls?.get(event.requestId);
				if (leaked?.length) {
					for (const signal of leaked) {
						dualBroadcast(ctx, {
							type: "leaked_tool_call_notice",
							narratorId: broadcastTargetId,
							phase: signal.phase,
							apiRequestId,
							toolUseIds: signal.toolUseIds,
							toolNames: signal.toolNames,
							snippet: signal.snippet,
						});
					}
				}
			} catch (error) {
				logger.error("Failed to create API request record", {
					narratorId,
					requestId: event.requestId,
					apiRequestId: requestInfo.id,
					error,
				});
			} finally {
				// Clean up in-progress request info after persistence attempt.
				ctx.apiRequestsMap?.delete(event.requestId);
				ctx.pendingLeakedToolCalls?.delete(event.requestId);
			}
			return null;
		}

		default:
			return null;
	}
}
