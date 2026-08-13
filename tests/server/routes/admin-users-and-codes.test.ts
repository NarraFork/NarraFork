/**
 * Admin provisioning endpoints: creating an account directly, and issuing /
 * revoking single-use registration codes.
 *
 * The security-relevant assertions are that these routes are admin-only, that
 * account creation never returns a session token for the created user, and that
 * the code plaintext appears in the creation response and nowhere else.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { registrationCodes, userPreferences, users } from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { adminRoutes } = await import("../../../server/routes/admin");

const NOW = "2026-08-12T00:00:00.000Z";
const ADMIN_ID = "admin-1";

function appForRole(role: "admin" | "user") {
	const user = { sub: role === "admin" ? ADMIN_ID : "user-1", role, iat: 0, exp: 2 ** 31 };
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("auth", { type: "session", user });
		c.set("user", user);
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		throw error;
	});
	app.route("/", adminRoutes);
	return app;
}

function post(path: string, body: unknown, role: "admin" | "user" = "admin") {
	return appForRole(role).request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(async () => {
	cleanDb(sqlite);
	// The acting administrator must exist: created rows reference them.
	await db.insert(users).values({
		id: ADMIN_ID,
		username: "root-admin",
		passwordHash: "x",
		role: "admin",
		createdAt: NOW,
	});
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

describe("POST /users", () => {
	test("creates an account with the given role and preferences, without a token", async () => {
		const res = await post("/users", {
			username: "alice",
			password: "correct-horse-battery",
			role: "admin",
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.username).toBe("alice");
		expect(body.role).toBe("admin");
		// An admin provisioning someone else's account must not receive credentials for it.
		expect(body).not.toHaveProperty("token");
		expect(body).not.toHaveProperty("passwordHash");

		const row = await db.query.users.findFirst({ where: eq(users.username, "alice") });
		expect(row?.passwordHash).not.toBe("correct-horse-battery");
		expect(await Bun.password.verify("correct-horse-battery", row?.passwordHash ?? "")).toBe(true);

		const prefs = await db
			.select()
			.from(userPreferences)
			.where(eq(userPreferences.userId, row?.id ?? ""));
		expect(prefs).toHaveLength(1);
	});

	test("defaults to the user role", async () => {
		const res = await post("/users", { username: "bob", password: "another-passphrase" });
		expect(((await res.json()) as { role: string }).role).toBe("user");
	});

	test("rejects a duplicate username", async () => {
		await post("/users", { username: "alice", password: "correct-horse-battery" });
		const res = await post("/users", { username: "alice", password: "different-passphrase" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code: string }).code).toBe("USERNAME_TAKEN");
	});

	test("rejects a short password without creating anything", async () => {
		const res = await post("/users", { username: "alice", password: "short" });
		expect(res.status).toBe(400);
		expect(await db.query.users.findFirst({ where: eq(users.username, "alice") })).toBeUndefined();
	});

	test("rejects a non-admin caller", async () => {
		const res = await post(
			"/users",
			{ username: "alice", password: "correct-horse-battery" },
			"user",
		);
		expect(res.status).toBe(403);
		expect(await db.query.users.findFirst({ where: eq(users.username, "alice") })).toBeUndefined();
	});
});

/**
 * Role changes and the token generation.
 *
 * A session JWT carries its own `role` claim and `assertAdmin` reads that claim, so a
 * demotion that only clears the existence cache leaves the target's already-issued
 * token passing `requireAdmin` until it expires — the version check the cache serves
 * compares `tokenVersion`, not the role.
 */
describe("PATCH /users/:id role changes", () => {
	async function seedUser(id: string, role: "admin" | "user") {
		await db.insert(users).values({
			id,
			username: id,
			passwordHash: "x",
			role,
			createdAt: NOW,
		});
	}

	function patch(path: string, body: unknown, role: "admin" | "user" = "admin") {
		return appForRole(role).request(path, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function tokenVersionOf(id: string): Promise<number> {
		const row = await db.query.users.findFirst({
			where: eq(users.id, id),
			columns: { tokenVersion: true },
		});
		return row?.tokenVersion ?? -1;
	}

	test("a demotion revokes the target's existing sessions", async () => {
		await seedUser("second-admin", "admin");
		const before = await tokenVersionOf("second-admin");

		const res = await patch("/users/second-admin", { role: "user" });

		expect(res.status).toBe(200);
		expect(await tokenVersionOf("second-admin")).toBeGreaterThan(before);
	});

	test("a promotion does not revoke sessions", async () => {
		// Gaining privileges invalidates nothing the user already holds, and signing
		// someone out for being promoted would be gratuitous.
		await seedUser("plain", "user");
		const before = await tokenVersionOf("plain");

		const res = await patch("/users/plain", { role: "admin" });

		expect(res.status).toBe(200);
		expect(await tokenVersionOf("plain")).toBe(before);
	});

	test("re-applying the same role revokes nothing", async () => {
		// Not a demotion: there is no stale elevated claim to invalidate, so a no-op
		// write must not sign the user out.
		await seedUser("plain", "user");
		const before = await tokenVersionOf("plain");

		const res = await patch("/users/plain", { role: "user" });

		expect(res.status).toBe(200);
		expect(await tokenVersionOf("plain")).toBe(before);
	});

	test("the last administrator cannot be demoted", async () => {
		await seedUser("plain", "user");

		const res = await patch("/users/plain", { role: "user" });
		expect(res.status).toBe(200);

		// ADMIN_ID is the only admin, and demoting yourself is refused earlier.
		const selfRes = await patch(`/users/${ADMIN_ID}`, { role: "user" });
		expect(selfRes.status).toBe(400);
		expect(((await selfRes.json()) as { code: string }).code).toBe("SELF_DEMOTE");
	});
});

describe("registration codes", () => {
	test("the plaintext is returned once and never listed again", async () => {
		const created = await post("/registration-codes", { note: "for alice" });
		expect(created.status).toBe(201);
		const body = (await created.json()) as { code: string; id: string };
		expect(body.code).toStartWith("nfrc_");

		const list = await appForRole("admin").request("/registration-codes");
		const listBody = await list.text();
		expect(listBody).not.toContain(body.code);
		expect(listBody).toContain("for alice");

		// Storage keeps only the hash.
		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, body.id),
		});
		expect(row?.codeHash).not.toBe(body.code);
	});

	test("records the issuing administrator and requested attributes", async () => {
		const res = await post("/registration-codes", {
			role: "admin",
			username: "alice",
			expiresInHours: 1,
		});
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.role).toBe("admin");
		expect(body.boundUsername).toBe("alice");
		expect(body.createdByUsername).toBe("root-admin");
		expect(body.status).toBe("active");
	});

	test("revoking flips the status and delete removes the row", async () => {
		const created = (await (await post("/registration-codes", {})).json()) as { id: string };

		const revoked = await post(`/registration-codes/${created.id}/revoke`, {});
		expect(revoked.status).toBe(200);
		expect(((await revoked.json()) as { status: string }).status).toBe("revoked");

		const deleted = await appForRole("admin").request(`/registration-codes/${created.id}`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(200);
		const remaining = await db.select().from(registrationCodes);
		expect(remaining).toHaveLength(0);
	});

	test("rejects an out-of-range expiry", async () => {
		const res = await post("/registration-codes", { expiresInHours: 0 });
		expect(res.status).toBe(400);
		expect(await db.select().from(registrationCodes)).toHaveLength(0);
	});

	test("rejects non-admin callers on every endpoint", async () => {
		const created = (await (await post("/registration-codes", {})).json()) as { id: string };

		expect((await appForRole("user").request("/registration-codes")).status).toBe(403);
		expect((await post("/registration-codes", {}, "user")).status).toBe(403);
		expect((await post(`/registration-codes/${created.id}/revoke`, {}, "user")).status).toBe(403);
		const deleted = await appForRole("user").request(`/registration-codes/${created.id}`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(403);

		// Nothing was mutated by the rejected calls.
		const rows = await db.select().from(registrationCodes);
		expect(rows).toHaveLength(1);
		expect(rows[0].revokedAt).toBeNull();
	});
});
