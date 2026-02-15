import type { ServerWebSocket } from "bun";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { type MergeDecision, resolveMergeDecision } from "../services/chapter-batch-merge";
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
	| {
			type: "tool_completed";
			narratorId: string;
			toolUseId: string;
			status: string;
			output?: unknown;
	  }
	| { type: "title_updated"; narratorId: string; title: string }
	| { type: "permission_resolved"; narratorId: string; requestId: string }
	| { type: "todos_updated"; narratorId: string; todos: unknown[]; toolUseId?: string }
	| { type: "buffer_set"; narratorId: string; text: string; bufferedAt: string }
	| { type: "buffer_cleared"; narratorId: string; reason: "cancelled" | "sent" | "session_error" }
	| { type: "sdk_plan_mode_changed"; narratorId: string; sdkPlanMode: boolean }
	| { type: "error"; message: string };

// Client → Server messages
export type NarratorClientMessage =
	| { type: "subscribe"; narratorIds: string[] }
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
		switch (parsed.type) {
			case "subscribe": {
				for (const id of parsed.narratorIds) {
					ws.data.subscribedNarrators.add(id);
				}
				logger.debug("Narrator WS subscribed", { count: parsed.narratorIds.length });
				break;
			}
			case "unsubscribe": {
				for (const id of parsed.narratorIds) {
					ws.data.subscribedNarrators.delete(id);
				}
				break;
			}
			case "permission_decision": {
				resolvePermission(
					parsed.requestId,
					parsed.decision,
					parsed.message,
					parsed.answers,
					parsed.feedbackText,
				).catch((err) => logger.error("Failed to resolve permission", { error: String(err) }));
				break;
			}
			case "merge_decision": {
				resolveMergeDecision(parsed.mergeSessionId, parsed.decision);
				logger.debug("Merge decision received via WS", {
					mergeSessionId: parsed.mergeSessionId,
					decision: parsed.decision,
				});
				break;
			}
			case "buffer_message": {
				if (!parsed.text || typeof parsed.text !== "string" || parsed.text.length > 100_000) {
					break;
				}
				const result = setBufferedMessage(parsed.narratorId, parsed.text);
				if (result.ok) {
					broadcastToNarrator(parsed.narratorId, {
						type: "buffer_set",
						narratorId: parsed.narratorId,
						text: parsed.text,
						bufferedAt: result.bufferedAt,
					});
				}
				break;
			}
			case "cancel_buffer": {
				clearBufferedMessage(parsed.narratorId);
				broadcastToNarrator(parsed.narratorId, {
					type: "buffer_cleared",
					narratorId: parsed.narratorId,
					reason: "cancelled",
				});
				break;
			}
			default: {
				logger.warn("Unknown narrator WS message type", { parsed });
			}
		}
	},

	close(ws: NarratorWS) {
		connections.delete(ws);
	},
};
