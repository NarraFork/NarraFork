import type { ServerWebSocket } from "bun";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { resolvePermission } from "../services/narrator-session";
import type { WSData } from "./ws-handler";

// === Types ===

export interface NarratorWSData {
	connectedAt: number;
	subscribedNarrators: Set<string>;
}

// Server → Client messages
export type NarratorServerMessage =
	| { type: "message"; narratorId: string; message: unknown }
	| { type: "permission_request"; narratorId: string; request: unknown }
	| { type: "status_change"; narratorId: string; status: string }
	| { type: "tool_progress"; narratorId: string; toolUseId: string; elapsed: number }
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
	  };

// === Connection registry ===

type NarratorWS = ServerWebSocket<WSData & { channel: "narrator" }>;

const connections = new Set<NarratorWS>();

// === Event bus → WebSocket broadcast ===

function shouldForwardEvent(event: NarraForkEvent): boolean {
	return event.type.startsWith("narrator:") || event.type.startsWith("chapter:");
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
		// Otherwise (chapter events), broadcast to all narrator WS clients
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
				logger.debug("Narrator WS subscribed", {
					count: parsed.narratorIds.length,
				});
				break;
			}
			case "unsubscribe": {
				for (const id of parsed.narratorIds) {
					ws.data.subscribedNarrators.delete(id);
				}
				break;
			}
			case "permission_decision": {
				resolvePermission(parsed.requestId, parsed.decision, parsed.message).catch((err) =>
					logger.error("Failed to resolve permission", { error: String(err) }),
				);
				logger.debug("Permission decision received via WS", {
					requestId: parsed.requestId,
					decision: parsed.decision,
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
