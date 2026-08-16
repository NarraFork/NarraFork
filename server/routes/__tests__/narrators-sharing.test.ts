/**
 * The sharing API.
 *
 * What must hold:
 *  - only the owner (or an admin) may change who has access — a write grant lets
 *    someone work in a session, not hand it onward;
 *  - a share actually takes effect, and revoking it actually removes access;
 *  - `read` and `write` are distinct: a read grant must not permit driving;
 *  - a batch reports per-user outcomes instead of failing wholesale on one bad id;
 *  - narrators with no owner (everything from before access control) are manageable
 *    by admins only, and `transfer-owner` is the way out of that state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-narrator-sharing-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "share-owner";
const FRIEND = "share-friend";
const STRANGER = "share-stranger";

function appAs(userId: string, role: "admin" | "user" = "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/narrators", narratorRoutes);
	return app;
}

function request(
	userId: string,
	path: string,
	init: { method?: string; body?: unknown; role?: "admin" | "user" } = {},
) {
	const { method = "GET", body, role = "user" } = init;
	return appAs(userId, role).request(`http://localhost/narrators${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}

async function makeNarrator(options: { ownerUserId?: string | null } = {}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: "shared session",
		ownerUserId: options.ownerUserId === undefined ? OWNER : options.ownerUserId,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

beforeAll(async () => {
	const now = new Date().toISOString();
	for (const [id, role] of [
		[OWNER, "user"],
		[FRIEND, "user"],
		[STRANGER, "user"],
		["share-admin", "admin"],
	] as const) {
		await db.insert(users).values({
			id,
			username: `${id}-${Date.now()}`,
			passwordHash: "x",
			role,
			createdAt: now,
		});
	}
});

describe("who may change sharing", () => {
	test("the owner can share and the grantee gains access", async () => {
		const id = await makeNarrator();
		expect((await request(FRIEND, `/${id}`)).status).toBe(404);

		const res = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "read" },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).granted).toEqual([FRIEND]);

		expect((await request(FRIEND, `/${id}`)).status).toBe(200);
	});

	test("a write-granted user cannot re-share", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "write" },
		});

		const res = await request(FRIEND, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [STRANGER], access: "read" },
		});
		expect(res.status).toBe(400);
		// The stranger stayed out.
		expect((await request(STRANGER, `/${id}`)).status).toBe(404);
	});

	test("an admin can share someone else's narrator", async () => {
		const id = await makeNarrator();
		const res = await request("share-admin", `/${id}/grants`, {
			method: "POST",
			body: { userIds: [STRANGER] },
			role: "admin",
		});
		expect(res.status).toBe(200);
		expect((await request(STRANGER, `/${id}`)).status).toBe(200);
	});

	test("a stranger cannot even read the access panel", async () => {
		const id = await makeNarrator();
		expect((await request(STRANGER, `/${id}/access`)).status).toBe(404);
	});
});

describe("grant levels", () => {
	test("a read grant does not allow driving the session", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "read" },
		});

		const res = await request(FRIEND, `/${id}/model`, {
			method: "PATCH",
			body: { model: "m" },
		});
		expect(res.status).toBe(404);
	});

	test("upgrading to write allows it", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "read" },
		});
		const access = await (await request(OWNER, `/${id}/access`)).json();
		const grantId = access.grants[0].id;

		const upgrade = await request(OWNER, `/${id}/grants/${grantId}`, {
			method: "PATCH",
			body: { access: "write" },
		});
		expect(upgrade.status).toBe(200);

		const res = await request(FRIEND, `/${id}/model`, {
			method: "PATCH",
			body: { model: "m" },
		});
		expect(res.status).toBe(200);
	});

	test("revoking a grant removes access", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND] },
		});
		const access = await (await request(OWNER, `/${id}/access`)).json();
		const grantId = access.grants[0].id;

		expect((await request(OWNER, `/${id}/grants/${grantId}`, { method: "DELETE" })).status).toBe(
			200,
		);
		expect((await request(FRIEND, `/${id}`)).status).toBe(404);
	});
});

describe("batch outcomes", () => {
	test("one unknown user does not fail the whole batch", async () => {
		const id = await makeNarrator();
		const res = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND, "no-such-user"] },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.granted).toEqual([FRIEND]);
		expect(body.failed).toEqual(["no-such-user"]);
	});

	test("re-granting the same access is reported as skipped", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, { method: "POST", body: { userIds: [FRIEND] } });
		const res = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND] },
		});
		expect((await res.json()).skipped).toEqual([FRIEND]);
	});

	test("sharing with the owner is refused rather than creating a redundant grant", async () => {
		const id = await makeNarrator();
		const res = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [OWNER] },
		});
		const body = await res.json();
		expect(body.failed).toEqual([OWNER]);
		expect(body.access.grants).toEqual([]);
	});
});

describe("visibility", () => {
	test("making a narrator public lets others read but not drive it", async () => {
		const id = await makeNarrator();
		expect(
			(
				await request(OWNER, `/${id}/visibility`, {
					method: "PATCH",
					body: { visibility: "public" },
				})
			).status,
		).toBe(200);

		expect((await request(STRANGER, `/${id}`)).status).toBe(200);
		expect(
			(await request(STRANGER, `/${id}/model`, { method: "PATCH", body: { model: "m" } })).status,
		).toBe(404);
	});

	test("going back to private revokes the broad read again", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "private" } });
		expect((await request(STRANGER, `/${id}`)).status).toBe(404);
	});

	test("an unknown visibility value is rejected", async () => {
		const id = await makeNarrator();
		const res = await request(OWNER, `/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "everyone" },
		});
		expect(res.status).toBe(400);
	});
});

describe("narrators with no owner (pre-ACL rows)", () => {
	test("a normal user cannot change their sharing, even though they can read them", async () => {
		const id = await makeNarrator({ ownerUserId: null });
		// The backfill makes these public, so reading works; managing must not.
		await db
			.update(narrators)
			.set({ visibility: "public" })
			.where((await import("drizzle-orm")).eq(narrators.id, id));

		expect((await request(STRANGER, `/${id}/access`)).status).toBe(200);
		const res = await request(STRANGER, `/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "private" },
		});
		// Refused by the router's write gate (404) before the owner-or-admin check in
		// the service (400) is ever reached. Either way it must not succeed: a public
		// narrator is readable by everyone, and if anyone passing by could flip it to
		// private, "public" would be a booby trap.
		expect(res.status).toBe(404);
	});

	test("an admin can transfer ownership, after which the new owner manages it", async () => {
		const id = await makeNarrator({ ownerUserId: null });

		const transfer = await request("share-admin", `/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: FRIEND },
			role: "admin",
		});
		expect(transfer.status).toBe(200);
		expect((await transfer.json()).owner.userId).toBe(FRIEND);

		const res = await request(FRIEND, `/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "private" },
		});
		expect(res.status).toBe(200);
	});

	test("a non-admin owner cannot drop the narrator back to ownerless", async () => {
		const id = await makeNarrator();
		const res = await request(OWNER, `/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: null },
		});
		expect(res.status).toBe(400);
	});
});
