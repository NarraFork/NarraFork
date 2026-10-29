import { afterEach, describe, expect, test } from "bun:test";
import {
	type ConnectOptions,
	type Invitation,
	PrototypeClient,
} from "../../remote-prototype/client";
import { generateIdentity, instanceId, sha256Hex, sign } from "../../shared/remote-access/identity";
import { APP_VERSION, VERSION } from "../../shared/remote-access/protocol";

class Channel extends EventTarget {
	readyState = "open";
	bufferedAmount = 0;
	binaryType = "arraybuffer";
	bufferedAmountLowThreshold = 0;
	readonly sent: unknown[] = [];
	constructor(readonly label: string) {
		super();
	}
	send(data: unknown) {
		this.sent.push(data);
		if (this.label !== "nf.control.v1" || typeof data !== "string") return;
		const message = JSON.parse(data);
		if (message.type === "hello")
			this.receive({
				type: "hello.ready",
				grantId: "grant",
				discoveryCapability: "discovery-grant",
				expiresAt: Math.floor(Date.now() / 1000) + 3600,
			});
		else if (message.type === "auth")
			this.receive({ type: "ready", version: VERSION, apiVersion: 1, appVersion: APP_VERSION });
	}
	receive(data: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
	close() {
		if (this.readyState === "closed") return;
		this.readyState = "closed";
		this.dispatchEvent(new Event("close"));
	}
}
const sdp = "v=0\r\na=candidate:1 1 udp 100 127.0.0.1 1234 typ host\r\n";
class Peer extends EventTarget {
	connectionState = "connected";
	iceGatheringState = "complete";
	localDescription?: RTCSessionDescriptionInit;
	remoteDescription?: RTCSessionDescriptionInit;
	sctp = { maxMessageSize: 65536 };
	channels = new Map<string, Channel>();
	remoteType = "host";
	createDataChannel(label: string, options: RTCDataChannelInit) {
		expect(options).toEqual({ ordered: true });
		const channel = new Channel(label);
		this.channels.set(label, channel);
		return channel;
	}
	async createOffer() {
		return { type: "offer", sdp };
	}
	async setLocalDescription(description: RTCSessionDescriptionInit) {
		this.localDescription = description;
	}
	async setRemoteDescription(description: RTCSessionDescriptionInit) {
		this.remoteDescription = description;
	}
	async getStats() {
		return new Map([
			["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
			[
				"pair",
				{
					id: "pair",
					type: "candidate-pair",
					localCandidateId: "local",
					remoteCandidateId: "remote",
					state: "succeeded",
					nominated: true,
					bytesSent: 12,
					bytesReceived: 24,
				},
			],
			["local", { id: "local", type: "local-candidate", candidateType: "host" }],
			["remote", { id: "remote", type: "remote-candidate", candidateType: this.remoteType }],
		]);
	}
	close() {
		this.connectionState = "closed";
	}
}
class Signal extends EventTarget {
	readyState = 1;
	readonly sent: Record<string, unknown>[] = [];
	constructor(
		private readonly respond: (
			message: Record<string, unknown>,
		) => Promise<Record<string, unknown>>,
	) {
		super();
	}
	send(raw: string) {
		const message = JSON.parse(raw);
		this.sent.push(message);
		void this.respond(message).then((answer) =>
			this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(answer) })),
		);
	}
	close() {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
}
const clients: PrototypeClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
});
async function fixture(mutate?: (answer: Record<string, unknown>) => void) {
	const identity = await generateIdentity();
	const id = await instanceId(identity.publicKey);
	const invitation: Invitation = {
		instanceId: id,
		publicKey: identity.publicKey,
		pairId: "invite",
		pairingSecret: "a".repeat(64),
		discoveryCapability: "discovery",
		signalUrl: "ws://localhost:9000/signal/browser",
	};
	const peer = new Peer();
	const signal = new Signal(async (connect) => {
		const offerHash = await sha256Hex(String(connect.offer));
		const answerHash = await sha256Hex(sdp);
		const answer: Record<string, unknown> = {
			type: "connected",
			sessionId: "session",
			answer: sdp,
			ticket: {
				instanceId: id,
				leaseEpoch: "lease",
				sessionId: "session",
				clientPublicKey: connect.clientPublicKey,
				offerHash,
				expiresAt: Math.floor(Date.now() / 1000) + 60,
				targetKind: "invite",
				targetId: "invite",
				signature: "b".repeat(128),
			},
			signature: await sign(identity.privateKey, "answer", [
				id,
				"session",
				String(connect.clientPublicKey),
				offerHash,
				answerHash,
			]),
		};
		mutate?.(answer);
		return answer;
	});
	const options: ConnectOptions = {
		allowLocalhost: true,
		expectedInstanceId: id,
		persistGrant: false,
		negotiationTimeoutMs: 1000,
		origin: "http://localhost:9000",
		peerFactory: (config) => {
			expect(config.iceServers).toEqual([]);
			return peer as unknown as RTCPeerConnection;
		},
		signalFactory: () => signal as unknown as WebSocket,
	};
	return { invitation, options, peer, signal };
}

describe("browser signed nontrickle handshake", () => {
	test("only discovery and signed offer go over A, pairing/JWT are direct, A close leaves RTC alive", async () => {
		const data = await fixture();
		const client = await PrototypeClient.connect(data.invitation, data.options);
		clients.push(client);
		expect([...data.peer.channels.keys()]).toEqual([
			"nf.control.v1",
			"nf.realtime.v1",
			"nf.bulk.v1",
		]);
		expect(data.signal.sent).toHaveLength(1);
		expect(data.signal.sent[0]?.pairingSecret).toBeUndefined();
		expect(data.signal.sent[0]?.token).toBeUndefined();
		expect(typeof data.signal.sent[0]?.offerSignature).toBe("string");
		const control = data.peer.channels.get("nf.control.v1");
		expect(JSON.parse(String(control?.sent[0])).pairingSecret).toBe(data.invitation.pairingSecret);
		await client.authenticate("secret-jwt");
		expect(JSON.parse(String(control?.sent[1])).token).toBe("secret-jwt");
		data.signal.close();
		expect(client.state).toBe("ready");
		expect(data.peer.connectionState).toBe("connected");
		expect(await client.candidateStats()).toMatchObject({
			localType: "host",
			remoteType: "host",
			bytesSent: 12,
			bytesReceived: 24,
		});
	});
	test("tampered answer or cross-client ticket is rejected before setRemoteDescription", async () => {
		for (const mutate of [
			(answer: Record<string, unknown>) => {
				answer.answer = `${sdp}a=extra:tampered\r\n`;
			},
			(answer: Record<string, unknown>) => {
				(answer.ticket as Record<string, unknown>).clientPublicKey = `04${"0".repeat(128)}`;
			},
			(answer: Record<string, unknown>) => {
				(answer.ticket as Record<string, unknown>).offerHash = "0".repeat(64);
			},
		]) {
			const data = await fixture(mutate);
			await expect(PrototypeClient.connect(data.invitation, data.options)).rejects.toThrow();
			expect(data.peer.remoteDescription).toBeUndefined();
			expect(data.peer.connectionState).toBe("closed");
		}
	});
	test("relay on either selected candidate side fails closed", async () => {
		const data = await fixture();
		data.peer.remoteType = "relay";
		await expect(PrototypeClient.connect(data.invitation, data.options)).rejects.toThrow(
			"relay_or_unknown_selected_pair",
		);
		expect(data.peer.channels.get("nf.control.v1")?.sent).toHaveLength(0);
	});
	test("negotiated SCTP smaller than contract frames is explicitly unsupported", async () => {
		const data = await fixture();
		data.peer.sctp.maxMessageSize = 8192;
		await expect(PrototypeClient.connect(data.invitation, data.options)).rejects.toThrow(
			"sctp_message_size_unsupported",
		);
	});
});
