import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
	apiRequests,
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narratorToolCalls,
} from "../db/schema";
import type { AgentEvent } from "../lib/agent";
import { summaryGenerate } from "../lib/agent";
import { saveImageGenerationResult } from "../lib/agent/image-generation";
import {
	type ApiRequestHandle,
	finishApiRequest,
	startApiRequest,
} from "../lib/api-request-tracker";
import { updateCustomApiQuotaByPrefix } from "../lib/custom-api-quota-cache";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { DEFAULT_CONTEXT_THRESHOLDS, LARGE_CONTEXT_BOUNDARY, settings } from "../lib/settings";
import { buildUsageDataFromSnapshot, updateMessageUsage } from "../lib/usage-tracking";
import { broadcastToNarrator, type NarratorServerMessage } from "../websocket/narrator-ws";
import {
	enrichToolUseBlocks,
	narratorService,
	truncateJson,
	truncateToolIO,
} from "./narrator-service";
import { recordOutputChunk } from "./output-stats";

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
	/** Tracks API requests in progress (requestId → request info) */
	apiRequestsMap?: Map<string, ApiRequestHandle>;
	/** API requests inserted during this turn and awaiting assistant-message binding */
	pendingApiRequestIds?: string[];
}

/**
 * Optional hooks for main-narrator-specific behavior.
 * Subagents simply don't provide these.
 */
export interface EventHooks {
	/** Title tracking after assistant_message */
	onTitleCheck?: (savedId: string) => Promise<{ titleUpdate?: boolean } | null>;
	/** TodoWrite tool call */
	onTodoWrite?: (todos: unknown[], toolUseId: string) => Promise<void>;
	/** EnterPlanMode tool call */
	onEnterPlanMode?: () => Promise<void>;
	/** ExitPlanMode completed successfully */
	onExitPlanMode?: (toolUseId: string) => Promise<void>;
	/** Clear compact summary after first response */
	onClearCompactSummary?: () => Promise<void>;
	/** Git status tracking after file-mutating tools */
	onGitTrack?: (toolName: string, toolUseId: string) => void;
	/** Snapshot: record tree hash before a file-mutating tool executes */
	onSnapshotBefore?: (toolUseId: string, toolName: string) => void;
	/** Snapshot: record tree hash after a file-mutating tool completes */
	onSnapshotAfter?: (toolUseId: string, toolName: string) => void;
	/** Context usage event (prune + compact trigger) */
	onContextUsage?: (percentage: number) => void;
	/** Error cleanup (partial message removal, orphaned tool calls) */
	onErrorCleanup?: (message: string) => Promise<void>;
}

// === Streaming snapshot: track in-progress streaming state per narrator ===
// Allows newly-subscribing clients to restore tool_use_chunk / text streaming
// state when switching between narrator sessions.

export interface ToolChunkSnapshot {
	toolUseId: string;
	toolName: string;
	inputCharsTotal: number;
	parentToolUseId?: string;
	extractedFilePath?: string;
	contentCharsReceived?: number;
	extractedFields?: Record<string, string>;
	metadata?: Record<string, unknown>;
	/** Whether tool_started has fired (tool is executing) */
	started?: boolean;
	/** Input payload from tool_started */
	input?: unknown;
	/** Timestamp from tool_started */
	streamStartedAt?: number;
	/** Latest streaming output from bash tool */
	streamingOutput?: string;
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
			outputIndex?: number;
	  }
	| { type: "text"; text: string; outputIndex?: number };

export interface StreamingSnapshot {
	/** Ordered streaming blocks — preserves temporal order of reasoning, web_search, and text. */
	streamingBlocks: SnapshotStreamingBlock[];
	toolChunks: Map<string, ToolChunkSnapshot>;
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
 * The self-copy replaces `narratorId` with the subagent's own ID and strips
 * subagent-specific linking fields so it looks like a normal narrator event.
 */
function dualBroadcast(ctx: EventHandlerContext, message: NarratorServerMessage): void {
	// Primary broadcast (to parent narrator's subscribers)
	broadcastToNarrator(ctx.broadcastTargetId, message);

	// Self-broadcast for subagents: send to subagent's own narratorId
	if (ctx.parentToolUseId && ctx.narratorId !== ctx.broadcastTargetId) {
		// biome-ignore lint/suspicious/noExplicitAny: shallow clone with dynamic field overrides
		const selfMsg: any = { ...message, narratorId: ctx.narratorId };
		// Strip subagent linking fields from the nested event (if present)
		if (selfMsg.event && typeof selfMsg.event === "object") {
			const { subagentToolUseId, subagentNarratorId, ...cleanEvent } = selfMsg.event;
			selfMsg.event = cleanEvent;
		}
		// Strip parentToolUseId from tool_use_chunk self-copy
		if (selfMsg.parentToolUseId) {
			delete selfMsg.parentToolUseId;
		}
		// Strip isSubagent flag from context_usage / metering self-copy
		if (selfMsg.isSubagent) {
			delete selfMsg.isSubagent;
		}
		// Strip parentToolUseId from the message payload so the subagent page
		// treats it as a top-level message (not a child of some tool_use)
		if (selfMsg.message?.parentToolUseId) {
			selfMsg.message = { ...selfMsg.message, parentToolUseId: null };
		}
		broadcastToNarrator(ctx.narratorId, selfMsg);
	}
}

async function getToolCallMessageId(narratorId: string, toolUseId: string): Promise<string | null> {
	const row = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { messageId: true },
	});
	return row?.messageId ?? null;
}

async function getLatestAssistantMessageId(narratorId: string): Promise<string | null> {
	const [row] = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessages.role, "assistant")),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1);
	return row?.id ?? null;
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
 * Translate a reasoning block's text via the summary model, then patch the
 * message in DB and broadcast the updated message to connected clients.
 * Runs as fire-and-forget — errors are logged but never propagate.
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

			await narratorService.patchReasoningTranslation(messageId, targetIdx, translated);

			// Broadcast updated message so frontend picks up the translation
			const fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				with: { toolCalls: true, sideCars: true },
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

			// Snapshot: accumulate streaming text (top-level only). When the provider
			// exposes outputIndex, keep the text block ordered relative to native
			// web_search/image_generation blocks.
			if (!ctx.parentToolUseId) {
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existingIdx =
					event.outputIndex != null
						? snap.streamingBlocks.findIndex(
								(b) => b.type === "text" && b.outputIndex === event.outputIndex,
							)
						: -1;
				if (existingIdx !== -1) {
					const existing = snap.streamingBlocks[existingIdx];
					if (existing.type === "text") existing.text += event.text;
				} else {
					const lastBlock = snap.streamingBlocks[snap.streamingBlocks.length - 1];
					if (lastBlock?.type === "text" && event.outputIndex == null) {
						lastBlock.text += event.text;
					} else {
						snap.streamingBlocks.splice(
							findOrderedSnapshotInsertIndex(snap.streamingBlocks, event.outputIndex),
							0,
							{ type: "text", text: event.text, outputIndex: event.outputIndex },
						);
					}
				}
			}

			const streamEvent: Record<string, unknown> = {
				type: "content_block_delta",
				delta: { type: "text_delta", text: event.text },
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
					delta: { type: "text_delta", text: event.text },
					...(event.outputIndex != null ? { outputIndex: event.outputIndex } : {}),
				},
			});
			return null;
		}

		case "tool_call": {
			// Snapshot: capture tree state before the tool modifies files
			if (hooks?.onSnapshotBefore) {
				hooks.onSnapshotBefore(event.toolUseId, event.toolName);
			}
			// Snapshot: mark tool as started (executing)
			{
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existing = snap.toolChunks.get(event.toolUseId);
				snap.toolChunks.set(event.toolUseId, {
					...existing,
					toolUseId: event.toolUseId,
					toolName: event.toolName,
					inputCharsTotal: existing?.inputCharsTotal ?? 0,
					...(existing?.parentToolUseId && { parentToolUseId: existing.parentToolUseId }),
					started: true,
					input: event.input,
					streamStartedAt: event.streamStartedAt,
				});
			}
			dualBroadcast(ctx, {
				type: "tool_started",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				input: event.input,
				streamStartedAt: event.streamStartedAt,
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
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
			// Snapshot: track active tool chunk
			{
				const snap = getOrCreateSnapshot(broadcastTargetId);
				const existing = snap.toolChunks.get(event.toolUseId);
				snap.toolChunks.set(event.toolUseId, {
					...existing,
					toolUseId: event.toolUseId,
					toolName: event.toolName,
					inputCharsTotal: event.inputCharsTotal,
					...(event.extractedFilePath && { extractedFilePath: event.extractedFilePath }),
					...(event.contentCharsReceived != null && {
						contentCharsReceived: event.contentCharsReceived,
					}),
					...(event.extractedFields && { extractedFields: event.extractedFields }),
					...(event.metadata && { metadata: event.metadata }),
					...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
				});
			}
			dualBroadcast(ctx, {
				type: "tool_use_chunk",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				inputCharsTotal: event.inputCharsTotal,
				...(event.extractedFilePath && { extractedFilePath: event.extractedFilePath }),
				...(event.contentCharsReceived != null && {
					contentCharsReceived: event.contentCharsReceived,
				}),
				...(event.extractedFields && { extractedFields: event.extractedFields }),
				...(event.metadata && { metadata: event.metadata }),
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
				...(event.streamingField && { streamingField: event.streamingField }),
			});
			return null;
		}

		case "block_complete": {
			const { block } = event;

			// Snapshot: remove the completed block from the ordered streaming blocks.
			// The completed block will be served via the partial message from the
			// database, so the snapshot should only contain blocks still being streamed.
			if (!ctx.parentToolUseId) {
				const snap = streamingSnapshots.get(broadcastTargetId);
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
				});
			} else if (block.type === "tool_use") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "tool_use",
					id: block.toolUseId,
					name: block.name,
					input: block.input,
					streamStartedAt: block.streamStartedAt,
					outputIndex: block.outputIndex,
				});
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
			}
			return null;
		}

		case "assistant_message": {
			// Snapshot: clear streaming state — this turn's text + tools are done
			clearStreamingSnapshot(broadcastTargetId);

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
				if (event.text) content.push({ type: "text", text: event.text });
				for (const tu of event.toolUses) {
					content.push({
						type: "tool_use",
						id: tu.toolUseId,
						name: tu.name,
						input: tu.input,
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

			// Main narrator hooks: TodoWrite, EnterPlanMode
			for (const tu of event.toolUses) {
				if (tu.name === "TaskCreate" && tu.input?.todos && hooks?.onTodoWrite) {
					await hooks.onTodoWrite(tu.input.todos as unknown[], tu.toolUseId);
				}
				if (tu.name === "EnterPlanMode" && hooks?.onEnterPlanMode) {
					await hooks.onEnterPlanMode();
				}
			}

			// Load full message with tool calls for broadcast
			const fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, savedId),
				with: { toolCalls: true, sideCars: true },
			});

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

			// Subagent: attach model info
			const broadcastMessage =
				ctx.subagentModel && processed
					? { ...processed, subagentModel: ctx.subagentModel }
					: processed;

			dualBroadcast(ctx, {
				type: "message",
				narratorId: broadcastTargetId,
				message: broadcastMessage,
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
			// Snapshot: remove completed tool from active chunks
			streamingSnapshots.get(broadcastTargetId)?.toolChunks.delete(event.toolUseId);

			const status = event.isError ? "fail" : "success";
			try {
				await narratorService.updateToolCallResult(event.toolUseId, {
					output: event.metadata
						? { _text: event.output, _metadata: event.metadata }
						: event.output,
					status,
					errorMessage: event.isError ? event.output : undefined,
					durationMs: event.durationMs,
					permissionStartedAt: event.permissionStartedAt,
					executionStartedAt: event.executionStartedAt,
					completedAt: event.completedAt,
				});
				// Broken tool call: overwrite the persisted inputJson with a sanitized
				// version (large content fields replaced with a short placeholder).
				if (event.brokenInputOverride) {
					await narratorService.overwriteToolCallInput(event.toolUseId, event.brokenInputOverride);
				}
				// Permission-level input redirect (e.g. plan-mode file path):
				// update the persisted inputJson to reflect the actual path used.
				else if (event.updatedInput) {
					await narratorService.overwriteToolCallInput(event.toolUseId, event.updatedInput);
				}
			} catch (err) {
				logger.error("Failed to persist tool result", {
					narratorId,
					toolUseId: event.toolUseId,
					error: String(err),
				});
				// Retry once — transient DB lock / busy errors are common with SQLite
				try {
					await narratorService.updateToolCallResult(event.toolUseId, {
						output: event.metadata
							? { _text: event.output, _metadata: event.metadata }
							: event.output,
						status,
						errorMessage: event.isError ? event.output : undefined,
						durationMs: event.durationMs,
					});
					if (event.brokenInputOverride) {
						await narratorService.overwriteToolCallInput(
							event.toolUseId,
							event.brokenInputOverride,
						);
					} else if (event.updatedInput) {
						await narratorService.overwriteToolCallInput(event.toolUseId, event.updatedInput);
					}
				} catch (retryErr) {
					logger.error("CRITICAL: tool_result persist failed after retry", {
						narratorId,
						toolUseId: event.toolUseId,
						error: String(retryErr),
					});
				}
			}

			dualBroadcast(ctx, {
				type: "tool_completed",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				status,
				output: truncateJson(event.output, 2000),
				durationMs: event.durationMs,
				...(event.updatedInput && { updatedInput: event.updatedInput }),
				...(event.metadata && { metadata: event.metadata }),
				...(event.sideCars?.length && { sideCars: event.sideCars }),
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});

			// Persist tool-result sidecars
			if (event.sideCars?.length) {
				const now = new Date().toISOString();
				const partialId = ctx.getPartialMessageId();
				const messageId = partialId ?? (await getToolCallMessageId(narratorId, event.toolUseId));
				try {
					await db.insert(narratorSidecars).values(
						event.sideCars.map((sc, idx) => ({
							id: generateId(),
							narratorId,
							messageId,
							toolUseId: event.toolUseId,
							target: sc.target,
							source: sc.source,
							content: sc.content,
							orderIndex: sc.orderIndex ?? idx,
							createdAt: now,
						})),
					);
				} catch (err) {
					logger.warn("Failed to persist tool-result sidecars", {
						narratorId,
						toolUseId: event.toolUseId,
						error: String(err),
					});
				}
			}

			// Main narrator: git tracking
			if (hooks?.onGitTrack) {
				hooks.onGitTrack(event.toolName, event.toolUseId);
			}

			// Snapshot: capture tree state after the tool completed
			if (hooks?.onSnapshotAfter) {
				hooks.onSnapshotAfter(event.toolUseId, event.toolName);
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

		case "tool_progress": {
			dualBroadcast(ctx, {
				type: "tool_progress",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				elapsed: event.elapsed,
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

			if (hooks?.onErrorCleanup) {
				await hooks.onErrorCleanup(event.message);
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
				pruneStart: activeThresholds.pruneStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].pruneStart,
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
					pruneStart: activeThresholds.pruneStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].pruneStart,
					compactStart:
						activeThresholds.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].compactStart,
				},
			});

			// Main narrator: prune + compact trigger
			if (hooks?.onContextUsage) {
				hooks.onContextUsage(event.percentage);
			}
			return null;
		}

		case "metering": {
			ctx.setMeterData(event.usage, event.unit);
			if (event.credentialId) {
				try {
				} catch {
				}
			}
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

			dualBroadcast(ctx, {
				narratorId: broadcastTargetId,
				quotaBalance: event.quotaBalance,
			});
			// Update the global in-memory quota cache so the provider management page
			// can display the latest balance without an extra network round-trip.
			if (ctx.providerPrefix) {
				try {
				} catch {
				}
			}
			return null;
		}

			// Cache queue position in the streaming snapshot so late-joining
			// subscribers see it immediately via streaming_snapshot.
			const qSnap = getOrCreateSnapshot(narratorId);
			dualBroadcast(ctx, {
				narratorId: broadcastTargetId,
				position: event.position,
				queueDepth: event.queueDepth,
			});
			return null;
		}

		// Generic gateway-injected queue/quota events (OpenAI/Anthropic via unified gateway).
		case "queue_status": {
			const qsSnap = getOrCreateSnapshot(narratorId);
			if (event.position !== undefined) {
			}
			if (event.queueDepth !== undefined) {
			}
			qsSnap.queueMessage = event.queueMessage;
			dualBroadcast(ctx, {
				type: "queue_status",
				narratorId: broadcastTargetId,
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
							...(event.outputIndex != null ? { outputIndex: event.outputIndex } : {}),
						},
					);
				}
			}
			// Omit `result` (base64 image data, potentially several MB) from WS
			// broadcast to avoid oversized WebSocket frames.  The frontend loads
			// the image via /api/fs/preview using the savedPath persisted in the
			// block_complete handler above.
			dualBroadcast(ctx, {
				type: "image_generation",
				narratorId: broadcastTargetId,
				id: event.id,
				status: event.status as "in_progress" | "generating" | "completed",
				revisedPrompt: event.revisedPrompt,
				outputIndex: event.outputIndex,
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
					rawDump: event.rawDump,
				});
				if (!event.errorMessage) {
					if (!ctx.pendingApiRequestIds) ctx.pendingApiRequestIds = [];
					ctx.pendingApiRequestIds.push(apiRequestId);
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
			}
			return null;
		}

		case "sidecars": {
			// Persist sidecars to DB and broadcast to frontend
			const now = new Date().toISOString();
			const partialId = ctx.getPartialMessageId();
			if (event.sideCars.length > 0) {
				const latestAssistantMessageId = partialId
					? null
					: await getLatestAssistantMessageId(narratorId);
				try {
					await db.insert(narratorSidecars).values(
						event.sideCars.map((sc, idx) => ({
							id: generateId(),
							narratorId,
							messageId: partialId ?? latestAssistantMessageId,
							toolUseId: sc.toolUseId ?? null,
							target: sc.target,
							source: sc.source,
							content: sc.content,
							orderIndex: sc.orderIndex ?? idx,
							createdAt: now,
						})),
					);
				} catch (err) {
					logger.warn("Failed to persist sidecars", {
						narratorId,
						count: event.sideCars.length,
						error: String(err),
					});
				}
				dualBroadcast(ctx, {
					type: "sidecars",
					narratorId: broadcastTargetId,
					sideCars: event.sideCars.map((sc) => ({
						target: sc.target,
						source: sc.source,
						content: sc.content,
						toolUseId: sc.toolUseId,
						orderIndex: sc.orderIndex,
					})),
					...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
				});
			}
			return null;
		}

		default:
			return null;
	}
}
