import { describe, expect, it } from "bun:test";
import { canonicalJson } from "../../../server/lib/vnet/protocol";
import { VNetRelayHub, type VNetRelaySocket } from "../../../server/lib/vnet/relay";

class MockSocket implements VNetRelaySocket {
	messages: unknown[] = [];
	closed = false;

	send(data: string): void {
		this.messages.push(JSON.parse(data));
	}

	close(): void {
		this.closed = true;
	}
}

function makeHub(options: { maxPeersPerNetwork?: number } = {}) {
	const hub = new VNetRelayHub();
	hub.configure({
		maxPeersPerNetwork: options.maxPeersPerNetwork ?? 8,
		maxMessageBytes: 64 * 1024,
		udp: { enabled: true, port: 9999 },
	});
	return hub;
}

describe("VNetRelayHub", () => {
	it("registers peers and broadcasts joins", async () => {
		const hub = makeHub();
		const a = new MockSocket();
		const b = new MockSocket();
		hub.attachSocket(a, { kind: "relay-token" });
		hub.attachSocket(b, { kind: "relay-token" });

		await hub.handleClientMessage(a, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});
		await hub.handleClientMessage(b, {
			type: "hello",
			networkId: "net",
			peerId: "b",
			virtualIp: "10.88.0.2",
		});

		expect(a.messages.some((msg) => (msg as { type?: string }).type === "peer_joined")).toBe(true);
		const welcomeB = b.messages.find((msg) => (msg as { type?: string }).type === "welcome") as {
			peers: Array<{ peerId: string }>;
			udpAuthToken?: string;
		};
		expect(welcomeB.peers.map((peer) => peer.peerId)).toEqual(["a"]);
		expect(welcomeB.udpAuthToken).toBeTruthy();
		expect(hub.getStats()).toMatchObject({ networks: 1, peers: 2, connections: 2 });
	});

	it("forwards encrypted relay packets without inspecting ciphertext", async () => {
		const hub = makeHub();
		const a = new MockSocket();
		const b = new MockSocket();
		hub.attachSocket(a, { kind: "relay-token" });
		hub.attachSocket(b, { kind: "relay-token" });
		await hub.handleClientMessage(a, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});
		await hub.handleClientMessage(b, {
			type: "hello",
			networkId: "net",
			peerId: "b",
			virtualIp: "10.88.0.2",
		});

		await hub.handleClientMessage(a, {
			type: "relay_packet",
			toPeerId: "b",
			srcIp: "10.88.0.1",
			dstIp: "10.88.0.2",
			dstPort: 8080,
			seq: 1,
			nonce: "nonce",
			ciphertext: "opaque-ciphertext",
		});

		const packet = b.messages.find((msg) => (msg as { type?: string }).type === "relay_packet") as {
			fromPeerId: string;
			ciphertext: string;
		};
		expect(packet.fromPeerId).toBe("a");
		expect(packet.ciphertext).toBe("opaque-ciphertext");
	});

	it("replaces duplicate peer connections and cleans up on detach", async () => {
		const hub = makeHub();
		const first = new MockSocket();
		const second = new MockSocket();
		hub.attachSocket(first, { kind: "relay-token" });
		hub.attachSocket(second, { kind: "relay-token" });
		await hub.handleClientMessage(first, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});
		await hub.handleClientMessage(second, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});

		expect(first.closed).toBe(true);
		expect(hub.getStats().peers).toBe(1);
		hub.detachSocket(second);
		expect(hub.getStats()).toMatchObject({ networks: 0, peers: 0, connections: 0 });
	});

	it("allows same-peer replacement when the network is already full", async () => {
		const hub = makeHub({ maxPeersPerNetwork: 1 });
		const first = new MockSocket();
		const second = new MockSocket();
		hub.attachSocket(first, { kind: "relay-token" });
		hub.attachSocket(second, { kind: "relay-token" });

		await hub.handleClientMessage(first, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});
		await hub.handleClientMessage(second, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});

		expect(first.closed).toBe(true);
		expect(second.messages.some((msg) => (msg as { type?: string }).type === "welcome")).toBe(true);
		expect(hub.getStats().peers).toBe(1);
	});

	it("rejects duplicate virtual IPs inside a network", async () => {
		const hub = makeHub();
		const a = new MockSocket();
		const b = new MockSocket();
		hub.attachSocket(a, { kind: "relay-token" });
		hub.attachSocket(b, { kind: "relay-token" });

		await hub.handleClientMessage(a, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});
		await hub.handleClientMessage(b, {
			type: "hello",
			networkId: "net",
			peerId: "b",
			virtualIp: "10.88.0.1",
		});

		const error = b.messages.find((msg) => (msg as { type?: string }).type === "error") as {
			code?: string;
		};
		expect(error.code).toBe("VIRTUAL_IP_IN_USE");
		expect(hub.getStats().peers).toBe(1);
	});

	it("normalizes relay packet IP metadata and rejects forged addresses", async () => {
		const hub = makeHub();
		const a = new MockSocket();
		const b = new MockSocket();
		hub.attachSocket(a, { kind: "relay-token" });
		hub.attachSocket(b, { kind: "relay-token" });
		await hub.handleClientMessage(a, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});
		await hub.handleClientMessage(b, {
			type: "hello",
			networkId: "net",
			peerId: "b",
			virtualIp: "10.88.0.2",
		});

		await hub.handleClientMessage(a, {
			type: "relay_packet",
			toPeerId: "b",
			srcIp: "10.88.0.99",
			dstIp: "10.88.0.2",
			seq: 1,
			nonce: "nonce",
			ciphertext: "ciphertext",
		});
		const sourceError = a.messages.find(
			(msg) => (msg as { code?: string }).code === "INVALID_SOURCE_IP",
		) as { code?: string };
		expect(sourceError.code).toBe("INVALID_SOURCE_IP");

		await hub.handleClientMessage(a, {
			type: "relay_packet",
			toPeerId: "b",
			dstIp: "10.88.0.99",
			seq: 2,
			nonce: "nonce",
			ciphertext: "ciphertext",
		});
		const destinationError = a.messages.find(
			(msg) => (msg as { code?: string }).code === "INVALID_DESTINATION_IP",
		) as { code?: string };
		expect(destinationError.code).toBe("INVALID_DESTINATION_IP");

		await hub.handleClientMessage(a, {
			type: "relay_packet",
			toPeerId: "b",
			seq: 3,
			nonce: "nonce",
			ciphertext: "ciphertext",
		});
		const packet = b.messages.find((msg) => (msg as { seq?: number }).seq === 3) as {
			srcIp?: string;
			dstIp?: string;
		};
		expect(packet.srcIp).toBe("10.88.0.1");
		expect(packet.dstIp).toBe("10.88.0.2");
	});

	it("verifies UDP session auth tags", async () => {
		const hub = makeHub();
		const socket = new MockSocket();
		hub.attachSocket(socket, { kind: "relay-token" });
		await hub.handleClientMessage(socket, {
			type: "hello",
			networkId: "net",
			peerId: "a",
			virtualIp: "10.88.0.1",
		});
		const welcome = socket.messages.find(
			(msg) => (msg as { type?: string }).type === "welcome",
		) as {
			sessionId: string;
		};
		const packet = {
			type: "register" as const,
			sessionId: welcome.sessionId,
			networkId: "net",
			peerId: "a",
			timestamp: 1,
			nonce: "nonce",
		};
		const tag = await hub.signUdpPacket(welcome.sessionId, packet);

		expect(tag).toBeTruthy();
		expect(await hub.verifyUdpAuth(welcome.sessionId, packet, tag ?? "")).toBe(true);
		expect(
			await hub.verifyUdpAuth(welcome.sessionId, { ...packet, nonce: "other" }, tag ?? ""),
		).toBe(false);
		expect(canonicalJson(packet)).toContain("register");
	});
});
