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
 * Cause: `Bun.Server.stop(true)`'s promise resolves only once Bun's internal `pendingWebSockets`
 * counter drains, but the counter is not decremented when the SERVER closes a socket
 * (`ws.close()` / `ws.terminate()`) — the `close` callback fires, the peer disconnects, and the
 * counter stays stuck for the rest of the process's life. NarraFork closes sockets server-side both
 * at runtime (heartbeat timeout, expired session) and in `closeAllConnections()` during shutdown,
 * so the promise could never settle.
 *
 * These tests pin the two Bun behaviours the fix relies on. If a future Bun release fixes the
 * counter leak, `stopPromiseStillPending` starts failing — at which point awaiting the promise
 * becomes safe again and this file should be revisited.
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

	test("a server-initiated ws.close() leaves stop()'s promise pending forever", async () => {
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
		// ...yet Bun's counter never drops, even given the same settle window that a
		// client-initiated close needs, which is why stop()'s promise cannot settle.
		expect(await waitForPendingWebSockets(server, 0)).toBe(1);

		let settled = false;
		void Promise.resolve(server.stop(true))
			.then(() => {
				settled = true;
			})
			.catch(() => {
				settled = true;
			});
		await Bun.sleep(750);
		expect(settled).toBe(false);
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

	test("the port is rebindable after stop(true) even with the counter leaked", async () => {
		const { server, live } = startServer();
		const port = boundPort(server);
		const ws = await connect(server);
		const closed = new Promise<void>((resolve) => {
			ws.onclose = () => resolve();
		});
		for (const socket of live) socket.close(1001, "server shutting down");
		await closed;
		expect(server.pendingWebSockets).toBe(1);

		void Promise.resolve(server.stop(true)).catch(() => {});

		// The settings-driven host/port restart rebinds immediately after stopping; that has to work
		// despite the leaked counter, otherwise the server would be left with no listener at all.
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
