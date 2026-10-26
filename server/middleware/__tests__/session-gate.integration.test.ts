import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The session gate through the real app: sliding renewal, the absolute ceiling, logout,
 * token-generation revocation and rejected credentials, observed exactly as a browser
 * would see them (middleware order, Hono response construction and the global error
 * handler all included).
 *
 * NARRAFORK_HOME is redirected to a temp directory before the app is imported so
 * this never touches the developer's real database or settings.
 */
const previousHome = process.env.NARRAFORK_HOME;
const previousAllowMultiple = process.env.NARRAFORK_ALLOW_MULTIPLE;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-session-gate-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const [
	{ app },
	{ db },
	{ authSessions, users },
	{ eq },
	{ sign },
	{ generateId },
	{ settings },
	{ ABSOLUTE_SESSION_MAX_SECONDS, SESSION_RENEWAL_THRESHOLD_SECONDS, SESSION_TOKEN_TTL_SECONDS },
	{ createToken, revokeUserSessions, verifyToken },
	{ hashSessionToken },
	{ authSessionStore },
	{ isSessionInvalidResponse },
] = await Promise.all([
	import("../../app"),
	import("../../db"),
	import("../../db/schema"),
	import("drizzle-orm"),
	import("hono/jwt"),
	import("../../lib/id"),
	import("../../lib/settings"),
	import("@shared/session-auth"),
	import("../../lib/auth"),
	import("../../lib/session-token-hash"),
	import("../../services/auth/store"),
	import("@shared/session-auth"),
]);

const USERNAME = "session-gate-user";
let userId = "";

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function authGet(path: string, token: string): Promise<Response> {
	return await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

async function setSession(
	token: string,
	values: Partial<typeof authSessions.$inferInsert>,
): Promise<void> {
	await db
		.update(authSessions)
		.set(values)
		.where(eq(authSessions.tokenHash, hashSessionToken(token)));
}

async function sessionOf(token: string) {
	const [row] = await db
		.select()
		.from(authSessions)
		.where(eq(authSessions.tokenHash, hashSessionToken(token)));
	return row;
}

beforeAll(async () => {
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: USERNAME,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: new Date().toISOString(),
	});
});

beforeEach(async () => {
	await db.update(users).set({ role: "user", tokenVersion: 0 }).where(eq(users.id, userId));
});

afterAll(async () => {
	await db.delete(users).where(eq(users.id, userId));
	if (previousHome === undefined) {
		delete process.env.NARRAFORK_HOME;
	} else {
		process.env.NARRAFORK_HOME = previousHome;
	}
	if (previousAllowMultiple === undefined) {
		delete process.env.NARRAFORK_ALLOW_MULTIPLE;
	} else {
		process.env.NARRAFORK_ALLOW_MULTIPLE = previousAllowMultiple;
	}
	rmSync(testHome, { recursive: true, force: true });
});

describe("sliding renewal", () => {
	test("extends a session inside the renewal window without changing the token", async () => {
		const token = await createToken(userId);
		await setSession(token, {
			expiresAt: nowSeconds() + SESSION_RENEWAL_THRESHOLD_SECONDS - 3600,
		});

		expect((await authGet("/api/auth/me", token)).status).toBe(200);
		expect((await sessionOf(token)).expiresAt - nowSeconds()).toBeGreaterThan(
			SESSION_RENEWAL_THRESHOLD_SECONDS,
		);
	});

	test("writes nothing for a session outside the window", async () => {
		const token = await createToken(userId);
		const expiresAt = (await sessionOf(token)).expiresAt - 60;
		await setSession(token, { expiresAt });
		expect((await authGet("/api/auth/me", token)).status).toBe(200);
		expect((await sessionOf(token)).expiresAt).toBe(expiresAt);
	});

	test("never extends past the absolute ceiling", async () => {
		const token = await createToken(userId);
		const sessionStart = nowSeconds() - ABSOLUTE_SESSION_MAX_SECONDS + 3600;
		await setSession(token, { sessionStart, expiresAt: nowSeconds() + 60 });

		expect((await authGet("/api/auth/me", token)).status).toBe(200);
		expect((await sessionOf(token)).expiresAt).toBe(sessionStart + ABSOLUTE_SESSION_MAX_SECONDS);
	});

	test("a fresh session lasts the full TTL", async () => {
		const payload = await verifyToken(await createToken(userId));
		expect(payload.exp - payload.iat).toBe(SESSION_TOKEN_TTL_SECONDS);
	});
});

describe("finished sessions", () => {
	test("an expired session reports TOKEN_EXPIRED", async () => {
		const token = await createToken(userId);
		await setSession(token, { expiresAt: nowSeconds() - 60 });
		const response = await authGet("/api/auth/me", token);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
	});

	test("a session past the absolute ceiling reports TOKEN_EXPIRED", async () => {
		const token = await createToken(userId);
		await setSession(token, { sessionStart: nowSeconds() - ABSOLUTE_SESSION_MAX_SECONDS - 60 });
		const response = await authGet("/api/auth/me", token);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
	});

	test("logout revokes the presenting session and no other", async () => {
		const token = await createToken(userId);
		const other = await createToken(userId);
		const logout = await app.request("/api/auth/logout", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(logout.status).toBe(200);

		const after = await authGet("/api/auth/me", token);
		expect(after.status).toBe(401);
		// TOKEN_EXPIRED (not UNAUTHORIZED) is what makes the client clear its stored token.
		expect(await after.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
		expect((await authGet("/api/auth/me", other)).status).toBe(200);
	});

	test("a generation bump revokes every session immediately", async () => {
		const token = await createToken(userId);
		expect((await authGet("/api/auth/me", token)).status).toBe(200);
		const version = await revokeUserSessions(userId);

		const after = await authGet("/api/auth/me", token);
		expect(after.status).toBe(401);
		expect(await after.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
		// A session issued against the new generation works.
		expect((await authGet("/api/auth/me", await createToken(userId, version))).status).toBe(200);
	});

	test("a deleted user's session is rejected", async () => {
		const ghostId = generateId();
		await db.insert(users).values({
			id: ghostId,
			username: `ghost-${ghostId}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const token = await createToken(ghostId);
		await db.delete(users).where(eq(users.id, ghostId));
		expect((await authGet("/api/auth/me", token)).status).toBe(401);
	});
});

describe("live authorization state", () => {
	test("a role change applies to the very next request", async () => {
		const token = await createToken(userId);
		expect((await authGet("/api/admin/users", token)).status).toBe(403);
		await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));
		expect((await authGet("/api/admin/users", token)).status).toBe(200);
		await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
		expect((await authGet("/api/admin/users", token)).status).toBe(403);
	});
});

describe("storage failures", () => {
	test("a failing session lookup is a server error, never a session loss", async () => {
		// Reading a DB hiccup as "your session is gone" would make every client drop a
		// perfectly good token and log the whole user base out at once.
		const token = await createToken(userId);
		const original = authSessionStore.findSessionByTokenHash;
		authSessionStore.findSessionByTokenHash = async () => {
			throw new Error("database unavailable");
		};
		let response: Response;
		try {
			response = await authGet("/api/auth/me", token);
		} finally {
			authSessionStore.findSessionByTokenHash = original;
		}
		expect(response.status).toBeGreaterThanOrEqual(500);
		const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
		expect(isSessionInvalidResponse(body)).toBe(false);
		expect((await authGet("/api/auth/me", token)).status).toBe(200);
	});
});

describe("rejected credentials", () => {
	test("an unknown session token is UNAUTHORIZED", async () => {
		const response = await authGet("/api/auth/me", `nfs_${"A".repeat(43)}`);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("a session JWT signed with the instance secret is no longer accepted", async () => {
		// The pre-opaque session format. UNAUTHORIZED sends the client back to login.
		const now = nowSeconds();
		const jwt = await sign(
			{ sub: userId, role: "admin", iat: now, exp: now + 3600 },
			settings.auth.jwtSecret,
		);
		const response = await authGet("/api/auth/me", jwt);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("a request without credentials is rejected", async () => {
		expect((await app.request("/api/auth/me")).status).toBe(401);
	});
});
