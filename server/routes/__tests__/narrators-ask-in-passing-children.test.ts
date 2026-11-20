import { beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { narrators, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { askInPassingListParentId, narratorRoutes } from "../narrators";

const owner = generateId();
const now = "2026-10-01T00:00:00.000Z";

beforeAll(async () => {
	await db.insert(users).values({
		id: owner,
		username: `aip-${owner}`,
		passwordHash: "fixture",
		role: "user",
		createdAt: now,
	});
	// a-main(idle) 带两个顺便提问：一个还在用，一个已经被单独归档。
	// b-main(archived) 带一个归档的顺便提问。orphan 的父已经被删掉（parent 置空）。
	await db.insert(narrators).values([
		session("a-main", { updatedAt: "2026-10-02T00:00:00.000Z" }),
		session("a-child", { isAskInPassing: true, parentNarratorId: "a-main" }),
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
			throw error;
		})
		.route("/narrators", narratorRoutes);
}

async function listNarrators(query = "") {
	const response = await appAs(owner).request(`/narrators${query}`);
	expect(response.status).toBe(200);
	return (await response.json()) as {
		items: Array<{ id: string; askInPassingSessions: Array<{ id: string }> }>;
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
		expect(main?.askInPassingSessions.map((child) => child.id)).toEqual(["a-child"]);
	});

	test("归档列表收进父项，父没归档的那条自己占一行", async () => {
		const body = await listNarrators("?status=archived");
		const ids = body.items.map((item) => item.id);
		expect(ids).toContain("b-main");
		// a-main 还在活动列表里，它的归档子会话不能跟着消失。
		expect(ids).toContain("a-archived-child");
		expect(ids).not.toContain("b-child");

		const main = body.items.find((item) => item.id === "b-main");
		expect(main?.askInPassingSessions.map((child) => child.id)).toEqual(["b-child"]);
	});
});

describe("顺便提问会话随父会话归档", () => {
	test("归档父会话把它还没归档的顺便提问一起带走", async () => {
		const response = await appAs(owner).request("/narrators/a-main/archive", { method: "PATCH" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			archivedChildIds: ["a-child"],
		});
		expect(await statusesOf(["a-main", "a-child"])).toEqual({
			"a-main": "archived",
			"a-child": "archived",
		});

		const body = await listNarrators("?status=archived");
		const main = body.items.find((item) => item.id === "a-main");
		expect(main?.askInPassingSessions.map((child) => child.id).sort()).toEqual([
			"a-archived-child",
			"a-child",
		]);
	});

	test("解除归档父会话把它的顺便提问一起放回来", async () => {
		const response = await appAs(owner).request("/narrators/a-main/unarchive", { method: "PATCH" });
		expect(response.status).toBe(200);
		expect(await statusesOf(["a-main", "a-child", "a-archived-child"])).toEqual({
			"a-main": "idle",
			"a-child": "idle",
			"a-archived-child": "idle",
		});
	});
});

describe("嵌套的顺便提问拍平到最外层会话", () => {
	test("源会话是普通会话时挂到它自己名下", () => {
		expect(askInPassingListParentId({ isAskInPassing: false, parentNarratorId: null }, "src")).toBe(
			"src",
		);
	});

	test("源会话本身是顺便提问时挂到它的父会话", () => {
		expect(
			askInPassingListParentId({ isAskInPassing: true, parentNarratorId: "root" }, "src"),
		).toBe("root");
	});

	test("源会话没有父时不会挂到自己身上以外的地方", () => {
		expect(askInPassingListParentId({ isAskInPassing: true, parentNarratorId: null }, "src")).toBe(
			"src",
		);
		expect(askInPassingListParentId(null, "src")).toBe("src");
	});
});
