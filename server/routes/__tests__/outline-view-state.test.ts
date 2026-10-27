/**
 * `GET/PUT /api/outline/view-state/:pageId`: one person's folding and mind-map direction of a
 * page (design §6.10, §7.1).
 *
 * What must hold:
 *  - the defaults (nothing folded, rightward) until the person writes; a write replaces both
 *    and reads back; every person has their own;
 *  - read access is enough (a reader folds the page they may only read); a page in a space the
 *    person cannot read, a block that is not a page, a deleted page and an unknown id are all
 *    the same 404, and nothing is written;
 *  - the body is bounded: too many ids, an overlong id, an id that is not a block id (free
 *    text), an unknown direction and a body over the byte limit are refused; duplicate ids are
 *    kept once; ids that are not live blocks of the page (another page's, a deleted block's,
 *    made up) are dropped;
 *  - two surfaces or tabs of one person writing the same page: the last write wins;
 *  - with `outline.enabled` off the routes are a plain 404.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { OUTLINE_VIEW_STATE_LIMITS, type OutlineViewStateResponse } from "@shared/outline-api";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, projects, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { ensureProjectSpace } from "../../services/outline/spaces";
import { outlineStore } from "../../services/outline/store";
import { writeOutline } from "../../services/outline/write";
import { outlineRoutes } from "../outline";

const NOW = "2026-10-27T00:00:00.000Z";

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
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
	app.route("/outline", outlineRoutes);
	return app;
}

async function call(
	userId: string,
	method: "GET" | "PUT",
	pageId: string,
	body?: unknown,
): Promise<{ status: number; body: OutlineViewStateResponse & { code?: string } }> {
	const response = await appAs(userId).request(`http://localhost/outline/view-state/${pageId}`, {
		method,
		...(body !== undefined
			? {
					body: typeof body === "string" ? body : JSON.stringify(body),
					headers: { "content-type": "application/json" },
				}
			: {}),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: parsed as OutlineViewStateResponse & { code?: string } };
}

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

let alice: string;
let bob: string;
let carol: string;
let pageId: string;
let childId: string;
let deletedPageId: string;
let grandchildId: string;
let otherChildId: string;

beforeEach(() => {
	settings.outline.enabled = true;
});

beforeAll(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	bob = await user("bob");
	carol = await user("carol");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "View state",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	// Bob may read the project; Carol may not.
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: bob,
		capability: "read",
		createdAt: NOW,
	});
	const space = await ensureProjectSpace(projectId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Page" },
			{ op: "insert", tempId: "c", parent: { tempId: "p" }, content: "Child" },
			{ op: "insert", tempId: "g", parent: { tempId: "c" }, content: "Grandchild" },
			{ op: "insert", tempId: "d", parent: null, content: "Gone" },
			{ op: "insert", tempId: "o", parent: null, content: "Other page" },
			{ op: "insert", tempId: "oc", parent: { tempId: "o" }, content: "Other child" },
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	pageId = written.results[0]?.blockId as string;
	childId = written.results[1]?.blockId as string;
	grandchildId = written.results[2]?.blockId as string;
	deletedPageId = written.results[3]?.blockId as string;
	otherChildId = written.results[5]?.blockId as string;
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "delete", block: { id: deletedPageId } }],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
});

describe("outline view state", () => {
	test("defaults until written; a write replaces both parts and reads back", async () => {
		const first = await call(alice, "GET", pageId);
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ pageId, collapsed: [], layout: "right", updatedAt: null });

		const put = await call(alice, "PUT", pageId, { collapsed: [childId, childId], layout: "down" });
		expect(put.status).toBe(200);
		expect(put.body.collapsed).toEqual([childId]);
		expect(put.body.layout).toBe("down");
		expect(typeof put.body.updatedAt).toBe("string");

		const again = await call(alice, "GET", pageId);
		expect(again.body).toMatchObject({ pageId, collapsed: [childId], layout: "down" });

		const next = await call(alice, "PUT", pageId, { collapsed: [], layout: "right" });
		expect(next.body).toMatchObject({ collapsed: [], layout: "right" });
		expect((await call(alice, "GET", pageId)).body).toMatchObject({
			collapsed: [],
			layout: "right",
		});
	});

	test("each person has their own; read access is enough", async () => {
		await call(alice, "PUT", pageId, { collapsed: [childId], layout: "down" });
		expect((await call(bob, "GET", pageId)).body).toMatchObject({
			collapsed: [],
			layout: "right",
			updatedAt: null,
		});
		const bobPut = await call(bob, "PUT", pageId, {
			collapsed: [grandchildId, childId],
			layout: "right",
		});
		expect(bobPut.status).toBe(200);
		expect((await call(bob, "GET", pageId)).body.collapsed).toEqual([grandchildId, childId]);
		expect((await call(alice, "GET", pageId)).body).toMatchObject({
			collapsed: [childId],
			layout: "down",
		});
	});

	test("unreadable, not a page, deleted and unknown are the same 404; nothing written", async () => {
		for (const [who, id] of [
			[carol, pageId],
			[alice, childId],
			[alice, deletedPageId],
			[alice, "no-such-page"],
		] as const) {
			const read = await call(who, "GET", id);
			expect(read.status).toBe(404);
			const write = await call(who, "PUT", id, { collapsed: [childId], layout: "down" });
			expect(write.status).toBe(404);
			expect(await outlineStore.getViewState(who, id)).toBeNull();
		}
	});

	test("the body is bounded", async () => {
		const tooMany = Array.from(
			{ length: OUTLINE_VIEW_STATE_LIMITS.maxCollapsed + 1 },
			(_, i) => `id${i}`,
		);
		expect((await call(alice, "PUT", pageId, { collapsed: tooMany, layout: "right" })).status).toBe(
			400,
		);
		const longId = "x".repeat(OUTLINE_VIEW_STATE_LIMITS.maxIdChars + 1);
		expect(
			(await call(alice, "PUT", pageId, { collapsed: [longId], layout: "right" })).status,
		).toBe(400);
		expect((await call(alice, "PUT", pageId, { collapsed: [], layout: "left" })).status).toBe(400);
		expect((await call(alice, "PUT", pageId, { layout: "right" })).status).toBe(400);
		expect((await call(alice, "PUT", pageId, "not json")).status).toBe(400);
		const huge = JSON.stringify({
			collapsed: [],
			layout: "right",
			pad: "x".repeat(OUTLINE_VIEW_STATE_LIMITS.maxBodyBytes),
		});
		const big = await call(alice, "PUT", pageId, huge);
		expect(big.status).toBe(413);
		// Free text is not an id.
		for (const bad of ["has space", "长 id", "a/b", "short", "<script>x</script>"]) {
			expect({
				bad,
				status: (await call(alice, "PUT", pageId, { collapsed: [bad], layout: "right" })).status,
			}).toEqual({ bad, status: 400 });
		}
		// The most ids allowed fit within the byte limit; ids that are no blocks of the page are
		// dropped, so nothing of them is stored.
		const most = Array.from({ length: OUTLINE_VIEW_STATE_LIMITS.maxCollapsed }, () =>
			"y".repeat(OUTLINE_VIEW_STATE_LIMITS.maxIdChars - 5),
		).map((id, i) => `${id}${String(i).padStart(5, "0")}`);
		const ok = await call(alice, "PUT", pageId, {
			collapsed: [...most.slice(1), childId],
			layout: "right",
		});
		expect(ok.status).toBe(200);
		expect(ok.body.collapsed).toEqual([childId]);
		expect((await outlineStore.getViewState(alice, pageId))?.collapsed).toEqual([childId]);
	});

	test("only live blocks of the page are kept", async () => {
		const put = await call(alice, "PUT", pageId, {
			collapsed: [otherChildId, childId, deletedPageId, pageId, grandchildId, generateId()],
			layout: "down",
		});
		expect(put.status).toBe(200);
		// Another page's block, a deleted page and a made-up id go; the page and its blocks stay.
		expect(put.body.collapsed).toEqual([childId, pageId, grandchildId]);
	});

	test("two surfaces or tabs writing the same page: the last write wins", async () => {
		await call(alice, "PUT", pageId, { collapsed: [childId], layout: "down" });
		await call(alice, "PUT", pageId, { collapsed: [grandchildId], layout: "right" });
		expect((await call(alice, "GET", pageId)).body).toMatchObject({
			collapsed: [grandchildId],
			layout: "right",
		});
	});

	test("with the outline off the routes are a plain 404", async () => {
		settings.outline.enabled = false;
		expect((await call(alice, "GET", pageId)).status).toBe(404);
		expect((await call(alice, "PUT", pageId, { collapsed: [], layout: "right" })).status).toBe(404);
	});
});
