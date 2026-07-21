import { Buffer } from "node:buffer";
import type { ServerWebSocket } from "bun";
import { isChunkFrame } from "../lib/agent/execution/rpc-types";
import { hotTimer, hotTimerClear } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import type { VNetClientMessage } from "../lib/vnet/types";
import {
	type DeviceWSData,
	getDeviceConnections,
	handleDeviceWS,
} from "../services/device-connection-service";
import {
	handleExternalNarratorWS,
	rejectOversizedExternalNarratorFrame,
} from "./external-narrator-ws";
import type { ExternalNarratorWSData } from "./external-narrator-ws-types";
import {
	getNarratorConnections,
	handleNarratorWS,
	type NarratorClientMessage,
	type NarratorWSData,
} from "./narrator-ws";
import {
	closeAllExternalNarratorConnections,
	closeExternalNarratorConnectionForAuthLoss,
	type ExternalNarratorWS,
	getExternalNarratorConnections,
	sendExternalNarratorFrame,
} from "./oauth-connection-registry";
import { getTerminalConnections, handleTerminalWS, type TerminalWSData } from "./terminal-ws";
import { getVNetConnections, handleVNetWS, type VNetWSData } from "./vnet-ws";

// === Unified WS data type ===

export type WSData =
	| ({ channel: "narrator" } & NarratorWSData)
	| ({ channel: "external-narrator" } & ExternalNarratorWSData)
	| ({ channel: "terminal" } & TerminalWSData)
	| ({ channel: "vnet" } & VNetWSData)
	| ({ channel: "device" } & DeviceWSData);

let acceptingWebSocketMessages = true;
const activeWebSocketHandlers = new Set<Promise<void>>();

function trackWebSocketHandler(work: Promise<void>, onError: (error: unknown) => void): void {
	const tracked = work.catch(onError);
	activeWebSocketHandlers.add(tracked);
	void tracked.then(
		() => activeWebSocketHandlers.delete(tracked),
		() => activeWebSocketHandlers.delete(tracked),
	);
}

/** Wait until every application-level WS message handler that started before shutdown settles. */
export async function waitForWebSocketActivityDrain(): Promise<void> {
	while (activeWebSocketHandlers.size > 0) {
		await Promise.allSettled([...activeWebSocketHandlers]);
	}
}

/**
 * Determine channel from the upgrade URL path and build initial WSData.
 * Returns null if the path doesn't match any known WS endpoint.
 */
export function resolveExternalNarratorWSData(
	authSnapshot: ExternalNarratorWSData["authSnapshot"],
): WSData {
	return {
		channel: "external-narrator",
		connectedAt: Date.now(),
		lastPongAt: Date.now(),
		connectionId: `oauth-ws:${generateId()}`,
		integrationSubscriptions: new Map(),
		authSnapshot,
		controlTokens: 40,
		writeTokens: 10,
		rateUpdatedAt: Date.now(),
		controlLimited: false,
		writeLimited: false,
	};
}

export function resolveWSData(
	url: URL,
	userInfo?: {
		userId: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	},
	vnetAuth?: VNetWSData["auth"],
): WSData | null {
	if (url.pathname === "/ws/narrator" || url.pathname.startsWith("/ws/narrator?")) {
		return {
			channel: "narrator",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
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
	if (url.pathname === "/ws/vnet" || url.pathname.startsWith("/ws/vnet?")) {
		return {
			channel: "vnet",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			auth: vnetAuth ?? { kind: "anonymous" },
		};
	}
	if (url.pathname === "/ws/device" || url.pathname.startsWith("/ws/device?")) {
		return {
			channel: "device",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			authenticated: false,
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
			const staleExternalNarrator: ExternalNarratorWS[] = [];
			const staleTerminal: Array<ServerWebSocket<WSData & { channel: "terminal" }>> = [];
			const staleVNet: Array<ServerWebSocket<WSData & { channel: "vnet" }>> = [];
			const staleDevice: Array<ServerWebSocket<WSData & { channel: "device" }>> = [];

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

			for (const ws of getExternalNarratorConnections()) {
				if (Date.parse(ws.data.authSnapshot.oauth.expiresAt) <= now) {
					closeExternalNarratorConnectionForAuthLoss(
						ws,
						"TOKEN_EXPIRED",
						"OAuth access token has expired",
						4001,
					);
					continue;
				}
				if (now - ws.data.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
					staleExternalNarrator.push(ws);
					continue;
				}
				if (!sendExternalNarratorFrame(ws, { type: "ping" })) {
					staleExternalNarrator.push(ws);
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

			for (const ws of getVNetConnections()) {
				if (now - ws.data.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
					staleVNet.push(ws);
					continue;
				}
				try {
					ws.send(pingPayload);
				} catch {
					staleVNet.push(ws);
				}
			}

			for (const ws of getDeviceConnections()) {
				if (now - ws.data.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
					staleDevice.push(ws);
					continue;
				}
				try {
					ws.send(pingPayload);
				} catch {
					staleDevice.push(ws);
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

			for (const ws of staleExternalNarrator) {
				handleExternalNarratorWS.close(ws);
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

			for (const ws of staleVNet) {
				logger.debug("Closing stale VNet WS (heartbeat timeout)", {
					connectedAt: ws.data.connectedAt,
					lastPongAt: ws.data.lastPongAt,
				});
				handleVNetWS.close(ws);
				try {
					ws.close(1000, "heartbeat timeout");
				} catch {
					// already dead
				}
			}

			for (const ws of staleDevice) {
				logger.debug("Closing stale device WS (heartbeat timeout)", {
					connectedAt: ws.data.connectedAt,
					lastPongAt: ws.data.lastPongAt,
				});
				handleDeviceWS.close(ws);
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
	acceptingWebSocketMessages = false;
	closeAllExternalNarratorConnections();
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
	for (const ws of getVNetConnections()) {
		try {
			ws.terminate();
		} catch {
			// already dead — ignore
		}
	}
	for (const ws of getDeviceConnections()) {
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
		if (!acceptingWebSocketMessages) {
			try {
				ws.close(1012, "server shutting down");
			} catch {
				// already dead
			}
			return;
		}
		const { channel } = ws.data;

		if (channel === "narrator") {
			handleNarratorWS.open(ws as ServerWebSocket<WSData & { channel: "narrator" }>);
		} else if (channel === "external-narrator") {
			handleExternalNarratorWS.open(ws as ExternalNarratorWS);
		} else if (channel === "terminal") {
			handleTerminalWS.open(ws as ServerWebSocket<WSData & { channel: "terminal" }>);
		} else if (channel === "vnet") {
			handleVNetWS.open(ws as ServerWebSocket<WSData & { channel: "vnet" }>);
		} else if (channel === "device") {
			handleDeviceWS.open(ws as ServerWebSocket<WSData & { channel: "device" }>);
		}
	},

	message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
		if (!acceptingWebSocketMessages) {
			try {
				ws.close(1012, "server shutting down");
			} catch {
				// already dead
			}
			return;
		}
		const { channel } = ws.data;

		if (
			channel === "external-narrator" &&
			rejectOversizedExternalNarratorFrame(ws as ExternalNarratorWS, message)
		) {
			return;
		}

		// Device channel: binary messages are file-transfer chunk frames. Route
		// them straight to the transfer receiver without JSON parsing. A binary
		// message is one Bun delivers as a Buffer whose first byte is the frame
		// magic; everything else on this channel is JSON text control.
		if (channel === "device" && typeof message !== "string") {
			const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
			if (isChunkFrame(bytes)) {
				const maxChunkBytes = (settings.devices?.transferChunkBytes ?? 1024 * 1024) + 64 * 1024;
				if (bytes.byteLength > maxChunkBytes) {
					logger.warn("Device chunk frame rejected: too large", {
						size: bytes.byteLength,
						maxChunkBytes,
					});
					try {
						ws.close(1009, "chunk too large");
					} catch {
						// dead
					}
					return;
				}
				trackWebSocketHandler(
					handleDeviceWS.binaryMessage(
						ws as ServerWebSocket<WSData & { channel: "device" }>,
						bytes,
					),
					(err) => logger.warn("Device WS binary handler error", { error: String(err) }),
				);
				return;
			}
		}

		if (channel === "vnet") {
			const rawBytes =
				typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
			const maxBytes = settings.vnet?.maxMessageBytes ?? 1024 * 1024;
			if (rawBytes > maxBytes) {
				logger.warn("VNet WS message rejected before parsing: payload too large", {
					rawBytes,
					maxBytes,
				});
				try {
					ws.send(
						JSON.stringify({
							type: "error",
							code: "MESSAGE_TOO_LARGE",
							message: "Message is too large",
						}),
					);
					ws.close(1009, "message too large");
				} catch {
					// connection may be dead
				}
				return;
			}
		} else if (channel === "device") {
			// Device frames carry base64 file/exec payloads. Cap at the configured
			// RPC byte budget, allowing for base64 (~4/3) + framing overhead.
			const rawBytes =
				typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
			const maxRpcBytes = settings.devices?.maxRpcBytes ?? 10 * 1024 * 1024;
			const maxBytes = Math.ceil(maxRpcBytes * 1.4) + 4096;
			if (rawBytes > maxBytes) {
				logger.warn("Device WS message rejected before parsing: payload too large", {
					rawBytes,
					maxBytes,
				});
				try {
					ws.send(JSON.stringify({ type: "error", code: "MESSAGE_TOO_LARGE" }));
					ws.close(1009, "message too large");
				} catch {
					// connection may be dead
				}
				return;
			}
		}

		const text = typeof message === "string" ? message : new TextDecoder().decode(message);

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
				logger.warn("Invalid WebSocket message: missing type field", {
					channel,
					text: text.slice(0, 200),
				});
				try {
					ws.send(
						JSON.stringify(
							channel === "external-narrator"
								? { type: "error", code: "INVALID_FRAME", message: "Missing message type" }
								: { type: "error", message: "Missing message type" },
						),
					);
				} catch {
					// connection may be dead
				}
				return;
			}
		} catch {
			logger.warn("Invalid WebSocket JSON", { channel, text: text.slice(0, 200) });
			try {
				ws.send(
					JSON.stringify(
						channel === "external-narrator"
							? { type: "error", code: "INVALID_JSON", message: "Invalid message format" }
							: { type: "error", message: "Invalid message format" },
					),
				);
			} catch {
				// connection may be dead
			}
			return;
		}

		if (channel === "narrator") {
			trackWebSocketHandler(
				handleNarratorWS.message(
					ws as ServerWebSocket<WSData & { channel: "narrator" }>,
					parsed as NarratorClientMessage,
				),
				(err) => {
					logger.warn("Narrator WS message handler error", { error: String(err) });
					try {
						ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
					} catch {
						// connection may be dead
					}
				},
			);
		} else if (channel === "external-narrator") {
			trackWebSocketHandler(
				handleExternalNarratorWS.message(ws as ExternalNarratorWS, parsed),
				(err) => {
					logger.warn("External narrator WS message handler error", { error: String(err) });
					try {
						ws.send(
							JSON.stringify({
								type: "error",
								code: "INTERNAL_ERROR",
								message: "Internal error",
							}),
						);
					} catch {
						// connection may be dead
					}
				},
			);
		} else if (channel === "terminal") {
			trackWebSocketHandler(
				Promise.resolve(
					handleTerminalWS.message(ws as ServerWebSocket<WSData & { channel: "terminal" }>, parsed),
				),
				(err) => logger.warn("Terminal WS message handler error", { error: String(err) }),
			);
		} else if (channel === "vnet") {
			trackWebSocketHandler(
				handleVNetWS.message(
					ws as ServerWebSocket<WSData & { channel: "vnet" }>,
					parsed as VNetClientMessage,
				),
				(err) => {
					logger.warn("VNet WS message handler error", { error: String(err) });
					try {
						ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
					} catch {
						// connection may be dead
					}
				},
			);
		} else if (channel === "device") {
			trackWebSocketHandler(
				handleDeviceWS.message(ws as ServerWebSocket<WSData & { channel: "device" }>, parsed),
				(err) => logger.warn("Device WS message handler error", { error: String(err) }),
			);
		}
	},

	close(ws: ServerWebSocket<WSData>, _code: number, _reason: string) {
		const { channel } = ws.data;

		if (channel === "narrator") {
			handleNarratorWS.close(ws as ServerWebSocket<WSData & { channel: "narrator" }>);
		} else if (channel === "external-narrator") {
			handleExternalNarratorWS.close(ws as ExternalNarratorWS);
		} else if (channel === "terminal") {
			handleTerminalWS.close(ws as ServerWebSocket<WSData & { channel: "terminal" }>);
		} else if (channel === "vnet") {
			handleVNetWS.close(ws as ServerWebSocket<WSData & { channel: "vnet" }>);
		} else if (channel === "device") {
			handleDeviceWS.close(ws as ServerWebSocket<WSData & { channel: "device" }>);
		}
	},
};
