/**
 * Opaque session tokens, end to end through the SQLite session store.
 *
 * ISOLATION: the store runs on `tests/setup`'s in-memory database, mocked over
 * `server/db`. No real NarraFork database is touched.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ABSOLUTE_SESSION_MAX_SECONDS, SESSION_TOKEN_TTL_SECONDS } from "@shared/session-auth";
import { eq } from "drizzle-orm";
import { authSessions, users } from "../../../server/db/schema";
import { generateId } from "../../../server/lib/id";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const {
	createToken,
	extendSessionToken,
	pruneStaleSessions,
	revokeSessionToken,
	revokeUserSessions,
	verifyToken,
} = await import("../../../server/lib/auth");
const { hashSessionToken } = await import("../../../server/lib/session-token-hash");

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

beforeEach(() => {
	cleanDb(sqlite);
});

const now = () => Math.floor(Date.now() / 1000);

async function makeUser(role: "admin" | "user" = "user"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `user-${id.slice(0, 8)}`,
		passwordHash: "hash",
		role,
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function sessionRow(token: string) {
	const [row] = await db
		.select()
		.from(authSessions)
		.where(eq(authSessions.tokenHash, hashSessionToken(token)));
	return row;
}

async function errorName(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return (error as Error).name;
	}
	return undefined;
}

describe("createToken", () => {
	test("issues an opaque token and stores only its hash", async () => {
		const userId = await makeUser();
		const token = await createToken(userId);
		expect(token).toMatch(/^nfs_[A-Za-z0-9_-]{43}$/);

		const rows = await db.select().from(authSessions);
		expect(rows).toHaveLength(1);
		expect(rows[0].tokenHash).toBe(hashSessionToken(token));
		expect(JSON.stringify(rows[0])).not.toContain(token.slice(4));
	});

	test("anchors a fresh login at the present and expires after the full TTL", async () => {
		const userId = await makeUser("admin");
		const before = now();
		const payload = await verifyToken(await createToken(userId));
		expect(payload.sub).toBe(userId);
		expect(payload.role).toBe("admin");
		expect(payload.sid).toBeString();
		expect(payload.sessionStart).toBeGreaterThanOrEqual(before);
		expect(payload.exp - payload.iat).toBe(SESSION_TOKEN_TTL_SECONDS);
	});
});

describe("verifyToken (opaque)", () => {
	test("rejects an unknown, tampered or non-session token as invalid", async () => {
		const token = await createToken(await makeUser());
		for (const bad of [`${token}x`, `nfs_${"A".repeat(43)}`, token.slice(4), "a.b.c"]) {
			const error = await verifyToken(bad).catch((e: unknown) => e);
			expect(error).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
		}
	});

	test("reads the role live, not from issuance", async () => {
		const userId = await makeUser("admin");
		const token = await createToken(userId);
		await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
		expect((await verifyToken(token)).role).toBe("user");
	});

	test("reports an expired session as expired", async () => {
		const token = await createToken(await makeUser());
		await db
			.update(authSessions)
			.set({ expiresAt: now() - 1 })
			.where(eq(authSessions.tokenHash, hashSessionToken(token)));
		expect(await errorName(verifyToken(token))).toBe("SessionTokenExpired");
	});

	test("reports a session past the absolute ceiling as expired", async () => {
		const token = await createToken(await makeUser());
		await db
			.update(authSessions)
			.set({ sessionStart: now() - ABSOLUTE_SESSION_MAX_SECONDS - 1 })
			.where(eq(authSessions.tokenHash, hashSessionToken(token)));
		expect(await errorName(verifyToken(token))).toBe("SessionTokenExpired");
	});

	test("logout revokes only that session", async () => {
		const userId = await makeUser();
		const first = await createToken(userId);
		const second = await createToken(userId);
		await revokeSessionToken(await verifyToken(first));
		expect(await errorName(verifyToken(first))).toBe("SessionTokenRevoked");
		expect((await verifyToken(second)).sub).toBe(userId);
	});

	test("a token-generation bump revokes every session of the user", async () => {
		const userId = await makeUser();
		const old = await createToken(userId);
		const version = await revokeUserSessions(userId);
		expect(await errorName(verifyToken(old))).toBe("SessionTokenRevoked");
		// A replacement bound to the new generation works.
		expect((await verifyToken(await createToken(userId, version))).sub).toBe(userId);
	});

	test("deleting the user deletes its sessions", async () => {
		const userId = await makeUser();
		const token = await createToken(userId);
		await db.delete(users).where(eq(users.id, userId));
		const error = await verifyToken(token).catch((e: unknown) => e);
		expect(error).toMatchObject({ statusCode: 401 });
	});
});

describe("extendSessionToken", () => {
	test("slides the expiry forward without touching the anchor or the token", async () => {
		const token = await createToken(await makeUser());
		const row = await sessionRow(token);
		await db
			.update(authSessions)
			.set({ expiresAt: now() + 3600 })
			.where(eq(authSessions.id, row.id));

		await extendSessionToken(await verifyToken(token));
		const payload = await verifyToken(token);
		expect(payload.exp).toBeGreaterThanOrEqual(now() + SESSION_TOKEN_TTL_SECONDS - 1);
		expect(payload.sessionStart).toBe(row.sessionStart);
	});

	test("never slides past the absolute ceiling", async () => {
		const token = await createToken(await makeUser());
		const sessionStart = now() - ABSOLUTE_SESSION_MAX_SECONDS + 3600;
		await db
			.update(authSessions)
			.set({ sessionStart, expiresAt: now() + 60 })
			.where(eq(authSessions.tokenHash, hashSessionToken(token)));

		await extendSessionToken(await verifyToken(token));
		expect((await sessionRow(token)).expiresAt).toBe(sessionStart + ABSOLUTE_SESSION_MAX_SECONDS);
	});

	test("does not revive a session revoked after it was verified", async () => {
		const token = await createToken(await makeUser());
		const payload = await verifyToken(token);
		await revokeSessionToken(payload);
		await extendSessionToken({ ...payload, exp: now() + 60 });
		expect(await errorName(verifyToken(token))).toBe("SessionTokenRevoked");
	});
});

describe("pruneStaleSessions", () => {
	test("deletes long-expired and long-revoked sessions only", async () => {
		const userId = await makeUser();
		const live = await createToken(userId);
		const recentlyExpired = await createToken(userId);
		const longExpired = await createToken(userId);
		const longRevoked = await createToken(userId);
		const day = 24 * 60 * 60;
		const set = (token: string, values: Partial<typeof authSessions.$inferInsert>) =>
			db
				.update(authSessions)
				.set(values)
				.where(eq(authSessions.tokenHash, hashSessionToken(token)));
		await set(recentlyExpired, { expiresAt: now() - 60 });
		await set(longExpired, { expiresAt: now() - 2 * day });
		await set(longRevoked, { revokedAt: now() - 2 * day });

		expect(await pruneStaleSessions()).toBe(2);
		expect(await sessionRow(live)).toBeDefined();
		expect(await sessionRow(recentlyExpired)).toBeDefined();
		expect(await sessionRow(longExpired)).toBeUndefined();
		expect(await sessionRow(longRevoked)).toBeUndefined();
	});
});
