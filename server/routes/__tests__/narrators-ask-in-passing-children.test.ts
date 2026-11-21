import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { narrators, projects, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { withNarratorMutationAdmission } from "../../services/narrator-session-state";
import { narratorRoutes } from "../narrators";

const owner = generateId();
const other = generateId();
const projectId = generateId();
const now = "2026-10-01T00:00:00.000Z";

beforeAll(async () => {
	await db.insert(users).values(
		[owner, other].map((id) => ({
			id,
			username: `aip-${id}`,
			passwordHash: "fixture",
			role: "user" as const,
			createdAt: now,
		})),
	);
	await db.insert(projects).values({
		id: projectId,
		name: "Ask-in-passing test project",
		ownerUserId: owner,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	});
	// a-main(idle) 带两个顺便提问：一个还在用，一个已经被单独归档。
	// b-main(archived) 带一个归档的顺便提问。orphan 的父已经被删掉（parent 置空）。
	await db.insert(narrators).values([
		session("a-main", {
			updatedAt: "2026-10-02T00:00:00.000Z",
			contextProjectId: projectId,
			visibility: "private",
		}),
		session("a-child", {
			isAskInPassing: true,
			parentNarratorId: "a-main",
			status: "working",
			contextProjectId: projectId,
			visibility: "public",
		}),
		session("a-nested", {
			isAskInPassing: true,
			parentNarratorId: "a-child",
			askInPassingGroupId: "a-main",
			visibility: "private",
		}),
		session("a-archived-child", {
			isAskInPassing: true,
			parentNarratorId: "a-main",
			status: "archived",
		}),
		session("b-main", { status: "archived", updatedAt: "2026-10-03T00:00:00.000Z" }),
		session("b-child", {
			isAskInPassing: true,
			parentNarratorId: "b-main",
			status: "archived",
		}),
		session("orphan", { isAskInPassing: true }),
	]);
});

function session(
	id: string,
	overrides: Partial<typeof narrators.$inferInsert> = {},
): typeof narrators.$inferInsert {
	return {
		id,
		ownerUserId: owner,
		traits: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function appAs(userId: string) {
	return new Hono()
		.use("*", async (c, next) => {
			c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		})
		.onError((error) => {
			if (error instanceof AppError) {
				return new Response(JSON.stringify({ error: error.message, code: error.code }), {
					status: error.statusCode,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(error.message, { status: 500 });
		})
		.route("/narrators", narratorRoutes);
}

async function listNarrators(query = "?groupAskInPassing=true", viewer = owner) {
	const response = await appAs(viewer).request(`/narrators${query}`);
	if (!response.ok) throw new Error(await response.text());
	return (await response.json()) as {
		items: Array<{
			id: string;
			askInPassingSessions?: Array<{ id: string; parentNarratorId: string }>;
		}>;
	};
}

async function statusesOf(ids: string[]) {
	const rows = await db
		.select({ id: narrators.id, status: narrators.status })
		.from(narrators)
		.where(inArray(narrators.id, ids));
	return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

describe("顺便提问会话在列表里的位置", () => {
	test("活动列表把顺便提问收进父项，父被删的仍占一行", async () => {
		const body = await listNarrators();
		const ids = body.items.map((item) => item.id);
		expect(ids).not.toContain("a-child");
		expect(ids).toContain("orphan");

		const main = body.items.find((item) => item.id === "a-main");
		expect(main?.askInPassingSessions).toEqual([
			expect.objectContaining({ id: "a-nested", parentNarratorId: "a-child" }),
			expect.objectContaining({ id: "a-child", parentNarratorId: "a-main" }),
		]);
	});

	test("归档列表收进父项，父没归档的那条自己占一行", async () => {
		const body = await listNarrators("?status=archived&groupAskInPassing=true");
		const ids = body.items.map((item) => item.id);
		expect(ids).toContain("b-main");
		// a-main 还在活动列表里，它的归档子会话不能跟着消失。
		expect(ids).toContain("a-archived-child");
		expect(ids).not.toContain("b-child");

		const main = body.items.find((item) => item.id === "b-main");
		expect(main?.askInPassingSessions?.map((child) => child.id)).toEqual(["b-child"]);
	});

	test("flat consumers include a working child of an idle parent", async () => {
		for (const query of ["", "?status=working", `?projectId=${projectId}`]) {
			const body = await listNarrators(query);
			expect(body.items.find((item) => item.id === "a-child")).toBeDefined();
			expect(body.items.every((item) => item.askInPassingSessions === undefined)).toBe(true);
		}
	});

	test("a readable child of an inaccessible parent keeps its own row", async () => {
		const body = await listNarrators("?groupAskInPassing=true", other);
		expect(body.items.map((item) => item.id)).toContain("a-child");
		expect(body.items.map((item) => item.id)).not.toContain("a-main");
		expect(body.items.map((item) => item.id)).not.toContain("a-nested");
	});

	test("each parent gets its own cap and overflow stays visible", async () => {
		await db.insert(narrators).values([
			session("busy"),
			session("quiet"),
			session("quiet-question", { isAskInPassing: true, parentNarratorId: "quiet" }),
			...Array.from({ length: 41 }, (_, i) =>
				session(`busy-question-${i}`, {
					isAskInPassing: true,
					parentNarratorId: "busy",
					updatedAt: "2026-10-01T01:00:00.000Z",
				}),
			),
		]);
		const { items } = await listNarrators("?groupAskInPassing=true&limit=100");
		expect(items.find((row) => row.id === "busy")?.askInPassingSessions).toHaveLength(20);
		expect(items.find((row) => row.id === "quiet")?.askInPassingSessions).toEqual([
			expect.objectContaining({ id: "quiet-question" }),
		]);
		expect(items.filter((row) => row.id.startsWith("busy-question-"))).toHaveLength(21);
	});
});

describe("顺便提问会话随父会话归档", () => {
	test("归档父会话把它还没归档的顺便提问一起带走", async () => {
		const response = await appAs(owner).request("/narrators/a-main/archive", { method: "PATCH" });
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ok: boolean; archivedChildIds: string[] };
		expect(result.ok).toBe(true);
		expect(result.archivedChildIds.sort()).toEqual(["a-child", "a-nested"]);
		expect(await statusesOf(["a-main", "a-child"])).toEqual({
			"a-main": "archived",
			"a-child": "archived",
		});

		const body = await listNarrators("?status=archived&groupAskInPassing=true");
		const main = body.items.find((item) => item.id === "a-main");
		expect(main?.askInPassingSessions?.map((child) => child.id).sort()).toEqual([
			"a-archived-child",
			"a-child",
			"a-nested",
		]);
	});

	test("restores only children archived by the parent", async () => {
		const response = await appAs(owner).request("/narrators/a-main/unarchive", { method: "PATCH" });
		expect(response.status).toBe(200);
		expect(await statusesOf(["a-main", "a-child", "a-archived-child", "a-nested"])).toEqual({
			"a-main": "idle",
			"a-child": "idle",
			"a-archived-child": "archived",
			"a-nested": "idle",
		});
	});
});

test("checks each child's write permission in both directions", async () => {
	await db.insert(narrators).values([
		session("acl-main"),
		session("acl-read-only", {
			isAskInPassing: true,
			parentNarratorId: "acl-main",
			ownerUserId: other,
			visibility: "public",
			writeAudience: "owner",
		}),
		session("acl-writable", {
			isAskInPassing: true,
			parentNarratorId: "acl-main",
			ownerUserId: other,
			visibility: "public",
			writeAudience: "public",
		}),
	]);
	const app = appAs(owner);
	const archive = await app.request("/narrators/acl-main/archive", { method: "PATCH" });
	expect(archive.status).toBe(200);
	expect(await archive.json()).toEqual({ ok: true, archivedChildIds: ["acl-writable"] });
	await db
		.update(narrators)
		.set({ writeAudience: "owner" })
		.where(eq(narrators.id, "acl-writable"));
	const unarchive = await app.request("/narrators/acl-main/unarchive", { method: "PATCH" });
	expect(unarchive.status).toBe(200);
	expect(await statusesOf(["acl-main", "acl-read-only", "acl-writable"])).toEqual({
		"acl-main": "idle",
		"acl-read-only": "idle",
		"acl-writable": "archived",
	});
});

test("does not archive the group while a child has a competing runtime mutation", async () => {
	const parentId = "busy-parent";
	const childId = "busy-child";
	await db
		.insert(narrators)
		.values([
			session(parentId),
			session(childId, { isAskInPassing: true, parentNarratorId: parentId }),
		]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const reservation = withNarratorMutationAdmission(childId, async () => {
		entered.resolve();
		await release.promise;
	});
	try {
		await Promise.race([entered.promise, reservation]);
		const response = await appAs(owner).request(`/narrators/${parentId}/archive`, {
			method: "PATCH",
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "WORKSPACE_CONTEXT_BUSY" });
		expect(await statusesOf([parentId, childId])).toEqual({
			[parentId]: "idle",
			[childId]: "idle",
		});
	} finally {
		release.resolve();
		await reservation;
	}
});

for (const { action, before, failedRow } of [
	{ action: "archive", before: "idle", failedRow: "parent" },
	{ action: "archive", before: "idle", failedRow: "child" },
	{ action: "unarchive", before: "archived", failedRow: "child" },
] as const) {
	test(`${action} rolls back when the ${failedRow} status write fails`, async () => {
		const parentId = `atomic-${action}-${failedRow}`;
		const childId = `${parentId}-child`;
		await db.insert(narrators).values([
			session(parentId, { status: before }),
			session(childId, {
				status: before,
				isAskInPassing: true,
				parentNarratorId: parentId,
				archivedWithNarratorId: before === "archived" ? parentId : null,
			}),
		]);
		sqlite.exec(`CREATE TEMP TRIGGER cascade_failure BEFORE UPDATE OF status ON narrators
			WHEN OLD.id = '${failedRow === "parent" ? parentId : childId}'
			BEGIN SELECT RAISE(ABORT, 'injected status failure'); END;`);
		try {
			const response = await appAs(owner).request(`/narrators/${parentId}/${action}`, {
				method: "PATCH",
			});
			expect(response.status).toBe(500);
			expect(await statusesOf([parentId, childId])).toEqual({
				[parentId]: before,
				[childId]: before,
			});
		} finally {
			sqlite.exec("DROP TRIGGER cascade_failure");
		}
	});
}

test("does not report a child deleted before its update", async () => {
	await db
		.insert(narrators)
		.values([
			session("delete-main"),
			session("delete-child", { isAskInPassing: true, parentNarratorId: "delete-main" }),
		]);
	sqlite.exec(`CREATE TEMP TRIGGER remove_cascade_child AFTER UPDATE OF status ON narrators
		WHEN OLD.id = 'delete-main'
		BEGIN DELETE FROM narrators WHERE id = 'delete-child'; END;`);
	try {
		const response = await appAs(owner).request("/narrators/delete-main/archive", {
			method: "PATCH",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, archivedChildIds: [] });
		expect(await statusesOf(["delete-main", "delete-child"])).toEqual({
			"delete-main": "archived",
		});
	} finally {
		sqlite.exec("DROP TRIGGER remove_cascade_child");
	}
});
