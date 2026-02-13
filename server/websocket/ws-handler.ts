import type { ServerWebSocket } from "bun";
import { logger } from "../lib/logger";
import { handleNarratorWS, type NarratorWSData } from "./narrator-ws";
import { handleTerminalWS, type TerminalWSData } from "./terminal-ws";

// === Unified WS data type ===

export type WSData =
	| ({ channel: "narrator" } & NarratorWSData)
	| ({ channel: "terminal" } & TerminalWSData);

/**
 * Determine channel from the upgrade URL path and build initial WSData.
 * Returns null if the path doesn't match any known WS endpoint.
 */
export function resolveWSData(url: URL): WSData | null {
	if (url.pathname === "/ws/narrator" || url.pathname.startsWith("/ws/narrator?")) {
		return { channel: "narrator", connectedAt: Date.now(), subscribedNarrators: new Set() };
	}
	if (url.pathname === "/ws/terminal" || url.pathname.startsWith("/ws/terminal?")) {
		const terminalId = url.searchParams.get("terminalId") ?? undefined;
		return { channel: "terminal", connectedAt: Date.now(), terminalId };
	}
	return null;
}

// === Bun WebSocket handlers ===

export const wsHandlers = {
	open(ws: ServerWebSocket<WSData>) {
		const { channel } = ws.data;
		logger.debug("WebSocket connected", { channel });

		if (channel === "narrator") {
			handleNarratorWS.open(ws as ServerWebSocket<WSData & { channel: "narrator" }>);
		} else if (channel === "terminal") {
			handleTerminalWS.open(ws as ServerWebSocket<WSData & { channel: "terminal" }>);
		}
	},

	message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
		const text = typeof message === "string" ? message : new TextDecoder().decode(message);
		const { channel } = ws.data;

		try {
			const parsed = JSON.parse(text);
			if (channel === "narrator") {
				handleNarratorWS.message(ws as ServerWebSocket<WSData & { channel: "narrator" }>, parsed);
			} else if (channel === "terminal") {
				handleTerminalWS.message(ws as ServerWebSocket<WSData & { channel: "terminal" }>, parsed);
			}
		} catch {
			// For terminal, raw text might be terminal input (not JSON)
			if (channel === "terminal") {
				handleTerminalWS.rawMessage(ws as ServerWebSocket<WSData & { channel: "terminal" }>, text);
			} else {
				logger.warn("Invalid WebSocket JSON", { channel, text: text.slice(0, 200) });
			}
		}
	},

	close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
		const { channel } = ws.data;
		logger.debug("WebSocket disconnected", { channel, code, reason });

		if (channel === "narrator") {
			handleNarratorWS.close(ws as ServerWebSocket<WSData & { channel: "narrator" }>);
		} else if (channel === "terminal") {
			handleTerminalWS.close(ws as ServerWebSocket<WSData & { channel: "terminal" }>);
		}
	},
};
