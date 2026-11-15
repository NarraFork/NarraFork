/**
 * The outline reads that know no page, over HTTP (`routes/outline-subtree.ts`).
 *
 * What must hold:
 *  - with `outline.enabled` off every route is a plain 404;
 *  - a space the caller cannot read is 404 on every route, exactly like one that does not
 *    exist; a block named in the path under a space it is not in is 404; a block of another
 *    space named in a query has nothing here, and no response ever carries one;
 *  - a private session's space is its readers' only;
 *  - a read of history the space cannot answer is a 409 with a code and the floor, while the
 *    tree as it is now still reads;
 *  - limits are refused before any read; levels and timelines page by cursor.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	OUTLINE_SUBTREE_LIMITS,
	type OutlineChangedChildrenResponse,
	type OutlineLevelsResponse,
	type OutlineMarksResponse,
	type OutlineSubtreeResponse,
	type OutlineSubtreeTimelineResponse,
} from "@shared/outline-subtree-api";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, narrators, outlineSpaces, projects, users } from "../../db/schema";
import { toErrorPayload } from "../../lib/app-error-response";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { lockOutlineTask } from "../../services/outline/pending";
import { ensureProjectSpace, ensureSessionSpace } from "../../services/outline/spaces";
import { outlineStore } from "../../services/outline/store";
import type { OutlineSpaceRow } from "../../services/outline/store/port";
import { type OutlineOp, writeOutline } from "../../services/outline/write";
import { outlineRoutes } from "../outline";

const NOW = "2026-10-26T00:00:00.000Z";

type Role = "admin" | "user";
type Who = { id: string; role: Role };

function appAs(who: Who) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: who.id, role: who.role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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

async function call<T = Record<string, unknown>>(
	who: Who,
	path: string,
): Promise<{ status: number; body: T; text: string }> {
	const response = await appAs(who).request(`http://localhost/outline${path}`);
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: body as T, text };
}

async function user(label: string, role: Role = "user"): Promise<Who> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role, createdAt: NOW });
	return { id, role };
}

async function project(owner: Who, readers: Who[] = []): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `Project ${id}`,
		ownerUserId: owner.id,
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
			principalId: reader.id,
			capability: "read",
			createdAt: NOW,
		});
	}
	return id;
}

async function write(space: OutlineSpaceRow, ops: OutlineOp[], actor: Who) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: actor.id },
		responsibleUserId: actor.id,
	});
}

let alice: Who;
let bob: Who;
let carol: Who;
/** Alice's project space, which Bob may read. */
let spaceA: OutlineSpaceRow;
/** Carol's project space, which neither Alice nor Bob may read. */
let spaceB: OutlineSpaceRow;
/** The space of Alice's private session. */
let sessionSpace: OutlineSpaceRow;
let a: { page: string; fact: string; task: string; note: string; kids: string[] };
let b: { page: string; child: string };
let s: { page: string };

/** Every route of a space, for a block of it. */
function routes(spaceId: string, blockId: string): string[] {
	return [
		`/spaces/${spaceId}/subtree`,
		`/spaces/${spaceId}/blocks/${blockId}/subtree`,
		`/spaces/${spaceId}/children`,
		`/spaces/${spaceId}/children?parents=${blockId}`,
		`/spaces/${spaceId}/marks?keys=${blockId},${spaceId}`,
		`/spaces/${spaceId}/changed-children?after=0`,
		`/spaces/${spaceId}/changed-children?after=0&parent=${blockId}`,
		`/spaces/${spaceId}/commits`,
		`/spaces/${spaceId}/blocks/${blockId}/commits`,
	];
}

// The preload restores settings after every test.
beforeEach(() => {
	settings.outline.enabled = true;
});

beforeAll(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	bob = await user("bob");
	carol = await user("carol");
	spaceA = await ensureProjectSpace(await project(alice, [bob]));
	spaceB = await ensureProjectSpace(await project(carol));
	const narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		title: "Alice's session",
		ownerUserId: alice.id,
		visibility: "private",
		writeAudience: "owner",
		type: "primary",
		createdAt: NOW,
		updatedAt: NOW,
	});
	sessionSpace = await ensureSessionSpace(narratorId);

	const inA = await write(
		spaceA,
		[
			{ op: "insert", tempId: "p", parent: null, content: "Page A" },
			{ op: "insert", tempId: "f", parent: { tempId: "p" }, content: "A fact" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "p" },
				content: "A task",
				task: { status: "todo" },
			},
			{ op: "insert", tempId: "n", parent: { tempId: "t" }, content: "A note" },
			...Array.from(
				{ length: 12 },
				(_, i): OutlineOp => ({ op: "insert", parent: { tempId: "f" }, content: `kid ${i}` }),
			),
		],
		alice,
	);
	const idsA = inA.results.map((r) => r.blockId as string);
	a = {
		page: idsA[0] as string,
		fact: idsA[1] as string,
		task: idsA[2] as string,
		note: idsA[3] as string,
		kids: idsA.slice(4),
	};
	const inB = await write(
		spaceB,
		[
			{ op: "insert", tempId: "p", parent: null, content: "Page B, secret" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Child B, secret",
				task: { status: "doing" },
			},
		],
		carol,
	);
	b = { page: inB.results[0]?.blockId as string, child: inB.results[1]?.blockId as string };
	const inS = await write(
		sessionSpace,
		[{ op: "insert", parent: null, content: "Session page, private" }],
		alice,
	);
	s = { page: inS.results[0]?.blockId as string };
	spaceA = (await outlineStore.getSpace(spaceA.id)) as OutlineSpaceRow;
	spaceB = (await outlineStore.getSpace(spaceB.id)) as OutlineSpaceRow;
});

describe("the outline switch", () => {
	test("every route is a plain 404 while outline.enabled is off", async () => {
		settings.outline.enabled = false;
		try {
			for (const path of routes(spaceA.id, a.page)) {
				const res = await call(alice, path);
				expect(res.status).toBe(404);
				expect(res.text).toBe("404 Not Found");
			}
		} finally {
			settings.outline.enabled = true;
		}
	});
});

describe("access", () => {
	test("a space the caller cannot read is 404 on every route, like one that does not exist", async () => {
		for (const who of [alice, bob]) {
			const missing = routes("no-such-space", b.page);
			for (const [i, path] of routes(spaceB.id, b.page).entries()) {
				const res = await call(who, path);
				expect(res.status).toBe(404);
				expect(res.text).not.toContain("secret");
				const absent = await call(who, missing[i] as string);
				expect(absent.status).toBe(404);
				expect(Object.keys(res.body)).toEqual(Object.keys(absent.body));
			}
		}
		// Its own reader reads it.
		for (const path of routes(spaceB.id, b.page))
			expect((await call(carol, path)).status).toBe(200);
	});

	test("a block named in the path must be a block of that space", async () => {
		// Bob reads space A; a block of B under A's path is 404, as is an id that names nothing.
		for (const blockId of [b.page, b.child, "no-such-block"]) {
			for (const tail of ["subtree", "commits"]) {
				const res = await call(bob, `/spaces/${spaceA.id}/blocks/${blockId}/${tail}`);
				expect(res.status).toBe(404);
				expect(res.text).not.toContain("secret");
			}
		}
		// Carol reads space B; a block of A under B's path is 404 too.
		expect((await call(carol, `/spaces/${spaceB.id}/blocks/${a.page}/subtree`)).status).toBe(404);
	});

	test("a block of another space named in a query has nothing here", async () => {
		const levels = await call<OutlineLevelsResponse>(
			bob,
			`/spaces/${spaceA.id}/children?parents=${b.page},${a.task}`,
		);
		expect(levels.status).toBe(200);
		expect(levels.body.blocks.map((block) => block.id)).toEqual([a.note]);
		expect(levels.body.levels).toEqual([
			{ parentId: b.page, childIds: [], more: false, nextCursor: null, processHidden: 0 },
			{ parentId: a.task, childIds: [a.note], more: false, nextCursor: null, processHidden: 0 },
		]);
		expect(levels.text).not.toContain("secret");
		for (const asOf of [1, spaceA.nextSeq - 1]) {
			const then = await call<OutlineLevelsResponse>(
				bob,
				`/spaces/${spaceA.id}/children?parents=${b.page}&asOf=${asOf}`,
			);
			expect(then.body.blocks).toEqual([]);
		}
		const marks = await call<OutlineMarksResponse>(
			bob,
			`/spaces/${spaceA.id}/marks?keys=${b.page},${spaceB.id},${a.page}&since=0`,
		);
		expect(marks.body.marks.map((mark) => mark.key)).toEqual([a.page]);
		// The other space's open task is not counted here.
		expect(marks.body.marks[0]?.tasks).toEqual({ todo: 1, doing: 0 });
		const changed = await call<OutlineChangedChildrenResponse>(
			bob,
			`/spaces/${spaceA.id}/changed-children?after=0&parent=${b.page}`,
		);
		expect(changed.body.children).toEqual([]);
		// Nothing of space B ever shows in a whole read of space A.
		const whole = await call<OutlineSubtreeResponse>(bob, `/spaces/${spaceA.id}/subtree?view=all`);
		expect(whole.body.blocks.every((block) => block.id !== b.page && block.id !== b.child)).toBe(
			true,
		);
		expect(whole.text).not.toContain("secret");
	});

	test("a private session's space is its readers' only", async () => {
		for (const path of routes(sessionSpace.id, s.page)) {
			expect((await call(alice, path)).status).toBe(200);
			for (const who of [bob, carol]) {
				const res = await call(who, path);
				expect(res.status).toBe(404);
				expect(res.text).not.toContain("private");
			}
		}
	});
});

describe("reading", () => {
	test("a subtree comes breadth first within its budget, with its path and what is left to load", async () => {
		const whole = await call<OutlineSubtreeResponse>(
			bob,
			`/spaces/${spaceA.id}/blocks/${a.page}/subtree?view=all`,
		);
		expect(whole.status).toBe(200);
		expect(whole.body).toMatchObject({
			spaceId: spaceA.id,
			rootId: a.page,
			seq: spaceA.nextSeq - 1,
			current: true,
			view: "all",
			path: [],
			rootInTask: false,
			truncated: false,
		});
		expect(whole.body.blocks.map((block) => block.id)).toEqual([
			a.page,
			a.fact,
			a.task,
			...a.kids,
			a.note,
		]);
		expect(whole.body.blocks[1]).toMatchObject({
			id: a.fact,
			parentId: a.page,
			content: "A fact",
			task: null,
			hasChildren: true,
			lock: null,
			pending: [],
		});

		const cut = await call<OutlineSubtreeResponse>(
			bob,
			`/spaces/${spaceA.id}/blocks/${a.fact}/subtree?view=all&blocks=5`,
		);
		expect(cut.body.blocks.map((block) => block.id)).toEqual([a.fact, ...a.kids.slice(0, 4)]);
		expect(cut.body.path).toEqual([{ id: a.page, sid: expect.any(String), title: "Page A" }]);
		expect(cut.body.truncated).toBe(true);
		const level = cut.body.levels[0];
		expect(level).toMatchObject({ parentId: a.fact, more: true });
		// The level continues from its cursor, a page at a time.
		const rest: string[] = [];
		let cursor = level?.nextCursor ?? null;
		while (cursor) {
			const page = await call<OutlineLevelsResponse>(
				bob,
				`/spaces/${spaceA.id}/children?parents=${a.fact}&limit=3&cursor=${cursor}`,
			);
			expect(page.body.blocks.length).toBeLessThanOrEqual(3);
			rest.push(...(page.body.levels[0]?.childIds ?? []));
			cursor = page.body.levels[0]?.more ? (page.body.levels[0]?.nextCursor ?? null) : null;
		}
		expect([...a.kids.slice(0, 4), ...rest]).toEqual(a.kids);

		// The top level, alone and together with blocks.
		const top = await call<OutlineLevelsResponse>(bob, `/spaces/${spaceA.id}/children`);
		expect(top.body.levels).toMatchObject([{ parentId: null, childIds: [a.page] }]);
		const both = await call<OutlineLevelsResponse>(
			bob,
			`/spaces/${spaceA.id}/children?top=1&parents=${a.page}`,
		);
		expect(both.body.levels.map((entry) => entry.parentId)).toEqual([null, a.page]);

		// The facts view (the default of a subtree) leaves the task out and says so.
		const facts = await call<OutlineSubtreeResponse>(
			bob,
			`/spaces/${spaceA.id}/blocks/${a.page}/subtree`,
		);
		expect(facts.body.view).toBe("facts");
		expect(facts.body.blocks.some((block) => block.id === a.task)).toBe(false);
		expect(facts.body.levels[0]?.processHidden).toBe(1);
	});

	test("as of a seq or a time it shows that state; a lock says who may undo it", async () => {
		const before = (await outlineStore.getSpace(spaceA.id)) as OutlineSpaceRow;
		const seq = before.nextSeq - 1;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const at = new Date().toISOString();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await write(
			spaceA,
			[{ op: "update", block: { id: a.note }, content: "A note, edited" }],
			alice,
		);
		await lockOutlineTask({ blockId: a.task, userId: alice.id });
		for (const query of [`asOf=${seq}`, `at=${encodeURIComponent(at)}`]) {
			const then = await call<OutlineSubtreeResponse>(
				bob,
				`/spaces/${spaceA.id}/blocks/${a.task}/subtree?${query}`,
			);
			expect(then.body).toMatchObject({ seq, current: false, view: "all" });
			expect(then.body.blocks.map((block) => [block.id, block.content, block.lock])).toEqual([
				[a.task, "A task", null],
				[a.note, "A note", null],
			]);
		}
		expect(
			(await call(bob, `/spaces/${spaceA.id}/subtree?asOf=1&at=${encodeURIComponent(at)}`)).status,
		).toBe(400);
		for (const [who, canUnlock] of [
			[alice, true],
			[bob, false],
		] as const) {
			const now = await call<OutlineSubtreeResponse>(
				who,
				`/spaces/${spaceA.id}/blocks/${a.task}/subtree`,
			);
			expect(now.body.blocks[0]?.lock).toMatchObject({ blockId: a.task, canUnlock });
			expect(now.body.blocks[1]?.content).toBe("A note, edited");
		}
		const marks = await call<OutlineMarksResponse>(
			bob,
			`/spaces/${spaceA.id}/marks?keys=${a.page},${a.task},${spaceA.id}&since=${seq}`,
		);
		expect(marks.body).toMatchObject({ spaceId: spaceA.id, atLeast: false });
		expect(marks.body.marks).toEqual([
			{
				key: a.page,
				questions: 0,
				tasks: { todo: 1, doing: 0 },
				locked: 1,
				pending: 0,
				changed: { self: false, below: true },
			},
			{
				key: a.task,
				questions: 0,
				tasks: { todo: 0, doing: 0 },
				locked: 0,
				pending: 0,
				changed: { self: true, below: true },
			},
			{
				key: spaceA.id,
				questions: 0,
				tasks: { todo: 1, doing: 0 },
				locked: 1,
				pending: 0,
				changed: { self: false, below: true },
			},
		]);
		const changed = await call<OutlineChangedChildrenResponse>(
			bob,
			`/spaces/${spaceA.id}/changed-children?after=${seq}&parent=${a.page}`,
		);
		expect(changed.body.children.map((child) => [child.blockId, child.self, child.below])).toEqual([
			[a.task, true, true],
		]);
		expect(changed.body.nextCursor).toBeNull();
	});

	test("a block's timeline pages by seq and lists only what touched it", async () => {
		const space = (await outlineStore.getSpace(spaceA.id)) as OutlineSpaceRow;
		const ofNote = await call<OutlineSubtreeTimelineResponse>(
			bob,
			`/spaces/${space.id}/blocks/${a.note}/commits`,
		);
		expect(ofNote.body.commits.map((commit) => commit.seq)).toEqual([2, 1]);
		expect(ofNote.body.floorSeq).toBe(0);
		expect(ofNote.body.commits[0]).toMatchObject({ actorKind: "human", kind: expect.any(String) });
		const ofFact = await call<OutlineSubtreeTimelineResponse>(
			bob,
			`/spaces/${space.id}/blocks/${a.fact}/commits`,
		);
		expect(ofFact.body.commits.map((commit) => commit.seq)).toEqual([1]);
		const seqs: number[] = [];
		let before: number | null = null;
		do {
			const page: { body: OutlineSubtreeTimelineResponse } = await call(
				bob,
				`/spaces/${space.id}/commits?limit=2${before === null ? "" : `&before=${before}`}`,
			);
			expect(page.body.commits.length).toBeLessThanOrEqual(2);
			seqs.push(...page.body.commits.map((commit) => commit.seq));
			before = page.body.nextBefore;
		} while (before !== null);
		expect(seqs).toEqual(
			Array.from({ length: space.nextSeq - 1 }, (_, i) => space.nextSeq - 1 - i),
		);
	});

	test("requests outside the limits are refused before any read", async () => {
		const max = OUTLINE_SUBTREE_LIMITS;
		const many = Array.from({ length: max.maxParents + 1 }, (_, i) => `p${i}`).join(",");
		const keys = Array.from({ length: max.maxMarkKeys + 1 }, (_, i) => `k${i}`).join(",");
		for (const path of [
			`/spaces/${spaceA.id}/subtree?blocks=${max.maxBlocks + 1}`,
			`/spaces/${spaceA.id}/subtree?bytes=${max.maxBytes + 1}`,
			`/spaces/${spaceA.id}/subtree?fold=mine`,
			`/spaces/${spaceA.id}/children?limit=${max.maxLevelBlocks + 1}`,
			`/spaces/${spaceA.id}/children?parents=${many}`,
			`/spaces/${spaceA.id}/children?parents=${a.page},${a.page}`,
			`/spaces/${spaceA.id}/children?parents=${a.page},${a.fact}&cursor=abc`,
			`/spaces/${spaceA.id}/children?parents=${a.page}&cursor=not-a-cursor`,
			`/spaces/${spaceA.id}/marks`,
			`/spaces/${spaceA.id}/marks?keys=${keys}`,
			`/spaces/${spaceA.id}/changed-children`,
			`/spaces/${spaceA.id}/changed-children?after=0&limit=${max.maxChanged + 1}`,
			`/spaces/${spaceA.id}/changed-children?after=0&cursor=not-a-cursor`,
			`/spaces/${spaceA.id}/commits?limit=${max.maxTimeline + 1}`,
			`/spaces/${spaceA.id}/commits?before=-1`,
		]) {
			expect([path, (await call(bob, path)).status]).toEqual([path, 400]);
		}
	});
});

describe("history that cannot be read", () => {
	test("is a 409 with a code and the floor, while the tree as it is now still reads", async () => {
		const owner = await user("dave");
		const space0 = await ensureProjectSpace(await project(owner));
		const made = await write(
			space0,
			[
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				{ op: "insert", parent: { tempId: "p" }, content: "Child" },
			],
			owner,
		);
		const page = made.results[0]?.blockId as string;
		await write(space0, [{ op: "update", block: { id: page }, content: "Page, edited" }], owner);
		const history = [
			`/spaces/${space0.id}/subtree?asOf=1`,
			`/spaces/${space0.id}/blocks/${page}/subtree?asOf=1`,
			`/spaces/${space0.id}/children?asOf=1`,
			`/spaces/${space0.id}/marks?keys=${page}&since=1`,
			`/spaces/${space0.id}/changed-children?after=1`,
		];
		const timelines = [
			`/spaces/${space0.id}/commits`,
			`/spaces/${space0.id}/blocks/${page}/commits`,
		];
		const current = [
			`/spaces/${space0.id}/subtree`,
			`/spaces/${space0.id}/blocks/${page}/subtree`,
			`/spaces/${space0.id}/children?parents=${page}`,
			`/spaces/${space0.id}/marks?keys=${page}`,
		];

		// As a space written before placements existed: not converted yet.
		await db
			.update(outlineSpaces)
			.set({ edgesReady: false })
			.where(eq(outlineSpaces.id, space0.id));
		for (const path of [...history, ...timelines]) {
			const res = await call(owner, path);
			expect([path, res.status]).toEqual([path, 409]);
			expect(res.body).toMatchObject({
				code: "OUTLINE_HISTORY_NOT_READY",
				details: { reason: "not-ready", floorSeq: 0 },
			});
		}
		for (const path of current)
			expect([path, (await call(owner, path)).status]).toEqual([path, 200]);

		// Converted, with a floor above what is asked for.
		await db
			.update(outlineSpaces)
			.set({ edgesReady: true, historyFloorSeq: 2 })
			.where(eq(outlineSpaces.id, space0.id));
		for (const path of history) {
			const res = await call(owner, path);
			expect([path, res.status]).toEqual([path, 409]);
			expect(res.body).toMatchObject({
				code: "OUTLINE_HISTORY_BEFORE_FLOOR",
				details: { reason: "before-floor", floorSeq: 2, seq: 1 },
			});
		}
		// A timeline does not fail there: it ends at the floor, and says where that is.
		for (const path of timelines) {
			const res = await call<OutlineSubtreeTimelineResponse>(owner, path);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ commits: [], nextBefore: null, floorSeq: 2 });
		}
		for (const path of current) expect((await call(owner, path)).status).toBe(200);
		// The floor itself reads.
		expect((await call(owner, `/spaces/${space0.id}/subtree?asOf=2`)).status).toBe(200);
	});
});
