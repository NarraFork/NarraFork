import type { ServerWebSocket } from "bun";
import { logger } from "../lib/logger";
import { terminalWsMessageSchema } from "../lib/validators";
import { terminalService } from "../services/terminal-service";
import type { WSData } from "./ws-handler";

// === Types ===

export interface TerminalWSData {
	connectedAt: number;
	lastPongAt: number;
	subscribedTerminals: Set<string>;
}

// Server → Client messages
export type TerminalServerMessage =
	| { type: "output"; terminalId: string; data: string }
	| { type: "exit"; terminalId: string; code: number }
	| { type: "error"; terminalId: string; message: string }
	| { type: "requestResize"; terminalId: string }
	| { type: "scrollback"; terminalId: string; data: string; cols: number; rows: number }
	| {
			type: "bufferState";
			terminalId: string;
			mouseTracking: boolean;
			cursorVisible: boolean;
	  }
	| { type: "created"; requestId: string; terminal: unknown }
	| { type: "killed"; terminalId: string }
	| { type: "renamed"; terminalId: string; name: string };

// Client → Server messages (JSON)
export type TerminalClientMessage =
	| { type: "subscribe"; terminalIds: string[] }
	| { type: "unsubscribe"; terminalIds: string[] }
	| { type: "input"; terminalId: string; data: string }
	| { type: "resize"; terminalId: string; cols: number; rows: number }
	| {
			type: "create";
			requestId: string;
			chapterId?: string;
			narratorId?: string;
			name?: string;
			cols?: number;
			rows?: number;
	  }
	| { type: "kill"; terminalId: string }
	| { type: "rename"; terminalId: string; name: string };

type TerminalWS = ServerWebSocket<WSData & { channel: "terminal" }>;

// === Connection registry ===

const connections = new Set<TerminalWS>();

/** Expose connections for heartbeat iteration. */
export function getTerminalConnections(): Set<TerminalWS> {
	return connections;
}

/** Track the last client that sent input per terminal — only this client's resize is honored */
const lastActiveClient = new Map<string, TerminalWS>();

/** Send a message to all WS clients subscribed to a terminal */
export function sendToTerminal(terminalId: string, message: TerminalServerMessage): void {
	const payload = JSON.stringify(message);
	for (const ws of connections) {
		if (ws.data.subscribedTerminals.has(terminalId)) {
			try {
				ws.send(payload);
			} catch {
				connections.delete(ws);
			}
		}
	}
}

function subscribeToTerminal(ws: TerminalWS, terminalId: string) {
	ws.data.subscribedTerminals.add(terminalId);

	// Replay scrollback buffer so the client sees previous output
	terminalService.getScrollback(terminalId).then((scrollback) => {
		if (scrollback) {
			try {
				ws.send(
					JSON.stringify({
						type: "scrollback",
						terminalId,
						data: scrollback.data,
						cols: scrollback.cols,
						rows: scrollback.rows,
					}),
				);
			} catch {
				// connection may be dead
			}
		}

		// Send current buffer state after scrollback
		const bufferState = terminalService.getBufferState(terminalId);
		if (bufferState) {
			try {
				ws.send(JSON.stringify({ type: "bufferState", terminalId, ...bufferState }));
			} catch {
				// noop
			}
		}
	});
}

// === WebSocket handlers ===

export const handleTerminalWS = {
	open(ws: TerminalWS) {
		ws.data.lastPongAt = Date.now();
		connections.add(ws);
	},

	message(ws: TerminalWS, parsed: unknown) {
		const result = terminalWsMessageSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Invalid terminal WS message", {
				error: result.error.message,
			});
			return;
		}
		const msg = result.data;

		// Update heartbeat timestamp on any valid message
		ws.data.lastPongAt = Date.now();

		switch (msg.type) {
			case "pong":
				// Heartbeat response — lastPongAt already updated above
				break;
			case "subscribe": {
				for (const id of msg.terminalIds) {
					subscribeToTerminal(ws, id);
				}
				logger.debug("Terminal WS subscribed", { count: msg.terminalIds.length });
				break;
			}
			case "unsubscribe": {
				for (const id of msg.terminalIds) {
					ws.data.subscribedTerminals.delete(id);
					if (lastActiveClient.get(id) === ws) {
						lastActiveClient.delete(id);
					}
				}
				break;
			}
			case "input": {
				const { terminalId, data } = msg;
				if (!ws.data.subscribedTerminals.has(terminalId)) break;
				const prev = lastActiveClient.get(terminalId);
				if (prev !== ws) {
					lastActiveClient.set(terminalId, ws);
					// Active client changed — ask the new client to re-send its dimensions
					try {
						ws.send(JSON.stringify({ type: "requestResize", terminalId }));
					} catch {
						// noop
					}
				}
				terminalService.write(terminalId, data);
				break;
			}
			case "resize": {
				const { terminalId, cols, rows } = msg;
				if (!ws.data.subscribedTerminals.has(terminalId)) break;
				// Only honor resize from the last client that sent input
				const active = lastActiveClient.get(terminalId);
				if (!active || active === ws) {
					terminalService.resize(terminalId, cols, rows);
				}
				break;
			}
			case "create": {
				const { requestId, ...opts } = msg;
				terminalService
					.create(opts)
					.then((terminal) => {
						// Send created confirmation to the requesting client
						try {
							ws.send(JSON.stringify({ type: "created", requestId, terminal }));
						} catch {
							// noop
						}
						// Auto-subscribe the creator
						subscribeToTerminal(ws, terminal.id);
					})
					.catch((err) => {
						try {
							ws.send(
								JSON.stringify({
									type: "error",
									terminalId: "",
									message: String(err instanceof Error ? err.message : err),
								}),
							);
						} catch {
							// noop
						}
					});
				break;
			}
			case "kill": {
				terminalService
					.kill(msg.terminalId)
					.then(() => {
						sendToTerminal(msg.terminalId, { type: "killed", terminalId: msg.terminalId });
					})
					.catch((err) => {
						logger.error("Failed to kill terminal via WS", { error: String(err) });
						try {
							ws.send(
								JSON.stringify({
									type: "error",
									terminalId: msg.terminalId,
									message: String(err instanceof Error ? err.message : err),
								}),
							);
						} catch {
							// connection may be dead
						}
					});
				break;
			}
			case "rename": {
				terminalService
					.rename(msg.terminalId, msg.name)
					.then(() => {
						sendToTerminal(msg.terminalId, {
							type: "renamed",
							terminalId: msg.terminalId,
							name: msg.name,
						});
					})
					.catch((err) => {
						logger.error("Failed to rename terminal via WS", { error: String(err) });
						try {
							ws.send(
								JSON.stringify({
									type: "error",
									terminalId: msg.terminalId,
									message: String(err instanceof Error ? err.message : err),
								}),
							);
						} catch {
							// connection may be dead
						}
					});
				break;
			}
		}
	},

	close(ws: TerminalWS) {
		connections.delete(ws);
		// Clean up lastActiveClient references
		for (const terminalId of ws.data.subscribedTerminals) {
			if (lastActiveClient.get(terminalId) === ws) {
				lastActiveClient.delete(terminalId);
			}
		}
	},
};
