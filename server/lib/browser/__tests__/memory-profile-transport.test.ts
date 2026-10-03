import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, ConnectionTransport, connect } from "puppeteer-core";
import type WebSocket from "ws";
import type { WebSocketServer as ServerType } from "ws";
// Exercise real RFC6455 fragmentation, not Bun's non-fragmenting ws server shim.
// @ts-expect-error ws has no declaration for its internal concrete implementation.
import ServerImplementation from "../../../../node_modules/ws/lib/websocket-server.js";
import { connectProfileTarget } from "../memory-profile-worker";

const WebSocketServer = ServerImplementation as typeof ServerType;

import { PROFILE_LIMITS } from "../memory-profile-constants";
import { MemoryProfileTransport } from "../memory-profile-transport";

const servers: ServerType[] = [];
const transports: MemoryProfileTransport[] = [];
const httpServers: Server[] = [];
afterEach(async () => {
	for (const transport of transports.splice(0)) transport.close();
	for (const server of servers.splice(0)) {
		for (const client of server.clients) client.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const server of httpServers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
async function endpoint() {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: true });
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function connectFixture() {
	const { server, url } = await endpoint();
	let accepted: (socket: WebSocket) => void = () => {};
	const socket = new Promise<WebSocket>((resolve) => {
		accepted = resolve;
	});
	server.on("connection", (socket) => {
		socket.on("error", () => {});
		accepted(socket);
	});
	const transport = await MemoryProfileTransport.create(url);
	transports.push(transport);
	return { server, transport, socket: await socket };
}
function closed(transport: MemoryProfileTransport): Promise<void> {
	return new Promise((resolve) => {
		transport.onclose = resolve;
	});
}

for (const matches of [true, false]) {
	test(`precise target attachment ${matches ? "succeeds" : "rejects identity mismatch"} using transport only, never closes shared Chrome`, async () => {
		const { server, url } = await endpoint();
		server.on("connection", (socket) => socket.on("error", () => {}));
		const attaches: unknown[] = [];
		let providedTransport: ConnectionTransport | undefined;
		let rootDetached = false;
		let disconnected = false;
		let closedShared = false;
		const target = {
			send: async () => ({
				targetInfo: { targetId: matches ? "precise-target" : "wrong-target", type: "page" },
			}),
		};
		const connection = {
			send: async (method: string, params: unknown) => {
				attaches.push({ method, params });
				return { sessionId: "owned-session" };
			},
			session: (sessionId: string) => {
				expect(sessionId).toBe("owned-session");
				return target;
			},
		};
		const root = {
			connection: () => connection,
			detach: async () => {
				rootDetached = true;
			},
		};
		const fakeBrowser = {
			target: () => ({ createCDPSession: async () => root }),
			disconnect: async () => {
				disconnected = true;
				providedTransport?.close();
			},
			close: async () => {
				closedShared = true;
				throw new Error("shared Chrome cannot be closed");
			},
		} as unknown as Browser;
		const connector: typeof connect = async (options) => {
			expect(options?.browserWSEndpoint).toBeUndefined();
			providedTransport = options?.transport;
			expect(providedTransport).toBeInstanceOf(MemoryProfileTransport);
			return fakeBrowser;
		};
		const pending = connectProfileTarget(
			{
				profileId: "profile",
				wsEndpoint: url,
				targetId: "precise-target",
				dir: "unused",
				maxArtifactsBytes: PROFILE_LIMITS.artifactBytes,
				config: {
					mode: "allocation",
					durationMs: 1000,
					samplingIntervalBytes: PROFILE_LIMITS.defaultSamplingIntervalBytes,
				},
			},
			new AbortController().signal,
			connector,
		);
		if (matches) await (await pending).disconnect();
		else await expect(pending).rejects.toThrow("Memory profile failed (target)");
		expect(attaches).toEqual([
			{ method: "Target.attachToTarget", params: { targetId: "precise-target", flatten: true } },
		]);
		expect(rootDetached).toBe(true);
		expect(disconnected).toBe(true);
		expect(closedShared).toBe(false);
	});
}

describe("pre-parser bounded CDP WebSocket transport", () => {
	test("compression is disabled, plain CDP strings pass through without parsing", async () => {
		const { transport, socket } = await connectFixture();
		expect(socket.extensions).toBe("");
		const received = new Promise<string>((resolve) => {
			transport.onmessage = resolve;
		});
		socket.send('{"method":"not-parsed-by-transport","params":{"text":"中文"}}');
		expect(await received).toBe('{"method":"not-parsed-by-transport","params":{"text":"中文"}}');
		const echoed = new Promise<string>((resolve) => {
			socket.once("message", (data) => resolve(data.toString()));
		});
		transport.send('{"id":1}');
		expect(await echoed).toBe('{"id":1}');
	});

	test("oversized message is rejected before onmessage/JSON.parse with a generic limit stage", async () => {
		const { transport, socket } = await connectFixture();
		let forwarded = 0;
		transport.onmessage = () => {
			forwarded++;
		};
		const disconnected = closed(transport);
		socket.send(Buffer.alloc(PROFILE_LIMITS.messageBytes + 1, 0x78));
		await disconnected;
		expect(forwarded).toBe(0);
		expect(transport.failureStage).toBe("profile_limit");
	}, 10000);

	test("fragmented payload cannot evade the whole-message source limit", async () => {
		const { transport, socket } = await connectFixture();
		let forwarded = 0;
		transport.onmessage = () => {
			forwarded++;
		};
		const disconnected = closed(transport);
		const fragment = Buffer.alloc(PROFILE_LIMITS.messageBytes / 2 + 1, 0x78);
		socket.send(fragment, { fin: false });
		socket.send(fragment, { fin: true });
		await disconnected;
		expect(forwarded).toBe(0);
		expect(transport.failureStage).toBe("profile_limit");
	}, 10000);

	test("oversized outgoing command is bounded and close notification is idempotent", async () => {
		const { transport } = await connectFixture();
		let closes = 0;
		transport.onclose = () => {
			closes++;
		};
		expect(() => transport.send("x".repeat(PROFILE_LIMITS.messageBytes + 1))).toThrow(
			"profile_limit",
		);
		transport.close();
		transport.close();
		await Bun.sleep(10);
		expect(closes).toBe(1);
	});

	test("handshake timeout is bounded, without exposing endpoint or upstream errors", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200);
		});
		httpServers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const start = performance.now();
		await expect(
			MemoryProfileTransport.create(
				`ws://127.0.0.1:${(server.address() as AddressInfo).port}/private-canary`,
				100,
			),
		).rejects.toThrow("Memory profile failed (connect)");
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
