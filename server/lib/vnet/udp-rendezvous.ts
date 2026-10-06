import { logger } from "../logger";
import {
	canonicalJson,
	decodeJson,
	encodeJson,
	isVNetUdpClientPacket,
	randomToken,
} from "./protocol";
import { type VNetRelayHub, vnetRelayHub } from "./relay";
import type { VNetEndpoint, VNetSettings, VNetUdpClientPacket } from "./types";

type BunUdpSocket = Bun.udp.Socket<"buffer">;

export interface VNetUdpRendezvousStatus {
	enabled: boolean;
	running: boolean;
	host?: string;
	port?: number;
	error?: string;
}

function stripAuthTag(packet: VNetUdpClientPacket): Omit<VNetUdpClientPacket, "authTag"> {
	const { authTag: _authTag, ...unsigned } = packet;
	return unsigned;
}

export class VNetUdpRendezvousServer {
	private socket: BunUdpSocket | null = null;
	private status: VNetUdpRendezvousStatus = { enabled: false, running: false };

	constructor(private readonly hub: VNetRelayHub) {}

	async start(config?: VNetSettings["udp"]): Promise<VNetUdpRendezvousStatus> {
		await this.stop();
		if (!config?.enabled) {
			this.status = { enabled: false, running: false };
			this.hub.setUdpInfo({ enabled: false });
			return this.status;
		}

		this.status = { enabled: true, running: false, host: config.host, port: config.port };
		try {
			const socket = (await Bun.udpSocket({
				hostname: config.host,
				port: config.port,
				binaryType: "buffer",
				socket: {
					data: async (_socket, data, port, address) => {
						await this.handlePacket(data, port, address);
					},
					error: (_socket, error) => {
						logger.warn("VNet UDP rendezvous socket error", { error: String(error) });
					},
				},
			})) as Bun.udp.Socket<"buffer">;
			this.socket = socket;
			this.status = {
				enabled: true,
				running: true,
				host: socket.hostname,
				port: socket.port,
			};
			this.hub.setUdpInfo({ enabled: true, host: socket.hostname, port: socket.port });
			logger.info("VNet UDP rendezvous started", {
				host: socket.hostname,
				port: socket.port,
			});
		} catch (error) {
			this.status = {
				enabled: true,
				running: false,
				host: config.host,
				port: config.port,
				error: error instanceof Error ? error.message : String(error),
			};
			this.hub.setUdpInfo({ enabled: false });
			logger.warn("VNet UDP rendezvous failed to start; relay fallback remains available", {
				error: this.status.error,
			});
		}
		return this.status;
	}

	async stop(): Promise<void> {
		if (this.socket) {
			try {
				this.socket.close();
			} catch {}
			this.socket = null;
		}
		this.status = { ...this.status, running: false };
		this.hub.setUdpInfo({ enabled: false });
	}

	getStatus(): VNetUdpRendezvousStatus {
		return { ...this.status };
	}

	private async handlePacket(data: Buffer, port: number, address: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = decodeJson(data);
		} catch {
			return;
		}
		if (!isVNetUdpClientPacket(parsed)) return;
		const unsigned = stripAuthTag(parsed);
		const ok = await this.hub.verifyUdpAuth(parsed.sessionId, unsigned, parsed.authTag);
		if (!ok) return;

		const endpoint: VNetEndpoint = { transport: "udp", address, port, observedAt: Date.now() };
		this.hub.updateUdpEndpoint(parsed.sessionId, endpoint);
		if (parsed.type === "punch_probe") {
			this.hub.sendPunchOffer(parsed.sessionId, parsed.toPeerId, parsed.tid, endpoint);
			this.sendAck(port, address, parsed.peerId, parsed.tid);
		}
	}

	private sendAck(port: number, address: string, peerId: string, tid: string): void {
		if (!this.socket) return;
		try {
			this.socket.send(encodeJson({ type: "punch_ack", tid, peerId }), port, address);
		} catch {
			// UDP best-effort
		}
	}
}

export const vnetUdpRendezvous = new VNetUdpRendezvousServer(vnetRelayHub);

export async function startVNetUdpRendezvous(
	settings?: VNetSettings,
): Promise<VNetUdpRendezvousStatus> {
	vnetRelayHub.configure(settings);
	if (!settings?.enabled)
		return vnetUdpRendezvous.start({ enabled: false, host: "0.0.0.0", port: 0 });
	return vnetUdpRendezvous.start(settings.udp);
}

export async function stopVNetUdpRendezvous(): Promise<void> {
	await vnetUdpRendezvous.stop();
}

export function getVNetUdpRendezvousStatus(): VNetUdpRendezvousStatus {
	return vnetUdpRendezvous.getStatus();
}

export async function buildAuthenticatedUdpPacket(
	hub: VNetRelayHub,
	sessionId: string,
	packet: Omit<VNetUdpClientPacket, "authTag">,
): Promise<VNetUdpClientPacket | null> {
	const authTag = await hub.signUdpPacket(sessionId, packet);
	if (!authTag) return null;
	return { ...packet, authTag } as VNetUdpClientPacket;
}

export function createUdpRegisterPacketBase(
	sessionId: string,
	networkId: string,
	peerId: string,
): Omit<Extract<VNetUdpClientPacket, { type: "register" }>, "authTag"> {
	return {
		type: "register",
		sessionId,
		networkId,
		peerId,
		timestamp: Date.now(),
		nonce: randomToken(12),
	};
}

export function createUdpPunchProbePacketBase(
	sessionId: string,
	networkId: string,
	peerId: string,
	toPeerId: string,
	tid: string,
): Omit<Extract<VNetUdpClientPacket, { type: "punch_probe" }>, "authTag"> {
	return {
		type: "punch_probe",
		sessionId,
		networkId,
		peerId,
		toPeerId,
		tid,
		timestamp: Date.now(),
		nonce: randomToken(12),
	};
}

export function canonicalUdpPacket(packet: Omit<VNetUdpClientPacket, "authTag">): string {
	return canonicalJson(packet);
}
