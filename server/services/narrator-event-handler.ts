import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages } from "../db/schema";
import type { AgentEvent } from "../lib/agent";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
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
			dualBroadcast(ctx, {
				type: "tool_started",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				input: event.input,
				streamStartedAt: event.streamStartedAt,
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
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "block_complete": {
			const { block } = event;

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
			} else if (block.type === "tool_use") {
				await narratorService.appendBlockToMessage(partialId, narratorId, {
					type: "tool_use",
					id: block.toolUseId,
					name: block.name,
					input: block.input,
				});
			}
			return null;
		}

		case "assistant_message": {
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
					}
				: undefined;
			let savedId: string;
			const partialId = ctx.getPartialMessageId();

			if (partialId) {
				// Partial message was already created incrementally via block_complete —
				// just update final metadata (messageUuid + token usage).
				savedId = partialId;
				await db
					.update(narratorMessages)
					.set({
						...(event.messageId ? { messageUuid: event.messageId } : {}),
						...(tokenUsage?.promptTokens != null ? { tokensIn: tokenUsage.promptTokens } : {}),
						...(turnUsage ? { turnUsageJson: turnUsage } : {}),
					})
					.where(eq(narratorMessages.id, savedId));
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
				if (tu.name === "TodoWrite" && tu.input?.todos && hooks?.onTodoWrite) {
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
			const status = event.isError ? "fail" : "success";
			try {
				await narratorService.updateToolCallResult(event.toolUseId, {
					output: event.output,
					status,
					errorMessage: event.isError ? event.output : undefined,
					durationMs: event.durationMs,
				});
				// Broken tool call: overwrite the persisted inputJson with a sanitized
				// version (large content fields replaced with a short placeholder).
				if (event.brokenInputOverride) {
					await narratorService.overwriteToolCallInput(event.toolUseId, event.brokenInputOverride);
				}
			} catch (err) {
				logger.error("Failed to persist tool result", {
					narratorId,
					toolUseId: event.toolUseId,
					error: String(err),
				});
			}

			dualBroadcast(ctx, {
				type: "tool_completed",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				status,
				output: truncateJson(event.output, 2000),
				durationMs: event.durationMs,
				...(event.updatedInput && { updatedInput: event.updatedInput }),
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
			dualBroadcast(ctx, {
				type: "tool_output",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				output: event.output,
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

		case "error": {
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
			});

			const isSubagent = !!ctx.parentToolUseId;
			dualBroadcast(ctx, {
				type: "context_usage",
				narratorId: broadcastTargetId,
				percentage: event.percentage,
				...(event.promptTokens != null && { promptTokens: event.promptTokens }),
				...(event.contextWindow != null && { contextWindow: event.contextWindow }),
				...(isSubagent && { isSubagent: true }),
			});
			ctx.sseEmitter?.emit("event", {
				type: "context_usage",
				data: {
					percentage: event.percentage,
					...(event.promptTokens != null && { promptTokens: event.promptTokens }),
					...(event.contextWindow != null && { contextWindow: event.contextWindow }),
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

		case "context_length_exceeded": {
			logger.warn("Context length exceeded by API", {
				narratorId,
				message: event.message,
			});
			return null;
		}

		default:
			return null;
	}
}
