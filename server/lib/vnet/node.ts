import {
	decryptPacket,
	deriveHmacKey,
	deriveNetworkId,
	derivePacketKey,
	encryptPacket,
	hmacSha256,
	type VNetHmacKey,
	type VNetPacketKey,
	verifyHmac,
} from "./crypto";
import {
	canonicalJson,
	decodeJson,
	encodeJson,
	randomNonce,
	randomToken,
	utf8String,
} from "./protocol";
import type {
	VNetDatagramMetadata,
	VNetEndpoint,
	VNetPeerInfo,
	VNetRelayPacketServerMessage,
	VNetServerMessage,
	VNetUdpClientPacket,
} from "./types";

interface VNetNodeConfig {
	relayUrl: string;
	relayToken?: string;
	networkName: string;
	networkSecret: string;
	peerId: string;
	virtualIp: string;
	displayName?: string;
	enableUdp?: boolean;
}

export interface VNetDatagram {
	fromPeerId: string;
	srcIp: string;
	dstIp: string;
	srcPort: number;
	dstPort: number;
	data: Uint8Array;
}

type DatagramHandler = (datagram: VNetDatagram) => void | Promise<void>;
type NodeUdpSocket = Bun.udp.Socket<"buffer">;

interface DirectUdpPacket {
	type: "direct_packet";
	networkId: string;
	fromPeerId: string;
	toPeerId: string;
	srcIp: string;
	dstIp: string;
	srcPort: number;
	dstPort: number;
	seq: number;
	nonce: string;
	ciphertext: string;
	authTag: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerMessage(value: unknown): value is VNetServerMessage {
	return isRecord(value) && typeof value.type === "string";
}

function isDirectUdpPacket(value: unknown): value is DirectUdpPacket {
	return (
		isRecord(value) &&
		value.type === "direct_packet" &&
		typeof value.networkId === "string" &&
		typeof value.fromPeerId === "string" &&
		typeof value.toPeerId === "string" &&
		typeof value.srcIp === "string" &&
		typeof value.dstIp === "string" &&
		typeof value.srcPort === "number" &&
		typeof value.dstPort === "number" &&
		typeof value.seq === "number" &&
		typeof value.nonce === "string" &&
		typeof value.ciphertext === "string" &&
		typeof value.authTag === "string"
	);
}

function withoutAuthTag<T extends { authTag: string }>(packet: T): Omit<T, "authTag"> {
	const { authTag: _authTag, ...rest } = packet;
	return rest;
}

export class VNetNode {
	private ws: WebSocket | null = null;
	private udpSocket: NodeUdpSocket | null = null;
	private networkId = "";
	private packetKey: VNetPacketKey | null = null;
	private hmacKey: VNetHmacKey | null = null;
	private sessionId = "";
	private udpAuthToken = "";
	private seq = 0;
	private readonly peers = new Map<string, VNetPeerInfo>();
	private readonly directUdpEndpoints = new Map<string, VNetEndpoint>();
	private readonly handlers = new Set<DatagramHandler>();

	constructor(private readonly config: VNetNodeConfig) {}

	async connectRelay(): Promise<void> {
		this.networkId = await deriveNetworkId(this.config.networkName, this.config.networkSecret);
		this.packetKey = await derivePacketKey(this.config.networkSecret, this.config.networkName);
		this.hmacKey = await deriveHmacKey(this.config.networkSecret, this.config.networkName);

		const url = new URL(this.config.relayUrl);
		if (this.config.relayToken) url.searchParams.set("token", this.config.relayToken);
		const ws = new WebSocket(url);
		this.ws = ws;

		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
			};
			const onOpen = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("VNet relay WebSocket connection failed"));
			};
			ws.addEventListener("open", onOpen);
			ws.addEventListener("error", onError);
		});

		ws.addEventListener("message", (event) => {
			this.handleRelayMessage(event.data).catch(() => {});
		});
		ws.addEventListener("close", () => {
			this.ws = null;
		});

		this.sendWs({
			type: "hello",
			networkId: this.networkId,
			peerId: this.config.peerId,
			virtualIp: this.config.virtualIp,
			displayName: this.config.displayName,
			endpoints: [{ transport: "relay", observedAt: Date.now() }],
			capabilities: { udp: this.config.enableUdp !== false },
		});
	}

	onDatagram(handler: DatagramHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	async sendDatagram(dstIp: string, dstPort: number, data: Uint8Array | string): Promise<void> {
		const peer = [...this.peers.values()].find((item) => item.virtualIp === dstIp);
		if (!peer) throw new Error(`Unknown VNet destination ${dstIp}`);
		const metadata: VNetDatagramMetadata = {
			fromPeerId: this.config.peerId,
			toPeerId: peer.peerId,
			srcIp: this.config.virtualIp,
			dstIp,
			srcPort: 0,
			dstPort,
			seq: ++this.seq,
		};
		const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
		const encrypted = await encryptPacket(this.requirePacketKey(), metadata, payload);
		const directEndpoint = this.directUdpEndpoints.get(peer.peerId);
		if (directEndpoint?.address && directEndpoint.port && this.udpSocket) {
			await this.sendDirectUdp(
				peer.peerId,
				metadata,
				encrypted.nonce,
				encrypted.ciphertext,
				directEndpoint,
			);
			return;
		}
		this.sendWs({
			type: "relay_packet",
			toPeerId: peer.peerId,
			dstIp,
			srcIp: this.config.virtualIp,
			srcPort: 0,
			dstPort,
			seq: metadata.seq,
			nonce: encrypted.nonce,
			ciphertext: encrypted.ciphertext,
		});
	}

	async tryPunch(peerId: string): Promise<void> {
		this.sendWs({ type: "punch_request", toPeerId: peerId, tid: randomToken(12) });
		await this.ensureUdpSocket();
	}

	close(): void {
		try {
			this.ws?.close();
		} catch {}
		try {
			this.udpSocket?.close();
		} catch {}
		this.ws = null;
		this.udpSocket = null;
	}

	private async handleRelayMessage(raw: unknown): Promise<void> {
		const parsed = typeof raw === "string" ? JSON.parse(raw) : decodeJson(raw as Buffer);
		if (!isServerMessage(parsed)) return;
		switch (parsed.type) {
			case "ping":
				this.sendWs({ type: "pong" });
				break;
			case "welcome":
				this.sessionId = parsed.sessionId;
				this.udpAuthToken = parsed.udpAuthToken ?? "";
				this.peers.clear();
				for (const peer of parsed.peers) this.peers.set(peer.peerId, peer);
				if (this.config.enableUdp !== false && parsed.udp?.enabled && parsed.udp.port) {
					await this.ensureUdpSocket();
					await this.registerUdp(parsed.udp.host, parsed.udp.port);
				}
				break;
			case "peer_joined":
			case "peer_update":
				this.peers.set(parsed.peer.peerId, parsed.peer);
				break;
			case "peer_left":
				this.peers.delete(parsed.peerId);
				this.directUdpEndpoints.delete(parsed.peerId);
				break;
			case "relay_packet":
				await this.handleRelayPacket(parsed);
				break;
			case "punch_offer":
				await this.handlePunchOffer(parsed.fromPeerId, parsed.tid, parsed.endpoint);
				break;
		}
	}

	private async handleRelayPacket(packet: VNetRelayPacketServerMessage): Promise<void> {
		const peer = this.peers.get(packet.fromPeerId);
		const metadata: VNetDatagramMetadata = {
			fromPeerId: packet.fromPeerId,
			toPeerId: this.config.peerId,
			srcIp: packet.srcIp ?? peer?.virtualIp ?? "",
			dstIp: packet.dstIp ?? this.config.virtualIp,
			srcPort: packet.srcPort ?? 0,
			dstPort: packet.dstPort ?? 0,
			seq: packet.seq,
		};
		const data = await decryptPacket(
			this.requirePacketKey(),
			metadata,
			packet.nonce,
			packet.ciphertext,
		);
		await this.emitDatagram({
			fromPeerId: packet.fromPeerId,
			srcIp: metadata.srcIp,
			dstIp: metadata.dstIp,
			srcPort: metadata.srcPort,
			dstPort: metadata.dstPort,
			data,
		});
	}

	private async handlePunchOffer(
		peerId: string,
		tid: string,
		endpoint?: VNetEndpoint,
	): Promise<void> {
		await this.ensureUdpSocket();
		const peerUdp = this.peers
			.get(peerId)
			?.endpoints.find((item) => item.transport === "udp" && item.address && item.port);
		if (endpoint?.address && endpoint.port && this.udpSocket) {
			await this.sendUdpPunchProbe(endpoint.address, endpoint.port, peerId, tid, false);
		}
		if (peerUdp?.address && peerUdp.port && this.udpSocket) {
			await this.sendUdpPunchProbe(peerUdp.address, peerUdp.port, peerId, tid, false);
		}
	}

	private async ensureUdpSocket(): Promise<void> {
		if (this.udpSocket || this.config.enableUdp === false) return;
		this.udpSocket = (await Bun.udpSocket({
			hostname: "0.0.0.0",
			port: 0,
			binaryType: "buffer",
			socket: {
				data: async (_socket, data, port, address) => {
					await this.handleUdpPacket(data, port, address);
				},
			},
		})) as Bun.udp.Socket<"buffer">;
	}

	private async registerUdp(host: string | undefined, port: number): Promise<void> {
		if (!this.udpSocket || !this.sessionId || !this.udpAuthToken) return;
		const relayHost = this.resolveRelayUdpHost(host);
		const packet = await this.signRelayUdpPacket({
			type: "register",
			sessionId: this.sessionId,
			networkId: this.networkId,
			peerId: this.config.peerId,
			timestamp: Date.now(),
			nonce: randomNonce(),
		});
		this.udpSocket.send(encodeJson(packet), port, relayHost);
	}

	private async sendUdpPunchProbe(
		address: string,
		port: number,
		toPeerId: string,
		tid: string,
		allowRelayToken: boolean,
	): Promise<void> {
		if (!this.udpSocket) return;
		if (allowRelayToken && this.sessionId && this.udpAuthToken) {
			const packet = await this.signRelayUdpPacket({
				type: "punch_probe",
				sessionId: this.sessionId,
				networkId: this.networkId,
				peerId: this.config.peerId,
				toPeerId,
				tid,
				timestamp: Date.now(),
				nonce: randomNonce(),
			});
			this.udpSocket.send(encodeJson(packet), port, address);
			return;
		}
		const packet = await this.signDirectUdpPacket({
			type: "direct_packet",
			networkId: this.networkId,
			fromPeerId: this.config.peerId,
			toPeerId,
			srcIp: this.config.virtualIp,
			dstIp: this.peers.get(toPeerId)?.virtualIp ?? "",
			srcPort: 0,
			dstPort: 0,
			seq: ++this.seq,
			nonce: randomNonce(),
			ciphertext: "",
		});
		this.udpSocket.send(encodeJson(packet), port, address);
	}

	private async sendDirectUdp(
		toPeerId: string,
		metadata: VNetDatagramMetadata,
		nonce: string,
		ciphertext: string,
		endpoint: VNetEndpoint,
	): Promise<void> {
		if (!this.udpSocket || !endpoint.address || !endpoint.port) return;
		const packet = await this.signDirectUdpPacket({
			type: "direct_packet",
			networkId: this.networkId,
			fromPeerId: this.config.peerId,
			toPeerId,
			srcIp: metadata.srcIp,
			dstIp: metadata.dstIp,
			srcPort: metadata.srcPort,
			dstPort: metadata.dstPort,
			seq: metadata.seq,
			nonce,
			ciphertext,
		});
		this.udpSocket.send(encodeJson(packet), endpoint.port, endpoint.address);
	}

	private async handleUdpPacket(data: Buffer, port: number, address: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = decodeJson(data);
		} catch {
			return;
		}
		if (!isDirectUdpPacket(parsed) || parsed.networkId !== this.networkId) return;
		if (parsed.toPeerId !== this.config.peerId) return;
		if (!this.peers.has(parsed.fromPeerId)) return;
		const unsigned = withoutAuthTag(parsed);
		if (!(await verifyHmac(this.requireHmacKey(), canonicalJson(unsigned), parsed.authTag))) return;
		const hadEndpoint = this.directUdpEndpoints.has(parsed.fromPeerId);
		this.directUdpEndpoints.set(parsed.fromPeerId, {
			transport: "udp",
			address,
			port,
			observedAt: Date.now(),
		});
		if (!parsed.ciphertext) {
			if (!hadEndpoint) {
				await this.sendUdpPunchProbe(address, port, parsed.fromPeerId, randomToken(12), false);
			}
			return;
		}
		const metadata: VNetDatagramMetadata = {
			fromPeerId: parsed.fromPeerId,
			toPeerId: parsed.toPeerId,
			srcIp: parsed.srcIp,
			dstIp: parsed.dstIp,
			srcPort: parsed.srcPort,
			dstPort: parsed.dstPort,
			seq: parsed.seq,
		};
		const plaintext = await decryptPacket(
			this.requirePacketKey(),
			metadata,
			parsed.nonce,
			parsed.ciphertext,
		);
		await this.emitDatagram({
			fromPeerId: parsed.fromPeerId,
			srcIp: parsed.srcIp,
			dstIp: parsed.dstIp,
			srcPort: parsed.srcPort,
			dstPort: parsed.dstPort,
			data: plaintext,
		});
	}

	private async signRelayUdpPacket<T extends Omit<VNetUdpClientPacket, "authTag">>(
		packet: T,
	): Promise<T & { authTag: string }> {
		const authTag = await hmacSha256(this.udpAuthToken, canonicalJson(packet));
		return { ...packet, authTag };
	}

	private async signDirectUdpPacket(
		packet: Omit<DirectUdpPacket, "authTag">,
	): Promise<DirectUdpPacket> {
		const authTag = await hmacSha256(this.requireHmacKey(), canonicalJson(packet));
		return { ...packet, authTag };
	}

	private async emitDatagram(datagram: VNetDatagram): Promise<void> {
		for (const handler of this.handlers) await handler(datagram);
	}

	private sendWs(message: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(encodeJson(message));
	}

	private requirePacketKey(): VNetPacketKey {
		if (!this.packetKey) throw new Error("VNet packet key is not initialized");
		return this.packetKey;
	}

	private requireHmacKey(): VNetHmacKey {
		if (!this.hmacKey) throw new Error("VNet HMAC key is not initialized");
		return this.hmacKey;
	}

	private resolveRelayUdpHost(host: string | undefined): string {
		if (host && host !== "0.0.0.0" && host !== "::") return host;
		const relayUrl = new URL(this.config.relayUrl);
		return relayUrl.hostname;
	}
}

export async function createVNetNode(config: VNetNodeConfig): Promise<VNetNode> {
	const node = new VNetNode(config);
	await node.connectRelay();
	return node;
}

export function datagramText(datagram: VNetDatagram): string {
	return utf8String(datagram.data);
}
