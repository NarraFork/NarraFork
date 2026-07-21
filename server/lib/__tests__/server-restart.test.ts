import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	beginGracefulRestartSession,
	cancelGracefulRestartSession,
	handleGracefullyShutdownRequest,
	registerGracefulShutdownHandler,
	registerRuntimeAddressGetter,
} from "../server-restart";

// registerRuntimeAddressGetter / registerGracefulShutdownHandler mutate shared
// module-level state. Reset both to a known-good state after every test so
// leftover fakes from one test cannot leak into the next.
afterEach(() => {
	registerRuntimeAddressGetter(() => ({ protocol: "http", host: "127.0.0.1", port: 7779 }));
	registerGracefulShutdownHandler(async () => ({
		success: true,
		reason: "test-default",
		pid: process.pid,
		durationMs: 0,
	}));
	cancelGracefulRestartSession();
});

describe("graceful restart session lifecycle", () => {
	test("accepts a valid token and returns the graceful shutdown handler's result", async () => {
		registerRuntimeAddressGetter(() => ({ protocol: "http", host: "127.0.0.1", port: 7779 }));
		const receivedRequests: Array<{ token: string; pid?: number; version?: string }> = [];
		registerGracefulShutdownHandler(async (request) => {
			receivedRequests.push(request);
			return { success: true, reason: "ok", pid: 4242, durationMs: 12 };
		});

		const session = beginGracefulRestartSession();
		const response = await handleGracefullyShutdownRequest({
			token: session.token,
			pid: 4242,
			version: "1.2.3",
		});

		expect(response.ok).toBe(true);
		if (response.ok) {
			expect(response.status).toBe(200);
			expect(response.body).toEqual({ success: true, reason: "ok", pid: 4242, durationMs: 12 });
		}
		expect(receivedRequests).toEqual([{ token: session.token, pid: 4242, version: "1.2.3" }]);

		// A successful shutdown must durably record the marker for the replacement
		// process to discover, keyed by the session's own nonce.
		expect(existsSync(session.markerPath)).toBe(true);
		const marker = JSON.parse(readFileSync(session.markerPath, "utf8"));
		expect(marker).toMatchObject({ nonce: session.markerNonce, pid: 4242, reason: "ok" });

		cancelGracefulRestartSession();
	});

	test("rejects an invalid or stale token without invoking the shutdown handler", async () => {
		registerRuntimeAddressGetter(() => ({ protocol: "http", host: "127.0.0.1", port: 7779 }));
		let handlerCalls = 0;
		registerGracefulShutdownHandler(async () => {
			handlerCalls++;
			return { success: true, reason: "should-not-run", pid: process.pid, durationMs: 0 };
		});

		const session = beginGracefulRestartSession();
		const response = await handleGracefullyShutdownRequest({ token: "wrong-token" });

		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.status).toBe(403);
			expect(response.body.error).toMatch(/Invalid graceful restart token/);
		}
		expect(handlerCalls).toBe(0);
		expect(existsSync(session.markerPath)).toBe(false);

		cancelGracefulRestartSession();
	});

	test("rejects any token when no restart session is pending", async () => {
		cancelGracefulRestartSession();
		const response = await handleGracefullyShutdownRequest({ token: "anything" });

		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.status).toBe(409);
			expect(response.body.error).toMatch(/No graceful restart pending/);
		}
	});

	test("cancelling a session after a spawn failure removes the marker file expectation", () => {
		registerRuntimeAddressGetter(() => ({ protocol: "http", host: "127.0.0.1", port: 7779 }));
		const session = beginGracefulRestartSession();

		// Simulate the replacement process failing to spawn before any shutdown
		// request ever reached the server: no marker should exist yet.
		expect(existsSync(session.markerPath)).toBe(false);
		cancelGracefulRestartSession();

		// The session is retired: a follow-up shutdown attempt using the same
		// (now-invalidated) token must be rejected as if no session exists.
		return handleGracefullyShutdownRequest({ token: session.token }).then((response) => {
			expect(response.ok).toBe(false);
			if (!response.ok) expect(response.status).toBe(409);
		});
	});

	test("cancelling after a marker was written removes the file from disk", async () => {
		registerRuntimeAddressGetter(() => ({ protocol: "http", host: "127.0.0.1", port: 7779 }));
		registerGracefulShutdownHandler(async () => ({
			success: true,
			reason: "ok",
			pid: 999,
			durationMs: 1,
		}));
		const session = beginGracefulRestartSession();
		await handleGracefullyShutdownRequest({ token: session.token });
		expect(existsSync(session.markerPath)).toBe(true);

		// Even after the marker was durably written, an explicit cancel (e.g. the
		// replacement process later failed a post-spawn health check) must clean it up.
		cancelGracefulRestartSession();
		expect(existsSync(session.markerPath)).toBe(false);
	});

	test("concurrent shutdown requests share one in-flight call to the handler", async () => {
		registerRuntimeAddressGetter(() => ({ protocol: "http", host: "127.0.0.1", port: 7779 }));
		let handlerCalls = 0;
		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
		registerGracefulShutdownHandler(async () => {
			handlerCalls++;
			await gate;
			return { success: true, reason: "shared", pid: 1, durationMs: 5 };
		});

		const session = beginGracefulRestartSession();
		const first = handleGracefullyShutdownRequest({ token: session.token });
		const second = handleGracefullyShutdownRequest({ token: session.token });
		releaseGate();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(handlerCalls).toBe(1);
		expect(firstResult).toEqual(secondResult);

		cancelGracefulRestartSession();
	});
});
