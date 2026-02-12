import type { ServerWebSocket } from "bun";
import { logger } from "../lib/logger";
import type { WSData } from "./ws-handler";

// === Types ===

export interface TerminalWSData {
	connectedAt: number;
	terminalId?: string;
}

// Server → Client messages
export type TerminalServerMessage =
	| { type: "output"; data: string }
	| { type: "exit"; code: number }
	| { type: "error"; message: string };

// Client → Server messages (JSON)
export type TerminalClientMessage =
	| { type: "resize"; cols: number; rows: number }
	| { type: "attach"; terminalId: string };

type TerminalWS = ServerWebSocket<WSData & { channel: "terminal" }>;

// === Connection registry (terminalId → set of WS clients) ===

const connectionsByTerminal = new Map<string, Set<TerminalWS>>();

/** Send data to all WS clients attached to a terminal */
export function sendToTerminal(terminalId: string, message: TerminalServerMessage): void {
	const clients = connectionsByTerminal.get(terminalId);
	if (!clients) return;
	const payload = JSON.stringify(message);
	for (const ws of clients) {
		try {
			ws.send(payload);
		} catch {
			// noop
		}
	}
}

function attachToTerminal(ws: TerminalWS, terminalId: string) {
	// Detach from previous terminal if any
	if (ws.data.terminalId) {
		const prev = connectionsByTerminal.get(ws.data.terminalId);
		prev?.delete(ws);
		if (prev?.size === 0) connectionsByTerminal.delete(ws.data.terminalId);
	}

	ws.data.terminalId = terminalId;
	let clients = connectionsByTerminal.get(terminalId);
	if (!clients) {
		clients = new Set();
		connectionsByTerminal.set(terminalId, clients);
	}
	clients.add(ws);
}

// === WebSocket handlers ===

export const handleTerminalWS = {
	open(ws: TerminalWS) {
		// If terminalId was provided via query param, auto-attach
		if (ws.data.terminalId) {
			attachToTerminal(ws, ws.data.terminalId);
			logger.debug("Terminal WS auto-attached", { terminalId: ws.data.terminalId });
		}
	},

	message(ws: TerminalWS, parsed: TerminalClientMessage) {
		switch (parsed.type) {
			case "attach": {
				attachToTerminal(ws, parsed.terminalId);
				logger.debug("Terminal WS attached", { terminalId: parsed.terminalId });
				break;
			}
			case "resize": {
				// Phase 1: log only. Phase 2 will forward to PTY.
				logger.debug("Terminal resize", {
					terminalId: ws.data.terminalId,
					cols: parsed.cols,
					rows: parsed.rows,
				});
				break;
			}
			default: {
				logger.warn("Unknown terminal WS message type", { parsed });
			}
		}
	},

	/** Handle raw (non-JSON) text as terminal input */
	rawMessage(ws: TerminalWS, text: string) {
		if (!ws.data.terminalId) return;
		// Phase 1: log only. Phase 2 will forward to PTY via dtach.
		logger.debug("Terminal input", {
			terminalId: ws.data.terminalId,
			length: text.length,
		});
	},

	close(ws: TerminalWS) {
		if (ws.data.terminalId) {
			const clients = connectionsByTerminal.get(ws.data.terminalId);
			clients?.delete(ws);
			if (clients?.size === 0) connectionsByTerminal.delete(ws.data.terminalId);
		}
	},
};
