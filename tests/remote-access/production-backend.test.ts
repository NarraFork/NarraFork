import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TOTP } from "otpauth";
import { db } from "../../server/db";
import { authSessions, users } from "../../server/db/schema";
import { createToken, verifyToken } from "../../server/lib/auth";
import { eventBus } from "../../server/lib/event-bus";
import { generateId } from "../../server/lib/id";
import {
	DEFAULT_REMOTE_ACCESS,
	remoteAccessSettingsSchema,
} from "../../server/lib/remote-access-config";
import { settings } from "../../server/lib/settings";
import { createProductionRemoteBackendHarness } from "../../server/services/__tests__/remote-access-harness";
import { authSessionStore } from "../../server/services/auth/store";
import { mfaService } from "../../server/services/mfa-service";
import {
	REMOTE_BRIDGE_HEADERS,
	REMOTE_SESSION_INTROSPECT_PATH,
} from "../../shared/remote-access/ipc";
import {
	canonicalRemotePath,
	resolveRemoteRequestRule,
} from "../../shared/remote-access/request-policy";

let adminId: string;
let memberId: string;
let adminName: string;
let harness: ReturnType<typeof createProductionRemoteBackendHarness> | undefined;
const password = "Remote-isolated-password-42";
beforeAll(async () => {
	adminId = generateId();
	memberId = generateId();
	adminName = `remote_${generateId()}`;
	const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });
	await db.insert(users).values([
		{
			id: adminId,
			username: adminName,
			passwordHash,
			createdAt: new Date().toISOString(),
			role: "admin",
		},
		{
			id: memberId,
			username: `member_${memberId}`,
			passwordHash,
			createdAt: new Date().toISOString(),
			role: "user",
		},
	]);
});
afterEach(async () => {
	await harness?.stop();
	harness = undefined;
});
function start(options: Parameters<typeof createProductionRemoteBackendHarness>[0] = {}) {
	harness = createProductionRemoteBackendHarness(options);
	return harness;
}
function request(
	h: ReturnType<typeof start>,
	peer: ReturnType<ReturnType<typeof start>["acceptPeer"]>,
	path: string,
	init: RequestInit = {},
) {
	return fetch(h.bridge.url + path, {
		...init,
		headers: { ...peer.headers, ...init.headers },
		redirect: "manual",
	});
}
async function bind(
	h: ReturnType<typeof start>,
	peer: ReturnType<ReturnType<typeof start>["acceptPeer"]>,
	token: string,
) {
	return request(h, peer, REMOTE_SESSION_INTROSPECT_PATH, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token }),
	});
}

describe("production backend: real app, dispatcher, bridge and opaque sessions", () => {
	test("default off, strict non-secret config, ordinary status performs no fetch/spawn", async () => {
		expect(settings.remoteAccess?.enabled).toBe(false);
		expect(
			remoteAccessSettingsSchema.safeParse({ ...DEFAULT_REMOTE_ACCESS, statePath: "/etc/private" })
				.success,
		).toBe(false);
		expect(
			remoteAccessSettingsSchema.safeParse({
				...DEFAULT_REMOTE_ACCESS,
				enabled: true,
				signalUrl: "http://evil",
			}).success,
		).toBe(false);
		const h = start();
		const token = await createToken(adminId);
		const fetchSpy = spyOn(globalThis, "fetch");
		const spawn = spyOn(Bun, "spawn");
		try {
			const response = await h.app.request("/api/remote-access/status", {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				enabled: false,
				state: "disabled",
				installed: false,
				peers: 0,
			});
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			spawn.mockRestore();
		}
	});
	test("real password login, no authentication before pairing ACK, admin introspection", async () => {
		const h = start();
		const peer = h.acceptPeer();
		const denied = await fetch(`${h.bridge.url}/api/auth/login`, { method: "POST", body: "{}" });
		expect(denied.status).toBe(403);
		const login = await request(h, peer, "/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: adminName, password }),
		});
		expect(login.status).toBe(200);
		const data = await login.json();
		expect(data.token.startsWith("nfs_")).toBe(true);
		const projection = await bind(h, peer, data.token);
		expect(projection.status).toBe(200);
		expect(await projection.json()).toMatchObject({ userId: adminId, role: "admin" });
		const me = await request(h, peer, "/api/auth/me", {
			headers: { Authorization: `Bearer ${data.token}` },
		});
		expect(me.status).toBe(200);
	});
	test("real MFA requires second factor and consumes backup code", async () => {
		const h = start();
		const peer = h.acceptPeer();
		const setup = await mfaService.beginSetup(adminId);
		if (!("secret" in setup)) throw new Error("Unexpected existing MFA");
		const code = new TOTP({
			secret: setup.secret,
			algorithm: "SHA1",
			digits: 6,
			period: 30,
		}).generate();
		const activation = await mfaService.activate(adminId, code);
		if (!activation.ok) throw new Error("MFA enrollment failed");
		await mfaService.setMfaEnabled(adminId, true);
		try {
			const login = await request(h, peer, "/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: adminName, password }),
			});
			const challenge = await login.json();
			expect(challenge.mfaRequired).toBe(true);
			expect(challenge.token).toBeUndefined();
			const body = JSON.stringify({
				mfaToken: challenge.mfaToken,
				method: "backup_code",
				code: activation.backupCodes[0],
			});
			const verified = await request(h, peer, "/api/auth/mfa/verify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(verified.status).toBe(200);
			const session = await verified.json();
			expect((await bind(h, peer, session.token)).status).toBe(200);
			const replay = await request(h, peer, "/api/auth/mfa/verify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(replay.status).toBe(401);
		} finally {
			await mfaService.disable(adminId);
			await mfaService.setMfaEnabled(adminId, false);
		}
	}, 15_000);
	test("non-admin session and non-admin ordinary management fail closed", async () => {
		const h = start();
		const peer = h.acceptPeer();
		const token = await createToken(memberId);
		expect((await bind(h, peer, token)).status).toBe(403);
		expect(
			(
				await fetch(`${h.url}/api/remote-access/status`, {
					headers: { Authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(403);
		expect(
			(await request(h, peer, "/api/projects", { headers: { Authorization: `Bearer ${token}` } }))
				.status,
		).toBe(403);
	});
	test("private introspection never renews; successful ordinary business renewal notifies peer", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const h = start({ notify: (type, payload) => events.push({ type, payload }) });
		const peer = h.acceptPeer();
		const token = await createToken(adminId);
		const payload = await verifyToken(token);
		const expiresAt = Math.floor(Date.now() / 1000) + 1800;
		await db
			.update(authSessions)
			.set({ expiresAt })
			.where(eq(authSessions.id, payload.sid ?? ""));
		for (let n = 0; n < 2; n++) {
			const response = await bind(h, peer, token);
			expect((await response.json()).expiresAt).toBe(expiresAt);
		}
		expect((await verifyToken(token)).exp).toBe(expiresAt);
		const me = await request(h, peer, "/api/auth/me", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(me.status).toBe(200);
		await me.arrayBuffer();
		expect((await verifyToken(token)).exp).toBeGreaterThan(expiresAt);
		await Promise.resolve();
		expect(
			events.some(
				(event) =>
					event.type === "session.updated" &&
					Number((event.payload.session as { expiresAt?: number })?.expiresAt) > expiresAt,
			),
		).toBe(true);
	});
	test("logout freezes immediately and invalidates only the matching sid", async () => {
		const h = start();
		const peerA = h.acceptPeer();
		const peerB = h.acceptPeer();
		const tokenA = await createToken(adminId);
		const tokenB = await createToken(adminId);
		await bind(h, peerA, tokenA);
		await bind(h, peerB, tokenB);
		await request(h, peerA, "/api/auth/logout", {
			method: "POST",
			headers: { Authorization: `Bearer ${tokenA}` },
		}).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.registry.contexts.has(peerA.contextId)).toBe(false);
		expect(h.registry.contexts.has(peerB.contextId)).toBe(true);
		expect(
			(await request(h, peerB, "/api/auth/me", { headers: { Authorization: `Bearer ${tokenB}` } }))
				.status,
		).toBe(200);
	});
	test("expired sessions do not bind, demotion immediately freezes then removes context", async () => {
		const h = start();
		const peer = h.acceptPeer();
		const token = await createToken(adminId);
		const session = await verifyToken(token);
		await db
			.update(authSessions)
			.set({ expiresAt: Math.floor(Date.now() / 1000) - 1 })
			.where(eq(authSessions.id, session.sid ?? ""));
		expect((await bind(h, peer, token)).status).toBe(401);
		const live = await createToken(adminId);
		await bind(h, peer, live);
		await db.update(users).set({ role: "user" }).where(eq(users.id, adminId));
		try {
			eventBus.emit({ type: "auth:changed", userId: adminId });
			expect(h.registry.contexts.get(peer.contextId)?.frozen).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(h.registry.contexts.has(peer.contextId)).toBe(false);
		} finally {
			await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
		}
	});
	test("old epoch, bad process/context capabilities and public spoofing cannot enter", async () => {
		const h = start();
		const peer = h.acceptPeer();
		const token = await createToken(adminId);
		for (const key of Object.values(REMOTE_BRIDGE_HEADERS)) {
			const response = await request(h, peer, REMOTE_SESSION_INTROSPECT_PATH, {
				method: "POST",
				headers: { [key]: "wrong", "content-type": "application/json" },
				body: JSON.stringify({ token }),
			});
			expect(response.status).toBe(403);
		}
		const response = await fetch(h.url + REMOTE_SESSION_INTROSPECT_PATH, {
			method: "POST",
			headers: peer.headers,
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(404);
	});
	test("storage faults are 503, not credential invalidation", async () => {
		const events: string[] = [];
		const h = start({ notify: (type) => events.push(type) });
		const peer = h.acceptPeer();
		const token = await createToken(adminId);
		const read = spyOn(authSessionStore, "findSessionByTokenHash").mockRejectedValue(
			new Error("database unavailable"),
		);
		try {
			expect((await bind(h, peer, token)).status).toBe(503);
			expect(events).not.toContain("session.invalidated");
		} finally {
			read.mockRestore();
		}
		expect((await bind(h, peer, token)).status).toBe(200);
	});
	test("grant revocation closes the context and keeps other grants", async () => {
		const h = start();
		const a = h.acceptPeer();
		const b = h.acceptPeer();
		const context = h.registry.contexts.get(a.contextId);
		if (!context) throw new Error();
		h.registry.revokeGrant(context.peer.grantId);
		expect(context.controller.signal.aborted).toBe(true);
		expect(h.registry.contexts.has(b.contextId)).toBe(true);
		expect((await request(h, a, "/api/auth/login", { method: "POST", body: "{}" })).status).toBe(
			403,
		);
	});
	test("allowlist checks methods, phase, canonical spelling and excludes dangerous namespaces", async () => {
		const h = start();
		const peer = h.acceptPeer();
		const token = await createToken(adminId);
		await bind(h, peer, token);
		for (const path of [
			"/api/remote-access/status",
			"/api/gracefully_shutdown",
			"/api/update",
			"/api/fs/read",
			"/api/devices",
			"/ws/device",
			"/ws/terminal",
			"/api/outline",
			"/api/narrators/workspace-devices",
			"/api/narrators/workspace-directory-browse",
			"/api/narrators/setup-assistant",
			"/api/narrators/named",
			"/api/narrators/questions",
			"/api/narrators/human-attention",
			"/api/narrators/broken-models",
			"/api/projects/hidden-existence",
		]) {
			expect(resolveRemoteRequestRule("GET", path, "ready")).toBeNull();
			expect(
				(await request(h, peer, path, { headers: { Authorization: `Bearer ${token}` } })).status,
			).toBe(403);
		}
		expect(resolveRemoteRequestRule("PATCH", "/api/settings", "ready")).toBeNull();
		expect(resolveRemoteRequestRule("GET", "/api/settings", "paired")).toBeNull();
		for (const path of ["/api/%73ettings", "/api/../settings", "//api/settings", "/api//settings"])
			expect(canonicalRemotePath(path)).toBeNull();
		expect(
			resolveRemoteRequestRule("GET", "/api/model-catalog/card?model=provider%3Amodel", "ready"),
		).not.toBeNull();
	});
	test("readiness and shutdown are shared; PostgreSQL WS remains refused", async () => {
		const h = start({ ready: false });
		const peer = h.acceptPeer();
		let settled = false;
		const pending = request(h, peer, "/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}).then((response) => {
			settled = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		h.lifecycle.stopAccepting();
		h.readiness.settle({ ok: true });
		expect((await pending).status).toBe(503);
	});
});
