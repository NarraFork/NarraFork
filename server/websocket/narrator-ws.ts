import type { ServerWebSocket } from "bun";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { narratorWsMessageSchema } from "../lib/validators";
import { type MergeDecision, resolveMergeDecision } from "../services/chapter-batch-merge";
import type { GitStatusSummary } from "../services/git-service";
import { narratorService } from "../services/narrator-service";
import {
	clearBufferedMessage,
	resolvePermission,
	setBufferedMessage,
} from "../services/narrator-session";
import type { WSData } from "./ws-handler";

// === Types ===

export interface NarratorWSData {
	connectedAt: number;
	subscribedNarrators: Set<string>;
}

// Server → Client messages
export type NarratorServerMessage =
	| { type: "message"; narratorId: string; message: unknown }
	| { type: "stream_event"; narratorId: string; event: unknown }
	| { type: "permission_request"; narratorId: string; request: unknown }
	| { type: "status_change"; narratorId: string; status: string }
	| { type: "tool_progress"; narratorId: string; toolUseId: string; elapsed: number }
	| { type: "tool_output"; narratorId: string; toolUseId: string; output: string }
	| {
			type: "tool_completed";
			narratorId: string;
			toolUseId: string;
			status: string;
			output?: unknown;
			durationMs?: number;
	  }
	| { type: "title_updated"; narratorId: string; title: string }
	| { type: "permission_resolved"; narratorId: string; requestId: string; toolUseId?: string }
	| { type: "todos_updated"; narratorId: string; todos: unknown[]; toolUseId?: string }
	| { type: "buffer_set"; narratorId: string; text: string; bufferedAt: string }
	| { type: "buffer_cleared"; narratorId: string; reason: "cancelled" | "sent" | "session_error" }
	| { type: "plan_mode_changed"; narratorId: string; planMode: boolean }
	| { type: "user_message"; narratorId: string; message: unknown }
	| { type: "compacting"; narratorId: string }
	| { type: "compact_done"; narratorId: string }
	| { type: "context_usage"; narratorId: string; percentage: number }
	| { type: "metering"; narratorId: string; unit: string; unitPlural: string; usage: number }
	// Narrator fork events forwarded via eventBus.onAny
	| { type: "narrator:forked"; narratorId: string; parentNarratorId: string }
	| {
			type: "tool_started";
			narratorId: string;
			toolUseId: string;
			toolName: string;
			input: unknown;
			streamStartedAt?: number;
	  }
	| {
			type: "tool_use_chunk";
			narratorId: string;
			toolUseId: string;
			toolName: string;
			inputCharsTotal: number;
	  }
	| {
			type: "subagent_started";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
			subagentType: string;
	  }
	| {
			type: "git_status";
			narratorId: string;
			chapterId: string;
			toolUseId: string;
			status: GitStatusSummary;
	  }
	| { type: "auto_commit_started"; narratorId: string; chapterId: string }
	| {
			type: "auto_commit_done";
			narratorId: string;
			chapterId: string;
			commitSha: string;
			message: string;
	  }
	| { type: "error"; message: string };

// Client → Server messages
export type NarratorClientMessage =
	| { type: "subscribe"; narratorIds: string[]; lastMessageId?: string }
	| { type: "unsubscribe"; narratorIds: string[] }
	| {
			type: "permission_decision";
			requestId: string;
			decision: "allow" | "deny";
			message?: string;
			answers?: Record<string, string>;
			feedbackText?: string;
	  }
	| {
			type: "merge_decision";
			mergeSessionId: string;
			decision: MergeDecision;
	  }
	| { type: "buffer_message"; narratorId: string; text: string }
	| { type: "cancel_buffer"; narratorId: string };

// === Connection registry ===

type NarratorWS = ServerWebSocket<WSData & { channel: "narrator" }>;

const connections = new Set<NarratorWS>();

// === Event bus → WebSocket broadcast ===

/**
 * Events that are already pushed to WS clients via broadcastToNarrator()
 * in narrator-session.ts / narrator-title.ts. Forwarding them again from
 * the event bus would cause duplicate delivery.
 */
const ALREADY_BROADCAST_EVENTS = new Set([
	"narrator:message",
	"narrator:permission_request",
	"narrator:title_updated",
	"narrator:subagent_started",
	"narrator:subagent_completed",
]);

function shouldForwardEvent(event: NarraForkEvent): boolean {
	if (ALREADY_BROADCAST_EVENTS.has(event.type)) return false;
	return (
		event.type.startsWith("narrator:") ||
		event.type.startsWith("chapter:") ||
		event.type.startsWith("merge:")
	);
}

function eventToNarratorId(event: NarraForkEvent): string | null {
	if ("narratorId" in event) return event.narratorId;
	return null;
}

eventBus.onAny((event) => {
	if (!shouldForwardEvent(event)) return;

	const narratorId = eventToNarratorId(event);

	for (const ws of connections) {
		// If event has a narratorId, only send to subscribers of that narrator
		// Otherwise (chapter/merge events), broadcast to all narrator WS clients
		if (narratorId && !ws.data.subscribedNarrators.has(narratorId)) continue;

		try {
			ws.send(JSON.stringify(event));
		} catch {
			// Connection might be dead, will be cleaned up on close
		}
	}
});

// === Public API for services to push messages directly ===

export function broadcastToNarrator(narratorId: string, message: NarratorServerMessage): void {
	const payload = JSON.stringify(message);
	for (const ws of connections) {
		if (ws.data.subscribedNarrators.has(narratorId)) {
			try {
				ws.send(payload);
			} catch {
				// noop
			}
		}
	}
}

// === WebSocket handlers ===

export const handleNarratorWS = {
	open(ws: NarratorWS) {
		connections.add(ws);
	},

	message(ws: NarratorWS, parsed: NarratorClientMessage) {
		const result = narratorWsMessageSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Invalid narrator WS message", {
				error: result.error.message,
				parsed,
			});
			try {
				ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
			} catch {
				// connection may be dead
			}
			return;
		}
		const msg = result.data;

		switch (msg.type) {
			case "subscribe": {
				for (const id of msg.narratorIds) {
					ws.data.subscribedNarrators.add(id);
				}
				// Catch-up: send messages the client missed while disconnected
				if (msg.lastMessageId && msg.narratorIds.length === 1) {
					const narratorId = msg.narratorIds[0];
					narratorService
						.getMessagesAfter(narratorId, msg.lastMessageId)
						.then(({ topLevel, orphanChildren }) => {
							// Send orphan children first — they belong to older messages
							// already in the client's cache and need to be inserted via
							// insertChildIntoCache before new top-level messages arrive.
							for (const message of orphanChildren) {
								try {
									ws.send(JSON.stringify({ type: "message", narratorId, message }));
								} catch {
									return;
								}
							}
							// Then send new top-level messages (tree-structured)
							for (const message of topLevel) {
								try {
									ws.send(JSON.stringify({ type: "message", narratorId, message }));
								} catch {
									return;
								}
							}
						})
						.catch((err: unknown) =>
							logger.warn("Failed to send catch-up messages", {
								error: String(err),
							}),
						);
				}
				break;
			}
			case "unsubscribe": {
				for (const id of msg.narratorIds) {
					ws.data.subscribedNarrators.delete(id);
				}
				break;
			}
			case "permission_decision": {
				logger.debug("WS permission_decision received", {
					requestId: msg.requestId,
					decision: msg.decision,
					hasFeedback: !!msg.feedbackText,
					hasAnswers: !!msg.answers,
				});
				resolvePermission(
					msg.requestId,
					msg.decision,
					msg.message,
					msg.answers,
					msg.feedbackText,
					msg.compactAfter,
				).catch((err) => logger.error("Failed to resolve permission", { error: String(err) }));
				break;
			}
			case "merge_decision": {
				resolveMergeDecision(msg.mergeSessionId, msg.decision);
				logger.debug("Merge decision received via WS", {
					mergeSessionId: msg.mergeSessionId,
					decision: msg.decision,
				});
				break;
			}
			case "buffer_message": {
				const bufResult = setBufferedMessage(msg.narratorId, msg.text);
				if (bufResult.ok) {
					broadcastToNarrator(msg.narratorId, {
						type: "buffer_set",
						narratorId: msg.narratorId,
						text: msg.text,
						bufferedAt: bufResult.bufferedAt,
					});
				}
				break;
			}
			case "cancel_buffer": {
				clearBufferedMessage(msg.narratorId);
				broadcastToNarrator(msg.narratorId, {
					type: "buffer_cleared",
					narratorId: msg.narratorId,
					reason: "cancelled",
				});
				break;
			}
		}
	},

	close(ws: NarratorWS) {
		connections.delete(ws);
	},
};
