import { hmacSha256, verifyHmac } from "./crypto";
import {
	canonicalJson,
	encodeJson,
	isVNetClientMessage,
	jsonByteLength,
	randomToken,
} from "./protocol";
import type {
	VNetClientMessage,
	VNetEndpoint,
	VNetErrorMessage,
	VNetPeerId,
	VNetPeerInfo,
	VNetRelayAuth,
	VNetRelayPacketMessage,
	VNetServerMessage,
	VNetSettings,
	VNetUdpRendezvousInfo,
} from "./types";

export interface VNetRelaySocket {
	data?: unknown;
	send(data: string): unknown;
	close(code?: number, reason?: string): unknown;
}

interface VNetRelayConnection {
	socket: VNetRelaySocket;
	auth: VNetRelayAuth;
	networkId?: string;
	peer?: VNetPeerInfo;
	sessionId?: string;
	udpAuthToken?: string;
	connectedAt: number;
	lastSeenAt: number;
}

interface VNetNetworkState {
	peers: Map<VNetPeerId, VNetRelayConnection>;
}

export interface VNetRelayHubOptions {
	maxPeersPerNetwork: number;
	maxMessageBytes: number;
	udp?: VNetUdpRendezvousInfo;
}

const DEFAULT_OPTIONS: VNetRelayHubOptions = {
	maxPeersPerNetwork: 64,
	maxMessageBytes: 1024 * 1024,
	udp: { enabled: false },
};

function normalizeOptions(
	options?: Partial<VNetSettings> | VNetRelayHubOptions,
): VNetRelayHubOptions {
	return {
		maxPeersPerNetwork: options?.maxPeersPerNetwork ?? DEFAULT_OPTIONS.maxPeersPerNetwork,
		maxMessageBytes: options?.maxMessageBytes ?? DEFAULT_OPTIONS.maxMessageBytes,
		udp:
			"udp" in (options ?? {})
				? {
						enabled: Boolean(options?.udp?.enabled),
						host: options?.udp?.host,
						port: options?.udp?.port,
					}
				: DEFAULT_OPTIONS.udp,
	};
}

function send(socket: VNetRelaySocket, message: VNetServerMessage | VNetErrorMessage): void {
	try {
		socket.send(encodeJson(message));
	} catch {
		// connection is already gone
	}
}

function publicPeerInfo(peer: VNetPeerInfo): VNetPeerInfo {
	return {
		peerId: peer.peerId,
		virtualIp: peer.virtualIp,
		displayName: peer.displayName,
		endpoints: [...peer.endpoints],
		capabilities: peer.capabilities ? { ...peer.capabilities } : undefined,
		lastSeenAt: peer.lastSeenAt,
	};
}

function findUdpEndpoint(peer?: VNetPeerInfo): VNetEndpoint | undefined {
	return peer?.endpoints.find((endpoint) => endpoint.transport === "udp" && endpoint.address);
}

export class VNetRelayHub {
	private connections = new Map<VNetRelaySocket, VNetRelayConnection>();
	private networks = new Map<string, VNetNetworkState>();
	private sessions = new Map<string, VNetRelayConnection>();
	private options: VNetRelayHubOptions = DEFAULT_OPTIONS;

	configure(options?: Partial<VNetSettings> | VNetRelayHubOptions): void {
		this.options = normalizeOptions(options);
	}

	setUdpInfo(udp: VNetUdpRendezvousInfo): void {
		this.options = { ...this.options, udp };
	}

	attachSocket(socket: VNetRelaySocket, auth: VNetRelayAuth): void {
		this.connections.set(socket, {
			socket,
			auth,
			connectedAt: Date.now(),
			lastSeenAt: Date.now(),
		});
	}

	async handleClientMessage(socket: VNetRelaySocket, message: unknown): Promise<void> {
		const conn = this.connections.get(socket);
		if (!conn) {
			send(socket, {
				type: "error",
				code: "NOT_ATTACHED",
				message: "Relay socket is not attached",
			});
			return;
		}
		if (jsonByteLength(message) > this.options.maxMessageBytes) {
			send(socket, { type: "error", code: "MESSAGE_TOO_LARGE", message: "Message is too large" });
			return;
		}
		if (!isVNetClientMessage(message)) {
			send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Invalid vnet message" });
			return;
		}

		conn.lastSeenAt = Date.now();
		switch (message.type) {
			case "hello":
				await this.handleHello(conn, message);
				break;
			case "relay_packet":
				this.handleRelayPacket(conn, message);
				break;
			case "punch_request":
				this.handlePunchRequest(conn, message.toPeerId, message.tid ?? randomToken(12));
				break;
			case "pong":
				break;
		}
	}

	detachSocket(socket: VNetRelaySocket): void {
		const conn = this.connections.get(socket);
		if (!conn) return;
		this.connections.delete(socket);
		if (conn.sessionId) this.sessions.delete(conn.sessionId);
		if (!conn.networkId || !conn.peer) return;

		const network = this.networks.get(conn.networkId);
		if (!network) return;
		const current = network.peers.get(conn.peer.peerId);
		if (current !== conn) return;
		network.peers.delete(conn.peer.peerId);
		this.broadcast(conn.networkId, { type: "peer_left", peerId: conn.peer.peerId });
		if (network.peers.size === 0) this.networks.delete(conn.networkId);
	}

	async verifyUdpAuth(
		sessionId: string,
		packetWithoutAuthTag: unknown,
		authTag: string,
	): Promise<boolean> {
		const conn = this.sessions.get(sessionId);
		if (!conn?.udpAuthToken) return false;
		return verifyHmac(conn.udpAuthToken, canonicalJson(packetWithoutAuthTag), authTag);
	}

	updateUdpEndpoint(sessionId: string, endpoint: VNetEndpoint): VNetPeerInfo | null {
		const conn = this.sessions.get(sessionId);
		if (!conn?.networkId || !conn.peer) return null;
		const withoutUdp = conn.peer.endpoints.filter((item) => item.transport !== "udp");
		conn.peer = {
			...conn.peer,
			endpoints: [...withoutUdp, { ...endpoint, transport: "udp", observedAt: Date.now() }],
			lastSeenAt: Date.now(),
		};
		const network = this.networks.get(conn.networkId);
		if (network?.peers.get(conn.peer.peerId) === conn) {
			this.broadcast(
				conn.networkId,
				{ type: "peer_update", peer: publicPeerInfo(conn.peer) },
				conn,
			);
		}
		return publicPeerInfo(conn.peer);
	}

	sendPunchOffer(sessionId: string, toPeerId: string, tid: string, endpoint: VNetEndpoint): void {
		const from = this.sessions.get(sessionId);
		if (!from?.networkId || !from.peer) return;
		const target = this.networks.get(from.networkId)?.peers.get(toPeerId);
		if (!target) return;
		send(target.socket, {
			type: "punch_offer",
			fromPeerId: from.peer.peerId,
			tid,
			endpoint,
		});
	}

	getStats(): {
		networks: number;
		peers: number;
		connections: number;
		udp: VNetUdpRendezvousInfo | undefined;
	} {
		let peers = 0;
		for (const network of this.networks.values()) peers += network.peers.size;
		return {
			networks: this.networks.size,
			peers,
			connections: this.connections.size,
			udp: this.options.udp,
		};
	}

	private async handleHello(
		conn: VNetRelayConnection,
		message: Extract<VNetClientMessage, { type: "hello" }>,
	) {
		if (conn.peer) this.detachSocket(conn.socket);
		this.attachSocket(conn.socket, conn.auth);
		const nextConn = this.connections.get(conn.socket);
		if (!nextConn) return;

		let network = this.networks.get(message.networkId);
		if (!network) {
			network = { peers: new Map() };
			this.networks.set(message.networkId, network);
		}

		const previous = network.peers.get(message.peerId);
		if (previous) {
			send(previous.socket, {
				type: "error",
				code: "PEER_REPLACED",
				message: "Peer was replaced by a newer connection",
			});
			try {
				previous.socket.close(1000, "peer replaced");
			} catch {}
			this.detachSocket(previous.socket);
			network = this.networks.get(message.networkId);
			if (!network) {
				network = { peers: new Map() };
				this.networks.set(message.networkId, network);
			}
		}

		const conflictingPeer = [...network.peers.values()].find(
			(item) => item.peer?.virtualIp === message.virtualIp && item.peer.peerId !== message.peerId,
		);
		if (conflictingPeer?.peer) {
			send(conn.socket, {
				type: "error",
				code: "VIRTUAL_IP_IN_USE",
				message: "VNet virtual IP is already in use by another peer",
			});
			return;
		}

		if (network.peers.size >= this.options.maxPeersPerNetwork) {
			send(conn.socket, {
				type: "error",
				code: "NETWORK_FULL",
				message: "VNet network has reached its peer limit",
			});
			return;
		}

		const sessionId = randomToken(18);
		const udpAuthToken = randomToken(32);
		const now = Date.now();
		const peer: VNetPeerInfo = {
			peerId: message.peerId,
			virtualIp: message.virtualIp,
			displayName: message.displayName,
			endpoints: message.endpoints ?? [{ transport: "relay", observedAt: now }],
			capabilities: message.capabilities,
			lastSeenAt: now,
		};

		nextConn.networkId = message.networkId;
		nextConn.peer = peer;
		nextConn.sessionId = sessionId;
		nextConn.udpAuthToken = udpAuthToken;
		nextConn.lastSeenAt = now;
		network.peers.set(peer.peerId, nextConn);
		this.sessions.set(sessionId, nextConn);

		const peers = [...network.peers.values()]
			.filter((item) => item !== nextConn && item.peer)
			.map((item) => publicPeerInfo(item.peer as VNetPeerInfo));

		send(conn.socket, {
			type: "welcome",
			networkId: message.networkId,
			peerId: peer.peerId,
			sessionId,
			udpAuthToken,
			udp: this.options.udp,
			peers,
		});
		this.broadcast(
			message.networkId,
			{ type: "peer_joined", peer: publicPeerInfo(peer) },
			nextConn,
		);
	}

	private handleRelayPacket(conn: VNetRelayConnection, message: VNetRelayPacketMessage): void {
		if (!conn.networkId || !conn.peer) {
			send(conn.socket, { type: "error", code: "NOT_REGISTERED", message: "Send hello first" });
			return;
		}
		const network = this.networks.get(conn.networkId);
		const target = message.toPeerId
			? network?.peers.get(message.toPeerId)
			: [...(network?.peers.values() ?? [])].find((item) => item.peer?.virtualIp === message.dstIp);
		if (!target?.peer) {
			send(conn.socket, {
				type: "error",
				code: "PEER_NOT_FOUND",
				message: "Target peer not found",
			});
			return;
		}
		if (message.srcIp !== undefined && message.srcIp !== conn.peer.virtualIp) {
			send(conn.socket, {
				type: "error",
				code: "INVALID_SOURCE_IP",
				message: "Relay packet source IP must match the sending peer",
			});
			return;
		}
		if (message.dstIp !== undefined && message.dstIp !== target.peer.virtualIp) {
			send(conn.socket, {
				type: "error",
				code: "INVALID_DESTINATION_IP",
				message: "Relay packet destination IP must match the target peer",
			});
			return;
		}
		send(target.socket, {
			...message,
			fromPeerId: conn.peer.peerId,
			srcIp: conn.peer.virtualIp,
			dstIp: target.peer.virtualIp,
		});
	}

	private handlePunchRequest(conn: VNetRelayConnection, toPeerId: string, tid: string): void {
		if (!conn.networkId || !conn.peer) {
			send(conn.socket, { type: "error", code: "NOT_REGISTERED", message: "Send hello first" });
			return;
		}
		const target = this.networks.get(conn.networkId)?.peers.get(toPeerId);
		if (!target) {
			send(conn.socket, {
				type: "error",
				code: "PEER_NOT_FOUND",
				message: "Target peer not found",
			});
			return;
		}
		send(target.socket, {
			type: "punch_offer",
			fromPeerId: conn.peer.peerId,
			tid,
			endpoint: findUdpEndpoint(conn.peer),
		});
	}

	private broadcast(
		networkId: string,
		message: VNetServerMessage,
		except?: VNetRelayConnection,
	): void {
		const network = this.networks.get(networkId);
		if (!network) return;
		for (const conn of network.peers.values()) {
			if (conn === except) continue;
			send(conn.socket, message);
		}
	}

	async signUdpPacket(sessionId: string, packetWithoutAuthTag: unknown): Promise<string | null> {
		const conn = this.sessions.get(sessionId);
		if (!conn?.udpAuthToken) return null;
		return hmacSha256(conn.udpAuthToken, canonicalJson(packetWithoutAuthTag));
	}
}

export const vnetRelayHub = new VNetRelayHub();
