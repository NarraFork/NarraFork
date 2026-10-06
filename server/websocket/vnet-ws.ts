import type { ServerWebSocket } from "bun";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { vnetRelayHub } from "../lib/vnet/relay";
import type { VNetClientMessage, VNetRelayAuth } from "../lib/vnet/types";

export interface VNetWSData {
	connectedAt: number;
	lastPongAt: number;
	auth: VNetRelayAuth;
}

type VNetWS = ServerWebSocket<VNetWSData & { channel: "vnet" }>;

const connections = new Set<VNetWS>();

export function getVNetConnections(): Set<VNetWS> {
	return connections;
}

export function closeVNetConnections(reason = "vnet settings changed"): number {
	const sockets = [...connections];
	for (const ws of sockets) {
		handleVNetWS.close(ws);
		try {
			ws.close(1000, reason);
		} catch {
			// already dead
		}
	}
	return sockets.length;
}

export const handleVNetWS = {
	open(ws: VNetWS) {
		connections.add(ws);
		vnetRelayHub.attachSocket(ws, ws.data.auth);
		logger.debug("VNet WS connected", { authKind: ws.data.auth.kind });
	},

	async message(ws: VNetWS, msg: VNetClientMessage) {
		if (msg.type === "pong") {
			ws.data.lastPongAt = Date.now();
			return;
		}
		if (!settings.vnet?.enabled) {
			try {
				ws.send(
					JSON.stringify({ type: "error", code: "VNET_DISABLED", message: "VNet is disabled" }),
				);
			} catch {
				// connection may be dead
			}
			closeVNetConnections("vnet disabled");
			return;
		}
		await vnetRelayHub.handleClientMessage(ws, msg);
	},

	close(ws: VNetWS) {
		connections.delete(ws);
		vnetRelayHub.detachSocket(ws);
		logger.debug("VNet WS disconnected", { connectedAt: ws.data.connectedAt });
	},
};
