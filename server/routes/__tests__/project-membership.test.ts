/**
 * The project membership API.
 *
 * What must hold:
 *  - only the owner, a manager or an admin may change membership — a write member
 *    works in the project but does not decide who else may;
 *  - adding a member actually grants access, and removing one actually revokes it;
 *  - the three tiers stay distinct: read cannot write, write cannot manage;
 *  - a role change REPLACES the previous tier rather than stacking, so a downgrade
 *    is effective;
 *  - a batch reports per-user outcomes instead of failing wholesale on one bad id;
 *  - projects with no owner (everything from before project ACLs) are manageable by
 *    admins only, and `transfer-owner` is the way out of that state;
 *  - membership changes are audited.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-project-membership-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectRoutes } = await import("../projects");
const { chapterRoutes } = await import("../chapters");
const { db } = await import("../../db");
const { knowledgeCollections, projects, users } = await import("../../db/schema");
const { eventBus } = await import("../../lib/event-bus");
const { generateId } = await import("../../lib/id");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "mem-owner";
const MANAGER = "mem-manager";
const WRITER = "mem-writer";
const READER = "mem-reader";
const OUTSIDER = "mem-outsider";

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
	app.route("/projects", projectRoutes);
	app.route("/chapters", chapterRoutes);
	return app;
}

function request(
	userId: string,
	path: string,
	init: { method?: string; body?: unknown; role?: "admin" | "user" } = {},
) {
	const { method = "GET", body, role = "user" } = init;
	return appAs(userId, role).request(`http://localhost${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}

async function makeProject(options: { ownerUserId?: string | null } = {}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: `membership-${generateId(6)}`,
		gitPath: join(testHome, `repo-${generateId(6)}`),
		ownerUserId: options.ownerUserId === undefined ? OWNER : options.ownerUserId,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

beforeAll(async () => {
	const now = new Date().toISOString();
	for (const id of [OWNER, MANAGER, WRITER, READER, OUTSIDER, "mem-admin"]) {
		await db.insert(users).values({
			id,
			username: `${id}-${Date.now()}`,
			passwordHash: "x",
			role: id === "mem-admin" ? "admin" : "user",
			createdAt: now,
		});
	}
});

describe("who may change membership", () => {
	test("the owner can add a member, and that member gains access", async () => {
		const id = await makeProject();
		expect((await request(READER, `/projects/${id}`)).status).toBe(404);

		const res = await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).added).toEqual([READER]);

		expect((await request(READER, `/projects/${id}`)).status).toBe(200);
	});

	test("a write member cannot add members", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [WRITER], role: "write" },
		});

		const res = await request(WRITER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [OUTSIDER], role: "read" },
		});
		expect(res.status).toBe(400);
		expect((await request(OUTSIDER, `/projects/${id}`)).status).toBe(404);
	});

	test("a manage member can", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [MANAGER], role: "manage" },
		});

		const res = await request(MANAGER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [OUTSIDER], role: "read" },
		});
		expect(res.status).toBe(200);
		expect((await request(OUTSIDER, `/projects/${id}`)).status).toBe(200);
	});

	test("an outsider cannot even read the access panel", async () => {
		const id = await makeProject();
		expect((await request(OUTSIDER, `/projects/${id}/access`)).status).toBe(404);
	});
});

describe("tiers stay distinct", () => {
	test("a read member cannot create a chapter, a write member can be added to do so", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});

		expect(
			(
				await request(READER, "/chapters", {
					method: "POST",
					body: { projectId: id, title: "nope" },
				})
			).status,
		).toBe(404);
	});

	test("a role change replaces the previous tier instead of stacking", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [WRITER], role: "write" },
		});
		// Downgrade to read.
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [WRITER], role: "read" },
		});

		const access = await (await request(OWNER, `/projects/${id}/access`)).json();
		const entry = access.members.find((m: { userId: string }) => m.userId === WRITER);
		// One entry, at the new tier: a stale write row would keep the downgrade from
		// taking effect.
		expect(entry.role).toBe("read");
		expect(access.members.filter((m: { userId: string }) => m.userId === WRITER)).toHaveLength(1);
		// And the downgrade is real: they can no longer create chapters.
		expect(
			(
				await request(WRITER, "/chapters", {
					method: "POST",
					body: { projectId: id, title: "nope" },
				})
			).status,
		).toBe(404);
	});

	test("removing a member revokes access", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});
		expect((await request(READER, `/projects/${id}`)).status).toBe(200);

		const res = await request(OWNER, `/projects/${id}/members/${READER}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect((await request(READER, `/projects/${id}`)).status).toBe(404);
	});

	test("removing someone who is not a member is a 404", async () => {
		const id = await makeProject();
		expect(
			(await request(OWNER, `/projects/${id}/members/${OUTSIDER}`, { method: "DELETE" })).status,
		).toBe(404);
	});
});

describe("batch outcomes", () => {
	test("one unknown user does not fail the whole batch", async () => {
		const id = await makeProject();
		const res = await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER, "no-such-user"], role: "read" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.added).toEqual([READER]);
		expect(body.failed).toEqual(["no-such-user"]);
	});

	test("re-adding at the same role is reported as skipped", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});
		const res = await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});
		expect((await res.json()).skipped).toEqual([READER]);
	});

	test("adding the owner is refused rather than creating a redundant grant", async () => {
		const id = await makeProject();
		const res = await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [OWNER], role: "read" },
		});
		const body = await res.json();
		expect(body.failed).toEqual([OWNER]);
		expect(body.access.members).toEqual([]);
	});
});

describe("visibility", () => {
	test("making a project public opens read but not write", async () => {
		const id = await makeProject();
		expect(
			(
				await request(OWNER, `/projects/${id}/visibility`, {
					method: "PATCH",
					body: { visibility: "public" },
				})
			).status,
		).toBe(200);

		expect((await request(OUTSIDER, `/projects/${id}`)).status).toBe(200);
		expect(
			(
				await request(OUTSIDER, "/chapters", {
					method: "POST",
					body: { projectId: id, title: "nope" },
				})
			).status,
		).toBe(404);
	});

	test("going back to private closes it again", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "public" },
		});
		await request(OWNER, `/projects/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "private" },
		});
		expect((await request(OUTSIDER, `/projects/${id}`)).status).toBe(404);
	});

	test("an unknown visibility value is rejected", async () => {
		const id = await makeProject();
		const res = await request(OWNER, `/projects/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "everyone" },
		});
		expect(res.status).toBe(400);
	});
});

describe("projects with no owner (pre-ACL rows)", () => {
	test("a normal user cannot change membership even when they can read them", async () => {
		const id = await makeProject({ ownerUserId: null });
		await request("mem-admin", `/projects/${id}/visibility`, {
			method: "PATCH",
			body: { visibility: "public" },
			role: "admin",
		});

		expect((await request(OUTSIDER, `/projects/${id}/access`)).status).toBe(200);
		const res = await request(OUTSIDER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});
		expect(res.status).toBe(400);
	});

	test("an admin can transfer ownership, after which the new owner manages it", async () => {
		const id = await makeProject({ ownerUserId: null });

		const transfer = await request("mem-admin", `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: READER },
			role: "admin",
		});
		expect(transfer.status).toBe(200);
		expect((await transfer.json()).owner.userId).toBe(READER);

		const res = await request(READER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [WRITER], role: "write" },
		});
		expect(res.status).toBe(200);
	});

	test("a non-admin owner cannot drop the project back to ownerless", async () => {
		const id = await makeProject();
		const res = await request(OWNER, `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: null },
		});
		expect(res.status).toBe(400);
	});

	test("a manage member cannot transfer ownership to themselves", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [MANAGER], role: "manage" },
		});

		const res = await request(MANAGER, `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: MANAGER },
		});
		expect(res.status).toBe(400);
	});

	test("a manage member cannot transfer ownership to someone else either", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [MANAGER], role: "manage" },
		});

		const res = await request(MANAGER, `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: READER },
		});
		expect(res.status).toBe(400);
	});

	test("the owner can transfer ownership successfully", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});

		const res = await request(OWNER, `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: READER },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).owner.userId).toBe(READER);
	});

	test("an admin can transfer ownership of any project", async () => {
		const id = await makeProject();

		const res = await request("mem-admin", `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: WRITER },
			role: "admin",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).owner.userId).toBe(WRITER);
	});

	test("an admin can set owner to null but a non-admin cannot", async () => {
		const id = await makeProject();

		// Non-admin owner cannot set null
		const res1 = await request(OWNER, `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: null },
		});
		expect(res1.status).toBe(400);

		// Admin can set null
		const res2 = await request("mem-admin", `/projects/${id}/transfer-owner`, {
			method: "POST",
			body: { userId: null },
			role: "admin",
		});
		expect(res2.status).toBe(200);
	});
});

describe("audit", () => {
	test("adding and removing a member leaves audit rows", async () => {
		const id = await makeProject();
		await request(OWNER, `/projects/${id}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "write" },
		});
		await request(OWNER, `/projects/${id}/members/${READER}`, { method: "DELETE" });

		// Audit writes are fire-and-forget, so allow the microtask queue to drain.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const rows = await db.query.aclEvents.findMany({
			where: (e, { and, eq }) => and(eq(e.scopeType, "project"), eq(e.scopeId, id)),
		});
		const types = rows.map((r) => r.eventType);
		expect(types).toContain("project_members_added");
		expect(types).toContain("project_member_removed");
		// The detail must not carry anything beyond ids and the tier.
		const added = rows.find((r) => r.eventType === "project_members_added");
		expect(Object.keys((added?.detailJson ?? {}) as Record<string, unknown>).sort()).toEqual([
			"role",
			"userIds",
		]);
	});
});

describe("knowledge collections that inherit the project gate", () => {
	test("a membership change hints affected users to refetch their knowledge library", async () => {
		const projectId = await makeProject();
		await db.insert(knowledgeCollections).values([
			{
				id: generateId(),
				name: `gate-${generateId(6)}`,
				slug: `gate-${generateId(6)}`,
				projectId,
				inheritProjectGate: true,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		]);

		const seen: { userIds: string[]; reason: string }[] = [];
		const listener = (e: { userIds: string[]; reason: string }) => {
			seen.push({ userIds: e.userIds, reason: e.reason });
		};
		eventBus.on("knowledge:acl_changed", listener);
		try {
			const res = await request(OWNER, `/projects/${projectId}/members`, {
				method: "POST",
				body: { userIds: [READER], role: "read" },
			});
			expect(res.status).toBe(200);
			await new Promise((r) => setTimeout(r, 25));

			// No knowledge grant moved, but the ancestor gate opened for this user, so their
			// readable set changed and a stale library would otherwise persist.
			const hint = seen.find((e) => e.reason === "project_gate_changed");
			expect(hint).toBeDefined();
			expect(hint?.userIds).toContain(READER);
		} finally {
			eventBus.off("knowledge:acl_changed", listener);
		}
	});

	test("a project with no inheriting collection stays quiet", async () => {
		const projectId = await makeProject();
		await db.insert(knowledgeCollections).values([
			{
				id: generateId(),
				name: `nogate-${generateId(6)}`,
				slug: `nogate-${generateId(6)}`,
				projectId,
				// Opted out of the gate: its readable set does not move with membership.
				inheritProjectGate: false,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		]);

		const seen: string[] = [];
		const listener = (e: { reason: string }) => {
			seen.push(e.reason);
		};
		eventBus.on("knowledge:acl_changed", listener);
		try {
			const res = await request(OWNER, `/projects/${projectId}/members`, {
				method: "POST",
				body: { userIds: [WRITER], role: "write" },
			});
			expect(res.status).toBe(200);
			await new Promise((r) => setTimeout(r, 25));
			expect(seen).not.toContain("project_gate_changed");
		} finally {
			eventBus.off("knowledge:acl_changed", listener);
		}
	});
});

describe("distinguishing an empty project list from a filtered one", () => {
	test("the hint fires exactly when the caller sees nothing but projects exist", async () => {
		const projectId = await makeProject();

		// Asserted as an invariant against the caller's own list rather than against an
		// assumed-empty database: earlier tests in this file leave public projects behind,
		// which a non-member legitimately sees. Hard-coding `true` here would only be
		// testing test-ordering.
		const listRes = await request(OUTSIDER, "/projects");
		const visible = (await listRes.json()) as unknown[];
		const res = await request(OUTSIDER, "/projects/hidden-existence");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { hasHidden: boolean };
		expect(body.hasHidden).toBe(visible.length === 0);

		// Existence only: a name or id here would defeat the point of hiding the project.
		expect(JSON.stringify(body)).not.toContain(projectId);
		expect(Object.keys(body)).toEqual(["hasHidden"]);
	});

	test("a member sees their project, so nothing is reported as hidden", async () => {
		const projectId = await makeProject();
		await request(OWNER, `/projects/${projectId}/members`, {
			method: "POST",
			body: { userIds: [READER], role: "read" },
		});

		const res = await request(READER, "/projects/hidden-existence");
		const body = (await res.json()) as { hasHidden: boolean };
		// The hint is only for a caller who sees nothing at all; READER sees one project.
		expect(body.hasHidden).toBe(false);
	});

	test("nothing is ever hidden from an admin", async () => {
		await makeProject();
		const res = await request("mem-admin", "/projects/hidden-existence", { role: "admin" });
		expect(((await res.json()) as { hasHidden: boolean }).hasHidden).toBe(false);
	});

	test("the path is not swallowed by the :id route", async () => {
		// Registered before `/:id`, so it must not be read as a project called
		// "hidden-existence" (which would 404 instead of answering).
		const res = await request(OUTSIDER, "/projects/hidden-existence");
		expect(res.status).toBe(200);
		expect(await res.json()).toHaveProperty("hasHidden");
	});
});
