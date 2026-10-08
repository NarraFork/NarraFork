import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

type TestServer = ReturnType<typeof Bun.serve>;

/**
 * Regression coverage for the graceful-shutdown stall.
 *
 * Every shutdown was logging `Shutdown step timed out: httpServer.stop` and then
 * `Graceful shutdown degraded — releasing lock without clean marker`, so the clean-shutdown marker
 * was never written and every startup paid for an integrity check + FTS probe.
 *
 * Historical cause: `Bun.Server.stop(true)`'s promise resolved only once Bun's internal
 * `pendingWebSockets` counter drained, but old runtimes did not decrement it when the SERVER closed a socket
 * (`ws.close()` / `ws.terminate()`) — the `close` callback fires, the peer disconnects, and the
 * counter stays stuck for the rest of the process's life. NarraFork closes sockets server-side both
 * at runtime (heartbeat timeout, expired session) and in `closeAllConnections()` during shutdown,
 * so the promise could never settle.
 *
 * Older Bun versions exhibited the counter leak above; the pinned runtime has fixed it.
 * Test the recovered counter/settled promise and the actual listener safety contract rather
 * than requiring a historical runtime defect to remain. Production shutdown still stops
 * accepting requests synchronously without awaiting a promise, protecting older runtimes.
 */

const servers: TestServer[] = [];
const sockets: WebSocket[] = [];

function startServer(): { server: TestServer; live: Set<ServerWebSocket<unknown>> } {
	const live = new Set<ServerWebSocket<unknown>>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, bunServer) {
			if (new URL(request.url).pathname === "/ws") {
				if (bunServer.upgrade(request)) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			return new Response("ok");
		},
		websocket: {
			open(ws) {
				live.add(ws);
			},
			message() {},
			close(ws) {
				live.delete(ws);
			},
		},
	});
	servers.push(server);
	return { server, live };
}

async function connect(server: TestServer): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${boundPort(server)}/ws`);
	sockets.push(ws);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("test WebSocket failed to open"));
	});
	return ws;
}

/**
 * Wait for Bun's pendingWebSockets counter to reach `expected`.
 *
 * The client's `onclose` fires before the server finishes retiring the connection, so the counter
 * is read after a bounded settle window rather than immediately.
 */
async function waitForPendingWebSockets(server: TestServer, expected: number): Promise<number> {
	const deadline = Date.now() + 1000;
	while (server.pendingWebSockets !== expected && Date.now() < deadline) {
		await Bun.sleep(25);
	}
	return server.pendingWebSockets;
}

/** The bound port, asserted non-null so each test can use it directly. */
function boundPort(server: TestServer): number {
	const port = server.port;
	if (port === undefined) throw new Error("test server is not bound to a port");
	return port;
}

/** True when the listener still accepts a plain HTTP request. */
async function isAccepting(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			signal: AbortSignal.timeout(500),
		});
		await response.text().catch(() => {});
		return response.ok;
	} catch {
		return false;
	}
}

afterEach(() => {
	for (const ws of sockets.splice(0)) {
		try {
			ws.close();
		} catch {}
	}
	for (const server of servers.splice(0)) {
		try {
			server.stop(true);
		} catch {}
	}
});

describe("Bun.Server.stop() behaviour that graceful shutdown depends on", () => {
	test("stop(false) releases the port synchronously and preserves the requesting response", async () => {
		let replacement: TestServer | undefined;
		const old = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(_request, server) {
				const port = boundPort(server);
				void Promise.resolve(server.stop(false)).catch(() => {});
				replacement = Bun.serve({
					hostname: "127.0.0.1",
					port,
					fetch: () => new Response("replacement"),
				});
				servers.push(replacement);
				await Bun.sleep(25);
				return Response.json({ port: boundPort(replacement) });
			},
		});
		servers.push(old);
		const port = boundPort(old);
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			signal: AbortSignal.timeout(1000),
		});
		expect(await response.json()).toEqual({ port });
		expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("replacement");
	});
	test("stop(true) stops accepting requests synchronously, before any await", async () => {
		const { server } = startServer();
		const port = boundPort(server);
		expect(await isAccepting(port)).toBe(true);

		// Exactly what shutdown does: call stop and do NOT await its promise.
		void Promise.resolve(server.stop(true)).catch(() => {});

		// The listener must already be closed, which is what makes not awaiting safe: no request
		// can slip in and write to SQLite after the clean marker.
		expect(await isAccepting(port)).toBe(false);
	});

	test("a server-initiated ws.close() drains the counter and permits shutdown", async () => {
		const { server, live } = startServer();
		const ws = await connect(server);
		const closed = new Promise<void>((resolve) => {
			ws.onclose = () => resolve();
		});
		expect(server.pendingWebSockets).toBe(1);

		// closeAllConnections() does this to send peers a 1001 "going away".
		for (const socket of live) socket.close(1001, "server shutting down");
		await closed;

		// The connection is fully gone as far as the application can tell...
		expect(live.size).toBe(0);
		// The repaired runtime must count that close, rather than keeping a ghost socket.
		expect(await waitForPendingWebSockets(server, 0)).toBe(0);

		let settled = false;
		void Promise.resolve(server.stop(true))
			.then(() => {
				settled = true;
			})
			.catch(() => {
				settled = true;
			});
		await Bun.sleep(750);
		expect(settled).toBe(true);
	});

	test("without a server-initiated close, stop()'s promise settles normally", async () => {
		const { server } = startServer();
		const ws = await connect(server);
		const closed = new Promise<void>((resolve) => {
			ws.onclose = () => resolve();
		});
		// Client-initiated close: Bun decrements the counter correctly here.
		ws.close();
		await closed;
		expect(await waitForPendingWebSockets(server, 0)).toBe(0);

		let settled = false;
		void Promise.resolve(server.stop(true))
			.then(() => {
				settled = true;
			})
			.catch(() => {
				settled = true;
			});
		await Bun.sleep(250);
		expect(settled).toBe(true);
	});

	test("the port is rebindable immediately after server-side close and stop(true)", async () => {
		const { server, live } = startServer();
		const port = boundPort(server);
		const ws = await connect(server);
		const closed = new Promise<void>((resolve) => {
			ws.onclose = () => resolve();
		});
		for (const socket of live) socket.close(1001, "server shutting down");
		await closed;
		expect(await waitForPendingWebSockets(server, 0)).toBe(0);

		void Promise.resolve(server.stop(true)).catch(() => {});

		// A host/port restart must rebind without waiting on the stop promise, including
		// on older runtimes where the websocket counter could leak.
		const replacement = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch: () => new Response("replacement"),
		});
		servers.push(replacement);
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			signal: AbortSignal.timeout(1000),
		});
		expect(await response.text()).toBe("replacement");
	});
});
