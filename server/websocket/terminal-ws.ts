import type { ServerWebSocket } from "bun";
import { logger } from "../lib/logger";
import { terminalWsMessageSchema } from "../lib/validators";
import { terminalService } from "../services/terminal-service";
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
	| { type: "error"; message: string }
	| { type: "requestResize" };

// Client → Server messages (JSON)
export type TerminalClientMessage =
	| { type: "resize"; cols: number; rows: number }
	| { type: "attach"; terminalId: string };

type TerminalWS = ServerWebSocket<WSData & { channel: "terminal" }>;

// === Connection registry (terminalId → set of WS clients) ===

const connectionsByTerminal = new Map<string, Set<TerminalWS>>();

/** Track the last client that sent input per terminal — only this client's resize is honored */
const lastActiveClient = new Map<string, TerminalWS>();

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
		const prevId = ws.data.terminalId;
		const prev = connectionsByTerminal.get(prevId);
		prev?.delete(ws);
		if (prev?.size === 0) connectionsByTerminal.delete(prevId);
		if (lastActiveClient.get(prevId) === ws) {
			lastActiveClient.delete(prevId);
		}
	}

	ws.data.terminalId = terminalId;
	let clients = connectionsByTerminal.get(terminalId);
	if (!clients) {
		clients = new Set();
		connectionsByTerminal.set(terminalId, clients);
	}
	clients.add(ws);

	// Replay scrollback buffer so the client sees previous output
	const scrollback = terminalService.getScrollback(terminalId);
	if (scrollback) {
		try {
			ws.send(JSON.stringify({ type: "output", data: scrollback }));
		} catch {
			// connection may be dead
		}
	}
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
		const result = terminalWsMessageSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Invalid terminal WS message", {
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
			case "attach": {
				attachToTerminal(ws, msg.terminalId);
				logger.debug("Terminal WS attached", { terminalId: msg.terminalId });
				break;
			}
			case "resize": {
				const terminalId = ws.data.terminalId;
				if (!terminalId) break;
				// Only honor resize from the last client that sent input,
				// or if no client has sent input yet (single-client case)
				const active = lastActiveClient.get(terminalId);
				if (!active || active === ws) {
					terminalService.resize(terminalId, msg.cols, msg.rows);
				}
				break;
			}
		}
	},

	/** Handle raw (non-JSON) text as terminal input */
	rawMessage(ws: TerminalWS, text: string) {
		if (!ws.data.terminalId) return;
		const terminalId = ws.data.terminalId;
		const prev = lastActiveClient.get(terminalId);
		if (prev !== ws) {
			lastActiveClient.set(terminalId, ws);
			// Active client changed — ask the new client to re-send its dimensions
			try {
				ws.send(JSON.stringify({ type: "requestResize" }));
			} catch {
				// connection may be dead
			}
		}
		terminalService.write(terminalId, text);
	},

	close(ws: TerminalWS) {
		if (ws.data.terminalId) {
			const terminalId = ws.data.terminalId;
			const clients = connectionsByTerminal.get(terminalId);
			clients?.delete(ws);
			if (clients?.size === 0) connectionsByTerminal.delete(terminalId);
			// Clear active client if this was it
			if (lastActiveClient.get(terminalId) === ws) {
				lastActiveClient.delete(terminalId);
			}
		}
	},
};
