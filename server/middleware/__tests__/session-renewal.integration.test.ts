import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Sliding session renewal, exercised through the real app so the response header
 * is observed exactly as a browser would see it (middleware order, Hono response
 * construction and the global error handler all included).
 *
 * NARRAFORK_HOME is redirected to a temp directory before the app is imported so
 * this never touches the developer's real database or settings.
 */
const previousHome = process.env.NARRAFORK_HOME;
const previousAllowMultiple = process.env.NARRAFORK_ALLOW_MULTIPLE;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-session-renewal-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const [
	{ app },
	{ db },
	{ users },
	{ eq },
	{ sign },
	{ generateId },
	{ settings },
	{
		ABSOLUTE_SESSION_MAX_SECONDS,
		SESSION_RENEWAL_HEADER,
		SESSION_RENEWAL_THRESHOLD_SECONDS,
		SESSION_START_CLAIM,
		SESSION_TOKEN_TTL_SECONDS,
	},
	{ verifyToken },
	{ invalidateUserCache },
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
	import("../auth"),
]);

const USERNAME = "session-renewal-user";
let userId = "";

/** How long into the renewal window a "nearly expired" test token sits. */
const NEARLY_EXPIRED_REMAINING = SESSION_RENEWAL_THRESHOLD_SECONDS - 3600;

/** Sign a session JWT whose remaining lifetime is exactly `remainingSeconds`. */
async function sessionTokenExpiringIn(
	remainingSeconds: number,
	options?: { role?: string; sessionStart?: number | null; sub?: string },
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const sessionStart = options?.sessionStart;
	return sign(
		{
			sub: options?.sub ?? userId,
			role: options?.role ?? "user",
			iat: now - (SESSION_TOKEN_TTL_SECONDS - remainingSeconds),
			exp: now + remainingSeconds,
			// `null` means "legacy token, no anchor at all".
			...(sessionStart === null ? {} : { [SESSION_START_CLAIM]: sessionStart ?? now }),
		},
		settings.auth.jwtSecret,
	);
}

async function authGet(path: string, token: string): Promise<Response> {
	return await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
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

describe("sliding session renewal", () => {
	test("issues a fresh token when the current one nears expiry", async () => {
		const nearlyExpired = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING);
		const response = await authGet("/api/auth/me", nearlyExpired);
		expect(response.status).toBe(200);

		const renewed = response.headers.get(SESSION_RENEWAL_HEADER);
		expect(renewed).toBeString();
		expect(renewed).not.toBe(nearlyExpired);

		// The replacement must be a valid session token for the same principal,
		// with a lifetime reset to the full window.
		const payload = await verifyToken(renewed as string);
		expect(payload.sub).toBe(userId);
		expect(payload.role).toBe("user");
		const nowSeconds = Math.floor(Date.now() / 1000);
		expect(payload.exp - nowSeconds).toBeGreaterThan(SESSION_RENEWAL_THRESHOLD_SECONDS);
	});

	test("leaves a freshly issued token untouched", async () => {
		const fresh = await sessionTokenExpiringIn(SESSION_TOKEN_TTL_SECONDS);
		const response = await authGet("/api/auth/me", fresh);
		expect(response.status).toBe(200);
		expect(response.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
	});

	test("the renewed token authenticates subsequent requests", async () => {
		const nearlyExpired = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING);
		const first = await authGet("/api/auth/me", nearlyExpired);
		const renewed = first.headers.get(SESSION_RENEWAL_HEADER) as string;
		expect(renewed).toBeString();

		const second = await authGet("/api/auth/me", renewed);
		expect(second.status).toBe(200);
		// The replacement is far from expiry, so it must not renew again.
		expect(second.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
	});

	test("an expired token is rejected as TOKEN_EXPIRED and gets no renewal", async () => {
		const expired = await sessionTokenExpiringIn(-60);
		const response = await authGet("/api/auth/me", expired);
		expect(response.status).toBe(401);
		expect(response.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
		expect(await response.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
	});

	test("an unauthenticated request gets no renewal", async () => {
		const response = await app.request("/api/auth/me");
		expect(response.status).toBe(401);
		expect(response.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
	});
});

describe("absolute session ceiling", () => {
	test("carries the original session start through every renewal", async () => {
		const sessionStart = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
		const nearlyExpired = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING, { sessionStart });
		const response = await authGet("/api/auth/me", nearlyExpired);
		const renewed = response.headers.get(SESSION_RENEWAL_HEADER) as string;
		expect(renewed).toBeString();

		const payload = (await verifyToken(renewed)) as unknown as Record<string, unknown>;
		// The anchor must not slide forward, otherwise the ceiling can be pushed
		// out forever one renewal at a time.
		expect(payload[SESSION_START_CLAIM]).toBe(sessionStart);
	});

	test("stops renewing once the chain exceeds the absolute maximum", async () => {
		const sessionStart = Math.floor(Date.now() / 1000) - ABSOLUTE_SESSION_MAX_SECONDS - 60;
		const nearlyExpired = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING, { sessionStart });
		const response = await authGet("/api/auth/me", nearlyExpired);
		// The token itself is still valid, so the request succeeds — but it is the
		// last stretch of this session: no replacement is issued.
		expect(response.status).toBe(200);
		expect(response.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
	});

	test("repeated renewal terminates instead of extending forever", async () => {
		// Walk a chain that is one renewal short of the ceiling: the first request
		// renews, and a token anchored a hair past the ceiling no longer does.
		const nowSeconds = Math.floor(Date.now() / 1000);
		const almostOver = nowSeconds - (ABSOLUTE_SESSION_MAX_SECONDS - 120);
		const first = await authGet(
			"/api/auth/me",
			await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING, { sessionStart: almostOver }),
		);
		expect(first.headers.get(SESSION_RENEWAL_HEADER)).toBeString();

		const over = nowSeconds - (ABSOLUTE_SESSION_MAX_SECONDS + 120);
		const second = await authGet(
			"/api/auth/me",
			await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING, { sessionStart: over }),
		);
		expect(second.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
	});

	test("anchors a legacy token without the claim at the current time", async () => {
		const legacy = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING, { sessionStart: null });
		const before = Math.floor(Date.now() / 1000);
		const response = await authGet("/api/auth/me", legacy);
		const renewed = response.headers.get(SESSION_RENEWAL_HEADER) as string;
		expect(renewed).toBeString();

		const payload = (await verifyToken(renewed)) as unknown as Record<string, unknown>;
		const anchor = payload[SESSION_START_CLAIM] as number;
		// Legacy sessions get one more full window rather than an immediate logout,
		// but they are anchored from here on.
		expect(anchor).toBeGreaterThanOrEqual(before);
		expect(anchor).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});
});

describe("renewal reflects live authorization state", () => {
	test("renews with the database role, not the role in the presented token", async () => {
		// The user was demoted to `user` in the database but still holds an admin
		// token. Copying the presented role would freeze the stale admin grant into
		// an endless renewal chain.
		const staleAdmin = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING, { role: "admin" });
		const response = await authGet("/api/auth/me", staleAdmin);
		expect(response.status).toBe(200);

		const renewed = response.headers.get(SESSION_RENEWAL_HEADER) as string;
		expect(renewed).toBeString();
		const payload = await verifyToken(renewed);
		expect(payload.role).toBe("user");
	});

	test("refuses to renew (and rejects) a token whose user row is gone", async () => {
		const ghostId = generateId();
		const ghostToken = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING, { sub: ghostId });
		invalidateUserCache(ghostId);
		const response = await authGet("/api/auth/me", ghostToken);
		expect(response.status).toBe(401);
		expect(response.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
	});
});

describe("renewal never rides on a cacheable response", () => {
	test("skips paths that answer with a public or long-lived Cache-Control", async () => {
		const nearlyExpired = await sessionTokenExpiringIn(NEARLY_EXPIRED_REMAINING);
		// These routes serve `public`/`immutable` (uploads, notification sounds) or a
		// cacheable `private` body (fs preview). A session JWT in their headers would
		// be written to the browser's disk cache and be reusable by shared caches.
		for (const path of [
			"/api/uploads/does-not-exist/also-missing",
			"/api/notification-sounds/does-not-exist",
			"/api/fs/preview?path=/definitely/not/here",
		]) {
			const response = await authGet(path, nearlyExpired);
			expect(response.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
		}

		// Control: an ordinary JSON route on the same token does renew, so the
		// assertions above are about the path filter and not about the token.
		const control = await authGet("/api/auth/me", nearlyExpired);
		expect(control.headers.get(SESSION_RENEWAL_HEADER)).toBeString();
	});
});

describe("expired versus forged tokens", () => {
	test("a token signed with a foreign key is UNAUTHORIZED even when its exp is past", async () => {
		// hono's verify checks `exp` before the signature, so without an explicit
		// signature confirmation this would answer TOKEN_EXPIRED — telling an
		// unauthenticated caller the token was once ours and making the client throw
		// away whatever session it currently holds.
		const now = Math.floor(Date.now() / 1000);
		const forged = await sign(
			{ sub: userId, role: "admin", iat: now - 7200, exp: now - 3600 },
			"an-attacker-controlled-secret",
		);
		const response = await authGet("/api/auth/me", forged);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("a genuinely expired token still reports TOKEN_EXPIRED", async () => {
		const expired = await sessionTokenExpiringIn(-60);
		const response = await authGet("/api/auth/me", expired);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
	});
});

describe("session token shape", () => {
	test("rejects a correctly signed token that carries no exp", async () => {
		const now = Math.floor(Date.now() / 1000);
		const noExp = await sign({ sub: userId, role: "user", iat: now }, settings.auth.jwtSecret);
		const response = await authGet("/api/auth/me", noExp);
		// Without this check such a token is a permanent credential: hono skips the
		// exp comparison entirely, and it never enters renewal or the ceiling.
		expect(response.status).toBe(401);
		expect(response.headers.get(SESSION_RENEWAL_HEADER)).toBeNull();
	});

	test("rejects a correctly signed token that carries no sub", async () => {
		const now = Math.floor(Date.now() / 1000);
		const noSub = await sign(
			{ role: "admin", iat: now, exp: now + SESSION_TOKEN_TTL_SECONDS },
			settings.auth.jwtSecret,
		);
		const response = await authGet("/api/auth/me", noSub);
		expect(response.status).toBe(401);
	});
});
