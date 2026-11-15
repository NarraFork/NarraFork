/**
 * `GET/PUT /api/outline/spaces/:spaceId/fold-state`: one reader's own folding of a space, by
 * block (pageless outline, F1), and the folded reads that follow it.
 *
 * What must hold:
 *  - nothing stored until the person writes; a write carries changes (an unnamed block keeps
 *    what it had, `open: null` puts a block back to its default) and reads back;
 *  - every person has their own: nobody reads or writes another person's, and the user is the
 *    session's, never something the request names;
 *  - read access is enough (a reader folds what they may only read); a space the person cannot
 *    read is a 404 exactly like one that does not exist, on both methods, and nothing is
 *    written;
 *  - a write is bounded: too many changes, a malformed id, a body over the byte limit are
 *    refused; ids that are not live blocks of the space (another space's, a deleted block's,
 *    made up) are dropped;
 *  - a reader keeps at most the cap of rows per space;
 *  - a folded read of a subtree follows the stored folding of its reader and nobody else's; a
 *    folded read of a whole space with `top=closed` goes below a top-level block only when its
 *    reader opened it;
 *  - with `outline.enabled` off the routes are a plain 404.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	OUTLINE_FOLD_STATE_LIMITS,
	type OutlineFoldStateResponse,
	type OutlineSubtreeResponse,
} from "@shared/outline-subtree-api";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, outlineFoldState, projects, users } from "../../db/schema";
import { toErrorPayload } from "../../lib/app-error-response";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { writeFoldState } from "../../services/outline/fold-state";
import { ensureProjectSpace } from "../../services/outline/spaces";
import { outlineStore } from "../../services/outline/store";
import type { OutlineSpaceRow } from "../../services/outline/store/port";
import { type OutlineOp, writeOutline } from "../../services/outline/write";
import { outlineRoutes } from "../outline";

const NOW = "2026-11-15T00:00:00.000Z";

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify(toErrorPayload(error)), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/outline", outlineRoutes);
	return app;
}

async function call<T = OutlineFoldStateResponse>(
	userId: string,
	method: "GET" | "PUT",
	path: string,
	body?: unknown,
): Promise<{ status: number; body: T }> {
	const response = await appAs(userId).request(`http://localhost/outline${path}`, {
		method,
		...(body !== undefined
			? {
					headers: { "content-type": "application/json" },
					body: typeof body === "string" ? body : JSON.stringify(body),
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
	return { status: response.status, body: parsed as T };
}

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function project(owner: string, readers: string[] = []): Promise<OutlineSpaceRow> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `Project ${id}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	for (const reader of readers) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: id,
			principalType: "user",
			principalId: reader,
			capability: "read",
			createdAt: NOW,
		});
	}
	return ensureProjectSpace(id);
}

async function write(space: OutlineSpaceRow, ops: OutlineOp[], actor: string) {
	return (
		await writeOutline({
			spaceId: space.id,
			ops,
			actor: { kind: "human", id: actor },
			responsibleUserId: actor,
		})
	).results.map((result) => result.blockId);
}

let alice: string;
let bob: string;
let mallory: string;
let space: OutlineSpaceRow;
let other: OutlineSpaceRow;
/** Top-level blocks `top1`, `top2`; under `top1`: a fact with a child, a finished task with a note. */
let ids: {
	top1: string;
	top2: string;
	fact: string;
	factChild: string;
	done: string;
	note: string;
};
let elsewhere: string;
let deleted: string;

const sorted = (list: string[]) => [...list].sort();
const foldPath = () => `/spaces/${space.id}/fold-state`;

beforeAll(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	bob = await user("bob");
	mallory = await user("mallory");
	space = await project(alice, [bob]);
	other = await project(mallory);
	const made = await write(
		space,
		[
			{ op: "insert", tempId: "t1", parent: null, content: "Top one" },
			{ op: "insert", tempId: "t2", parent: null, content: "Top two" },
			{ op: "insert", tempId: "f", parent: { tempId: "t1" }, content: "A fact" },
			{ op: "insert", tempId: "fc", parent: { tempId: "f" }, content: "Under the fact" },
			{
				op: "insert",
				tempId: "d",
				parent: { tempId: "t1" },
				content: "A finished task",
				task: { status: "done" },
			},
			{ op: "insert", tempId: "n", parent: { tempId: "d" }, content: "Its result" },
			{ op: "insert", tempId: "x", parent: { tempId: "t2" }, content: "Soon deleted" },
		],
		alice,
	);
	ids = {
		top1: made[0] as string,
		top2: made[1] as string,
		fact: made[2] as string,
		factChild: made[3] as string,
		done: made[4] as string,
		note: made[5] as string,
	};
	deleted = made[6] as string;
	await write(space, [{ op: "delete", block: { id: deleted } }], alice);
	elsewhere = (
		await write(other, [{ op: "insert", parent: null, content: "Elsewhere" }], mallory)
	)[0] as string;
});

beforeEach(async () => {
	settings.outline.enabled = true;
	await db.delete(outlineFoldState).where(eq(outlineFoldState.spaceId, space.id));
});

describe("a reader's own folding of a space", () => {
	test("nothing until written; a write carries changes and reads back", async () => {
		expect((await call(alice, "GET", foldPath())).body).toEqual({
			spaceId: space.id,
			expanded: [],
			collapsed: [],
		});
		const first = await call(alice, "PUT", foldPath(), {
			changes: [
				{ blockId: ids.done, open: true },
				{ blockId: ids.fact, open: false },
			],
		});
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ spaceId: space.id, expanded: [ids.done], collapsed: [ids.fact] });
		// An unnamed block keeps what it had; a named one is replaced; null goes back to default.
		const second = await call(alice, "PUT", foldPath(), {
			changes: [
				{ blockId: ids.top1, open: true },
				{ blockId: ids.fact, open: null },
				// Named twice: the last change wins.
				{ blockId: ids.top2, open: false },
				{ blockId: ids.top2, open: true },
			],
		});
		expect(sorted(second.body.expanded)).toEqual(sorted([ids.done, ids.top1, ids.top2]));
		expect(second.body.collapsed).toEqual([]);
		const read = await call(alice, "GET", foldPath());
		expect(sorted(read.body.expanded)).toEqual(sorted([ids.done, ids.top1, ids.top2]));
	});

	test("every person has their own; a reader may fold what they may only read", async () => {
		await call(alice, "PUT", foldPath(), { changes: [{ blockId: ids.done, open: true }] });
		expect((await call(bob, "GET", foldPath())).body.expanded).toEqual([]);
		const bobs = await call(bob, "PUT", foldPath(), {
			changes: [{ blockId: ids.fact, open: false }],
		});
		expect(bobs.status).toBe(200);
		expect(bobs.body).toEqual({ spaceId: space.id, expanded: [], collapsed: [ids.fact] });
		// Bob's write changed nothing of Alice's, and removing "her" block removes only his row.
		await call(bob, "PUT", foldPath(), { changes: [{ blockId: ids.done, open: null }] });
		expect((await call(alice, "GET", foldPath())).body).toEqual({
			spaceId: space.id,
			expanded: [ids.done],
			collapsed: [],
		});
		// The user is the session's: a body naming another user is not a thing the route reads.
		const sneaky = await call(bob, "PUT", foldPath(), {
			userId: alice,
			changes: [{ blockId: ids.done, open: false }],
		});
		expect(sneaky.status).toBe(200);
		expect((await call(alice, "GET", foldPath())).body.expanded).toEqual([ids.done]);
		expect((await call(bob, "GET", foldPath())).body.collapsed).toContain(ids.done);
	});

	test("a space the person cannot read is 404 like one that does not exist; nothing is written", async () => {
		const missing = `/spaces/${generateId()}/fold-state`;
		const noAccess = await call(mallory, "GET", foldPath());
		const unknown = await call(mallory, "GET", missing);
		expect(noAccess.status).toBe(404);
		expect(unknown.status).toBe(404);
		const put = await call(mallory, "PUT", foldPath(), {
			changes: [{ blockId: ids.done, open: true }],
		});
		expect(put.status).toBe(404);
		expect(
			(await call(mallory, "PUT", missing, { changes: [{ blockId: ids.done, open: true }] }))
				.status,
		).toBe(404);
		const rows = await db
			.select()
			.from(outlineFoldState)
			.where(eq(outlineFoldState.userId, mallory));
		expect(rows).toEqual([]);
	});

	test("bounded: too many changes, a malformed id, an oversized body and bad JSON are refused", async () => {
		const many = Array.from({ length: OUTLINE_FOLD_STATE_LIMITS.maxChanges + 1 }, () => ({
			blockId: generateId(),
			open: true,
		}));
		expect((await call(alice, "PUT", foldPath(), { changes: many })).status).toBe(400);
		expect((await call(alice, "PUT", foldPath(), { changes: [] })).status).toBe(400);
		expect(
			(
				await call(alice, "PUT", foldPath(), {
					changes: [{ blockId: "x".repeat(400), open: true }],
				})
			).status,
		).toBe(400);
		expect(
			(await call(alice, "PUT", foldPath(), { changes: [{ blockId: ids.done, open: "yes" }] }))
				.status,
		).toBe(400);
		expect((await call(alice, "PUT", foldPath(), "{not json")).status).toBe(400);
		const huge = JSON.stringify({
			changes: [{ blockId: ids.done, open: true }],
			pad: "x".repeat(OUTLINE_FOLD_STATE_LIMITS.maxBodyBytes),
		});
		expect((await call(alice, "PUT", foldPath(), huge)).status).toBe(413);
		expect((await call(alice, "GET", foldPath())).body.expanded).toEqual([]);
	});

	test("ids that are not live blocks of the space are dropped", async () => {
		const result = await call(alice, "PUT", foldPath(), {
			changes: [
				{ blockId: elsewhere, open: true },
				{ blockId: deleted, open: true },
				{ blockId: generateId(), open: false },
				{ blockId: ids.fact, open: false },
			],
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ spaceId: space.id, expanded: [], collapsed: [ids.fact] });
		const rows = await db
			.select({ id: outlineFoldState.blockId })
			.from(outlineFoldState)
			.where(eq(outlineFoldState.userId, alice));
		expect(rows.map((row) => row.id)).toEqual([ids.fact]);
	});

	test("a reader keeps at most the cap of rows per space", async () => {
		const big = await project(alice);
		const blocks: string[] = [];
		for (let i = 0; i < 3; i++) {
			blocks.push(
				...(await write(
					big,
					Array.from({ length: 180 }, (_, n) => ({
						op: "insert" as const,
						parent: null,
						content: `row ${i}-${n}`,
					})),
					alice,
				)),
			);
		}
		const cap = 300;
		let at = 0;
		for (let from = 0; from < blocks.length; from += 180) {
			await outlineStore.putFoldState(
				alice,
				big.id,
				blocks.slice(from, from + 180).map((blockId) => ({ blockId, open: true })),
				`2026-11-15T00:00:0${at++}.000Z`,
				cap,
			);
		}
		const rows = await outlineStore.listFoldState(alice, big.id, 1000);
		expect(rows.length).toBe(cap);
		// The newest write is whole; the oldest is what made room.
		const kept = new Set(rows.map((row) => row.blockId));
		expect(blocks.slice(360).every((id) => kept.has(id))).toBe(true);
		expect(blocks.slice(0, 180).some((id) => kept.has(id))).toBe(false);
		// The service's own cap is the shared limit.
		const written = await writeFoldState(alice, big, [
			{ blockId: blocks[0] as string, open: false },
		]);
		expect(written.collapsed).toEqual([blocks[0] as string]);
		expect(written.expanded.length).toBeLessThanOrEqual(OUTLINE_FOLD_STATE_LIMITS.maxPerSpace);
	});

	test("with the outline off the routes are a plain 404", async () => {
		settings.outline.enabled = false;
		expect((await call(alice, "GET", foldPath())).status).toBe(404);
		expect(
			(await call(alice, "PUT", foldPath(), { changes: [{ blockId: ids.done, open: true }] }))
				.status,
		).toBe(404);
		settings.outline.enabled = true;
		expect(
			await db
				.select()
				.from(outlineFoldState)
				.where(and(eq(outlineFoldState.userId, alice), eq(outlineFoldState.spaceId, space.id))),
		).toEqual([]);
	});
});

describe("folded reads follow the reader's own folding", () => {
	const subtree = (who: string, path: string) =>
		call<OutlineSubtreeResponse>(who, "GET", `/spaces/${space.id}${path}`);
	const has = (read: OutlineSubtreeResponse, id: string) => read.blocks.some((b) => b.id === id);

	test("a block's subtree: closed by default until its reader opens it, and only for them", async () => {
		const path = `/blocks/${ids.top1}/subtree?view=all&fold=default`;
		const before = (await subtree(alice, path)).body;
		expect(before.closed).toContain(ids.done);
		expect(has(before, ids.factChild)).toBe(true);
		await call(alice, "PUT", foldPath(), {
			changes: [
				{ blockId: ids.done, open: true },
				{ blockId: ids.fact, open: false },
			],
		});
		const after = (await subtree(alice, path)).body;
		expect(after.closed).not.toContain(ids.done);
		expect(after.closed).toContain(ids.fact);
		expect(has(after, ids.note)).toBe(true);
		// Bob reads the default.
		const bobs = (await subtree(bob, path)).body;
		expect(bobs.closed).toContain(ids.done);
		expect(bobs.closed).not.toContain(ids.fact);
	});

	test("a whole space with top=closed: below a top-level block only when its reader opened it", async () => {
		const path = "/subtree?view=all&fold=default&top=closed";
		const landing = (await subtree(alice, path)).body;
		expect(landing.rootId).toBeNull();
		expect(sorted(landing.closed ?? [])).toEqual(sorted([ids.top1]));
		// (`top2` has no live child: nothing to close.)
		expect(has(landing, ids.top1)).toBe(true);
		expect(has(landing, ids.top2)).toBe(true);
		// The one child its preview line is read from, nothing deeper.
		expect(has(landing, ids.fact)).toBe(true);
		expect(has(landing, ids.factChild)).toBe(false);
		await call(alice, "PUT", foldPath(), { changes: [{ blockId: ids.top1, open: true }] });
		const opened = (await subtree(alice, path)).body;
		expect(opened.closed).not.toContain(ids.top1);
		// Under it the default folding: the fact open, the finished task closed.
		expect(has(opened, ids.factChild)).toBe(true);
		expect(opened.closed).toContain(ids.done);
		// Without `top=closed` the space reads by the default alone, as before.
		const plain = (await subtree(bob, "/subtree?view=all&fold=default")).body;
		expect(plain.closed).not.toContain(ids.top1);
		expect(has(plain, ids.factChild)).toBe(true);
	});
});
