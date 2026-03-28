import type { ServerWebSocket } from "bun";
import { hotTimer, hotTimerClear } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import {
	getNarratorConnections,
	handleNarratorWS,
	type NarratorClientMessage,
	type NarratorWSData,
} from "./narrator-ws";
import { getTerminalConnections, handleTerminalWS, type TerminalWSData } from "./terminal-ws";

// === Unified WS data type ===

export type WSData =
	| ({ channel: "narrator" } & NarratorWSData)
	| ({ channel: "terminal" } & TerminalWSData);

/**
 * Determine channel from the upgrade URL path and build initial WSData.
 * Returns null if the path doesn't match any known WS endpoint.
 */
export function resolveWSData(
	url: URL,
	userInfo?: {
		userId: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	},
): WSData | null {
	if (url.pathname === "/ws/narrator" || url.pathname.startsWith("/ws/narrator?")) {
		return {
			channel: "narrator",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set(),
			userId: userInfo?.userId,
			username: userInfo?.username,
			avatarColor: userInfo?.avatarColor,
			avatarImageId: userInfo?.avatarImageId,
		};
	}
	if (url.pathname === "/ws/terminal" || url.pathname.startsWith("/ws/terminal?")) {
		return {
			channel: "terminal",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedTerminals: new Set(),
		};
	}
	return null;
}

// === Heartbeat ===

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

const pingPayload = JSON.stringify({ type: "ping" });

const HEARTBEAT_KEY = "narrafork.heartbeatTimer";

export function startHeartbeat() {
	hotTimer(HEARTBEAT_KEY, () =>
		setInterval(() => {
			const now = Date.now();
			const staleNarrator: Array<ServerWebSocket<WSData & { channel: "narrator" }>> = [];
			const staleTerminal: Array<ServerWebSocket<WSData & { channel: "terminal" }>> = [];

			for (const ws of getNarratorConnections()) {
				if (now - ws.data.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
					staleNarrator.push(ws);
					continue;
				}
				try {
					ws.send(pingPayload);
				} catch {
					staleNarrator.push(ws);
				}
			}

			for (const ws of getTerminalConnections()) {
				if (now - ws.data.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
					staleTerminal.push(ws);
					continue;
				}
				try {
					ws.send(pingPayload);
				} catch {
					staleTerminal.push(ws);
				}
			}

			for (const ws of staleNarrator) {
				// Delegate to the channel handler so presence / stats are cleaned up
				handleNarratorWS.close(ws);
				try {
					ws.close(1000, "heartbeat timeout");
				} catch {
					// already dead
				}
			}

			for (const ws of staleTerminal) {
				logger.debug("Closing stale terminal WS (heartbeat timeout)", {
					connectedAt: ws.data.connectedAt,
					lastPongAt: ws.data.lastPongAt,
				});
				// Delegate to the channel handler so subscriptions are cleaned up
				handleTerminalWS.close(ws);
				try {
					ws.close(1000, "heartbeat timeout");
				} catch {
					// already dead
				}
			}
		}, HEARTBEAT_INTERVAL_MS),
	);
}

export function stopHeartbeat() {
	hotTimerClear(HEARTBEAT_KEY);
}

/**
 * Explicitly close every active WebSocket connection with a 1001 "Going Away"
 * close frame.  Called during server shutdown so that clients receive a proper
 * TCP FIN and don't leave connections stuck in CLOSE_WAIT / FIN_WAIT_2
 * (especially problematic on Windows where Bun's `server.stop(true)` alone
 * may not send close frames to each peer).
 */
export function closeAllConnections() {
	for (const ws of getNarratorConnections()) {
		try {
			ws.close(1001, "server shutting down");
		} catch {
			// already dead — ignore
		}
	}
	for (const ws of getTerminalConnections()) {
		try {
			ws.close(1001, "server shutting down");
		} catch {
			// already dead — ignore
		}
	}
}

// === Bun WebSocket handlers ===

export const wsHandlers = {
	open(ws: ServerWebSocket<WSData>) {
		const { channel } = ws.data;

		if (channel === "narrator") {
			handleNarratorWS.open(ws as ServerWebSocket<WSData & { channel: "narrator" }>);
		} else if (channel === "terminal") {
			handleTerminalWS.open(ws as ServerWebSocket<WSData & { channel: "terminal" }>);
		}
	},

	message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
		const text = typeof message === "string" ? message : new TextDecoder().decode(message);
		const { channel } = ws.data;

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
				logger.warn("Invalid WebSocket message: missing type field", {
					channel,
					text: text.slice(0, 200),
				});
				try {
					ws.send(JSON.stringify({ type: "error", message: "Missing message type" }));
				} catch {
					// connection may be dead
				}
				return;
			}
		} catch {
			logger.warn("Invalid WebSocket JSON", { channel, text: text.slice(0, 200) });
			try {
				ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
			} catch {
				// connection may be dead
			}
			return;
		}

		if (channel === "narrator") {
			handleNarratorWS
				.message(
					ws as ServerWebSocket<WSData & { channel: "narrator" }>,
					parsed as NarratorClientMessage,
				)
				.catch((err: unknown) => {
					logger.warn("Narrator WS message handler error", { error: String(err) });
					try {
						ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
					} catch {
						// connection may be dead
					}
				});
		} else if (channel === "terminal") {
			handleTerminalWS.message(ws as ServerWebSocket<WSData & { channel: "terminal" }>, parsed);
		}
	},

	close(ws: ServerWebSocket<WSData>, _code: number, _reason: string) {
		const { channel } = ws.data;

		if (channel === "narrator") {
			handleNarratorWS.close(ws as ServerWebSocket<WSData & { channel: "narrator" }>);
		} else if (channel === "terminal") {
			handleTerminalWS.close(ws as ServerWebSocket<WSData & { channel: "terminal" }>);
		}
	},
};
