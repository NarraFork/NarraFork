import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	dialRelayTarget,
	parseAndValidateTarget,
	RelayTargetRejectedError,
} from "../nug-relay/dialer";
import {
	decodeFrame,
	decodeWindowUpdate,
	encodeFrame,
	encodeWindowUpdate,
	INITIAL_STREAM_WINDOW,
	MAX_DATA_PAYLOAD,
	OP_DATA,
	OP_DIAL,
	OP_DIAL_OK,
} from "../nug-relay/protocol";
import { NugRelayClient } from "../nug-relay/relay-client";

describe("relay protocol codec", () => {
	test("frame round trip", () => {
		const payload = new TextEncoder().encode("hello");
		const frame = encodeFrame(OP_DATA, 42n, payload);
		const decoded = decodeFrame(frame);
		expect(decoded.op).toBe(OP_DATA);
		expect(decoded.streamId).toBe(42n);
		expect(Buffer.from(decoded.payload).toString()).toBe("hello");
	});

	test("rejects short and length-mismatched frames", () => {
		expect(() => decodeFrame(new Uint8Array(3))).toThrow();
		const frame = encodeFrame(OP_DATA, 1n, new Uint8Array(3));
		frame[12] = 99; // corrupt declared length
		expect(() => decodeFrame(frame)).toThrow();
	});

	test("window update codec", () => {
		expect(decodeWindowUpdate(encodeWindowUpdate(7n, 65536).subarray(13))).toBe(65536);
	});
});

describe("relay target allowlist", () => {
	test("accepts chatgpt.com:443", () => {
		expect(parseAndValidateTarget("chatgpt.com:443")).toEqual({ host: "chatgpt.com", port: 443 });
	});

	test("rejects IP literals even when allowlisted", () => {
		expect(() => parseAndValidateTarget("127.0.0.1:8080", ["127.0.0.1"])).toThrow(
			RelayTargetRejectedError,
		);
	});

	test("rejects non-allowlisted hosts", () => {
		expect(() => parseAndValidateTarget("evil.internal:22")).toThrow(RelayTargetRejectedError);
	});

	test("rejects malformed targets", () => {
		expect(() => parseAndValidateTarget("chatgpt.com")).toThrow(RelayTargetRejectedError);
		expect(() => parseAndValidateTarget("chatgpt.com:0")).toThrow(RelayTargetRejectedError);
		expect(() => parseAndValidateTarget("chatgpt.com:abc")).toThrow(RelayTargetRejectedError);
	});
});

describe("dialRelayTarget via HTTP CONNECT proxy", () => {
	test("establishes a tunnel through a clash-style proxy", async () => {
		// Fake upstream: echoes whatever it receives.
		const echo = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					socket.write(data);
				},
			},
		});
		// Fake clash: answers CONNECT, then pipes to the echo server.
		let proxied = 0;
		const tunnels = new WeakMap<import("bun").Socket, import("bun").Socket>();
		const proxy = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(proxySocket, data) {
					const established = tunnels.get(proxySocket);
					if (established) {
						established.write(data);
						return;
					}
					const text = data.toString();
					const firstLine = text.split("\r\n")[0];
					expect(firstLine.startsWith("CONNECT ")).toBe(true);
					const target = firstLine.split(" ")[1];
					const [host, port] = target.split(":");
					Bun.connect({
						hostname: host,
						port: Number(port),
						socket: {
							open(upstream) {
								tunnels.set(proxySocket, upstream);
								tunnels.set(upstream, proxySocket);
								proxied += 1;
								proxySocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
							},
							data(upstream, chunk) {
								tunnels.get(upstream)?.write(chunk);
							},
						},
					});
				},
			},
		});

		try {
			const received: Buffer[] = [];
			let resolveEchoed!: () => void;
			let rejectEchoed!: (err: Error) => void;
			const echoed = new Promise<void>((res, rej) => {
				resolveEchoed = res;
				rejectEchoed = rej;
			});
			const socket = await dialRelayTarget(
				{ host: "localhost", port: echo.port },
				`http://127.0.0.1:${proxy.port}`,
				{
					onData: (d) => {
						received.push(Buffer.from(d));
						if (Buffer.concat(received).toString().includes("ping-through-proxy")) {
							resolveEchoed();
						}
					},
					onClose: () => rejectEchoed(new Error("closed before echo")),
					onError: rejectEchoed,
				},
			);
			socket.write("ping-through-proxy");
			await echoed;
			socket.end();
			expect(proxied).toBe(1);
		} finally {
			echo.stop(true);
			proxy.stop(true);
		}
	});
});

// ── End-to-end: relay client against a simulated NUG hub ──

interface HubStream {
	id: bigint;
	received: Buffer[];
	dialOk: boolean;
	dialErr: string | null;
}

/**
 * Minimal NUG hub simulation: upgrades, sends hello_ack, and lets the test
 * drive DIAL/DATA frames while recording what comes back. Grants send-window
 * credit for every DATA frame it receives, like the real server side.
 */
function startHub() {
	const streams = new Map<bigint, HubStream>();
	let ws: import("bun").ServerWebSocket<unknown> | null = null;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req)) {
				return;
			}
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				ws = socket;
				socket.send(JSON.stringify({ type: "hello_ack", channel_id: "hub-test-channel" }));
			},
			message(socket, message) {
				if (typeof message === "string") {
					return;
				}
				const buf = message as Buffer;
				const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
				const frame = decodeFrame(raw);
				let st = streams.get(frame.streamId);
				if (!st) {
					st = { id: frame.streamId, received: [], dialOk: false, dialErr: null };
					streams.set(frame.streamId, st);
				}
				switch (frame.op) {
					case OP_DIAL_OK:
						st.dialOk = true;
						break;
					case 0x03:
						st.dialErr = Buffer.from(frame.payload).toString();
						break;
					case OP_DATA:
						st.received.push(Buffer.from(frame.payload));
						socket.send(encodeWindowUpdate(frame.streamId, frame.payload.byteLength));
						break;
				}
			},
		},
	});
	return {
		server,
		streams,
		send(op: number, streamId: bigint, payload: Uint8Array) {
			ws?.send(encodeFrame(op, streamId, payload));
		},
		dial(streamId: bigint, addr: string) {
			ws?.send(encodeFrame(OP_DIAL, streamId, new TextEncoder().encode(addr)));
		},
	};
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for: ${what}`);
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("NugRelayClient end-to-end", () => {
	let echo: import("bun").TCPSocketListener;
	let hub: ReturnType<typeof startHub>;
	let client: NugRelayClient;

	beforeEach(() => {
		echo = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					socket.write(data);
				},
			},
		});
		hub = startHub();
		client = new NugRelayClient({
			providerId: "test-provider",
			baseUrl: `http://127.0.0.1:${hub.server.port}`,
			apiKey: "test-key",
			allowedHosts: ["localhost"],
			reconnect: { initialMs: 50, maxMs: 200 },
		});
	});

	afterEach(() => {
		client.stop();
		hub.server.stop(true);
		echo.stop(true);
	});

	test("connects, receives channel id, dials on DIAL, echoes data", async () => {
		client.start();
		await waitFor(() => client.status === "online", "relay online");
		expect(client.currentChannelId).toBe("hub-test-channel");

		hub.dial(1n, `localhost:${echo.port}`);
		await waitFor(() => hub.streams.get(1n)?.dialOk === true, "DIAL_OK");

		hub.send(OP_DATA, 1n, new TextEncoder().encode("ping"));
		await waitFor(
			() => Buffer.concat(hub.streams.get(1n)?.received ?? []).toString() === "ping",
			"echo round trip",
		);
	});

	test("rejects DIAL to a non-allowlisted host", async () => {
		client.start();
		await waitFor(() => client.status === "online", "relay online");

		hub.dial(2n, "evil.internal:22");
		await waitFor(() => hub.streams.get(2n)?.dialErr != null, "DIAL_ERR");
		expect(hub.streams.get(2n)?.dialErr).toContain("allowlist");
	});

	test("flow control: echoing more than one window requires WINDOW_UPDATE", async () => {
		client.start();
		await waitFor(() => client.status === "online", "relay online");
		hub.dial(3n, `localhost:${echo.port}`);
		await waitFor(() => hub.streams.get(3n)?.dialOk === true, "DIAL_OK");

		// Send 3 windows' worth of data hub→client→echo→client→hub. The return
		// leg exceeds the client's initial send window, so completion proves
		// the hub's WINDOW_UPDATE grants are honored.
		const total = INITIAL_STREAM_WINDOW * 3 + 12345;
		const chunk = new Uint8Array(MAX_DATA_PAYLOAD).fill(0x61);
		let sent = 0;
		while (sent < total) {
			const n = Math.min(MAX_DATA_PAYLOAD, total - sent);
			hub.send(OP_DATA, 3n, chunk.subarray(0, n));
			sent += n;
		}
		await waitFor(
			() => {
				const st = hub.streams.get(3n);
				return (st?.received.reduce((acc, b) => acc + b.byteLength, 0) ?? 0) === total;
			},
			"full echo of 3 windows",
			30000,
		);
	});

	test("reconnects after the hub drops the connection", async () => {
		client.start();
		await waitFor(() => client.status === "online", "relay online");
		const firstChannel = client.currentChannelId;
		expect(firstChannel).toBe("hub-test-channel");

		hub.server.stop(true);
		await waitFor(() => client.status !== "online", "offline after drop");

		// Restart the hub on a new port; point the client at it by rebuilding.
		client.stop();
		hub = startHub();
		client = new NugRelayClient({
			providerId: "test-provider",
			baseUrl: `http://127.0.0.1:${hub.server.port}`,
			apiKey: "test-key",
			allowedHosts: ["localhost"],
		});
		client.start();
		await waitFor(() => client.status === "online", "relay re-online");
	});
});
