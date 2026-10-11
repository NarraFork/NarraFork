import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { SESSION_VERSION_CLAIM } from "@shared/session-auth";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { sqlite as isolatedTemplate } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import type { AuthPrincipal } from "../middleware/auth";
import {
	remoteEditorSessionProvenance,
	remoteRecoveryProvenance,
} from "../middleware/remote-recovery-provenance";
import { EditorDocumentJobs } from "./editor-document-jobs";
import {
	assertRemoteEditorSessionOrigin,
	currentRemoteEditorSessionOrigin,
	currentRemoteRecoveryAuthProvenance,
	type RemoteEditorSessionOrigin,
	requireRemoteEditorSessionOrigin,
} from "./remote-history-recovery-auth";
import {
	checkWindowsEditorSession,
	preflightWindowsEditorMetadata,
	WINDOWS_EDITOR_METADATA_BLOCKERS,
} from "./windows-editor-metadata-preflight";

// Actual middleware/ALS/WeakMap and isolated DB; not JWT verification or native readiness.
let sqlite: Database;
let db: ReturnType<typeof database>;
function database(client: Database) {
	return drizzle({ client, schema: { ...schema, ...relations } });
}
function principal(userId = "alice"): AuthPrincipal {
	const now = Math.floor(Date.now() / 1000);
	return {
		type: "session",
		user: { sub: userId, role: "admin", iat: now, exp: now + 3600, [SESSION_VERSION_CLAIM]: 7 },
	};
}
beforeEach(() => {
	sqlite = new Database(":memory:");
	const definition = isolatedTemplate
		.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='users' AND type='table'")
		.get();
	if (!definition) throw new Error("Isolated user schema missing");
	sqlite.exec(definition.sql);
	db = database(sqlite);
	db.insert(schema.users)
		.values({
			id: "alice",
			username: "alice",
			passwordHash: "not-a-credential",
			tokenVersion: 7,
			role: "user",
			createdAt: new Date().toISOString(),
		})
		.run();
});
afterEach(() => sqlite.close());
function app(auth: AuthPrincipal | undefined, editor = true) {
	const application = new Hono();
	application.use("*", async (c, next) => {
		if (auth) {
			c.set("auth", auth);
			c.set("user", auth.user);
		}
		await next();
	});
	application.use("*", editor ? remoteEditorSessionProvenance : remoteRecoveryProvenance);
	return application;
}
const registry = () => ({ options: { db } });
const signal = () => new AbortController().signal;
function latch() {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
/** Both requests traverse actual middleware and the real same-user IO queue. */
function queuedRequests(
	authA: AuthPrincipal,
	authB: AuthPrincipal,
	bodyB: (
		expected: RemoteEditorSessionOrigin | undefined,
		provenance: ReturnType<typeof currentRemoteRecoveryAuthProvenance>,
	) => Promise<void>,
	detached = false,
) {
	const jobs = new EditorDocumentJobs();
	const marker = new AsyncLocalStorage<string>();
	const application = new Hono();
	application.use("*", (c, next) => marker.run(c.req.path, next));
	const occupied = latch(),
		releaseA = latch(),
		submitted = latch();
	let queued: Promise<void> | undefined;
	application.use("*", async (c, next) => {
		const auth = c.req.path === "/a" ? authA : authB;
		c.set("auth", auth);
		c.set("user", auth.user);
		await next();
	});
	application.use("*", remoteEditorSessionProvenance);
	application.get("/a", async (c) => {
		await jobs.withIo(authA.user.sub, async () => {
			occupied.release();
			await releaseA.promise;
		});
		return c.json({ okay: true });
	});
	application.get("/b", async (c) => {
		const expected = currentRemoteEditorSessionOrigin(authB.user.sub);
		const provenance = currentRemoteRecoveryAuthProvenance(authB.user.sub);
		queued = jobs.withIo(authB.user.sub, async () => bodyB(expected, provenance));
		// Observe rejection before a deliberately detached request exits.
		void queued.catch(() => {});
		submitted.release();
		if (!detached) await queued;
		return c.json({ okay: true });
	});
	return { application, occupied, releaseA, submitted, marker, completion: () => queued };
}

test("editor boundary supplies one stable ref; role is fresh and expiry is original", async () => {
	const auth = principal();
	const application = app(auth);
	let retained: RemoteEditorSessionOrigin | undefined;
	application.get("/", async (c) => {
		const first = requireRemoteEditorSessionOrigin("alice");
		retained = first;
		await Promise.resolve();
		expect(currentRemoteEditorSessionOrigin("alice")).toBe(first);
		expect(currentRemoteEditorSessionOrigin("bob")).toBeUndefined();
		const fresh = assertRemoteEditorSessionOrigin(registry(), first, "alice", signal());
		expect(fresh.isAdmin).toBe(false);
		const expiry = fresh.expiresAtSeconds;
		auth.user.exp += 86400;
		expect(
			assertRemoteEditorSessionOrigin(registry(), first, "alice", signal()).expiresAtSeconds,
		).toBe(expiry);
		expect(() =>
			assertRemoteEditorSessionOrigin(registry(), { ...first }, "alice", signal()),
		).toThrow("INVALID");
		expect(() =>
			assertRemoteEditorSessionOrigin(
				registry(),
				currentRemoteRecoveryAuthProvenance("alice"),
				"alice",
				signal(),
			),
		).toThrow("INVALID");
		return c.json({ origin: first, provenance: currentRemoteRecoveryAuthProvenance("alice") });
	});
	const response = await application.request("/", {
		headers: { authorization: "Bearer do-not-persist" },
	});
	expect(await response.json()).not.toHaveProperty("credentialRef");
	expect(currentRemoteEditorSessionOrigin("alice")).toBeUndefined();
	expect(() => assertRemoteEditorSessionOrigin(registry(), retained, "alice", signal())).toThrow(
		"INVALID",
	);
});

test("missing auth, bare users and client provenance never exchange into refs", async () => {
	const application = app(undefined);
	application.post("/", (c) => {
		expect(() => requireRemoteEditorSessionOrigin("alice")).toThrow("MISSING");
		return c.json({ origin: currentRemoteEditorSessionOrigin("alice") ?? null });
	});
	const response = await application.request("/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ userId: "alice", auth: principal(), origin: {} }),
	});
	expect(await response.json()).toEqual({ origin: null });
});

test("general recovery provenance cannot mint an editor ref", async () => {
	const application = app(principal(), false);
	application.get("/", (c) => {
		expect(currentRemoteRecoveryAuthProvenance("alice")?.authentication).toBe("session");
		expect(() => requireRemoteEditorSessionOrigin("alice")).toThrow("MISSING");
		return c.json({ okay: true });
	});
	expect((await application.request("/")).status).toBe(200);
});

test("OAuth stays unsupported for metadata origin, not silently promoted to session", async () => {
	const session = principal();
	const oauth: AuthPrincipal = {
		type: "oauth",
		user: session.user,
		oauth: {
			tokenId: "token",
			clientId: "client",
			oauthClientId: "client",
			grantId: "grant",
			refreshFamilyId: "family",
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
			scopes: ["narrators:write"],
		},
	};
	const application = app(oauth);
	application.get("/", (c) => {
		expect(() => requireRemoteEditorSessionOrigin("alice")).toThrow("UNSUPPORTED");
		expect(currentRemoteRecoveryAuthProvenance("alice")?.authentication).toBe("oauth");
		return c.json({ okay: true });
	});
	expect((await application.request("/")).status).toBe(200);
});

test("parallel same-user requests cannot borrow each other's genuine ref", async () => {
	const application = app(principal());
	let other: RemoteEditorSessionOrigin | undefined;
	let release: () => void = () => {};
	const first = new Promise<void>((resolve) => {
		release = resolve;
	});
	let finish: () => void = () => {};
	const second = new Promise<void>((resolve) => {
		finish = resolve;
	});
	application.get("/first", async (c) => {
		other = requireRemoteEditorSessionOrigin("alice");
		release();
		await second;
		return c.json({ okay: true });
	});
	application.get("/second", async (c) => {
		await first;
		expect(requireRemoteEditorSessionOrigin("alice")).not.toBe(other);
		expect(() => assertRemoteEditorSessionOrigin(registry(), other, "alice", signal())).toThrow(
			"INVALID",
		);
		finish();
		return c.json({ okay: true });
	});
	expect(
		(await Promise.all([application.request("/first"), application.request("/second")])).map(
			(response) => response.status,
		),
	).toEqual([200, 200]);
});

test("actual same-user queue restores B origin/expiry, recovery snapshot and unrelated ALS", async () => {
	const a = principal(),
		b = principal();
	b.user.iat -= 20;
	b.user.exp += 120;
	const queued = queuedRequests(a, b, async (expected, provenance) => {
		expect(expected).toBeDefined();
		expect(currentRemoteEditorSessionOrigin("alice")).toBe(expected);
		expect(currentRemoteRecoveryAuthProvenance("alice")).toEqual(provenance);
		expect(provenance?.expiresAtSeconds).toBe(b.user.exp);
		expect(
			assertRemoteEditorSessionOrigin(registry(), expected, "alice", signal()).expiresAtSeconds,
		).toBe(b.user.exp);
		expect(queued.marker.getStore()).toBe("/b");
	});
	const first = queued.application.request("/a");
	await queued.occupied.promise;
	const second = queued.application.request("/b");
	await queued.submitted.promise;
	queued.releaseA.release();
	expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([
		200, 200,
	]);
});

test("session task followed by queued OAuth never promotes B into A's session", async () => {
	const a = principal(),
		session = principal();
	const b: AuthPrincipal = {
		type: "oauth",
		user: session.user,
		oauth: {
			tokenId: "queued-token",
			clientId: "client",
			oauthClientId: "client",
			grantId: "grant",
			refreshFamilyId: "family",
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
			scopes: ["narrators:write"],
		},
	};
	const queued = queuedRequests(a, b, async (expected, provenance) => {
		expect(expected).toBeUndefined();
		expect(() => requireRemoteEditorSessionOrigin("alice")).toThrow("UNSUPPORTED");
		expect(currentRemoteRecoveryAuthProvenance("alice")).toEqual(provenance);
		expect(provenance?.authentication).toBe("oauth");
	});
	const first = queued.application.request("/a");
	await queued.occupied.promise;
	const second = queued.application.request("/b");
	await queued.submitted.promise;
	queued.releaseA.release();
	expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([
		200, 200,
	]);
});

test("B's session expires in the actual queue without borrowing A expiry", async () => {
	const a = principal(),
		b = principal();
	b.user.exp = Math.floor(Date.now() / 1000) + 60;
	const queued = queuedRequests(a, b, async (expected) => {
		expect(currentRemoteEditorSessionOrigin("alice")).toBe(expected);
		expect(() => assertRemoteEditorSessionOrigin(registry(), expected, "alice", signal())).toThrow(
			"EXPIRED",
		);
	});
	const first = queued.application.request("/a");
	await queued.occupied.promise;
	const second = queued.application.request("/b");
	await queued.submitted.promise;
	const advanced = Date.now() + 120000;
	const clock = spyOn(Date, "now").mockReturnValue(advanced);
	try {
		queued.releaseA.release();
		expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([
			200, 200,
		]);
	} finally {
		clock.mockRestore();
	}
});

test("captured queue snapshot does not keep an ended HTTP origin alive", async () => {
	const queued = queuedRequests(
		principal(),
		principal(),
		async (expected) => {
			expect(expected).toBeDefined();
			expect(currentRemoteEditorSessionOrigin("alice")).toBeUndefined();
			expect(() =>
				assertRemoteEditorSessionOrigin(registry(), expected, "alice", signal()),
			).toThrow("INVALID");
		},
		true,
	);
	const first = queued.application.request("/a");
	await queued.occupied.promise;
	const second = await queued.application.request("/b");
	expect(second.status).toBe(200);
	queued.releaseA.release();
	await first;
	await queued.completion();
});

test("session expiry, token version revocation and user removal are fresh denials", async () => {
	for (const reason of ["expiry", "token", "user"] as const) {
		const auth = principal();
		if (reason === "expiry") auth.user.exp = Math.floor(Date.now() / 1000) - 1;
		const application = app(auth);
		application.get("/", (c) => {
			const origin = requireRemoteEditorSessionOrigin("alice");
			if (reason === "token")
				db.update(schema.users).set({ tokenVersion: 8 }).where(eq(schema.users.id, "alice")).run();
			if (reason === "user") db.delete(schema.users).where(eq(schema.users.id, "alice")).run();
			expect(() => assertRemoteEditorSessionOrigin(registry(), origin, "alice", signal())).toThrow(
				reason === "expiry" ? "EXPIRED" : reason === "token" ? "REVOKED" : "UNAVAILABLE",
			);
			return c.json({ okay: true });
		});
		expect((await application.request("/")).status).toBe(200);
		if (reason === "token")
			db.update(schema.users).set({ tokenVersion: 7 }).where(eq(schema.users.id, "alice")).run();
	}
});

test("fresh genuine session still receives explicit fixed missing-chain reasons", async () => {
	const application = app(principal());
	let authorized = 0;
	application.get("/", async (c) => {
		try {
			await preflightWindowsEditorMetadata({
				registry: registry(),
				userId: "alice",
				phase: "source",
				signal: signal(),
				assertCurrent() {},
				async authorize() {
					authorized++;
				},
			});
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(error.message).not.toContain("Bearer");
			expect(error).toHaveProperty("data.blockers", WINDOWS_EDITOR_METADATA_BLOCKERS);
			return c.json({ rejected: true });
		}
		throw new Error("Fixed production preflight unexpectedly allowed capture");
	});
	expect((await application.request("/")).status).toBe(200);
	expect(authorized).toBe(1);
});

test("origin snapshot exceeding 32KiB is rejected before the handler can read a ref", async () => {
	const oversized = principal("x".repeat(33 * 1024));
	const application = app(oversized);
	let entered = false;
	application.onError((error, c) => c.json({ reason: error.message }, 400));
	application.get("/", (c) => {
		entered = true;
		return c.json({ okay: true });
	});
	const response = await application.request("/");
	expect(await response.json()).toEqual({ reason: "EDITOR_SESSION_ORIGIN_INVALID" });
	expect(entered).toBe(false);
});

test("token revocation inside resource authorization fails the second fresh check", async () => {
	const application = app(principal());
	application.get("/", async (c) => {
		await expect(
			checkWindowsEditorSession({
				registry: registry(),
				userId: "alice",
				phase: "save",
				signal: signal(),
				assertCurrent() {},
				async authorize() {
					db.update(schema.users)
						.set({ tokenVersion: 8 })
						.where(eq(schema.users.id, "alice"))
						.run();
				},
			}),
		).rejects.toMatchObject({
			code: "EDITOR_SESSION_ORIGIN_REVOKED",
			data: { reason: "EDITOR_SESSION_ORIGIN_REVOKED" },
		});
		return c.json({ okay: true });
	});
	expect((await application.request("/")).status).toBe(200);
});

test("hung fresh resource check has a hard five-second wait and no late success", async () => {
	const application = app(principal());
	application.get("/", async (c) => {
		let release: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let accepted = false;
		const checked = checkWindowsEditorSession({
			registry: registry(),
			userId: "alice",
			phase: "save",
			signal: signal(),
			assertCurrent() {},
			async authorize() {
				await waiting;
			},
		}).then(() => {
			accepted = true;
		});
		await expect(checked).rejects.toThrow();
		release();
		await Promise.resolve();
		await Promise.resolve();
		expect(accepted).toBe(false);
		return c.json({ okay: true });
	});
	expect((await application.request("/")).status).toBe(200);
}, 10000);

test("cancellation cannot let a late resource authorization reach fresh success", async () => {
	const application = app(principal());
	application.get("/", async (c) => {
		const controller = new AbortController();
		let release: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const checked = checkWindowsEditorSession({
			registry: registry(),
			userId: "alice",
			phase: "save",
			signal: controller.signal,
			assertCurrent() {},
			async authorize() {
				controller.abort(new Error("Original request cancelled"));
				await waiting;
			},
		});
		await expect(checked).rejects.toThrow("cancelled");
		release();
		await Promise.resolve();
		return c.json({ okay: true });
	});
	expect((await application.request("/")).status).toBe(200);
});
