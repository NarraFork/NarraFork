import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../server/app";
import { db } from "../../server/db";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../../server/db/schema";
import { createServerRequestDispatcher } from "../../server/http-dispatcher";
import { createServerRequestLifecycle } from "../../server/http-request-lifecycle";
import { createToken, verifyToken } from "../../server/lib/auth";
import { eventBus } from "../../server/lib/event-bus";
import { generateId } from "../../server/lib/id";
import { markTrustedRemoteRequest } from "../../server/lib/remote-request-context";
import { createStartupReadinessGate } from "../../server/lib/startup-readiness";
import { createProductionRemoteBackendHarness } from "../../server/services/__tests__/remote-access-harness";
import { authSessionStore } from "../../server/services/auth/store";
import {
	appendLiveCompactDelta,
	finishLiveCompactProgress,
	startLiveCompactProgress,
} from "../../server/services/compact-live-state";
import { type WSData, wsHandlers } from "../../server/websocket/ws-handler";
import { REMOTE_SESSION_INTROSPECT_PATH } from "../../shared/remote-access/ipc";

let harness: ReturnType<typeof createProductionRemoteBackendHarness> | undefined;
const userId = generateId();
beforeAll(async () => {
	await db.insert(users).values({
		id: userId,
		username: `lifecycle_${userId}`,
		passwordHash: "unused",
		role: "admin",
		createdAt: new Date().toISOString(),
	});
});
afterEach(async () => {
	await harness?.stop();
	harness = undefined;
});
async function authorized(
	options: Parameters<typeof createProductionRemoteBackendHarness>[0] = {},
) {
	const h = createProductionRemoteBackendHarness(options);
	harness = h;
	const peer = h.acceptPeer();
	const token = await createToken(userId);
	const bind = await fetch(h.bridge.url + REMOTE_SESSION_INTROSPECT_PATH, {
		method: "POST",
		headers: { ...peer.headers, "content-type": "application/json" },
		body: JSON.stringify({ token }),
	});
	expect(bind.status).toBe(200);
	await bind.arrayBuffer();
	return { h, peer, token, headers: { ...peer.headers, Authorization: `Bearer ${token}` } };
}
async function socketFor(value: Awaited<ReturnType<typeof authorized>>) {
	// The workspace includes lib.dom, whose global constructor hides Bun's documented options overload.
	const NativeSocket = WebSocket as unknown as {
		new (url: string, options: Bun.WebSocketOptions): WebSocket;
	};
	const socket = new NativeSocket(
		`${value.h.bridge.url.replace("http:", "ws:")}/ws/narrator?token=${value.token}`,
		{ headers: value.peer.headers },
	);
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error("WebSocket failed"));
	});
	return socket;
}
test("real native WebSocket upgrade works, non-core protocols are refused before handlers", async () => {
	const value = await authorized();
	const socket = await socketFor(value);
	const message = spyOn(wsHandlers, "message");
	try {
		const closed = new Promise<number>((resolve) => {
			socket.onclose = (event) => resolve(event.code);
		});
		socket.send(JSON.stringify({ type: "outline_page_subscribe", pageId: "blocked" }));
		expect(await closed).toBe(1008);
		expect(message).not.toHaveBeenCalled();
	} finally {
		message.mockRestore();
		socket.close();
	}
});
test("auth-change freeze closes an already-upgraded socket before an awaited storage read", async () => {
	const value = await authorized();
	const socket = await socketFor(value);
	const realRead = authSessionStore.findSessionById.bind(authSessionStore);
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const read = spyOn(authSessionStore, "findSessionById").mockImplementation(async (id) => {
		await barrier;
		return realRead(id);
	});
	const message = spyOn(wsHandlers, "message");
	try {
		eventBus.emit({ type: "auth:changed", userId });
		const closed = new Promise<number>((resolve) => {
			socket.onclose = (event) => resolve(event.code);
		});
		socket.send(JSON.stringify({ type: "subscribe", narratorIds: [] }));
		expect(await closed).toBe(1013);
		expect(message).not.toHaveBeenCalled();
	} finally {
		release();
		read.mockRestore();
		message.mockRestore();
		socket.close();
	}
});
test("a storage outage closes transport without claiming that a valid session expired", async () => {
	const value = await authorized();
	const socket = await socketFor(value);
	const read = spyOn(authSessionStore, "findSessionById").mockRejectedValue(
		new Error("injected_storage_outage"),
	);
	try {
		const closed = new Promise<number>((resolve) => {
			socket.onclose = (event) => resolve(event.code);
		});
		eventBus.emit({ type: "auth:changed", userId });
		expect(await closed).toBe(1013);
		expect(value.h.registry.contexts.size).toBe(0);
	} finally {
		read.mockRestore();
		socket.close();
	}
	// A later reconnect may still use the credential once storage recovers.
	expect((await verifyToken(value.token)).sub).toBe(userId);
});

test("revoking a pairing does not tell the browser that its independent NF session expired", async () => {
	const value = await authorized();
	const socket = await socketFor(value);
	const context = value.h.registry.get(value.peer.contextId, value.peer.contextCapability);
	if (!context) throw new Error("Missing test context");
	const closed = new Promise<number>((resolve) => {
		socket.onclose = (event) => resolve(event.code);
	});
	value.h.registry.revokeGrant(context.peer.grantId);
	expect(await closed).toBe(1008);
	expect((await verifyToken(value.token)).sub).toBe(userId);
});
test("remote dispatcher supplies per-grant identity without trusted local/proxy privileges", async () => {
	const app = new Hono<AppEnv>();
	app.get("/api/probe", (c) => c.json(c.env));
	const lifecycle = createServerRequestLifecycle();
	const readiness = createStartupReadinessGate();
	readiness.settle({ ok: true });
	const dispatch = createServerRequestDispatcher({
		app,
		lifecycle,
		startupReadiness: readiness,
		activeDatabaseBackend: "sqlite",
	});
	const request = new Request("http://localhost/api/probe", {
		headers: { "x-forwarded-for": "127.0.0.1" },
	});
	markTrustedRemoteRequest(request, {
		contextId: "trusted",
		grantId: "grant_one",
		clientIp: "remote-grant:grant_one",
	});
	const response = await dispatch(request, {
		requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }),
		upgrade: () => false,
	});
	expect(await response?.json()).toEqual({
		clientIp: "remote-grant:grant_one",
		trustedProxy: false,
	});
	await lifecycle.drain();
});
test("real compact SSE survives ordinary deadline and grant cancellation drains the full body", async () => {
	const value = await authorized({
		budgets: {
			requestTimeoutMs: 30,
			headerTimeoutMs: 1000,
			idleTimeoutMs: 1000,
			stallTimeoutMs: 1000,
			streamLifetimeMs: 3000,
		},
	});
	const narratorId = generateId();
	const messageId = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: narratorId,
		ownerUserId: userId,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "system",
		contentJson: [{ type: "compact", status: "compacting", summary: "" }],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: 0, isCompact: 0 });
	startLiveCompactProgress(messageId, { model: "test", startedAt: now });
	appendLiveCompactDelta(messageId, "output", "prefix:hello", {
		outputChars: 12,
		thinkingChars: 0,
	});
	try {
		const response = await fetch(
			`${value.h.bridge.url}/api/narrators/${narratorId}/compact/${messageId}/live?outputOffset=7`,
			{ headers: value.headers },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("No SSE body");
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("hello");
		expect(first).not.toContain("prefix:");
		expect(value.h.lifecycle.activeCount).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 80));
		appendLiveCompactDelta(messageId, "output", "still streaming", {
			outputChars: 27,
			thinkingChars: 0,
		});
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("still streaming");
		const context = value.h.registry.contexts.get(value.peer.contextId);
		if (!context) throw new Error("No peer");
		value.h.registry.revokeGrant(context.peer.grantId);
		await reader.read().catch(() => undefined);
		await value.h.lifecycle.drain();
		expect(value.h.lifecycle.activeCount).toBe(0);
	} finally {
		finishLiveCompactProgress(messageId, "failed");
	}
});
test("ordinary Response identity and Bun.file Range/HEAD semantics remain unchanged", async () => {
	const app = new Hono<AppEnv>();
	app.get("/file", () => new Response(Bun.file(import.meta.path)));
	const lifecycle = createServerRequestLifecycle();
	const readiness = createStartupReadinessGate();
	readiness.settle({ ok: true });
	const dispatch = createServerRequestDispatcher({
		app,
		lifecycle,
		startupReadiness: readiness,
		activeDatabaseBackend: "sqlite",
	});
	const server = Bun.serve<WSData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch: dispatch,
		websocket: wsHandlers,
	});
	try {
		const response = await fetch(new URL("/file", server.url), { headers: { Range: "bytes=0-9" } });
		expect(response.status).toBe(206);
		expect((await response.arrayBuffer()).byteLength).toBe(10);
		const head = await fetch(new URL("/file", server.url), { method: "HEAD" });
		expect(head.status).toBe(200);
		expect((await head.arrayBuffer()).byteLength).toBe(0);
		const original = new Response("native");
		expect(
			await lifecycle.track(200, new Request("http://localhost"), Promise.resolve(original)),
		).toBe(original);
	} finally {
		void server.stop(true);
	}
});
test("PostgreSQL refusal reaches both ordinary and private narrator socket entry", async () => {
	const value = await authorized({ backend: "postgres" });
	for (const origin of [value.h.url, value.h.bridge.url]) {
		const response = await fetch(`${origin}/ws/narrator?token=${value.token}`, {
			headers: value.headers,
		});
		expect(response.status).toBe(503);
		expect((await response.json()).code).toBe("POSTGRES_UNSUPPORTED");
	}
});
