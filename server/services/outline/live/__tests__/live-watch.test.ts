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
	OUTLINE_LIVE_SOCKET_BOUNDS,
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

/** What a fresh joiner of `rootId`'s subtree is shown (what the session holds there). */
async function freshOutline(rootId: string): Promise<string> {
	const c = open(link(third), rootId);
	await clock.until(() => c.ready || c.closeCode !== null, 5000, "fresh joiner");
	return c.outline();
}

describe("a watch ended by a move still gets the move (review B1)", () => {
	test("by an agent: a watcher of both places keeps the moved subtree where it went", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const b1 = two.ids[0] as string;
		const lf = link(owner);
		const f = open(lf, "", [{ s: one.pageId }, { s: two.pageId }]);
		const q = open(link(writer), one.pageId);
		await clock.until(() => f.ready && q.ready, 5000, "joined");
		const sentF = lf.socket.sent.length;
		await agent([{ op: "move", block: { id: one.pageId }, parent: { id: b1 } }]);
		await clock.settle();
		expect((await block(one.pageId))?.parentId).toBe(b1);
		expect(f.watchSet).toEqual([{ s: two.pageId }]);
		// A move (not a delete and an insert).
		const opsOfOne = lf.socket.sent
			.slice(sentF)
			.flatMap(
				(fr) => (fr.head as { c?: Array<{ ops: Array<{ t: string; id: string }> }> }).c ?? [],
			)
			.flatMap((c) => c.ops)
			.filter((op) => op.id === one.pageId)
			.map((op) => op.t);
		expect(opsOfOne).toEqual(["m"]);
		expect(f.outline(two.pageId)).toBe("- b1\n  - One\n    - a1");
		expect(q.closeCode).toBe("ended");
		expect(await freshOutline(two.pageId)).toBe(f.outline(two.pageId));
		type(f, one.ids[0] as string, "!");
		await flushAll();
		expect((await block(one.ids[0] as string))?.content).toBe("a1!");
		expect(f.stats.rejects).toBe(0);
	});

	test("by a third person: the watcher of both places is sent the move, not left with a hole", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const b1 = two.ids[0] as string;
		const lf = link(owner);
		const f = open(lf, "", [{ s: one.pageId }, { s: two.pageId }]);
		const q = open(link(writer), one.pageId);
		// The mover sees the top level and Two: it can put One under b1.
		const m = open(link(third), "", [{ l: null }, { s: two.pageId }]);
		await clock.until(() => f.ready && q.ready && m.ready, 5000, "joined");
		struct(m, [{ t: "m", id: one.pageId, p: b1, k: keyBetween(null, null) }]);
		await clock.settle();
		expect((await block(one.pageId))?.parentId).toBe(b1);
		expect(f.watchSet).toEqual([{ s: two.pageId }]);
		expect(f.outline(two.pageId)).toBe("- b1\n  - One\n    - a1");
		expect(m.outline(two.pageId)).toBe("- b1\n  - One\n    - a1");
		expect(q.closeCode).toBe("ended");
		expect(await freshOutline(two.pageId)).toBe(f.outline(two.pageId));
		expect(f.stats.rejects + m.stats.rejects).toBe(0);
	});

	test("while the watcher's own change waits for the log: the end comes after the move", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1", "b2"], "Two");
		const [b1, b2] = two.ids as [string, string];
		const lf = link(owner);
		const f = open(lf, "", [{ s: one.pageId }, { s: two.pageId }]);
		await clock.until(() => f.ready, 5000, "joined");
		type(f, b1, "!");
		await flushAll();
		setOutlineStore({
			...realStore,
			appendLiveLog: async () => {
				throw new Error("disk I/O error");
			},
		});
		// F's own structural change is committed but not logged: not acknowledged yet, so what
		// others change after it waits for it.
		struct(f, [
			{ t: "m", id: b2, p: two.pageId, k: keyBetween(null, f.visible.get(b1)?.orderKey ?? null) },
		]);
		await clock.settle();
		expect(f.pending.length + f.awaiting.length).toBeGreaterThan(0);
		await agent([{ op: "move", block: { id: one.pageId }, parent: { id: b1 } }]);
		await clock.settle();
		setOutlineStore(realStore);
		await clock.advance(1_000);
		await clock.settle();
		expect(f.pending.length + f.awaiting.length).toBe(0);
		expect(f.watchSet).toEqual([{ s: two.pageId }]);
		expect(f.outline(two.pageId)).toBe(await freshOutline(two.pageId));
		expect(f.outline(two.pageId)).toContain("- One\n");
		expect(f.stats.rejects).toBe(0);
	});
});

describe("a block moved into a watched subtree brings what is under it (review B2)", () => {
	test("moved by a person from a level watch: its children come too, and nothing goes next to hidden ones", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const a1 = one.ids[0] as string;
		const b1 = two.ids[0] as string;
		const g = (await agent([{ op: "insert", parent: { id: a1 }, content: "grandchild" }]))
			.results[0]?.blockId as string;
		const a = open(link(owner), "", [{ l: one.pageId }, { s: two.pageId }]);
		const p = open(link(writer), two.pageId);
		await clock.until(() => a.ready && p.ready, 5000, "joined");
		struct(a, [{ t: "m", id: a1, p: b1, k: keyBetween(null, null) }]);
		await clock.settle();
		expect((await block(a1))?.parentId).toBe(b1);
		expect(p.outline()).toBe("- b1\n  - a1\n    - grandchild");
		expect(a.outline(two.pageId)).toBe("- b1\n  - a1\n    - grandchild");
		expect(p.textOf(g)).toBe("grandchild");
		expect(await freshOutline(two.pageId)).toBe(p.outline());
		// The grandchild is the session's now: typed into, and a sibling put next to it.
		type(p, g, "!");
		const n = a.newId();
		struct(a, [
			{
				t: "i",
				id: n,
				p: a1,
				k: keyBetweenLoose(a.visible.get(g)?.orderKey ?? null, null),
				content: "next",
			},
		]);
		await clock.settle();
		expect(p.outline()).toBe("- b1\n  - a1\n    - grandchild!\n    - next");
		expect(a.stats.rejects + p.stats.rejects).toBe(0);
	});

	test("moved by an agent within one page: its children come too", async () => {
		const pg = await page(["X", "S"], "P");
		const [x, s] = pg.ids as [string, string];
		const a1 = (await agent([{ op: "insert", parent: { id: x }, content: "a1" }])).results[0]
			?.blockId as string;
		const g = (await agent([{ op: "insert", parent: { id: a1 }, content: "g" }])).results[0]
			?.blockId as string;
		await agent([{ op: "insert", parent: { id: g }, content: "gg" }]);
		const w1 = open(link(owner), "", [{ l: x }, { s }]);
		const w2 = open(link(writer), s);
		await clock.until(() => w1.ready && w2.ready, 5000, "joined");
		await agent([{ op: "move", block: { id: a1 }, parent: { id: s } }]);
		await clock.settle();
		expect(w2.outline()).toBe("- a1\n  - g\n    - gg");
		expect(w1.outline(s)).toBe("- a1\n  - g\n    - gg");
		expect(await freshOutline(s)).toBe(w2.outline());
		type(w2, g, "!");
		await flushAll();
		expect((await block(g))?.content).toBe("g!");
	});
});

describe("budgets of a join or watch frame (review S1, S3)", () => {
	test("one join with two watches past one person's share is refused", async () => {
		const one = await page(
			Array.from({ length: 9 }, (_, i) => `o${i}`),
			"One",
		);
		const two = await page(
			Array.from({ length: 9 }, (_, i) => `t${i}`),
			"Two",
		);
		OUTLINE_LIVE_BOUNDS.maxUserBlocks = 15;
		const a = open(link(owner), "", [{ s: one.pageId }, { s: two.pageId }]);
		await clock.until(() => a.ready || a.closeCode !== null, 5000, "answered");
		expect(a.closeCode).toBe("user_limit");
	});

	test("one watch frame adding several past the share: the rest are refused without being read", async () => {
		const one = await page(
			Array.from({ length: 4 }, (_, i) => `o${i}`),
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
		const four = await page(["f"], "Four");
		OUTLINE_LIVE_BOUNDS.maxUserBlocks = 15;
		const a = open(link(owner), one.pageId);
		await clock.until(() => a.ready, 5000, "joined");
		const read: string[] = [];
		setOutlineStore({
			...realStore,
			getBlock: async (id) => {
				read.push(id);
				return await realStore.getBlock(id);
			},
		});
		a.watch({ add: [{ s: two.pageId }, { s: three.pageId }, { s: four.pageId }] });
		await clock.settle();
		expect(a.watchSet).toEqual([{ s: one.pageId }, { s: two.pageId }]);
		expect(a.watchRefused.get(`s:${three.pageId}`)).toBe("user_limit");
		expect(a.watchRefused.get(`s:${four.pageId}`)).toBe("user_limit");
		expect(read).not.toContain(four.pageId);
	});

	test("the process's bound on watches counts what a frame adds", async () => {
		const one = await page(["o"], "One");
		const two = await page(["t"], "Two");
		const three = await page(["h"], "Three");
		const a = open(link(owner), one.pageId);
		await clock.until(() => a.ready, 5000, "joined");
		const limits = OUTLINE_LIVE_LIMITS as { liveWatches: number };
		const savedWatches = limits.liveWatches;
		try {
			limits.liveWatches = (liveSpaceOf(space.id)?.scopes.size ?? 0) + 1;
			a.watch({ add: [{ s: two.pageId }, { s: three.pageId }] });
			await clock.settle();
			expect(a.watchSet).toEqual([{ s: one.pageId }, { s: two.pageId }]);
			expect(a.watchRefused.get(`s:${three.pageId}`)).toBe("unavailable");
		} finally {
			limits.liveWatches = savedWatches;
		}
	});

	test("a subtree watch inside a loaded one past the bound is too_large", async () => {
		const one = await page(["inner"], "One");
		const inner = one.ids[0] as string;
		await agent(
			["x", "y", "z"].map((content) => ({ op: "insert" as const, parent: { id: inner }, content })),
		);
		const a = open(link(owner), one.pageId);
		await clock.until(() => a.ready, 5000, "joined");
		const limits = OUTLINE_LIVE_LIMITS as { maxWatchBlocks: number };
		const savedMax = limits.maxWatchBlocks;
		try {
			limits.maxWatchBlocks = 3;
			const b = open(link(writer), "", [{ s: inner }]);
			await clock.until(() => b.ready || b.closeCode !== null, 5000, "answered");
			expect(b.closeCode).toBe("too_large");
		} finally {
			limits.maxWatchBlocks = savedMax;
		}
	});
});

describe("watch changes that cross other traffic (review S2, S4)", () => {
	test("a removal while the log refuses writes still takes effect; added back later it is whole", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const a1 = one.ids[0] as string;
		const a = open(link(owner), "", [{ s: one.pageId }, { s: two.pageId }]);
		const c = open(link(third), one.pageId);
		await clock.until(() => a.ready && c.ready, 5000, "joined");
		setOutlineStore({
			...realStore,
			appendLiveLog: async () => {
				throw new Error("disk I/O error");
			},
		});
		type(c, a1, " x");
		await clock.advance(45);
		a.watch({ remove: [{ s: one.pageId }] });
		await clock.settle();
		setOutlineStore(realStore);
		await clock.advance(1000);
		await clock.settle();
		const server = [...(liveSpaceOf(space.id)?.participants.values() ?? [])].find(
			(x) => x.userId === owner,
		);
		expect(server?.views.map((v) => v.key)).toEqual([`s:${two.pageId}`]);
		expect(a.hasText(a1)).toBe(false);
		a.watch({ add: [{ s: one.pageId }] });
		await clock.settle();
		expect(a.watchSet).toEqual([{ s: two.pageId }, { s: one.pageId }]);
		expect(a.textOf(a1)).toBe("a1 x");
	});

	test("added and removed before the answer: not watched, on either end", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const la = link(owner);
		const a = open(la, one.pageId);
		await clock.until(() => a.ready, 5000, "joined");
		la.holdDown(true);
		a.watch({ add: [{ s: two.pageId }] });
		a.watch({ remove: [{ s: two.pageId }] });
		await clock.settle();
		la.holdDown(false);
		await clock.settle();
		expect(a.watchSet).toEqual([{ s: one.pageId }]);
		expect(a.hasText(two.ids[0] as string)).toBe(false);
		const server = [...(liveSpaceOf(space.id)?.participants.values() ?? [])].find(
			(x) => x.userId === owner,
		);
		expect(server?.views.map((v) => v.key)).toEqual([`s:${one.pageId}`]);
	});

	test("typing not sent yet reaches the page before its watch is removed", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const a1 = one.ids[0] as string;
		const a = open(link(owner), "", [{ s: one.pageId }, { s: two.pageId }]);
		await clock.until(() => a.ready, 5000, "joined");
		type(a, a1, " typed");
		a.watch({ remove: [{ s: one.pageId }] });
		await flushAll();
		expect((await block(a1))?.content).toBe("a1 typed");
		expect(unsavedTextsOf(one.pageId)).toEqual([]);
		expect(a.stats.rejects).toBe(0);
	});
});

describe("review round 2", () => {
	test("S6: a level shows its children only: what a subtree watch showed under one goes with that watch", async () => {
		const one = await page(["d", "x"], "One");
		const [d, x] = one.ids as [string, string];
		await agent(
			Array.from({ length: 15 }, (_, i) => ({
				op: "insert" as const,
				parent: { id: x },
				content: `k${i}`,
			})),
		);
		const limits = OUTLINE_LIVE_LIMITS as { maxWatchBlocks: number };
		const savedMax = limits.maxWatchBlocks;
		try {
			limits.maxWatchBlocks = 10;
			const a = open(link(owner), d);
			const f = open(link(writer), "", [{ s: d }, { l: one.pageId }]);
			await clock.until(() => a.ready && f.ready, 5000, "joined");
			// x and its 15 children into d: more than d's watch takes, so the watch ends.
			await agent([{ op: "move", block: { id: x }, parent: { id: d } }]);
			await clock.settle(100, 20_000);
			await clock.advance(3000);
			await clock.settle(100, 20_000);
			expect(a.closeCode).toBe("too_large");
			expect(f.watchSet).toEqual([{ l: one.pageId }]);
			// d is One's child (shown by the level); x is under d now: not shown.
			expect(f.visible.alive(d)).toBeDefined();
			expect(f.visible.alive(x)).toBeUndefined();
			expect(f.visible.children(d)).toEqual([]);
			expect(f.hasText(x)).toBe(false);
			type(f, d, "!");
			await flushAll();
			expect((await block(d))?.content).toBe("d!");
			expect(f.stats.rejects).toBe(0);
		} finally {
			limits.maxWatchBlocks = savedMax;
		}
	});

	test("S7: additions clicked quickly go out together; past the socket's rate they are retried until loaded", async () => {
		const pages: string[] = [];
		for (let i = 0; i < 26; i++) pages.push((await page([`c${i}`], `L${i}`)).pageId);
		const la = link(owner);
		const a = open(la, pages[0] as string);
		await clock.until(() => a.ready, 5000, "joined");
		const framesBefore = la.framesUp;
		// Same moment: one frame.
		for (let i = 1; i < 13; i++) a.watch({ add: [{ l: pages[i] as string }] });
		await clock.settle();
		expect(a.watchSet.length).toBe(13);
		expect(la.framesUp - framesBefore).toBe(1);
		// Spaced out past the batching, faster than the socket's rate: some are told to wait,
		// and come in later all the same.
		for (let i = 13; i < 26; i++) {
			a.watch({ add: [{ l: pages[i] as string }] });
			await clock.advance(OUTLINE_LIVE_LIMITS.watchBatchMs + 5);
		}
		await clock.settle();
		await clock.advance(20_000);
		await clock.settle();
		expect(a.watchSet.length).toBe(26);
		expect([...a.watchRefused.values()]).toEqual([]);
	});

	test("S7: a socket past its rate is told too_fast (not unavailable), without a read", async () => {
		const pages: string[] = [];
		for (let i = 0; i < 3; i++) pages.push((await page([`c${i}`], `R${i}`)).pageId);
		const answers: LiveFrame[] = [];
		const s = new TestSocket(owner, "raw", (frame) => {
			const d = decodeLiveFrame(frame);
			if (d) answers.push(d);
		});
		await joinLive(s, {
			kind: LIVE_FRAME.join,
			handle: 1,
			n: 0,
			head: joinHead(pages[0] as string, "edit", "rawratelimit1"),
			body: new Uint8Array(0),
		});
		await clock.settle();
		const read: string[] = [];
		setOutlineStore({
			...realStore,
			getBlock: async (id) => {
				read.push(id);
				return await realStore.getBlock(id);
			},
		});
		for (let w = 1; w <= OUTLINE_LIVE_SOCKET_BOUNDS.watchBurst + 1; w++)
			handleLiveFrame(
				s,
				decodeLiveFrame(
					encodeLiveFrame({
						kind: LIVE_FRAME.watch,
						handle: 1,
						head: { w, add: [{ l: `nosuchblock${w}` }] },
					}),
				) as LiveFrame,
			);
		await clock.settle();
		const codes = answers
			.filter((f) => f.kind === LIVE_FRAME.watched)
			.flatMap((f) =>
				((f.head as { refused?: [unknown, string][] }).refused ?? []).map((r) => r[1]),
			);
		expect(codes.filter((c) => c === "too_fast")).toHaveLength(1);
		expect(codes.filter((c) => c === "access_denied")).toHaveLength(
			OUTLINE_LIVE_SOCKET_BOUNDS.watchBurst,
		);
		// The one past the rate was not read.
		expect(read).not.toContain(`nosuchblock${OUTLINE_LIVE_SOCKET_BOUNDS.watchBurst + 1}`);
		releaseLiveSocket(s);
	});

	test("S8: a person's move bringing more than the space takes is refused as too_large, and said so", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const a1 = one.ids[0] as string;
		const b1 = two.ids[0] as string;
		await agent(
			Array.from({ length: 6 }, (_, i) => ({
				op: "insert" as const,
				parent: { id: a1 },
				content: `k${i}`,
			})),
		);
		const a = open(link(owner), "", [{ l: one.pageId }, { s: two.pageId }]);
		const other = open(link(writer), two.pageId);
		await clock.until(() => a.ready && other.ready, 5000, "joined");
		const size = liveSpaceOf(space.id)?.loadedBlocks as number;
		OUTLINE_LIVE_BOUNDS.maxLoadedBlocks = size + 3;
		struct(a, [{ t: "m", id: a1, p: b1, k: keyBetween(null, null) }]);
		await clock.settle();
		expect(a.lastReject?.code).toBe("too_large");
		expect((await block(a1))?.parentId).toBe(one.pageId);
		expect(a.visible.get(a1)?.parentId).toBe(one.pageId);
		expect(liveSpaceOf(space.id)?.loadedBlocks).toBeLessThanOrEqual(size + 3);
		expect(other.outline()).toBe("- b1");
	});

	test("S8: a person's move past their own share is refused as too_large", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const a1 = one.ids[0] as string;
		const b1 = two.ids[0] as string;
		await agent(
			Array.from({ length: 6 }, (_, i) => ({
				op: "insert" as const,
				parent: { id: a1 },
				content: `k${i}`,
			})),
		);
		OUTLINE_LIVE_BOUNDS.maxUserBlocks = 8;
		const a = open(link(owner), "", [{ l: one.pageId }, { s: two.pageId }]);
		await clock.until(() => a.ready, 5000, "joined");
		struct(a, [{ t: "m", id: a1, p: b1, k: keyBetween(null, null) }]);
		await clock.settle();
		expect(a.lastReject?.code).toBe("too_large");
		expect((await block(a1))?.parentId).toBe(one.pageId);
	});

	test("S8: an outside move bringing more than the space takes ends the watch it went into", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1"], "Two");
		const a1 = one.ids[0] as string;
		const b1 = two.ids[0] as string;
		await agent(
			Array.from({ length: 6 }, (_, i) => ({
				op: "insert" as const,
				parent: { id: a1 },
				content: `k${i}`,
			})),
		);
		const f = open(link(owner), "", [{ l: one.pageId }, { s: two.pageId }]);
		await clock.until(() => f.ready, 5000, "joined");
		const size = liveSpaceOf(space.id)?.loadedBlocks as number;
		OUTLINE_LIVE_BOUNDS.maxLoadedBlocks = size + 3;
		await agent([{ op: "move", block: { id: a1 }, parent: { id: b1 } }]);
		await clock.settle();
		expect(f.watchSet).toEqual([{ l: one.pageId }]);
		expect(f.visible.alive(a1)).toBeUndefined();
		expect(liveSpaceOf(space.id)?.loadedBlocks).toBeLessThanOrEqual(size + 3);
	});

	test("watch notices waiting past their bound make the participant rejoin", async () => {
		const one = await page(["a1"], "One");
		const two = await page(["b1", "b2"], "Two");
		const [b1, b2] = two.ids as [string, string];
		const lf = link(owner);
		const f = open(lf, "", [{ s: one.pageId }, { s: two.pageId }]);
		await clock.until(() => f.ready, 5000, "joined");
		type(f, b1, "!");
		await flushAll();
		setOutlineStore({
			...realStore,
			appendLiveLog: async () => {
				throw new Error("disk I/O error");
			},
		});
		// A change of F's own waits for the log: its notices wait behind it.
		struct(f, [
			{ t: "m", id: b2, p: two.pageId, k: keyBetween(null, f.visible.get(b1)?.orderKey ?? null) },
		]);
		await clock.settle();
		const resyncs = f.stats.resyncs;
		for (let i = 0; i < OUTLINE_LIVE_BOUNDS.notices + 2; i++) {
			f.watch({ add: [{ l: `nosuchblock${i}x` }] });
			await clock.advance(OUTLINE_LIVE_LIMITS.watchBatchMs + 5);
			f.watch({ remove: [{ l: `nosuchblock${i}x` }] });
			await clock.advance(250);
		}
		await clock.settle();
		const server = [...(liveSpaceOf(space.id)?.participants.values() ?? [])].find(
			(x) => x.userId === owner,
		);
		expect((server?.notices.length ?? 0) <= OUTLINE_LIVE_BOUNDS.notices).toBe(true);
		setOutlineStore(realStore);
		await clock.advance(2_000);
		await clock.settle();
		expect(f.stats.resyncs).toBeGreaterThan(resyncs);
		expect(f.status).toBe("live");
		expect(f.watchSet).toEqual([{ s: one.pageId }, { s: two.pageId }]);
		expect(f.outline(two.pageId)).toBe(await freshOutline(two.pageId));
	});

	test("S9: moving blocks into one's own subtree one at a time stops at the share (counted as shown now)", async () => {
		const one = await page(["a1", "a2", "a3"], "One");
		const two = await page(["b1"], "Two");
		const b1 = two.ids[0] as string;
		for (const id of one.ids)
			await agent(
				Array.from({ length: 6 }, (_, i) => ({
					op: "insert" as const,
					parent: { id },
					content: `k${i}`,
				})),
			);
		OUTLINE_LIVE_BOUNDS.maxUserBlocks = 12;
		const a = open(link(owner), "", [{ l: one.pageId }, { s: two.pageId }]);
		await clock.until(() => a.ready, 5000, "joined");
		const codes: string[] = [];
		for (const id of one.ids) {
			const last = a.visible.children(b1).at(-1);
			struct(a, [
				{
					t: "m",
					id,
					p: b1,
					k: keyBetweenLoose(last ? (a.visible.get(last)?.orderKey ?? null) : null, null),
				},
			]);
			await clock.settle();
			codes.push(a.lastReject?.code ?? "none");
			a.lastReject = null;
		}
		// The first fits (2 + 3 shown, 7 come in); the next two would pass the share.
		expect(codes).toEqual(["none", "too_large", "too_large"]);
		expect(a.outline(two.pageId).split("\n")).toHaveLength(8);
		const views = [...(liveSpaceOf(space.id)?.scopes.values() ?? [])];
		const own = views.reduce((n, v) => n + v.shownCount(), 0);
		expect(own).toBeLessThanOrEqual(12);
		expect((await block(one.ids[1] as string))?.parentId).toBe(one.pageId);
	});
});
