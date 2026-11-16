/**
 * Joining a space with a watch set (pageless plan L3, protocol version 4): top-level blocks over
 * the wire, watches added and removed while people edit, commits from outside routed by parent,
 * the budgets and their refusal codes, and the three things L2 left over (a whole text that
 * reached a client before its "not taken" notice, a refused transaction's text in a block with a
 * `moved_away` entry, a retry after `ended` overtaken by a later join).
 *
 * The clients are the editor's real engine over an in-process network (`harness.ts`), on a clock
 * the test advances (`FakeLiveClock`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LiveClient } from "@frontend/components/outline/editor/live-client";
import { keyBetweenLoose } from "@frontend/components/outline/editor/store";
import {
	clearUnsavedTextsForTests,
	unsavedTextsOf,
} from "@frontend/components/outline/editor/unsaved-texts";
import { keyBetween } from "@shared/outline";
import {
	decodeLiveFrame,
	decodeLiveTexts,
	encodeLiveFrame,
	LIVE_FRAME,
	type LiveFrame,
	type LiveWatchWire,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import { db } from "../../../../db";
import { aclGrants, projects, users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { ensureProjectSpace } from "../../spaces";
import { outlineStore, setOutlineStore } from "../../store";
import type { OutlineSpaceRow } from "../../store/port";
import { type OutlineOp, writeOutline } from "../../write";
import {
	closeAllLiveSessions,
	handleLiveFrame,
	joinLive,
	liveSessionOf,
	liveSpaceOf,
	releaseLiveSocket,
	runInLane,
} from "../registry";
import { OUTLINE_LIVE_BOUNDS, OUTLINE_LIVE_TIMING } from "../session";
import { client, FakeLiveClock, joinHead, struct, TestLink, TestSocket, type } from "./harness";

const NOW = "2026-11-16T00:00:00.000Z";
const saved = { ...OUTLINE_LIVE_TIMING };
const savedBounds = { ...OUTLINE_LIVE_BOUNDS };

let owner: string;
let writer: string;
let third: string;
let space: OutlineSpaceRow;
let otherSpace: OutlineSpaceRow;
let clock: FakeLiveClock;
const clients: LiveClient[] = [];
const links: TestLink[] = [];
const realStore = outlineStore;

async function user(label: string) {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

function link(userId: string): TestLink {
	const l = new TestLink(userId, userId);
	links.push(l);
	return l;
}

function open(l: TestLink, rootId: string, watch?: LiveWatchWire[]): LiveClient {
	const c = client(l, rootId, "edit", watch ? { space: space.id, watch } : {});
	clients.push(c);
	return c;
}

/** A page with blocks `texts` under it; returns its id and the block ids. */
async function page(
	texts: string[],
	title: string,
	into: OutlineSpaceRow = space,
): Promise<{ pageId: string; ids: string[] }> {
	const r = await writeOutline({
		spaceId: into.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: title },
			...texts.map((content, i) => ({
				op: "insert" as const,
				tempId: `b${i}`,
				parent: { tempId: "p" },
				content,
			})),
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const [p, ...rest] = r.results.map((x) => x.blockId);
	return { pageId: p as string, ids: rest };
}

function agent(ops: OutlineOp[]) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: "watch-agent" },
		responsibleUserId: owner,
	});
}

async function block(id: string) {
	return await outlineStore.getBlock(id);
}

async function flushAll(): Promise<void> {
	await runInLane(space.id, async () => {
		await liveSpaceOf(space.id)?.flushContent();
	});
	await clock.settle();
}

/** Every text entry and structural op a link's socket was sent that names one of `ids`. */
function sentAbout(l: TestLink, from: number, ids: readonly string[]): string[] {
	const out: string[] = [];
	for (const f of l.socket.sent.slice(from)) {
		for (const e of decodeLiveTexts(f.body) ?? []) if (ids.includes(e.id)) out.push(`text ${e.id}`);
		const head = f.head as { c?: Array<{ ops: Array<{ id: string }> }> } | null;
		for (const c of head?.c ?? [])
			for (const op of c.ops) if (ids.includes(op.id)) out.push(`op ${op.id}`);
	}
	return out;
}

/** The top-level blocks a client shows, by their text, in order. */
function topLevel(c: LiveClient): string[] {
	return c.visible.children("").map((id) => c.textOf(id));
}

beforeEach(() => {
	settings.outline.enabled = true;
	clock = new FakeLiveClock().install();
	Object.assign(OUTLINE_LIVE_TIMING, {
		flushIdleMs: 60,
		flushMaxMs: 300,
		persistMs: 20,
		idleCloseMs: 150,
	});
});

afterEach(async () => {
	setOutlineStore(realStore);
	clearUnsavedTextsForTests();
	Object.assign(OUTLINE_LIVE_BOUNDS, savedBounds);
	for (const c of clients.splice(0)) c.dispose();
	for (const l of links.splice(0)) if (l.connected) l.disconnect();
	const closing = closeAllLiveSessions("ended");
	await clock.settle();
	await closing;
	clock.uninstall();
	Object.assign(OUTLINE_LIVE_TIMING, saved);
});

afterAll(() => {
	Object.assign(OUTLINE_LIVE_TIMING, saved);
});

beforeAll(async () => {
	owner = await user("owner");
	writer = await user("writer");
	third = await user("third");
	for (const target of ["space", "other"] as const) {
		const projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: `Watch ${target}`,
			ownerUserId: owner,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		for (const principalId of [writer, third])
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType: "project",
				scopeId: projectId,
				principalType: "user",
				principalId,
				capability: "write",
				createdAt: NOW,
			});
		if (target === "space") space = await ensureProjectSpace(projectId);
		else otherSpace = await ensureProjectSpace(projectId);
	}
});

describe("top-level blocks over the wire (p: null)", () => {
	test("insert, move to and from the top level, check and delete a top-level block: one commit each, each watcher sees what concerns it", async () => {
		const one = await page(["a1", "a2"], "One");
		const two = await page(["b1"], "Two");
		const [a1, a2] = one.ids as [string, string];
		const b1 = two.ids[0] as string;
		// The forest: the top level, and the subtrees of both pages.
		const lf = link(owner);
		const f = open(lf, "", [{ l: null }, { s: one.pageId }, { s: two.pageId }]);
		const lq = link(writer);
		const q = open(lq, one.pageId);
		const lp = link(third);
		const p = open(lp, two.pageId);
		await clock.until(() => f.ready && q.ready && p.ready, 5000, "joined");
		expect(topLevel(f)).toEqual(expect.arrayContaining(["One", "Two"]));
		expect(f.outline(one.pageId)).toBe("- a1\n- a2");

		// A new top-level block.
		const n = f.newId();
		const last = f.visible.children("").at(-1) as string;
		struct(f, [
			{
				t: "i",
				id: n,
				p: null,
				k: keyBetweenLoose(f.visible.get(last)?.orderKey ?? null, null),
				content: "new top",
			},
		]);
		await clock.settle();
		expect((await block(n))?.parentId).toBeNull();
		expect(topLevel(f).at(-1)).toBe("new top");
		expect(sentAbout(lq, 0, [n])).toEqual([]);
		expect(sentAbout(lp, 0, [n])).toEqual([]);

		// A block of One to the top level: gone from One's watchers, there for the forest.
		const sentQ = lq.socket.sent.length;
		struct(f, [{ t: "m", id: a1, p: null, k: keyBetween(null, null) }]);
		await clock.settle();
		expect((await block(a1))?.parentId).toBeNull();
		expect(q.outline()).toBe("- a2");
		expect(sentAbout(lq, sentQ, [a1])).toEqual([`op ${a1}`]);
		expect(topLevel(f)).toContain("a1");

		// The checkbox of a top-level block (Two, the root P watches).
		struct(f, [{ t: "k", id: two.pageId, task: " " }]);
		await clock.settle();
		expect((await block(two.pageId))?.taskJson?.status).toBe("todo");
		expect(p.visible.get(two.pageId)?.task).toBe(" ");

		// A top-level block under a block of One: One's watchers get it, with its text.
		struct(f, [{ t: "m", id: n, p: a2, k: keyBetween(null, null) }]);
		await clock.settle();
		expect((await block(n))?.parentId).toBe(a2);
		expect(q.outline()).toBe("- a2\n  - new top");
		expect(q.textOf(n)).toBe("new top");

		// A top-level block deleted.
		struct(f, [{ t: "d", id: a1 }]);
		await clock.settle();
		expect((await block(a1))?.deleted).toBe(true);
		expect(topLevel(f)).not.toContain("a1");

		// A watched page moved under a block of the other: its watch ends for Q (it watched
		// nothing else: the session ends for it), the forest is told it is gone and keeps the
		// blocks (now under Two), P gets them with their text.
		struct(f, [{ t: "m", id: one.pageId, p: b1, k: keyBetween(null, null) }]);
		await clock.settle();
		expect((await block(one.pageId))?.parentId).toBe(b1);
		expect(
			lq.socket.sent.some(
				(frame) =>
					frame.kind === LIVE_FRAME.closed && (frame.head as { code: string }).code === "ended",
			),
		).toBe(true);
		expect(f.watchSet).toEqual([{ l: null }, { s: two.pageId }]);
		expect(f.outline(two.pageId)).toBe("- b1\n  - One\n    - a2\n      - new top");
		expect(p.outline()).toBe("- b1\n  - One\n    - a2\n      - new top");
		expect(p.textOf(n)).toBe("new top");
		await flushAll();
		expect(f.stats.rejects + p.stats.rejects).toBe(0);
	});

	test("the top level is a parent only while someone watches it: a raw insert there is refused otherwise", async () => {
		const one = await page(["x"], "Alone");
		const answers: LiveFrame[] = [];
		const s = new TestSocket(owner, "raw", (frame) => {
			const d = decodeLiveFrame(frame);
			if (d) answers.push(d);
		});
		await joinLive(s, {
			kind: LIVE_FRAME.join,
			handle: 1,
			n: 0,
			head: joinHead(one.pageId, "edit", "rawtoplevel1"),
			body: new Uint8Array(0),
		});
		await clock.settle();
		expect(answers[0]?.kind).toBe(LIVE_FRAME.joined);
		handleLiveFrame(
			s,
			decodeLiveFrame(
				encodeLiveFrame({
					kind: LIVE_FRAME.tx,
					handle: 1,
					n: 1,
					head: { ops: [{ t: "i", id: "rawTopLevelBlock1", p: null, k: keyBetween(null, null) }] },
				}),
			) as LiveFrame,
		);
		await clock.settle();
		const reject = answers.find((frame) => frame.kind === LIVE_FRAME.reject);
		expect((reject?.head as { code: string } | undefined)?.code).toBe("conflict");
		expect(await block("rawTopLevelBlock1")).toBeNull();
		releaseLiveSocket(s);
	});

	test("an old client (it names a page) is told outdated", async () => {
		const one = await page(["x"], "Old");
		const answers: LiveFrame[] = [];
		const s = new TestSocket(owner, "old", (frame) => {
			const d = decodeLiveFrame(frame);
			if (d) answers.push(d);
		});
		await joinLive(s, {
			kind: LIVE_FRAME.join,
			handle: 1,
			n: 0,
			head: { v: 3, page: one.pageId, mode: "edit", key: "oldclient03" },
			body: new Uint8Array(0),
		});
		expect(answers.map((f) => (f.head as { code?: string }).code)).toEqual(["outdated"]);
		expect(liveSessionOf(one.pageId)).toBeUndefined();
		releaseLiveSocket(s);
	});
});

describe("watches added and removed while people edit", () => {
	test("a watch added mid-typing converges; removed, nothing more of it arrives; added back, it is whole again", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const a1 = one.ids[0] as string;
		const b1 = two.ids[0] as string;
		const la = link(owner);
		const a = open(la, one.pageId);
		const b = open(link(writer), two.pageId);
		const c = open(link(third), one.pageId);
		await clock.until(() => a.ready && b.ready && c.ready, 5000, "joined");
		type(b, b1, " typed");
		await clock.advance(20);
		a.watch({ add: [{ s: two.pageId }] });
		type(b, b1, " more");
		await clock.settle();
		expect(a.watchSet).toEqual([{ s: one.pageId }, { s: two.pageId }]);
		expect(a.textOf(b1)).toBe("b1 typed more");
		expect(a.outline(two.pageId)).toBe("- b1 typed more");
		// Both type in it now; and in their own blocks.
		type(a, b1, "!");
		type(b, b1, "?");
		type(a, a1, " by a");
		await clock.settle();
		expect(a.textOf(b1)).toBe(b.textOf(b1));
		expect(c.textOf(a1)).toBe("a1 by a");
		// One removed while C types in it: A shows nothing of it any more and is sent nothing.
		a.watch({ remove: [{ s: one.pageId }] });
		const sentA = la.socket.sent.length;
		type(c, a1, " while away");
		await clock.settle();
		expect(a.visible.get(a1)).toBeUndefined();
		expect(a.hasText(a1)).toBe(false);
		expect(sentAbout(la, sentA, [a1, one.pageId])).toEqual([]);
		expect(liveSessionOf(one.pageId)?.participants.size).toBe(1);
		// Added back: it is whole, with what C typed meanwhile, and A types on.
		a.watch({ add: [{ s: one.pageId }] });
		await clock.settle();
		expect(a.textOf(a1)).toBe("a1 by a while away");
		type(a, a1, "#");
		await clock.settle();
		expect(c.textOf(a1)).toBe("a1 by a while away#");
		await flushAll();
		expect((await block(a1))?.content).toBe("a1 by a while away#");
		expect((await block(b1))?.content).toBe(a.textOf(b1));
		expect(a.stats.rejects + b.stats.rejects + c.stats.rejects).toBe(0);
		expect(a.stats.rebuilds).toBe(0);
	});

	test("a level watch shows the children only; a subtree watch inside it is whole; a disconnect resumes the whole set", async () => {
		const one = await page(["a1", "a2"], "One");
		const [a1, a2] = one.ids as [string, string];
		const g = (await agent([{ op: "insert", parent: { id: a1 }, content: "grandchild" }]))
			.results[0]?.blockId as string;
		const la = link(owner);
		const a = open(la, "", [{ l: one.pageId }]);
		await clock.until(() => a.ready, 5000, "joined");
		expect(a.visible.children(one.pageId).map((id) => a.textOf(id))).toEqual(["a1", "a2"]);
		expect(a.visible.get(g)).toBeUndefined();
		a.watch({ add: [{ s: a1 }] });
		await clock.settle();
		expect(a.textOf(g)).toBe("grandchild");
		type(a, g, "!");
		type(a, a2, "?");
		la.disconnect();
		type(a, g, "@");
		la.reconnect();
		await clock.until(() => a.status === "live", 5000, "back");
		await clock.settle();
		expect(a.stats.resumes).toBe(1);
		await flushAll();
		expect((await block(g))?.content).toBe("grandchild!@");
		expect((await block(a2))?.content).toBe("a2?");
	});
});

describe("commits from outside are routed by parent", () => {
	test("moves between watched and unwatched parents appear and disappear, with their text; a commit elsewhere is not read", async () => {
		const one = await page(["a1", "a2"], "One");
		const two = await page(["b1"], "Two");
		const [a1, a2] = one.ids as [string, string];
		const b1 = two.ids[0] as string;
		await agent([{ op: "update", block: { id: b1 }, content: "b1 text" }]);
		const ll = link(owner);
		const level = open(ll, "", [{ l: one.pageId }]);
		const ls = link(writer);
		const sub = open(ls, one.pageId);
		await clock.until(() => level.ready && sub.ready, 5000, "joined");
		// Under a1 (inside the subtree, below the level): only the subtree's watcher.
		const sentL = ll.socket.sent.length;
		const g = (await agent([{ op: "insert", parent: { id: a1 }, content: "under a1" }])).results[0]
			?.blockId as string;
		await clock.settle();
		expect(sub.outline()).toBe("- a1\n  - under a1\n- a2");
		expect(sentAbout(ll, sentL, [g])).toEqual([]);
		// From an unwatched place into One: both, with its text.
		await agent([{ op: "move", block: { id: b1 }, parent: { id: one.pageId } }]);
		await clock.settle();
		expect(level.visible.children(one.pageId).map((id) => level.textOf(id))).toEqual([
			"a1",
			"a2",
			"b1 text",
		]);
		expect(sub.textOf(b1)).toBe("b1 text");
		// Out of One to the unwatched page: gone for both; back: there again with its text.
		await agent([{ op: "move", block: { id: a2 }, parent: { id: two.pageId } }]);
		await clock.settle();
		expect(level.visible.alive(a2)).toBeUndefined();
		expect(sub.visible.alive(a2)).toBeUndefined();
		await agent([{ op: "update", block: { id: a2 }, content: "a2 changed away" }]);
		await agent([{ op: "move", block: { id: a2 }, parent: { id: one.pageId } }]);
		await clock.settle();
		expect(level.textOf(a2)).toBe("a2 changed away");
		expect(sub.textOf(a2)).toBe("a2 changed away");
		type(level, a2, "!");
		await flushAll();
		expect((await block(a2))?.content).toBe("a2 changed away!");
		// A commit of an unwatched part of the space: its versions are not read.
		let reads = 0;
		setOutlineStore({
			...realStore,
			listCommitVersions: async (commitId, limit) => {
				reads++;
				return await realStore.listCommitVersions(commitId, limit);
			},
		});
		await agent([{ op: "update", block: { id: two.pageId }, content: "Two renamed" }]);
		await clock.settle();
		expect(reads).toBe(0);
		await agent([{ op: "update", block: { id: a1 }, content: "a1 renamed" }]);
		await clock.settle();
		expect(reads).toBe(1);
		expect(level.textOf(a1)).toBe("a1 renamed");
		expect(level.stats.rejects + sub.stats.rejects).toBe(0);
	});
});

describe("budgets and refusal codes", () => {
	test("one person's share and the space's bound refuse a new watch, never one open; a refused watch is said so; a bad block is access_denied", async () => {
		const one = await page(
			Array.from({ length: 9 }, (_, i) => `o${i}`),
			"One",
		);
		const two = await page(
			Array.from({ length: 9 }, (_, i) => `t${i}`),
			"Two",
		);
		const three = await page(
			Array.from({ length: 9 }, (_, i) => `h${i}`),
			"Three",
		);
		const foreign = await page(["f"], "Foreign", otherSpace);
		OUTLINE_LIVE_BOUNDS.maxUserBlocks = 15;
		OUTLINE_LIVE_TIMING.idleCloseMs = 600_000;
		const a = open(link(owner), one.pageId);
		await clock.until(() => a.ready, 5000, "joined");
		a.watch({ add: [{ s: two.pageId }] });
		await clock.settle();
		expect(a.watchRefused.get(`s:${two.pageId}`)).toBe("user_limit");
		expect(a.watchSet).toEqual([{ s: one.pageId }]);
		expect(a.status).toBe("live");
		// Swapping makes room.
		a.watch({ remove: [{ s: one.pageId }], add: [{ s: two.pageId }] });
		await clock.settle();
		expect(a.watchSet).toEqual([{ s: two.pageId }]);
		expect(a.outline(two.pageId).split("\n")).toHaveLength(9);
		// The space's bound: everything in it watched by someone connected.
		const b = open(link(writer), one.pageId);
		await clock.until(() => b.ready, 5000, "joined");
		OUTLINE_LIVE_BOUNDS.maxUserBlocks = 8000;
		OUTLINE_LIVE_BOUNDS.maxLoadedBlocks = 25;
		b.watch({ add: [{ s: three.pageId }] });
		await clock.settle();
		expect(b.watchRefused.get(`s:${three.pageId}`)).toBe("space_full");
		expect([a.status, b.status]).toEqual(["live", "live"]);
		// A block of another space, and one that is not there.
		b.watch({ add: [{ s: foreign.pageId }, { l: "no-such-block-1" }] });
		await clock.settle();
		expect(b.watchRefused.get(`s:${foreign.pageId}`)).toBe("access_denied");
		expect(b.watchRefused.get("l:no-such-block-1")).toBe("access_denied");
		// A join naming one refused watch is refused whole, with its code.
		const c = open(link(third), "", [{ s: one.pageId }, { s: foreign.pageId }]);
		await clock.until(() => c.closeCode !== null, 5000, "refused");
		expect(c.closeCode).toBe("access_denied");
	});

	test("a level of more than the bound's children is too_large", async () => {
		const parent = (await agent([{ op: "insert", parent: null, content: "Wide" }])).results[0]
			?.blockId as string;
		const max = OUTLINE_LIVE_LIMITS.maxWatchBlocks;
		for (let at = 0; at <= max; at += 190)
			await agent(
				Array.from({ length: Math.min(190, max + 1 - at) }, (_, i) => ({
					op: "insert" as const,
					parent: { id: parent },
					content: `w${at + i}`,
				})),
			);
		const one = await page(["x"], "Small");
		const a = open(link(owner), one.pageId);
		await clock.until(() => a.ready, 5000, "joined");
		a.watch({ add: [{ l: parent }] });
		await clock.settle(100, 60_000);
		expect(a.watchRefused.get(`l:${parent}`)).toBe("too_large");
		expect(a.status).toBe("live");
	}, 120_000);
});

describe("what L2 left over", () => {
	test("(a) a block whose whole text reached the client before its notice is not left without the session's text", async () => {
		const one = await page(["goes"], "One");
		const two = await page(["there"], "Two");
		const x = one.ids[0] as string;
		const la = link(owner);
		const a = open(la, one.pageId);
		const b = open(link(writer), two.pageId);
		await clock.until(() => a.ready && b.ready, 5000, "joined");
		type(a, x, "1");
		await flushAll();
		la.hold(true);
		type(a, x, " LATE");
		await clock.advance(60);
		await agent([{ op: "move", block: { id: x }, parent: { id: two.pageId } }]);
		await agent([{ op: "delete", block: { id: x } }]);
		await clock.settle();
		// The log stops taking writes: A's typing is processed (not taken), never acknowledged,
		// so its notice waits; meanwhile the block comes back and its text reaches A whole.
		setOutlineStore({
			...realStore,
			appendLiveLog: async () => {
				throw new Error("disk I/O error");
			},
		});
		la.hold(false);
		await clock.settle();
		await agent([{ op: "restore", block: { id: x } } as OutlineOp]);
		await agent([{ op: "move", block: { id: x }, parent: { id: one.pageId } }]);
		await clock.settle();
		expect(a.visible.alive(x)).toBeDefined();
		setOutlineStore(realStore);
		await clock.advance(1_000);
		await clock.settle();
		expect(a.pending.length + a.awaiting.length).toBe(0);
		expect(unsavedTextsOf(one.pageId).map((e) => [e.blockId, e.text, e.reason])).toEqual([
			[x, "goes1 LATE", "moved_away"],
		]);
		// Not at the unknown generation: the session's text, and the next keystroke lands.
		expect(a.genOf(x)).toBe(liveSpaceOf(space.id)?.genOf(x) as number);
		expect(a.textOf(x)).toBe("goes1");
		type(a, x, " Z");
		await flushAll();
		expect((await block(x))?.content).toBe("goes1 Z");
		expect(a.stats.rejects).toBe(0);
	});

	test("(b) a refused transaction's text in a block with a moved_away entry joins that entry", async () => {
		const one = await page(["goes", "y", "z"], "One");
		const two = await page(["there"], "Two");
		const [x, y, z] = one.ids as [string, string, string];
		const la = link(owner);
		const a = open(la, one.pageId);
		const b = open(link(writer), two.pageId);
		await clock.until(() => a.ready && b.ready, 5000, "joined");
		la.hold(true);
		type(a, x, " LATE");
		await clock.advance(60);
		await agent([{ op: "move", block: { id: x }, parent: { id: two.pageId } }]);
		await agent([{ op: "delete", block: { id: x } }]);
		await clock.settle();
		la.hold(false);
		await clock.until(() => a.pending.length === 0, 5000, "answered");
		await clock.settle();
		expect(unsavedTextsOf(one.pageId).map((e) => [e.blockId, e.reason])).toEqual([
			[x, "moved_away"],
		]);
		// More typed into that copy, with a move the page refuses (its target deleted meanwhile).
		la.hold(true);
		struct(a, [{ t: "m", id: y, p: z, k: keyBetween(null, null) }], [{ id: x, md: "goes LATE 2" }]);
		await clock.advance(60);
		await agent([{ op: "delete", block: { id: z } }]);
		await clock.settle();
		la.hold(false);
		await clock.until(() => a.stats.rejects > 0 && a.status === "live", 5000, "refused");
		await clock.settle();
		expect(unsavedTextsOf(one.pageId).map((e) => [e.blockId, e.text, e.reason])).toEqual([
			[x, "goes LATE 2", "moved_away"],
		]);
	});

	test("(c) a retry after `ended` does not fire once a later join succeeded", async () => {
		const one = await page(["x"], "One");
		const x = one.ids[0] as string;
		const la = link(owner);
		const a = open(la, one.pageId);
		await clock.until(() => a.ready, 5000, "joined");
		const closing = closeAllLiveSessions("ended");
		await clock.settle();
		await closing;
		expect(a.status).toBe("offline");
		// The connection comes back before the retry is due: the join it makes succeeds.
		la.disconnect();
		la.reconnect();
		await clock.until(() => a.status === "live", 5000, "live again");
		type(a, x, "1");
		await clock.settle();
		const rebuilds = a.stats.rebuilds;
		const joins = la.socket.sent.filter((f) => f.kind === LIVE_FRAME.joined).length;
		await clock.advance(5_000);
		await clock.settle();
		expect(a.stats.rebuilds).toBe(rebuilds);
		expect(la.socket.sent.filter((f) => f.kind === LIVE_FRAME.joined).length).toBe(joins);
		expect(a.undoStack.length).toBe(1);
		await flushAll();
		expect((await block(x))?.content).toBe("x1");
	});
});
