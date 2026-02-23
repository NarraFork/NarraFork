import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages } from "../db/schema";
import type { AgentEvent } from "../lib/agent";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";

// === Context types ===

/**
 * Shared context for event processing — configures broadcast targets,
 * persistence options, and mutable state accessors.
 *
 * Both main narrators and subagents provide this; the differences are:
 * - Main narrator: broadcastTargetId === narratorId, has sseEmitter
 * - Subagent: broadcastTargetId === parentNarratorId, has parentToolUseId/subagentModel
 */
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
	setPartialMessageId: (id: string | undefined) => void;
	setContextUsagePct: (pct: number) => void;
	setMeterData: (usage: number, unit: string) => void;

	// --- Subagent-specific ---
	/** Parent tool_use ID that spawned this subagent */
	parentToolUseId?: string;
	/** Subagent's resolved model name (attached to broadcast messages) */
	subagentModel?: string;
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
	onExitPlanMode?: (output: string) => Promise<void>;
	/** Clear compact summary after first response */
	onClearCompactSummary?: () => Promise<void>;
	/** Git status tracking after file-mutating tools */
	onGitTrack?: (toolName: string, toolUseId: string) => void;
	/** Context usage event (prune + compact trigger) */
	onContextUsage?: (percentage: number) => void;
	/** Error cleanup (partial message removal, orphaned tool calls) */
	onErrorCleanup?: (message: string) => Promise<void>;
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
			const streamEvent: Record<string, unknown> = {
				type: "content_block_delta",
				delta: { type: "text_delta", text: event.text },
			};
			// Subagent: attach linking info so frontend knows which tool_use this belongs to
			if (ctx.parentToolUseId) {
				streamEvent.subagentToolUseId = ctx.parentToolUseId;
				streamEvent.subagentNarratorId = narratorId;
			}
			broadcastToNarrator(broadcastTargetId, {
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
			broadcastToNarrator(broadcastTargetId, {
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
			broadcastToNarrator(broadcastTargetId, {
				type: "tool_use_chunk",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				inputCharsTotal: event.inputCharsTotal,
				...(ctx.parentToolUseId && { parentToolUseId: ctx.parentToolUseId }),
			});
			return null;
		}

		case "block_complete": {
			const { block } = event;

			// Ensure a partial message exists for incremental persistence
			if (!ctx.getPartialMessageId()) {
				const partial = await narratorService.createPartialAssistantMessage(narratorId, {
					uuid: randomUUID(),
					session_id: ctx.conversationId,
					parent_tool_use_id: ctx.parentToolUseId,
					contextPercent: ctx.getContextUsagePct(),
					meterUsage: ctx.getMeterUsage(),
					meterUnit: ctx.getMeterUnit(),
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
			let savedId: string;
			const partialId = ctx.getPartialMessageId();

			if (partialId) {
				// Partial message was already created incrementally via block_complete —
				// just update the final messageUuid if the provider gave us one.
				savedId = partialId;
				if (event.messageId) {
					await db
						.update(narratorMessages)
						.set({ messageUuid: event.messageId })
						.where(eq(narratorMessages.id, savedId));
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
					message: { content },
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

			// Subagent: attach model info
			const broadcastMessage =
				ctx.subagentModel && fullMessage
					? { ...fullMessage, subagentModel: ctx.subagentModel }
					: fullMessage;

			broadcastToNarrator(broadcastTargetId, {
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
			} catch (err) {
				logger.error("Failed to persist tool result", {
					narratorId,
					toolUseId: event.toolUseId,
					error: String(err),
				});
			}

			broadcastToNarrator(broadcastTargetId, {
				type: "tool_completed",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				status,
				output: event.output,
				durationMs: event.durationMs,
			});

			// Main narrator: git tracking
			if (hooks?.onGitTrack) {
				hooks.onGitTrack(event.toolName, event.toolUseId);
			}

			// Main narrator: ExitPlanMode
			if (!event.isError && event.toolName === "ExitPlanMode" && hooks?.onExitPlanMode) {
				await hooks.onExitPlanMode(event.output ?? "");
			}
			return null;
		}

		case "tool_output": {
			broadcastToNarrator(broadcastTargetId, {
				type: "tool_output",
				narratorId: broadcastTargetId,
				toolUseId: event.toolUseId,
				output: event.output,
			});
			return null;
		}

		case "tool_progress": {
			broadcastToNarrator(broadcastTargetId, {
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

		case "stream_reasoning": {
			broadcastToNarrator(broadcastTargetId, {
				type: "stream_event",
				narratorId: broadcastTargetId,
				event: {
					type: "content_block_delta",
					delta: { type: "reasoning_delta", text: event.text },
				},
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

			broadcastToNarrator(broadcastTargetId, {
				type: "context_usage",
				narratorId: broadcastTargetId,
				percentage: event.percentage,
			});
			ctx.sseEmitter?.emit("event", {
				type: "context_usage",
				data: { percentage: event.percentage },
			});

			// Main narrator: prune + compact trigger
			if (hooks?.onContextUsage) {
				hooks.onContextUsage(event.percentage);
			}
			return null;
		}

		case "metering": {
			ctx.setMeterData(event.usage, event.unit);
			broadcastToNarrator(broadcastTargetId, {
				type: "metering",
				narratorId: broadcastTargetId,
				unit: event.unit,
				unitPlural: event.unitPlural,
				usage: event.usage,
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
			broadcastToNarrator(broadcastTargetId, {
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
