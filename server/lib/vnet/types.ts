export type VNetPeerId = string;
export type VNetVirtualIp = string;

export type VNetTransport = "relay" | "udp";

export interface VNetEndpoint {
	transport: VNetTransport;
	address?: string;
	port?: number;
	observedAt?: number;
}

export interface VNetPeerInfo {
	peerId: VNetPeerId;
	virtualIp: VNetVirtualIp;
	displayName?: string;
	endpoints: VNetEndpoint[];
	capabilities?: {
		udp?: boolean;
	};
	lastSeenAt: number;
}

export interface VNetRelayAuth {
	kind: "jwt" | "relay-token" | "anonymous";
	userId?: string;
}

export interface VNetUdpRendezvousInfo {
	enabled: boolean;
	host?: string;
	port?: number;
}

export interface VNetHelloMessage {
	type: "hello";
	networkId: string;
	peerId: VNetPeerId;
	virtualIp: VNetVirtualIp;
	displayName?: string;
	endpoints?: VNetEndpoint[];
	capabilities?: {
		udp?: boolean;
	};
}

export interface VNetRelayPacketMessage {
	type: "relay_packet";
	toPeerId?: VNetPeerId;
	dstIp?: VNetVirtualIp;
	srcIp?: VNetVirtualIp;
	srcPort?: number;
	dstPort?: number;
	seq: number;
	nonce: string;
	ciphertext: string;
}

export interface VNetPunchRequestMessage {
	type: "punch_request";
	toPeerId: VNetPeerId;
	tid?: string;
}

export interface VNetPongMessage {
	type: "pong";
}

export type VNetClientMessage =
	| VNetHelloMessage
	| VNetRelayPacketMessage
	| VNetPunchRequestMessage
	| VNetPongMessage;

export interface VNetWelcomeMessage {
	type: "welcome";
	networkId: string;
	peerId: VNetPeerId;
	sessionId: string;
	udpAuthToken?: string;
	udp?: VNetUdpRendezvousInfo;
	peers: VNetPeerInfo[];
}

export interface VNetPeerJoinedMessage {
	type: "peer_joined";
	peer: VNetPeerInfo;
}

export interface VNetPeerLeftMessage {
	type: "peer_left";
	peerId: VNetPeerId;
}

export interface VNetPeerUpdateMessage {
	type: "peer_update";
	peer: VNetPeerInfo;
}

export interface VNetRelayPacketServerMessage extends VNetRelayPacketMessage {
	fromPeerId: VNetPeerId;
}

export interface VNetPunchOfferMessage {
	type: "punch_offer";
	fromPeerId: VNetPeerId;
	tid: string;
	endpoint?: VNetEndpoint;
}

export interface VNetErrorMessage {
	type: "error";
	message: string;
	code?: string;
}

export interface VNetPingMessage {
	type: "ping";
}

export type VNetServerMessage =
	| VNetWelcomeMessage
	| VNetPeerJoinedMessage
	| VNetPeerLeftMessage
	| VNetPeerUpdateMessage
	| VNetRelayPacketServerMessage
	| VNetPunchOfferMessage
	| VNetErrorMessage
	| VNetPingMessage;

export interface VNetDatagramMetadata {
	fromPeerId: VNetPeerId;
	toPeerId: VNetPeerId;
	srcIp: VNetVirtualIp;
	dstIp: VNetVirtualIp;
	srcPort: number;
	dstPort: number;
	seq: number;
}

export interface VNetEncryptedPacket {
	metadata: VNetDatagramMetadata;
	nonce: string;
	ciphertext: string;
}

export interface VNetUdpRegisterPacket {
	type: "register";
	sessionId: string;
	networkId: string;
	peerId: VNetPeerId;
	timestamp: number;
	nonce: string;
	authTag: string;
}

export interface VNetUdpPunchProbePacket {
	type: "punch_probe";
	sessionId: string;
	networkId: string;
	peerId: VNetPeerId;
	toPeerId: VNetPeerId;
	tid: string;
	timestamp: number;
	nonce: string;
	authTag: string;
}

export interface VNetUdpPunchAckPacket {
	type: "punch_ack";
	tid: string;
	peerId?: VNetPeerId;
}

export type VNetUdpClientPacket = VNetUdpRegisterPacket | VNetUdpPunchProbePacket;

export interface VNetSettings {
	enabled: boolean;
	relayToken?: string;
	allowAnonymousRelay: boolean;
	maxPeersPerNetwork: number;
	maxMessageBytes: number;
	udp: {
		enabled: boolean;
		host: string;
		port: number;
	};
}
