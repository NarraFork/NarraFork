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
 *  - a reset (`DELETE`, optionally `?under=<block>`) is one request: the whole space, or the
 *    block and what is under it, nothing of anyone else's or of another space;
 *  - `GET open-tasks?under=` lists the open tasks under a block (in progress first), what the
 *    marks' count counted, cursor-paged, with read access, 404 like the others;
 *  - with `outline.enabled` off the routes are a plain 404.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	OUTLINE_FOLD_STATE_LIMITS,
	type OutlineFoldStateResponse,
	type OutlineMarksResponse,
	type OutlineOpenTasksResponse,
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
import { resetFoldWritersForTests, writeFoldState } from "../../services/outline/fold-state";
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
	method: "GET" | "PUT" | "DELETE",
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

describe("back to the default in one request", () => {
	test("the whole space: every row of the reader's, nobody else's, no other space's", async () => {
		await call(alice, "PUT", foldPath(), {
			changes: [
				{ blockId: ids.top1, open: true },
				{ blockId: ids.fact, open: false },
				{ blockId: ids.done, open: true },
			],
		});
		await call(bob, "PUT", foldPath(), { changes: [{ blockId: ids.fact, open: false }] });
		await call(mallory, "PUT", `/spaces/${other.id}/fold-state`, {
			changes: [{ blockId: elsewhere, open: true }],
		});
		const reset = await call(alice, "DELETE", foldPath());
		expect(reset.status).toBe(200);
		expect(reset.body).toEqual({ spaceId: space.id, expanded: [], collapsed: [] });
		expect((await call(bob, "GET", foldPath())).body.collapsed).toEqual([ids.fact]);
		expect((await call(mallory, "GET", `/spaces/${other.id}/fold-state`)).body.expanded).toEqual([
			elsewhere,
		]);
		// `under` the space's own id is the whole space too.
		await call(alice, "PUT", foldPath(), { changes: [{ blockId: ids.top1, open: true }] });
		expect((await call(alice, "DELETE", `${foldPath()}?under=${space.id}`)).body.expanded).toEqual(
			[],
		);
	});

	test("under a block: the block and what is under it, the rest stays", async () => {
		await call(alice, "PUT", foldPath(), {
			changes: [
				{ blockId: ids.top1, open: true },
				{ blockId: ids.fact, open: false },
				{ blockId: ids.done, open: true },
				{ blockId: ids.top2, open: true },
			],
		});
		const under = await call(alice, "DELETE", `${foldPath()}?under=${ids.fact}`);
		expect(under.status).toBe(200);
		expect(sorted(under.body.expanded)).toEqual(sorted([ids.top1, ids.done, ids.top2]));
		expect(under.body.collapsed).toEqual([]);
		const top = await call(alice, "DELETE", `${foldPath()}?under=${ids.top1}`);
		expect(top.body).toEqual({ spaceId: space.id, expanded: [ids.top2], collapsed: [] });
		// A block of another space, or made up: nothing matches, nothing else goes.
		expect((await call(alice, "DELETE", `${foldPath()}?under=${elsewhere}`)).body.expanded).toEqual(
			[ids.top2],
		);
		expect((await call(alice, "DELETE", `${foldPath()}?under=${"x".repeat(400)}`)).status).toBe(
			400,
		);
	});

	test("access as the other fold routes: 404 without read access or with the outline off", async () => {
		await call(alice, "PUT", foldPath(), { changes: [{ blockId: ids.top1, open: true }] });
		expect((await call(mallory, "DELETE", foldPath())).status).toBe(404);
		expect((await call(mallory, "DELETE", `/spaces/${generateId()}/fold-state`)).status).toBe(404);
		expect((await call(bob, "DELETE", foldPath())).status).toBe(200);
		settings.outline.enabled = false;
		expect((await call(alice, "DELETE", foldPath())).status).toBe(404);
		settings.outline.enabled = true;
		expect((await call(alice, "GET", foldPath())).body.expanded).toEqual([ids.top1]);
	});
});

describe("one write: resets, then changes, in order of the writer's numbers", () => {
	test("a write's resets apply before its changes, in one request", async () => {
		await call(alice, "PUT", foldPath(), {
			changes: [
				{ blockId: ids.top1, open: true },
				{ blockId: ids.fact, open: false },
				{ blockId: ids.done, open: true },
				{ blockId: ids.top2, open: true },
			],
		});
		// Back to the default under top1, and then the fact closed again: the change survives.
		const both = await call(alice, "PUT", foldPath(), {
			reset: [ids.top1],
			changes: [{ blockId: ids.fact, open: false }],
		});
		expect(both.status).toBe(200);
		expect(both.body).toEqual({ spaceId: space.id, expanded: [ids.top2], collapsed: [ids.fact] });
		// The whole space (null), then a change.
		const whole = await call(alice, "PUT", foldPath(), {
			reset: [null],
			changes: [{ blockId: ids.done, open: true }],
		});
		expect(whole.body).toEqual({ spaceId: space.id, expanded: [ids.done], collapsed: [] });
		// Resets alone are a write; nothing at all is not.
		expect((await call(alice, "PUT", foldPath(), { reset: [ids.done] })).body.expanded).toEqual([]);
		expect((await call(alice, "PUT", foldPath(), { reset: [] })).status).toBe(400);
		expect(
			(await call(alice, "PUT", foldPath(), { reset: Array.from({ length: 51 }, () => null) }))
				.status,
		).toBe(400);
		// Nobody else's: Bob's reset of the whole space leaves Alice's rows.
		await call(alice, "PUT", foldPath(), { changes: [{ blockId: ids.top1, open: true }] });
		await call(bob, "PUT", foldPath(), { reset: [null] });
		expect((await call(alice, "GET", foldPath())).body.expanded).toEqual([ids.top1]);
		expect((await call(mallory, "PUT", foldPath(), { reset: [null] })).status).toBe(404);
	});

	test("a write numbered at or below one already applied for its writer is ignored", async () => {
		resetFoldWritersForTests();
		const writer = "tab-0123456789";
		const newer = await call(alice, "PUT", foldPath(), {
			writer,
			n: 7,
			changes: [{ blockId: ids.fact, open: false }],
		});
		expect(newer.body.collapsed).toEqual([ids.fact]);
		// The older write, still on its way, lands later: ignored, and said so.
		const older = await call(alice, "PUT", foldPath(), {
			writer,
			n: 6,
			changes: [{ blockId: ids.fact, open: null }],
		});
		expect(older.status).toBe(200);
		expect(older.body.ignored).toBe(true);
		expect(older.body.collapsed).toEqual([ids.fact]);
		expect(
			(
				await call(alice, "PUT", foldPath(), {
					writer,
					n: 7,
					changes: [{ blockId: ids.fact, open: null }],
				})
			).body.ignored,
		).toBe(true);
		// Another writer (another view), or another person, is not held back by it.
		expect(
			(
				await call(alice, "PUT", foldPath(), {
					writer: "tab-other-writer",
					n: 1,
					changes: [{ blockId: ids.done, open: true }],
				})
			).body.expanded,
		).toEqual([ids.done]);
		expect(
			(
				await call(bob, "PUT", foldPath(), {
					writer,
					n: 1,
					changes: [{ blockId: ids.fact, open: false }],
				})
			).body.ignored,
		).toBeUndefined();
		// A newer one applies; writer and n go together; a bad writer id is refused.
		expect(
			(
				await call(alice, "PUT", foldPath(), {
					writer,
					n: 8,
					changes: [{ blockId: ids.fact, open: null }],
				})
			).body.collapsed,
		).toEqual([]);
		expect(
			(
				await call(alice, "PUT", foldPath(), {
					writer,
					changes: [{ blockId: ids.fact, open: false }],
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(alice, "PUT", foldPath(), {
					writer: "bad writer!",
					n: 9,
					changes: [{ blockId: ids.fact, open: false }],
				})
			).status,
		).toBe(400);
	});
});

describe("the open tasks under a block", () => {
	let taskSpace: OutlineSpaceRow;
	let parent: string;
	let doing: string[];
	let todo: string[];
	let outside: string;
	beforeAll(async () => {
		taskSpace = await project(alice, [bob]);
		parent = (
			await write(taskSpace, [{ op: "insert", parent: null, content: "Work" }], alice)
		)[0] as string;
		const made = await write(
			taskSpace,
			[
				...Array.from({ length: 3 }, (_, i) => ({
					op: "insert" as const,
					parent: { id: parent },
					content: `Doing ${i}\nmore text`,
					task: { status: "doing" as const, assignee: "agent:helper" },
				})),
				...Array.from({ length: 4 }, (_, i) => ({
					op: "insert" as const,
					parent: { id: parent },
					content: `Todo ${i}`,
					task: { status: "todo" as const },
				})),
				{
					op: "insert" as const,
					parent: { id: parent },
					content: "Finished",
					task: { status: "done" as const },
				},
				{
					op: "insert" as const,
					parent: null,
					content: "Elsewhere",
					task: { status: "todo" as const },
				},
			],
			alice,
		);
		doing = made.slice(0, 3) as string[];
		todo = made.slice(3, 7) as string[];
		outside = made[8] as string;
	});
	const path = (query: string) => `/spaces/${taskSpace.id}/open-tasks?${query}`;

	test("in progress first, paged by cursor, the count the marks give", async () => {
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page: { status: number; body: OutlineOpenTasksResponse } =
				await call<OutlineOpenTasksResponse>(
					bob,
					"GET",
					path(`under=${parent}&limit=3${cursor ? `&cursor=${cursor}` : ""}`),
				);
			expect(page.status).toBe(200);
			expect(page.body.items.length).toBeLessThanOrEqual(3);
			seen.push(...page.body.items.map((item) => item.id));
			if (pages === 0) {
				expect(page.body.items.every((item) => item.status === "doing")).toBe(true);
				expect(page.body.items[0]?.assignee).toBe("agent:helper");
				expect(page.body.items[0]?.title).toMatch(/^Doing \d$/);
			}
			cursor = page.body.nextCursor;
			pages++;
		} while (cursor && pages < 10);
		expect(pages).toBe(3);
		expect(sorted(seen.slice(0, 3))).toEqual(sorted(doing));
		expect(sorted(seen.slice(3))).toEqual(sorted(todo));
		const marks = await call<OutlineMarksResponse>(
			bob,
			"GET",
			`/spaces/${taskSpace.id}/marks?keys=${parent}`,
		);
		const counted = marks.body.marks[0]?.tasks;
		expect((counted?.doing ?? 0) + (counted?.todo ?? 0)).toBe(seen.length);
		// The whole space: the one outside too.
		const whole = await call<OutlineOpenTasksResponse>(
			bob,
			"GET",
			path(`under=${taskSpace.id}&limit=50`),
		);
		expect(whole.body.items.map((item) => item.id)).toContain(outside);
		expect(whole.body.items.length).toBe(8);
	});

	test("a key that is not a block of the space lists nothing; access as reads; bounded", async () => {
		const none = await call<OutlineOpenTasksResponse>(alice, "GET", path(`under=${elsewhere}`));
		expect(none.status).toBe(200);
		expect(none.body.items).toEqual([]);
		expect((await call(mallory, "GET", path(`under=${parent}`))).status).toBe(404);
		expect((await call(alice, "GET", path(`under=${parent}&limit=51`))).status).toBe(400);
		expect((await call(alice, "GET", path(`under=${parent}&cursor=nope`))).status).toBe(400);
		expect((await call(alice, "GET", path("limit=5"))).status).toBe(400);
	});
});
