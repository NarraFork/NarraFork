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
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-narrator-sharing-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { aclGrants, narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const narratorWs = await import("../../websocket/narrator-ws");
const narratorAcl = await import("../../services/narrator-acl");
const aclAudit = await import("../../services/acl/acl-audit");

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

function pauseTransferTargetLookups(targets: readonly string[], expectedArrivals: number) {
	let arrivals = 0;
	let released = false;
	let releaseGate!: () => void;
	let signalReady!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		signalReady = resolve;
	});
	const original = db.query.users.findFirst.bind(db.query.users);
	const restoreExecutions: Array<() => void> = [];
	const read = spyOn(db.query.users, "findFirst").mockImplementation((options) => {
		const query = original(options);
		const execute = query.execute.bind(query);
		const delayed = spyOn(query, "execute").mockImplementation(async () => {
			const row = await execute();
			// Retain the real query builder/SQL read, pausing only the transfer's
			// id-only target lookup after authorization. Other reads remain real.
			if (
				!released &&
				options?.columns?.id === true &&
				Object.keys(options.columns).length === 1 &&
				row &&
				targets.includes(row.id)
			) {
				arrivals++;
				if (arrivals === expectedArrivals) signalReady();
				await gate;
			}
			return row;
		});
		restoreExecutions.push(() => delayed.mockRestore());
		return query;
	});
	const release = () => {
		released = true;
		releaseGate();
	};
	return {
		async ready() {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					ready,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error("Concurrent transfers did not reach the target-read barrier")),
							2000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
		release,
		restore() {
			release();
			read.mockRestore();
			for (const restore of restoreExecutions) restore();
		},
	};
}

// This spies on the production named import, not a replacement authorization
// decision: only a successful, real owner/admin check is paused, once.
function pauseSuccessfulManagement(narratorId: string, userId: string) {
	let armed = true;
	let releaseGate!: () => void;
	let signalReady!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		signalReady = resolve;
	});
	const original = narratorAcl.canManageNarratorAcl;
	const check = spyOn(narratorAcl, "canManageNarratorAcl").mockImplementation(
		async (row, principal) => {
			const allowed = await original(row, principal);
			if (armed && allowed && row.id === narratorId && principal.userId === userId) {
				armed = false;
				signalReady();
				await gate;
			}
			return allowed;
		},
	);
	return {
		async ready() {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					ready,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error("Sharing did not reach the real management-check barrier")),
							2000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
		release: releaseGate,
		restore() {
			releaseGate();
			check.mockRestore();
		},
	};
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

describe("the read/write gate on mutating sub-paths", () => {
	test("`leave` is reachable with read access only", async () => {
		// Closing a tab clears the "interrupted" badge, and a read-only viewer legitimately
		// triggers it. Denying it would leave the badge stuck for everyone else.
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "read" },
		});
		expect((await request(FRIEND, `/${id}/leave`, { method: "POST" })).status).not.toBe(404);
	});

	test("the exemption does not extend to a deeper path ending in the same word", async () => {
		// The gate used to test only the LAST path segment, so any future
		// `/:id/<anything>/leave` would inherit the read downgrade without anyone deciding
		// so. A read-only user must be refused here — 404 is how this API hides sessions
		// the caller may not write.
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "read" },
		});
		const res = await request(FRIEND, `/${id}/rooms/r1/leave`, { method: "POST" });
		expect(res.status).toBe(404);
		// And specifically the ACL's 404, not the router's: the body carries an error.
		expect(await res.json()).toHaveProperty("error");
	});

	test("an ordinary mutating sub-path still requires write", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "read" },
		});
		expect((await request(FRIEND, `/${id}/interrupt`, { method: "POST" })).status).toBe(404);
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

	test("50-user batches preserve ordering, dedupe and per-user outcomes; 51 is refused", async () => {
		const id = await makeNarrator();
		const now = new Date().toISOString();
		const userIds = Array.from({ length: 50 }, () => generateId());
		await db.insert(users).values(
			userIds.map((userId) => ({
				id: userId,
				username: userId,
				passwordHash: "x",
				role: "user" as const,
				createdAt: now,
			})),
		);
		const created = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds, access: "read" },
		});
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({ granted: userIds, skipped: [], failed: [] });
		const upgraded = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds, access: "write" },
		});
		expect(upgraded.status).toBe(200);
		const upgradedBody = await upgraded.json();
		expect(upgradedBody.granted).toEqual(userIds);
		expect(upgradedBody.access.grants).toHaveLength(50);
		expect(
			upgradedBody.access.grants.every((grant: { access: string }) => grant.access === "write"),
		).toBe(true);
		const repeated = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: {
				userIds: [userIds[1], OWNER, "missing-batch-user", userIds[0], userIds[1], FRIEND],
				access: "write",
			},
		});
		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toMatchObject({
			granted: [FRIEND],
			skipped: [userIds[1], userIds[0]],
			failed: [OWNER, "missing-batch-user"],
		});
		const oversized = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [...userIds, STRANGER], access: "read" },
		});
		expect(oversized.status).toBe(400);
		const after = await (await request(OWNER, `/${id}/access`)).json();
		expect(after.grants).toHaveLength(51);
		expect(after.grants.every((grant: { access: string }) => grant.access === "write")).toBe(true);
		expect((await request(STRANGER, `/${id}`)).status).toBe(404);
	});

	test("existing multiple capabilities retain the legacy last-row batch outcome", async () => {
		const id = await makeNarrator();
		await db.insert(aclGrants).values(
			(["read", "write"] as const).map((capability) => ({
				id: generateId(),
				scopeType: "narrator" as const,
				scopeId: id,
				principalType: "user" as const,
				principalId: STRANGER,
				capability,
				grantedBy: OWNER,
				createdAt: new Date().toISOString(),
			})),
		);
		// Match the original batch's real SQL read and its Map's last-row choice;
		// these rows are valid under the capability-inclusive unique index.
		const held = await db
			.select({ access: aclGrants.capability })
			.from(aclGrants)
			.where(
				and(
					eq(aclGrants.scopeType, "narrator"),
					eq(aclGrants.scopeId, id),
					eq(aclGrants.principalType, "user"),
					isNull(aclGrants.domainKind),
					inArray(aclGrants.principalId, [STRANGER]),
				),
			);
		expect(held).toHaveLength(2);
		expect(held[1].access).toBe("write");
		const response = await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [STRANGER], access: "write" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ granted: [], skipped: [STRANGER], failed: [] });
	});

	test("a fourth held capability fails closed and rolls back earlier batch writes", async () => {
		const id = await makeNarrator();
		await db.insert(aclGrants).values(
			(["read", "write", "manage", "read"] as const).map((capability, index) => ({
				id: generateId(),
				scopeType: "narrator" as const,
				scopeId: id,
				principalType: "user" as const,
				principalId: STRANGER,
				capability,
				grantedBy: OWNER,
				createdAt: new Date().toISOString(),
				// A malformed legacy row remains in the unchanged sharing scope; a
				// non-null domain value bypasses the canonical capability unique index.
				domainValue: index === 3 ? "malformed-legacy-value" : null,
			})),
		);
		const grants = () =>
			db
				.select({
					id: aclGrants.id,
					principalId: aclGrants.principalId,
					capability: aclGrants.capability,
					domainKind: aclGrants.domainKind,
					domainValue: aclGrants.domainValue,
				})
				.from(aclGrants)
				.where(eq(aclGrants.scopeId, id))
				.limit(10)
				.all();
		const before = grants();
		expect(before).toHaveLength(4);
		const announcements = spyOn(narratorWs, "broadcastToUser");
		const drops = spyOn(narratorWs, "dropNarratorSubscriptionsForUnauthorizedUsers");
		const audits = spyOn(aclAudit, "recordAclEvent");
		try {
			const response = await request(OWNER, `/${id}/grants`, {
				method: "POST",
				body: { userIds: [FRIEND, STRANGER], access: "read" },
			});
			expect(response.status).toBe(400);
			expect((await response.json()).error).toMatch(/grant.*inconsistent/i);
			expect(grants()).toEqual(before);
			expect((await request(FRIEND, `/${id}`)).status).toBe(404);
			expect(announcements.mock.calls).toHaveLength(0);
			expect(drops.mock.calls).toHaveLength(0);
			expect(audits.mock.calls).toHaveLength(0);
		} finally {
			announcements.mockRestore();
			drops.mockRestore();
			audits.mockRestore();
		}
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

describe("write audience", () => {
	test("opening it to everyone lets a stranger drive the session", async () => {
		// The regression this whole axis exists for: a broad audience used to be settable
		// for reading only, so collaborators had to be added one by one before they could
		// do anything.
		//
		// Two steps, because the write audience is nested inside the read audience: you
		// cannot let everyone drive a session only you can open.
		const id = await makeNarrator();
		expect(
			(await request(STRANGER, `/${id}/model`, { method: "PATCH", body: { model: "m" } })).status,
		).toBe(404);

		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		const res = await request(OWNER, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "public" },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).writeAudience).toBe("public");

		expect(
			(await request(STRANGER, `/${id}/model`, { method: "PATCH", body: { model: "m" } })).status,
		).toBe(200);
	});

	test("setting a write audience wider than the read audience is refused", async () => {
		// The nesting is enforced at the boundary, and the message names the control to
		// change first rather than just reporting an invalid combination.
		const id = await makeNarrator();
		const res = await request(OWNER, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "public" },
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/visibility/i);
	});

	test("narrowing the read audience clamps the write audience instead of failing", async () => {
		// Tightening access must never be refused for producing an illegal pair.
		const id = await makeNarrator();
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		await request(OWNER, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "public" },
		});

		const res = await request(OWNER, `/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "private" },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).writeAudience).toBe("owner");
		expect(
			(await request(STRANGER, `/${id}/model`, { method: "PATCH", body: { model: "m" } })).status,
		).toBe(404);
	});

	test("narrowing it back to owner-only takes the ability away again", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		await request(OWNER, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "public" },
		});
		await request(OWNER, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "owner" },
		});
		expect(
			(await request(STRANGER, `/${id}/model`, { method: "PATCH", body: { model: "m" } })).status,
		).toBe(404);
	});

	test("a write-granted user cannot change the audience", async () => {
		// Driving a session is not deciding who else may. Visibility is opened first so
		// the request is a LEGAL pair — otherwise this would be refused by the nesting
		// rule and pass without ever exercising the ownership check it is about.
		const id = await makeNarrator();
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		await request(OWNER, `/${id}/grants`, {
			method: "POST",
			body: { userIds: [FRIEND], access: "write" },
		});
		const res = await request(FRIEND, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "public" },
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/owner or an administrator/i);
	});

	test("an unknown write audience value is rejected", async () => {
		const id = await makeNarrator();
		const res = await request(OWNER, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "anyone" },
		});
		expect(res.status).toBe(400);
	});

	test("the read audience alone still does not grant write", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		expect((await request(STRANGER, `/${id}`)).status).toBe(200);
		expect(
			(await request(STRANGER, `/${id}/model`, { method: "PATCH", body: { model: "m" } })).status,
		).toBe(404);
	});
});

describe("ownership transfer authorization and validation", () => {
	test("the owner can transfer, losing implicit access while the new owner gains management", async () => {
		const id = await makeNarrator();
		const transfer = await request(OWNER, `/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: FRIEND },
		});
		expect(transfer.status).toBe(200);
		expect(await transfer.json()).toMatchObject({ owner: { userId: FRIEND }, canManage: false });
		expect((await request(OWNER, `/${id}/access`)).status).toBe(404);
		const access = await request(FRIEND, `/${id}/access`);
		expect(access.status).toBe(200);
		expect(await access.json()).toMatchObject({ owner: { userId: FRIEND }, canManage: true });
	});

	test("a write grantee cannot take ownership or transfer it onward", async () => {
		const id = await makeNarrator();
		expect(
			(
				await request(OWNER, `/${id}/grants`, {
					method: "POST",
					body: { userIds: [FRIEND], access: "write" },
				})
			).status,
		).toBe(200);
		for (const userId of [FRIEND, STRANGER]) {
			const denied = await request(FRIEND, `/${id}/transfer-owner`, {
				method: "POST",
				body: { userId },
			});
			expect(denied.status).toBe(400);
			expect((await denied.json()).error).toMatch(/owner or an administrator/i);
		}
		expect((await (await request(OWNER, `/${id}/access`)).json()).owner.userId).toBe(OWNER);
	});

	test("strangers cannot enumerate or mutate ownership", async () => {
		const id = await makeNarrator();
		const denied = await request(STRANGER, `/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: STRANGER },
		});
		expect(denied.status).toBe(404);
		expect(await denied.json()).toHaveProperty("error");
		expect((await (await request(OWNER, `/${id}/access`)).json()).owner.userId).toBe(OWNER);
	});

	test("invalid targets cannot alter the existing owner", async () => {
		const id = await makeNarrator();
		for (const body of [{}, { userId: "" }, { userId: 42 }, { userId: "x".repeat(129) }])
			expect((await request(OWNER, `/${id}/transfer-owner`, { method: "POST", body })).status).toBe(
				400,
			);
		expect(
			(
				await request(OWNER, `/${id}/transfer-owner`, {
					method: "POST",
					body: { userId: "missing-user" },
				})
			).status,
		).toBe(404);
		expect((await (await request(OWNER, `/${id}/access`)).json()).owner.userId).toBe(OWNER);
	});

	test("only an admin may deliberately return a narrator to ownerless management", async () => {
		const id = await makeNarrator();
		const transfer = await request("share-admin", `/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: null },
			role: "admin",
		});
		expect(transfer.status).toBe(200);
		expect(await transfer.json()).toMatchObject({ owner: null, canManage: true });
		expect((await request(OWNER, `/${id}/access`)).status).toBe(404);
	});
});

describe("ownership transfer compare-and-swap races", () => {
	async function expectConflict(response: Response) {
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body).toEqual({ code: "NARRATOR_OWNERSHIP_CONFLICT", error: expect.any(String) });
		for (const userId of [OWNER, FRIEND, STRANGER]) expect(body.error).not.toContain(userId);
	}

	test("two authorized old-owner requests have exactly one winner and no loser announcement", async () => {
		const id = await makeNarrator();
		const hold = pauseTransferTargetLookups([FRIEND, STRANGER], 2);
		const announcements = spyOn(narratorWs, "broadcastToUser");
		const targets = [FRIEND, STRANGER];
		const pending = targets.map((userId) =>
			request(OWNER, `/${id}/transfer-owner`, { method: "POST", body: { userId } }),
		);
		try {
			await hold.ready();
			hold.release();
			const responses = await Promise.all(pending);
			expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
			const winner = responses.findIndex((response) => response.status === 200);
			const loser = responses.find((response) => response.status === 409);
			if (!loser) throw new Error("Missing ownership conflict");
			await expectConflict(loser);
			expect(await responses[winner].json()).toMatchObject({ owner: { userId: targets[winner] } });
			expect(
				(
					await db.query.narrators.findFirst({
						where: eq(narrators.id, id),
						columns: { ownerUserId: true },
					})
				)?.ownerUserId,
			).toBe(targets[winner]);
			const changed = announcements.mock.calls.filter(
				([, event]) => event.type === "narrator_access_changed" && event.narratorId === id,
			);
			expect(changed.map(([userId]) => userId).sort()).toEqual([OWNER, targets[winner]].sort());
		} finally {
			hold.release();
			await Promise.allSettled(pending);
			hold.restore();
			announcements.mockRestore();
		}
	});

	test("an old owner's delayed write cannot overwrite a completed admin reassignment", async () => {
		const id = await makeNarrator();
		const hold = pauseTransferTargetLookups([FRIEND], 1);
		const announcements = spyOn(narratorWs, "broadcastToUser");
		const oldOwner = request(OWNER, `/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: FRIEND },
		});
		try {
			await hold.ready();
			const admin = await request("share-admin", `/${id}/transfer-owner`, {
				method: "POST",
				body: { userId: STRANGER },
				role: "admin",
			});
			expect(admin.status).toBe(200);
			expect(await admin.json()).toMatchObject({ owner: { userId: STRANGER } });
			const count = announcements.mock.calls.length;
			hold.release();
			await expectConflict(await oldOwner);
			expect(announcements.mock.calls).toHaveLength(count);
			expect(
				(
					await db.query.narrators.findFirst({
						where: eq(narrators.id, id),
						columns: { ownerUserId: true },
					})
				)?.ownerUserId,
			).toBe(STRANGER);
		} finally {
			hold.release();
			await oldOwner;
			hold.restore();
			announcements.mockRestore();
		}
	});

	test("concurrent admins assigning an ownerless row also compare its null owner atomically", async () => {
		const id = await makeNarrator({ ownerUserId: null });
		const hold = pauseTransferTargetLookups([FRIEND, STRANGER], 2);
		const targets = [FRIEND, STRANGER];
		const pending = targets.map((userId) =>
			request("share-admin", `/${id}/transfer-owner`, {
				method: "POST",
				body: { userId },
				role: "admin",
			}),
		);
		try {
			await hold.ready();
			hold.release();
			const responses = await Promise.all(pending);
			expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
			const winner = responses.findIndex((response) => response.status === 200);
			const loser = responses.find((response) => response.status === 409);
			if (!loser) throw new Error("Missing null-owner conflict");
			await expectConflict(loser);
			expect(
				(
					await db.query.narrators.findFirst({
						where: eq(narrators.id, id),
						columns: { ownerUserId: true },
					})
				)?.ownerUserId,
			).toBe(targets[winner]);
		} finally {
			hold.release();
			await Promise.allSettled(pending);
			hold.restore();
		}
	});

	test("a row delegated after authorization cannot be mutated by the stale primary-owner write", async () => {
		const id = await makeNarrator();
		const hold = pauseTransferTargetLookups([FRIEND], 1);
		const transfer = request(OWNER, `/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: FRIEND },
		});
		try {
			await hold.ready();
			await db.update(narrators).set({ type: "subagent" }).where(eq(narrators.id, id));
			hold.release();
			await expectConflict(await transfer);
			expect(
				(
					await db.query.narrators.findFirst({
						where: eq(narrators.id, id),
						columns: { ownerUserId: true },
					})
				)?.ownerUserId,
			).toBe(OWNER);
		} finally {
			hold.release();
			await transfer;
			hold.restore();
		}
	});
});

describe("sharing mutations revalidate at the write boundary", () => {
	const mutations = [
		{ name: "visibility", path: "/visibility", method: "PATCH", body: { visibility: "private" } },
		{
			name: "write audience cannot restore the old owner's drive access",
			path: "/write-audience",
			method: "PATCH",
			body: { writeAudience: "public" },
		},
		{
			name: "grant create",
			path: "/grants",
			method: "POST",
			body: { userIds: [FRIEND], access: "write" },
		},
		{ name: "grant update", path: "/grants/:grant", method: "PATCH", body: { access: "write" } },
		{ name: "grant revoke", path: "/grants/:grant", method: "DELETE" },
		{
			name: "visibility no-op",
			path: "/visibility",
			method: "PATCH",
			body: { visibility: "public" },
		},
		{
			name: "write audience no-op",
			path: "/write-audience",
			method: "PATCH",
			body: { writeAudience: "owner" },
		},
		{
			name: "grant create no-op",
			path: "/grants",
			method: "POST",
			body: { userIds: [STRANGER], access: "read" },
		},
		{
			name: "grant update no-op",
			path: "/grants/:grant",
			method: "PATCH",
			body: { access: "read" },
		},
	] as const;

	async function snapshot(id: string) {
		return {
			row: await db.query.narrators.findFirst({
				where: eq(narrators.id, id),
				columns: { ownerUserId: true, type: true, visibility: true, writeAudience: true },
			}),
			grants: await db
				.select({
					id: aclGrants.id,
					principalId: aclGrants.principalId,
					capability: aclGrants.capability,
				})
				.from(aclGrants)
				.where(eq(aclGrants.scopeId, id))
				.limit(50),
		};
	}

	async function expectStaleMutation(
		mutation: (typeof mutations)[number],
		boundary: "handover" | "admin" | "null owner" | "delegated" = "handover",
	) {
		const id = await makeNarrator({ ownerUserId: boundary === "null owner" ? null : OWNER });
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, id));
		expect(
			(
				await request("share-admin", `/${id}/grants`, {
					method: "POST",
					body: { userIds: [STRANGER], access: "read" },
					role: "admin",
				})
			).status,
		).toBe(200);
		const grant = (await snapshot(id)).grants[0];
		const actor = boundary === "admin" || boundary === "null owner" ? "share-admin" : OWNER;
		const hold = pauseSuccessfulManagement(id, actor);
		const announcements = spyOn(narratorWs, "broadcastToUser");
		const drops = spyOn(narratorWs, "dropNarratorSubscriptionsForUnauthorizedUsers");
		const audits = spyOn(aclAudit, "recordAclEvent");
		const pending = request(actor, `/${id}${mutation.path.replace(":grant", grant.id)}`, {
			method: mutation.method,
			body: "body" in mutation ? mutation.body : undefined,
			role: actor === "share-admin" ? "admin" : "user",
		});
		try {
			await hold.ready();
			if (boundary === "delegated") {
				await db.update(narrators).set({ type: "subagent" }).where(eq(narrators.id, id));
			} else {
				expect(
					(
						await request("share-admin", `/${id}/transfer-owner`, {
							method: "POST",
							body: { userId: FRIEND },
							role: "admin",
						})
					).status,
				).toBe(200);
			}
			const before = await snapshot(id);
			const counts = [
				announcements.mock.calls.length,
				drops.mock.calls.length,
				audits.mock.calls.length,
			];
			hold.release();
			const response = await pending;
			expect(response.status).toBe(409);
			const body = await response.json();
			expect(body).toEqual({ code: "NARRATOR_OWNERSHIP_CONFLICT", error: expect.any(String) });
			for (const userId of [OWNER, FRIEND, STRANGER]) expect(body.error).not.toContain(userId);
			expect(await snapshot(id)).toEqual(before);
			expect([
				announcements.mock.calls.length,
				drops.mock.calls.length,
				audits.mock.calls.length,
			]).toEqual(counts);
			if (boundary === "handover") {
				expect(
					(await request(OWNER, `/${id}/model`, { method: "PATCH", body: { model: "m" } })).status,
				).toBe(404);
			}
		} finally {
			hold.release();
			await pending;
			hold.restore();
			announcements.mockRestore();
			drops.mockRestore();
			audits.mockRestore();
		}
	}

	for (const mutation of mutations) {
		test(`${mutation.name} conflicts after an admin handover, including no-ops`, async () => {
			await expectStaleMutation(mutation);
		});
	}
	for (const boundary of ["admin", "null owner", "delegated"] as const) {
		test(`grant creation revalidates the ${boundary} snapshot`, async () => {
			await expectStaleMutation(mutations[2], boundary);
		});
	}

	test("a subagent cannot manage any sharing mutation in place, even for an admin", async () => {
		const root = await makeNarrator();
		expect(
			(
				await request(OWNER, `/${root}/grants`, {
					method: "POST",
					body: { userIds: [STRANGER] },
				})
			).status,
		).toBe(200);
		const grant = (await snapshot(root)).grants[0];
		const child = await makeNarrator();
		await db
			.update(narrators)
			.set({ type: "subagent", aclRootNarratorId: root })
			.where(eq(narrators.id, child));
		const before = await snapshot(root);
		for (const actor of [OWNER, "share-admin"]) {
			for (const mutation of mutations.slice(0, 5)) {
				const response = await request(
					actor,
					`/${child}${mutation.path.replace(":grant", grant.id)}`,
					{
						method: mutation.method,
						body: "body" in mutation ? mutation.body : undefined,
						role: actor === "share-admin" ? "admin" : "user",
					},
				);
				expect(response.status).toBe(400);
				expect((await response.json()).error).toMatch(/subagent/i);
			}
		}
		expect(await snapshot(root)).toEqual(before);
		expect((await snapshot(child)).grants).toEqual([]);
	});

	test("same-owner visibility narrowing invalidates a delayed write audience widening", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		const hold = pauseSuccessfulManagement(id, OWNER);
		const pending = request(OWNER, `/${id}/write-audience`, {
			method: "PATCH",
			body: { writeAudience: "public" },
		});
		try {
			await hold.ready();
			expect(
				(
					await request(OWNER, `/${id}/visibility`, {
						method: "PATCH",
						body: { visibility: "private" },
					})
				).status,
			).toBe(200);
			hold.release();
			expect((await pending).status).toBe(400);
			expect((await snapshot(id)).row).toMatchObject({
				visibility: "private",
				writeAudience: "owner",
			});
		} finally {
			hold.release();
			await pending;
			hold.restore();
		}
	});

	test("same-owner visibility narrowing clamps the current, not stale, write audience", async () => {
		const id = await makeNarrator();
		await request(OWNER, `/${id}/visibility`, { method: "PATCH", body: { visibility: "public" } });
		const hold = pauseSuccessfulManagement(id, OWNER);
		const pending = request(OWNER, `/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "project" },
		});
		try {
			await hold.ready();
			expect(
				(
					await request(OWNER, `/${id}/write-audience`, {
						method: "PATCH",
						body: { writeAudience: "public" },
					})
				).status,
			).toBe(200);
			hold.release();
			expect((await pending).status).toBe(200);
			expect((await snapshot(id)).row).toMatchObject({
				visibility: "project",
				writeAudience: "project",
			});
		} finally {
			hold.release();
			await pending;
			hold.restore();
		}
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
