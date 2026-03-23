import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages } from "../db/schema";
import type { AgentEvent } from "../lib/agent";
import { summaryGenerate } from "../lib/agent";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
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
	completionTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
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

	// --- Mutable state accessors ---
	getContextUsagePct: () => number | undefined;
	getMeterUsage: () => number | undefined;
	getMeterUnit: () => string | undefined;
	getPartialMessageId: () => string | undefined;
	getTokenUsage: () => TokenUsageSnapshot | undefined;
	setPartialMessageId: (id: string | undefined) => void;
	setContextUsagePct: (pct: number) => void;
	setMeterData: (usage: number, unit: string) => void;
	setTokenUsage: (usage: TokenUsageSnapshot | undefined) => void;

	// --- Subagent-specific ---
	/** Parent tool_use ID that spawned this subagent */
	parentToolUseId?: string;
	/** Subagent's resolved model name (attached to broadcast messages) */
	subagentModel?: string;

	// --- Mutable tracking ---
	/** Tracks cumulative inputCharsTotal per tool_use for delta computation */
	toolUseCharsMap?: Map<string, number>;
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
	/** Whether tool_started has fired (tool is executing) */
	started?: boolean;
	/** Input payload from tool_started */
	input?: unknown;
	/** Timestamp from tool_started */
	streamStartedAt?: number;
	/** Latest streaming output from bash tool */
	streamingOutput?: string;
}

export interface StreamingSnapshot {
	streamingText: string;
	streamingReasoning: string;
	toolChunks: Map<string, ToolChunkSnapshot>;
}

const streamingSnapshots = (() => {
	const sym = Symbol.for("narrafork.streamingSnapshots");
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	const g = globalThis as any;
	if (!g[sym]) g[sym] = new Map<string, StreamingSnapshot>();
	return g[sym] as Map<string, StreamingSnapshot>;
})();

function getOrCreateSnapshot(narratorId: string): StreamingSnapshot {
	let snap = streamingSnapshots.get(narratorId);
	if (!snap) {
		snap = { streamingText: "", streamingReasoning: "", toolChunks: new Map() };
		streamingSnapshots.set(narratorId, snap);
	}
	return snap;
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

// === Reasoning translation ===

const LOCALE_NAMES: Record<string, string> = {
	"zh-CN": "简体中文",
	zh: "简体中文",
	ja: "日本語",
	ko: "한국어",
};

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
			);
			const translated = result.text?.trim();
			if (!translated) return;

			// Find the reasoning block index in the message
			const msg = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { contentJson: true },
			});
			if (!msg) return;
			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			// Find the last reasoning block whose text matches (in case of multiple)
			let targetIdx = -1;
			for (let i = blocks.length - 1; i >= 0; i--) {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON content blocks
				const b = blocks[i] as any;
				if (b.type === "reasoning" && b.text === reasoningText) {
					targetIdx = i;
					break;
				}
			}
			if (targetIdx === -1) return;

			await narratorService.patchReasoningTranslation(messageId, targetIdx, translated);

			// Broadcast updated message so frontend picks up the translation
			const fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				with: { toolCalls: true },
			});
			if (fullMessage) {
				const processed = enrichToolUseBlocks(truncateToolIO([fullMessage]))[0];
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
			// Track AI output character rate
			recordOutputChunk(event.text.length);

			// Snapshot: accumulate streaming text (top-level only)
			if (!ctx.parentToolUseId) {
				getOrCreateSnapshot(broadcastTargetId).streamingText += event.text;
			}

			const streamEvent: Record<string, unknown> = {
				type: "content_block_delta",
				delta: { type: "text_delta", text: event.text },
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
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "block_complete": {
			const { block } = event;

			// Snapshot: clear accumulated streaming text/reasoning once the block
			// is persisted — the completed block will be served via the partial
			// message from the database, so the snapshot should only contain
			// text that is still being streamed (i.e. not yet block_complete).
			if (!ctx.parentToolUseId) {
				const snap = streamingSnapshots.get(broadcastTargetId);
				if (snap) {
					if (block.type === "text") {
						snap.streamingText = "";
					} else if (block.type === "reasoning") {
						snap.streamingReasoning = "";
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
					tokensIn: tokenUsage?.promptTokens,
					turnUsage: tokenUsage
						? {
								input_tokens: tokenUsage.promptTokens,
								...(tokenUsage.completionTokens != null && {
									output_tokens: tokenUsage.completionTokens,
								}),
								...(tokenUsage.reasoningTokens != null && {
									reasoning_tokens: tokenUsage.reasoningTokens,
								}),
								...(tokenUsage.cachedInputTokens != null && {
									cached_input_tokens: tokenUsage.cachedInputTokens,
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
				});
			} else if (block.type === "reasoning") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "reasoning",
					text: block.text,
					providerMetadata: block.providerMetadata,
				});
				// Fire-and-forget reasoning translation
				if (settings.agent.translateReasoning && block.text) {
					translateReasoningBlock(partialId, narratorId, broadcastTargetId, block.text, ctx);
				}
			} else if (block.type === "tool_use") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "tool_use",
					id: block.toolUseId,
					name: block.name,
					input: block.input,
				});
			} else if (block.type === "web_search") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "web_search",
					id: block.id,
					query: block.query,
					queries: block.queries,
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
						input_tokens: tokenUsage.promptTokens,
						...(tokenUsage.completionTokens != null && {
							output_tokens: tokenUsage.completionTokens,
						}),
						...(tokenUsage.reasoningTokens != null && {
							reasoning_tokens: tokenUsage.reasoningTokens,
						}),
						...(tokenUsage.cachedInputTokens != null && {
							cached_input_tokens: tokenUsage.cachedInputTokens,
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
				if (tokenUsage?.promptTokens != null) updates.tokensIn = tokenUsage.promptTokens;
				if (turnUsage) updates.turnUsageJson = turnUsage;
				if (Object.keys(updates).length > 0) {
					await db.update(narratorMessages).set(updates).where(eq(narratorMessages.id, savedId));
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

				const saved = await narratorService.persistAssistantMessage(narratorId, {
					uuid: event.messageId ?? randomUUID(),
					session_id: ctx.conversationId,
					parent_tool_use_id: ctx.parentToolUseId,
					message: {
						content,
						usage:
							tokenUsage?.promptTokens != null
								? {
										input_tokens: tokenUsage.promptTokens,
										...(tokenUsage.completionTokens != null && {
											output_tokens: tokenUsage.completionTokens,
										}),
									}
								: undefined,
					},
					contextPercent: ctx.getContextUsagePct(),
					meterUsage: ctx.getMeterUsage(),
					meterUnit: ctx.getMeterUnit(),
				});
				savedId = saved.id;
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
				with: { toolCalls: true },
			});

			// Apply the same truncation and enrichment as the HTTP API so WS and REST
			// clients receive identically shaped messages.
			const processed = fullMessage
				? enrichToolUseBlocks(truncateToolIO([fullMessage]))[0]
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
				status,
				output: truncateJson(event.output, 2000),
				durationMs: event.durationMs,
				...(event.updatedInput && { updatedInput: event.updatedInput }),
				...(event.metadata && { metadata: event.metadata }),
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});

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

		case "stream_reasoning": {
			// Track AI reasoning output character rate
			recordOutputChunk(event.text.length);

			// Snapshot: accumulate streaming reasoning (top-level only)
			if (!ctx.parentToolUseId) {
				getOrCreateSnapshot(broadcastTargetId).streamingReasoning += event.text;
			}

			const reasoningStreamEvent: Record<string, unknown> = {
				type: "content_block_delta",
				delta: { type: "reasoning_delta", text: event.text },
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
					delta: { type: "reasoning_delta", text: event.text },
				},
			});
			return null;
		}

		case "context_usage": {
			ctx.setContextUsagePct(event.percentage);
			ctx.setTokenUsage({
				...(event.promptTokens != null && { promptTokens: event.promptTokens }),
				...(event.completionTokens != null && { completionTokens: event.completionTokens }),
				...(event.reasoningTokens != null && { reasoningTokens: event.reasoningTokens }),
				...(event.cachedInputTokens != null && { cachedInputTokens: event.cachedInputTokens }),
				...(event.contextWindow != null && { contextWindow: event.contextWindow }),
				...(event.isEstimated && { isEstimated: true }),
			});

			const isSubagent = !!ctx.parentToolUseId;
			dualBroadcast(ctx, {
				type: "context_usage",
				narratorId: broadcastTargetId,
				percentage: event.percentage,
				...(event.promptTokens != null && { promptTokens: event.promptTokens }),
				...(event.contextWindow != null && { contextWindow: event.contextWindow }),
				...(event.isEstimated && { isEstimated: true }),
				...(isSubagent && { isSubagent: true }),
			});
			ctx.sseEmitter?.emit("event", {
				type: "context_usage",
				data: {
					percentage: event.percentage,
					...(event.promptTokens != null && { promptTokens: event.promptTokens }),
					...(event.contextWindow != null && { contextWindow: event.contextWindow }),
					...(event.isEstimated && { isEstimated: true }),
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
			logger.info("Agent output truncated by max_tokens", {
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
			dualBroadcast(ctx, {
				type: "web_search",
				narratorId: broadcastTargetId,
				id: event.id,
				status: event.status,
				query: event.query,
				queries: event.queries,
			});
			return null;
		}

		case "model_switched": {
			dualBroadcast(ctx, {
				type: "model_switched",
				narratorId: broadcastTargetId,
				model: event.model,
				provider: event.provider,
			});
			return null;
		}

		default:
			return null;
	}
}
