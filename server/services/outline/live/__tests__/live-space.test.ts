/**
 * One live session per space (pageless plan L2): two pages of a space share a session; a block
 * moved from one page to another by a commit appears and disappears with its text document
 * kept; pages are loaded on the first join and unloaded when nobody is in them; documents are
 * dropped by every end together (generations); the log and its replay are per space; the
 * session's memory follows what is open.
 *
 * The clients are the editor's real engine over an in-process network (`harness.ts`), still
 * joining pages: the wire protocol is unchanged in this step.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LiveClient } from "@frontend/components/outline/editor/live-client";
import { type ClientOp, keyBetweenLoose } from "@frontend/components/outline/editor/store";
import { keyBetween } from "@shared/outline";
import {
	decodeLiveFrame,
	decodeLiveTexts,
	encodeLiveFrame,
	LIVE_FRAME,
	LIVE_TEXT_KIND,
	type LiveFrame,
	OUTLINE_LIVE_PROTOCOL_VERSION,
} from "@shared/outline-live-protocol";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "../../../../db";
import { aclGrants, outlineLiveLog, projects, users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { ensureProjectSpace } from "../../spaces";
import { outlineStore } from "../../store";
import type { OutlineSpaceRow } from "../../store/port";
import { type OutlineOp, writeOutline } from "../../write";
import {
	abandonLiveSessionForTests,
	closeAllLiveSessions,
	handleLiveFrame,
	joinLive,
	liveSessionOf,
	liveSpaceOf,
	outlineLiveStats,
	releaseLiveSocket,
	runInLane,
} from "../registry";
import { replayLiveEpoch } from "../replay";
import {
	type LivePageView,
	type LiveSpace,
	OUTLINE_LIVE_BOUNDS,
	OUTLINE_LIVE_HOOKS,
	OUTLINE_LIVE_TIMING,
} from "../session";
import { client, settle, struct, TestLink, TestSocket, type, waitFor } from "./harness";

const NOW = "2026-11-15T00:00:00.000Z";
const saved = { ...OUTLINE_LIVE_TIMING };
const savedHooks = { ...OUTLINE_LIVE_HOOKS };
const savedBounds = { ...OUTLINE_LIVE_BOUNDS };

let owner: string;
let writer: string;
let third: string;
let space: OutlineSpaceRow;
const clients: LiveClient[] = [];
const links: TestLink[] = [];

async function user(label: string) {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

function link(userId: string, name = userId): TestLink {
	const l = new TestLink(userId, name);
	links.push(l);
	return l;
}

function open(l: TestLink, pageId: string): LiveClient {
	const c = client(l, pageId);
	clients.push(c);
	return c;
}

/** A page with blocks `texts` under it, in order; returns the page id and the block ids. */
async function page(texts: string[], title = "Page"): Promise<{ pageId: string; ids: string[] }> {
	const r = await writeOutline({
		spaceId: space.id,
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

/** A page of `count` blocks under it (written 190 a transaction). */
async function bigPage(count: number, title: string): Promise<string> {
	const first = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "insert", parent: null, content: title }],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const pageId = first.results[0]?.blockId as string;
	for (let at = 0; at < count; at += 190) {
		await writeOutline({
			spaceId: space.id,
			ops: Array.from({ length: Math.min(190, count - at) }, (_, i) => ({
				op: "insert" as const,
				parent: { id: pageId },
				content: `${title} block ${at + i}`,
			})),
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
	}
	return pageId;
}

function agent(ops: OutlineOp[]) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: "space-agent" },
		responsibleUserId: owner,
	});
}

async function content(id: string): Promise<string> {
	return (await outlineStore.getBlock(id))?.content ?? "<missing>";
}

function edit(c: LiveClient, id: string, md: string): void {
	struct(c, [], [{ id, md }]);
}

function session(pageId: string): LivePageView {
	const s = liveSessionOf(pageId);
	if (!s) throw new Error("no session");
	return s;
}

function theSpace(): LiveSpace {
	const s = liveSpaceOf(space.id);
	if (!s) throw new Error("no space session");
	return s;
}

/** Drop every document that can go now (the idle time is 0 in the tests that call this). */
function sweep(): Promise<number> {
	return runInLane(space.id, () => theSpace().sweepDocs());
}

function shape(state: Uint8Array): string {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, state);
	const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("hex");
	const out = `${doc.getText("t").toString()}\u0000${snapshot}`;
	doc.destroy();
	return out;
}

/**
 * Every end of a page holds the same text for every block, the same document (and the same
 * generation) wherever two ends have one, and no document has an update stuck in it.
 */
function expectSameTexts(pageId: string, cs: readonly LiveClient[]): void {
	const s = session(pageId);
	const ids = new Set<string>(s.textDocIds);
	for (const c of cs) for (const id of c.visible.blocks.keys()) ids.add(id);
	for (const id of ids) {
		const server = s.textState(id);
		expect(server?.stuck ?? false).toBe(false);
		// A block that went to another page is that page's people's now: these hold it as deleted,
		// with whatever it was when it left.
		const here = s.space.mirror.topOf(id) === pageId;
		for (const c of cs) {
			if (c.visible.get(id) && here) {
				expect(c.textOf(id)).toBe(s.textOf(id));
				expect(c.genOf(id)).toBe(s.space.genOf(id));
			}
			const mine = c.textState(id);
			expect(mine?.stuck ?? false).toBe(false);
			if (mine && c.visible.get(id) && here)
				expect(shape(mine.state)).toBe(server ? shape(server.state) : "<none>");
		}
	}
}

async function flushed(pageId: string): Promise<void> {
	await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 5000, "flush");
}

async function dbOutline(pageId: string): Promise<string> {
	const { blocks } = await outlineStore.listPageBlocks(pageId, 10_000);
	const byParent = new Map<string, typeof blocks>();
	for (const b of blocks) {
		if (b.parentId === null) continue;
		byParent.set(b.parentId, [...(byParent.get(b.parentId) ?? []), b]);
	}
	const lines: string[] = [];
	const walk = (id: string, depth: number) => {
		const list = [...(byParent.get(id) ?? [])].sort((x, y) =>
			x.orderKey < y.orderKey ? -1 : x.orderKey > y.orderKey ? 1 : x.id < y.id ? -1 : 1,
		);
		for (const b of list) {
			lines.push(`${"  ".repeat(depth)}- ${b.content}`);
			walk(b.id, depth + 1);
		}
	};
	walk(pageId, 0);
	return lines.join("\n");
}

function rng(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let x = Math.imul(t ^ (t >>> 15), 1 | t);
		x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

/** One random step of one person on its page: text, undo and redo, some structure. */
function step(c: LiveClient, pageId: string, r: () => number): void {
	if (!c.editable) return;
	const live = [...c.visible.blocks.values()].filter(
		(b) => c.visible.inPage(b.id) && b.id !== pageId,
	);
	const b = live[Math.floor(r() * live.length)];
	const roll = r();
	if (roll < 0.14) {
		c.undo();
		return;
	}
	if (roll < 0.22) {
		c.redo();
		return;
	}
	if (!b) return;
	const text = c.textOf(b.id);
	const parentId = b.parentId ?? pageId;
	const sibs = c.visible.children(parentId);
	const at = sibs.indexOf(b.id);
	const keyAt = (i: number) =>
		i >= 0 && i < sibs.length ? (c.visible.get(sibs[i] as string)?.orderKey ?? null) : null;
	if (roll < 0.6) {
		const pos = Math.floor(r() * (text.length + 1));
		const ch = "abcdefghij 大纲块"[Math.floor(r() * 14)] as string;
		if (r() < 0.5) type(c, b.id, ch, pos);
		else edit(c, b.id, text.slice(0, pos) + ch + text.slice(pos));
	} else if (roll < 0.74 && text.length > 0) {
		const pos = Math.floor(r() * text.length);
		edit(c, b.id, text.slice(0, pos) + text.slice(pos + 1));
	} else if (roll < 0.84) {
		const pos = Math.floor(r() * (text.length + 1));
		struct(
			c,
			[
				{
					t: "i",
					id: c.newId(),
					p: parentId,
					k: keyBetweenLoose(b.orderKey, keyAt(at + 1)),
					content: text.slice(pos),
				},
			],
			[{ id: b.id, md: text.slice(0, pos) }],
		);
	} else if (roll < 0.92 && at > 0) {
		const prev = sibs[at - 1] as string;
		const last = c.visible.children(prev).at(-1);
		struct(c, [
			{
				t: "m",
				id: b.id,
				p: prev,
				k: keyBetweenLoose(last ? (c.visible.get(last)?.orderKey ?? null) : null, null),
			},
		]);
	} else if (live.length > 4) {
		const ops: ClientOp[] = c.visible.subtree(b.id).map((id) => ({ t: "d", id }));
		struct(c, ops.reverse());
	}
}

beforeEach(() => {
	settings.outline.enabled = true;
	Object.assign(OUTLINE_LIVE_TIMING, {
		flushIdleMs: 60,
		flushMaxMs: 300,
		persistMs: 20,
		idleCloseMs: 150,
	});
});

afterEach(async () => {
	Object.assign(OUTLINE_LIVE_HOOKS, savedHooks);
	Object.assign(OUTLINE_LIVE_BOUNDS, savedBounds);
	for (const c of clients.splice(0)) c.dispose();
	for (const l of links.splice(0)) if (l.connected) l.disconnect();
	await closeAllLiveSessions("ended");
	Object.assign(OUTLINE_LIVE_TIMING, saved);
});

afterAll(() => {
	Object.assign(OUTLINE_LIVE_TIMING, saved);
});

beforeAll(async () => {
	owner = await user("owner");
	writer = await user("writer");
	third = await user("third");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Live space project",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	for (const principalId of [writer, third]) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId,
			capability: "write",
			createdAt: NOW,
		});
	}
	space = await ensureProjectSpace(projectId);
});

describe("two pages of one space", () => {
	test("are one session; each person is sent only their page, and both pages are committed", async () => {
		const one = await page(["a1", "a2"], "One");
		const two = await page(["b1"], "Two");
		const la = link(owner);
		const lb = link(writer);
		const a = open(la, one.pageId);
		const b = open(lb, two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		expect(session(one.pageId).space).toBe(session(two.pageId).space);
		expect(session(one.pageId).epoch).toBe(session(two.pageId).epoch);
		expect(outlineLiveStats()).toMatchObject({ spaces: 1, sessions: 2, participants: 2 });
		// 3 + 2 blocks, nothing else of the space.
		expect(theSpace().loadedBlocks).toBe(5);
		type(a, one.ids[0] as string, " from a");
		type(b, two.ids[0] as string, " from b");
		const made = a.newId();
		struct(a, [
			{
				t: "i",
				id: made,
				p: one.pageId,
				k: keyBetweenLoose(a.visible.get(one.ids[1] as string)?.orderKey ?? null, null),
				content: "new",
			},
		]);
		struct(b, [{ t: "d", id: two.ids[0] as string }]);
		b.undo();
		await settle(60);
		expect(a.outline()).toBe("- a1 from a\n- a2\n- new");
		expect(b.outline()).toBe("- b1 from b");
		// Nothing of the other page reached either socket: no text entry, no participant.
		const foreign = (l: TestLink, mine: readonly string[]) =>
			l.socket.sent
				.filter((f) => f.kind === LIVE_FRAME.batch || f.kind === LIVE_FRAME.joined)
				.flatMap((f) => decodeLiveTexts(f.body) ?? [])
				.filter((e) => !mine.includes(e.id));
		expect(foreign(la, [one.pageId, ...one.ids, made])).toEqual([]);
		expect(foreign(lb, [two.pageId, ...two.ids])).toEqual([]);
		expect(a.presence.size).toBe(0);
		expect(b.presence.size).toBe(0);
		expectSameTexts(one.pageId, [a]);
		expectSameTexts(two.pageId, [b]);
		await flushed(one.pageId);
		await flushed(two.pageId);
		expect(await dbOutline(one.pageId)).toBe(a.outline());
		expect(await dbOutline(two.pageId)).toBe(b.outline());
		expect(a.stats.rejects + b.stats.rejects).toBe(0);
	});

	test("the same person on both pages over one socket: two handles, one session", async () => {
		const one = await page(["x"], "One");
		const two = await page(["y"], "Two");
		const l = link(owner);
		const a = open(l, one.pageId);
		const b = open(l, two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, one.ids[0] as string, "1");
		type(b, two.ids[0] as string, "2");
		await settle(60);
		expect(outlineLiveStats()).toMatchObject({ spaces: 1, sessions: 2, participants: 2 });
		expect(session(one.pageId).textOf(one.ids[0] as string)).toBe("x1");
		expect(session(two.pageId).textOf(two.ids[0] as string)).toBe("y2");
	});
});

describe("a block moved from one page to another by a commit, both pages open", () => {
	test("disappears there and appears here with what is under it and its text; its document is kept; moved back, the first page's stale copy catches up", async () => {
		const one = await page(["moves", "stays"], "One");
		const two = await page(["there"], "Two");
		const x = one.ids[0] as string;
		const child = (
			await agent([{ op: "insert", parent: { id: x }, content: "under it" }])
		).results[0]?.blockId as string;
		const la = link(owner);
		const lb = link(writer);
		const a = open(la, one.pageId);
		const b = open(lb, two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, x, "!");
		await settle(60);
		const before = shape(theSpace().textState(x)?.state as Uint8Array);
		const blocks = theSpace().loadedBlocks;

		await agent([{ op: "move", block: { id: x }, parent: { id: two.pageId } }]);
		await settle(60);
		expect(a.outline()).toBe("- stays");
		expect(b.outline()).toBe("- there\n- moves!\n  - under it");
		// A move, not a delete and a new block: the same document, nothing loaded twice.
		expect(shape(theSpace().textState(x)?.state as Uint8Array)).toBe(before);
		expect(theSpace().loadedBlocks).toBe(blocks);
		expect(theSpace().mirror.topOf(x)).toBe(two.pageId);
		expectSameTexts(two.pageId, [b]);
		// The people of the page it reached type in it; the page it left hears nothing of it.
		const sentToA = la.socket.sent.length;
		type(b, x, "?");
		type(b, child, "2");
		await settle(60);
		expect(session(two.pageId).textOf(x)).toBe("moves!?");
		expect(
			la.socket.sent.slice(sentToA).flatMap((f) => decodeLiveTexts(f.body) ?? []),
		).toEqual([]);
		// Back again: the first page's people held an older state of that document.
		await agent([{ op: "move", block: { id: x }, parent: { id: one.pageId } }]);
		await settle(60);
		expect(b.outline()).toBe("- there");
		expect(a.outline()).toBe("- stays\n- moves!?\n  - under it2");
		expectSameTexts(one.pageId, [a]);
		type(a, x, "#");
		await settle(60);
		await flushed(one.pageId);
		expect(await content(x)).toBe("moves!?#");
		expect(a.stats.rejects + b.stats.rejects).toBe(0);
		expect(a.stats.rebuilds + b.stats.rebuilds).toBe(0);
	});

	test("typing that crosses the move is taken, and the page the block reached sees it", async () => {
		const one = await page(["typed in"], "One");
		const two = await page(["there"], "Two");
		const x = one.ids[0] as string;
		const la = link(owner);
		const a = open(la, one.pageId);
		const b = open(link(writer), two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		la.hold(true);
		type(a, x, " late");
		await agent([{ op: "move", block: { id: x }, parent: { id: two.pageId } }]);
		la.hold(false);
		await settle(60);
		expect(a.stats.rejects).toBe(0);
		expect(a.outline()).toBe("");
		expect(b.outline()).toBe("- there\n- typed in late");
		await flushed(two.pageId);
		expect(await content(x)).toBe("typed in late");
	});

	test("to a page nobody has open: gone here, not loaded there; opened later it is there", async () => {
		const one = await page(["leaves", "stays"], "One");
		const two = await page(["there"], "Two");
		const x = one.ids[0] as string;
		const a = open(link(owner), one.pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, x, "!");
		await settle(60);
		await flushed(one.pageId);
		await agent([{ op: "move", block: { id: x }, parent: { id: two.pageId } }]);
		await settle(60);
		expect(a.outline()).toBe("- stays");
		expect(liveSessionOf(two.pageId)).toBeUndefined();
		const b = open(link(writer), two.pageId);
		await waitFor(() => b.ready, 3000, "joined");
		expect(b.outline()).toBe("- there\n- leaves!");
		type(b, x, "?");
		await settle(60);
		expectSameTexts(two.pageId, [b]);
		// And back to the first page, whose people still hold the block as a deleted one.
		await flushed(two.pageId);
		await agent([{ op: "move", block: { id: x }, parent: { id: one.pageId } }]);
		await settle(60);
		expect(a.outline()).toBe("- stays\n- leaves!?");
		expectSameTexts(one.pageId, [a]);
		type(a, x, "#");
		await settle(60);
		expect(session(one.pageId).textOf(x)).toBe("leaves!?#");
		expectSameTexts(one.pageId, [a]);
	});

	test("a page moved under a block of another page: its session ends for its people, its blocks appear there", async () => {
		const one = await page(["inside"], "Moved page");
		const two = await page(["host"], "Two");
		const a = open(link(owner), one.pageId);
		const b = open(link(writer), two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, one.ids[0] as string, "!");
		await settle(60);
		await agent([{ op: "move", block: { id: one.pageId }, parent: { id: two.ids[0] as string } }]);
		await waitFor(() => liveSessionOf(one.pageId) === undefined, 3000, "the page's view ended");
		await settle(60);
		expect(b.outline()).toBe("- host\n  - Moved page\n    - inside!");
		expect(theSpace().scopes.size).toBe(1);
		await flushed(two.pageId);
		expect(await content(one.ids[0] as string)).toBe("inside!");
	});
});

describe("a participant's own transaction between two loaded pages", () => {
	test("is one commit: a move for nobody's page boundary; the author's page loses the block, the other gains it; a cycle across pages is refused", async () => {
		const one = await page(["goes", "stays"], "One");
		const two = await page(["host"], "Two");
		const x = one.ids[0] as string;
		const host = two.ids[0] as string;
		const b = open(link(writer), two.pageId);
		const watcher = open(link(third), one.pageId);
		await waitFor(() => b.ready && watcher.ready, 3000, "joined");
		// A participant of page one speaking the wire protocol itself (today's editor never names
		// a parent outside its page; L3's will).
		const answers: LiveFrame[] = [];
		const s = new TestSocket(owner, "raw", (f) => {
			const d = decodeLiveFrame(f);
			if (d) answers.push(d);
		});
		await joinLive(s, {
			kind: LIVE_FRAME.join,
			handle: 1,
			n: 0,
			head: { v: OUTLINE_LIVE_PROTOCOL_VERSION, page: one.pageId, mode: "edit", key: "rawclient001" },
			body: new Uint8Array(0),
		});
		expect(answers[0]?.kind).toBe(LIVE_FRAME.joined);
		const send = (n: number, ops: unknown[]) =>
			handleLiveFrame(
				s,
				decodeLiveFrame(
					encodeLiveFrame({ kind: LIVE_FRAME.tx, handle: 1, n, head: { ops } }),
				) as LiveFrame,
			);
		const from = (await outlineStore.getSpace(space.id))?.nextSeq as number;
		const commits = async () =>
			(await outlineStore.listCommits(space.id, { afterSeq: from - 1, limit: 1000 })).length;
		const before = await commits();
		send(1, [{ t: "m", id: x, p: host, k: keyBetween(null, null) }]);
		await settle(60);
		expect(await commits()).toBe(before + 1);
		expect((await outlineStore.getBlock(x))?.parentId).toBe(host);
		expect(b.outline()).toBe("- host\n  - goes");
		expect(watcher.outline()).toBe("- stays");
		// The author is told what it came to in its own page: the block is gone from it.
		const ack = answers
			.filter((f) => f.kind === LIVE_FRAME.batch)
			.flatMap((f) => (f.head as { a?: Array<[number, number, unknown[]?]> } | null)?.a ?? [])
			.find((entry) => entry[0] === 1);
		expect(ack?.[2]).toEqual([{ t: "d", id: x }]);
		// The other way round, a block under itself across pages: refused, nothing written.
		send(2, [{ t: "m", id: host, p: x, k: keyBetween(null, null) }]);
		await settle(60);
		expect(answers.some((f) => f.kind === LIVE_FRAME.reject && f.n === 2)).toBe(true);
		expect(await commits()).toBe(before + 1);
		releaseLiveSocket(s);
	});
});

describe("pages are loaded on the first join and unloaded when nobody is in them", () => {
	test("a page left alone goes from the session, its text committed first; the other page is untouched; coming back loads what the database holds", async () => {
		const one = await page(["left"], "One");
		const two = await page(["kept"], "Two");
		const la = link(owner);
		const a = open(la, one.pageId);
		const b = open(link(writer), two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		type(a, one.ids[0] as string, " unsaved");
		type(b, two.ids[0] as string, "!");
		await settle(60);
		const epoch = theSpace().epoch;
		expect(theSpace().loadedBlocks).toBe(4);
		a.dispose();
		await waitFor(() => liveSessionOf(one.pageId) === undefined, 3000, "unloaded");
		expect(theSpace().epoch).toBe(epoch);
		expect(theSpace().loadedBlocks).toBe(2);
		expect(theSpace().textDocIds).toEqual([two.ids[0] as string]);
		expect(await content(one.ids[0] as string)).toBe("left unsaved");
		// The page that stayed keeps its people, their documents and their undo history.
		expect(b.stats.rebuilds).toBe(0);
		expect(b.undoStack.length).toBe(1);
		type(b, two.ids[0] as string, "?");
		// Written while it was not loaded: nothing of it reaches the session.
		await agent([{ op: "update", block: { id: one.ids[0] as string }, content: "left, rewritten" }]);
		await settle(60);
		expect(theSpace().loadedBlocks).toBe(2);
		const again = open(link(third), one.pageId);
		await waitFor(() => again.ready, 3000, "joined");
		expect(again.outline()).toBe("- left, rewritten");
		type(again, one.ids[0] as string, "!");
		await settle(60);
		expectSameTexts(one.pageId, [again]);
		expectSameTexts(two.pageId, [b]);
	});

	test("a client away while its page was unloaded and loaded again gets a snapshot, and what it typed offline is not lost", async () => {
		const one = await page(["mine"], "One");
		const two = await page(["other"], "Two");
		const la = link(owner);
		const a = open(la, one.pageId);
		const b = open(link(writer), two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, one.ids[0] as string, "1");
		await settle(60);
		la.disconnect();
		type(a, one.ids[0] as string, "2");
		await waitFor(() => liveSessionOf(one.pageId) === undefined, 3000, "unloaded");
		expect(liveSpaceOf(space.id)).toBeDefined();
		const rebuilds = a.stats.rebuilds;
		la.reconnect();
		await waitFor(() => a.status === "live", 3000, "live again");
		await settle(60);
		expect(a.stats.resumes).toBe(0);
		expect(a.stats.rebuilds).toBe(rebuilds);
		expect(a.textOf(one.ids[0] as string)).toBe("mine12");
		expectSameTexts(one.pageId, [a]);
		await flushed(one.pageId);
		expect(await content(one.ids[0] as string)).toBe("mine12");
	});

	test("the session's budget: pages nobody is in make room for a join; when everything is in use the join is refused", async () => {
		const pages = [];
		for (let i = 0; i < 4; i++)
			pages.push(await page(Array.from({ length: 9 }, (_, n) => `p${i} b${n}`), `P${i}`));
		// Room for two pages of ten blocks.
		OUTLINE_LIVE_BOUNDS.maxLoadedBlocks = 25;
		OUTLINE_LIVE_TIMING.idleCloseMs = 60_000;
		const l = link(owner);
		const first = open(l, pages[0]?.pageId as string);
		const second = open(l, pages[1]?.pageId as string);
		await waitFor(() => first.ready && second.ready, 3000, "joined");
		expect(theSpace().loadedBlocks).toBe(20);
		// Both in use: a third page does not fit.
		const refused = open(link(writer), pages[2]?.pageId as string);
		await waitFor(() => refused.closeCode !== null, 3000, "refused");
		expect(refused.closeCode).toBe("unavailable");
		expect(theSpace().loadedBlocks).toBe(20);
		// One is left (its idle time far off): the next join takes its room.
		type(second, pages[1]?.ids[0] as string, "!");
		await settle(60);
		second.dispose();
		await settle(60);
		expect(liveSessionOf(pages[1]?.pageId as string)).toBeDefined();
		const third3 = open(link(third), pages[3]?.pageId as string);
		await waitFor(() => third3.ready, 3000, "joined");
		expect(liveSessionOf(pages[1]?.pageId as string)).toBeUndefined();
		expect(theSpace().loadedBlocks).toBe(20);
		expect(await content(pages[1]?.ids[0] as string)).toBe("p1 b0!");
	});

	test("memory follows what is open: 50 pages of 2,000 blocks opened one after another stay under the bound", async () => {
		const ids: string[] = [];
		// 2,000 blocks each, the page block included: the largest page that is edited live.
		for (let i = 0; i < 50; i++) ids.push(await bigPage(1999, `Big ${i}`));
		// Room for three such pages.
		OUTLINE_LIVE_BOUNDS.maxLoadedBlocks = 3 * 2000 + 500;
		OUTLINE_LIVE_TIMING.idleCloseMs = 60_000;
		let peak = 0;
		let previous: LiveClient | null = null;
		const heap0 = process.memoryUsage().heapUsed;
		for (const pageId of ids) {
			// A socket of its own each (a socket's joins are rate-limited).
			const c = open(link(owner), pageId);
			await waitFor(() => c.ready || c.closeCode !== null, 10_000, "joined");
			expect(c.closeCode).toBeNull();
			expect(c.visible.children(pageId)).toHaveLength(1999);
			previous?.dispose();
			previous = c;
			await settle(10, 10_000);
			peak = Math.max(peak, theSpace().loadedBlocks);
			expect(theSpace().loadedBlocks).toBeLessThanOrEqual(OUTLINE_LIVE_BOUNDS.maxLoadedBlocks);
		}
		expect(theSpace().stats.treesLoaded).toBe(50);
		expect(theSpace().stats.treesUnloaded).toBeGreaterThanOrEqual(47);
		expect(peak).toBeLessThanOrEqual(OUTLINE_LIVE_BOUNDS.maxLoadedBlocks);
		if (process.env.NF_LIVE_STRESS_LOG)
			console.log(
				`SPACE-BOUND ${JSON.stringify({
					peak,
					loadMsPerTree: theSpace().stats.loadMs / 50,
					heapGrowthMB: (process.memoryUsage().heapUsed - heap0) / 1048576,
				})}`,
			);
	}, 300_000);
});

describe("documents are dropped by every end together", () => {
	beforeEach(() => {
		OUTLINE_LIVE_TIMING.docIdleMs = 0;
		OUTLINE_LIVE_TIMING.sweepMs = 3_600_000;
	});

	test("a committed document nobody changes goes on the session and on every client; the next keystroke makes the next generation's document everywhere", async () => {
		const { pageId, ids } = await page(["x", "y"]);
		const x = ids[0] as string;
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, x, "!");
		await settle(60);
		await flushed(pageId);
		expect([session(pageId).textDocs, a.textDocs, b.textDocs]).toEqual([1, 1, 1]);
		expect(await sweep()).toBe(1);
		await settle(60);
		expect([session(pageId).textDocs, a.textDocs, b.textDocs]).toEqual([0, 0, 0]);
		const gen = theSpace().genOf(x);
		expect(gen).toBeGreaterThan(0);
		expect([a.genOf(x), b.genOf(x)]).toEqual([gen, gen]);
		expect([a.textOf(x), b.textOf(x)]).toEqual(["x!", "x!"]);
		// The drop is one entry of the block's text and its generation.
		const drops = la.socket.sent
			.flatMap((f) => decodeLiveTexts(f.body) ?? [])
			.filter((e) => e.kind === LIVE_TEXT_KIND.drop);
		expect(drops.map((e) => [e.id, e.gen])).toEqual([[x, gen]]);
		type(b, x, "?");
		type(a, x, "#", 0);
		await settle(60);
		expect([session(pageId).textDocs, a.textDocs, b.textDocs]).toEqual([1, 1, 1]);
		expect(a.textOf(x)).toBe("#x!?");
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await content(x)).toBe("#x!?");
		expect(a.stats.rejects + b.stats.rejects + a.stats.rebuilds + b.stats.rebuilds).toBe(0);
		// Someone joining now is told the generation with the text.
		const c = open(link(third), pageId);
		await waitFor(() => c.ready, 3000, "joined");
		expect(c.genOf(x)).toBe(gen);
		type(c, x, "$");
		await settle(60);
		expectSameTexts(pageId, [a, b, c]);
	});

	test("text not committed, or not yet in the log, keeps its document", async () => {
		const { pageId, ids } = await page(["x"]);
		const x = ids[0] as string;
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, x, "!");
		await settle(60);
		expect(await sweep()).toBe(0);
		expect(session(pageId).textDocs).toBe(1);
		await runInLane(space.id, () => theSpace().flushContent());
		expect(await sweep()).toBe(1);
	});

	test("a client that was away during the drop: it comes back, drops its document, and what it typed meanwhile lands on the new text", async () => {
		const { pageId, ids } = await page(["x", "y"]);
		const [x, y] = ids as [string, string];
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, x, "1");
		type(a, y, "1");
		await settle(60);
		la.disconnect();
		type(a, x, " offline");
		type(b, x, "2", 0);
		await settle(60);
		await flushed(pageId);
		expect(await sweep()).toBe(2);
		// One block gets a new document before the client is back, the other stays plain text.
		type(b, x, "3", 0);
		await settle(60);
		const undo = a.undoStack.length;
		la.reconnect();
		await waitFor(() => a.status === "live", 3000, "live again");
		await settle(80);
		expect(a.stats.resumes).toBe(1);
		expect(a.stats.rebuilds).toBe(0);
		expect(a.textOf(x)).toBe("32x1 offline");
		expect(b.textOf(x)).toBe("32x1 offline");
		expect(a.textOf(y)).toBe("y1");
		expect(a.genOf(y)).toBe(theSpace().genOf(y));
		expectSameTexts(pageId, [a, b]);
		// Its undo history is kept, less the text steps of the dropped documents.
		expect(a.undoStack.length).toBeLessThanOrEqual(undo);
		type(a, y, "!");
		await settle(60);
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await content(x)).toBe("32x1 offline");
		expect(await content(y)).toBe("y1!");
	});

	test("typing on its way when the drop happens: the frame is not taken, the client joins again and the typing lands once", async () => {
		const { pageId, ids } = await page(["x", "other"]);
		const [x, other] = ids as [string, string];
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, x, "1");
		await settle(60);
		await flushed(pageId);
		la.hold(true);
		type(a, x, "Z");
		// The same frame carries a change of another block: it must not be lost either.
		type(a, other, "!");
		await new Promise((r) => setTimeout(r, 60));
		expect(await sweep()).toBe(1);
		la.hold(false);
		await waitFor(() => a.status === "live" && a.pending.length === 0, 5000, "taken");
		await settle(80);
		expect(a.stats.rejects).toBe(0);
		expect(a.stats.rebuilds).toBe(0);
		expect(a.textOf(x)).toBe("x1Z");
		expect(b.textOf(x)).toBe("x1Z");
		expect(b.textOf(other)).toBe("other!");
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await content(x)).toBe("x1Z");
	});

	test("an undo step that names a dropped document: its text part is gone, its structure still undoes, nothing diverges; a redo likewise", async () => {
		const { pageId, ids } = await page(["x", "y"]);
		const [x, y] = ids as [string, string];
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		edit(a, x, "x one");
		const z = a.newId();
		// A step of structure and text together, then one of text alone, then one undone.
		struct(
			a,
			[{ t: "i", id: z, p: pageId, k: keyBetweenLoose(a.visible.get(y)?.orderKey ?? null, null), content: "" }],
			[{ id: y, md: "y two" }],
		);
		edit(a, x, "x one three");
		edit(a, y, "y two four");
		a.undo();
		await settle(60);
		await flushed(pageId);
		expect(a.undoStack.length).toBe(3);
		expect(a.redoStack.length).toBe(1);
		expect(await sweep()).toBe(2);
		await settle(60);
		expect(a.textDocs).toBe(0);
		// The text-only steps are gone from both stacks; the step with structure stays.
		expect(a.redoStack.length).toBe(0);
		expect(a.undoStack.length).toBe(1);
		expect(a.redo()).toBe(false);
		expect(a.undo()).toBe(true);
		await settle(60);
		expect(a.outline()).toBe("- x one three\n- y two");
		expect(b.outline()).toBe("- x one three\n- y two");
		expect(a.undo()).toBe(false);
		expect(a.redo()).toBe(true);
		await settle(60);
		expect(b.outline()).toBe("- x one three\n- y two\n- ");
		expectSameTexts(pageId, [a, b]);
		expect(a.stats.rejects + a.stats.rebuilds).toBe(0);
	});

	test("a deleted block's document is dropped too, and undoing the delete brings the block back with its text", async () => {
		const { pageId, ids } = await page(["keep"]);
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		const w = a.newId();
		struct(a, [
			{
				t: "i",
				id: w,
				p: pageId,
				k: keyBetweenLoose(a.visible.get(ids[0] as string)?.orderKey ?? null, null),
				content: "hello",
			},
		]);
		await settle(60);
		struct(a, [{ t: "d", id: w }]);
		await settle(60);
		await flushed(pageId);
		expect(session(pageId).textDocIds).toEqual([w]);
		expect(await sweep()).toBe(1);
		await settle(60);
		expect([session(pageId).textDocs, a.textDocs, b.textDocs]).toEqual([0, 0, 0]);
		expect(a.undo()).toBe(true);
		await settle(60);
		expect(a.outline()).toBe("- keep\n- hello");
		expect(b.outline()).toBe("- keep\n- hello");
		await flushed(pageId);
		expect(await content(w)).toBe("hello");
		type(b, w, "!");
		await settle(60);
		expectSameTexts(pageId, [a, b]);
		expect(a.stats.rejects + b.stats.rejects).toBe(0);
	});

	test("blocks made and deleted over and over, a bound of 256 documents: none is reached, the session never starts afresh, the undo history stays", async () => {
		const { pageId, ids } = await page(["stays"]);
		const stays = ids[0] as string;
		// What made the session start afresh every 256 documents before documents were dropped.
		OUTLINE_LIVE_BOUNDS.maxDocBytes = 256 * OUTLINE_LIVE_BOUNDS.docCostBytes;
		OUTLINE_LIVE_BOUNDS.softDocs = 64;
		OUTLINE_LIVE_TIMING.docIdleMs = 3_600_000;
		OUTLINE_LIVE_TIMING.sweepMs = 20;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		const epoch = session(pageId).epoch;
		let peak = 0;
		for (let round = 0; round < 20; round++) {
			const last = a.visible.children(pageId).at(-1) as string;
			let key = a.visible.get(last)?.orderKey ?? null;
			const ops: ClientOp[] = [];
			for (let i = 0; i < 100; i++) {
				key = keyBetween(key, null);
				ops.push({ t: "i", id: a.newId(), p: pageId, k: key, content: "x" });
			}
			struct(a, ops);
			await settle(30, 20_000);
			peak = Math.max(peak, session(pageId).textDocs);
			struct(
				a,
				a.visible
					.children(pageId)
					.filter((id) => id !== stays)
					.map((id) => ({ t: "d" as const, id })),
			);
			await settle(30, 20_000);
			await waitFor(() => session(pageId).textDocs <= 64, 10_000, "documents dropped");
			peak = Math.max(peak, session(pageId).textDocs);
		}
		await settle(60, 20_000);
		expect(session(pageId).epoch).toBe(epoch);
		expect(a.stats.rebuilds).toBe(0);
		expect(a.stats.rejects).toBe(0);
		// One transaction makes 100 documents at once on top of what the soft bound leaves.
		expect(peak).toBeLessThanOrEqual(64 + 100);
		expect(theSpace().stats.docsEvicted).toBeGreaterThanOrEqual(1900);
		expect(a.textDocs).toBeLessThanOrEqual(64);
		expect(a.undoStack.length).toBe(40);
		expect(a.outline()).toBe("- stays");
		// The latest delete undoes: 100 blocks back with their text.
		a.undo();
		await settle(60, 20_000);
		expect(a.visible.children(pageId)).toHaveLength(101);
		expect(a.textOf(a.visible.children(pageId).at(-1) as string)).toBe("x");
		await flushed(pageId);
		expect((await dbOutline(pageId)).split("\n")).toHaveLength(101);
	}, 120_000);

	const SEEDS = process.env.NF_LIVE_SPACE_SEEDS
		? process.env.NF_LIVE_SPACE_SEEDS.split(",").map(Number)
		: [3, 17, 404, 9001, 31337, 65537];
	for (const seed of SEEDS) {
		test(`seed ${seed}: three people type, undo, redo, disconnect and stall while documents are dropped at random; every end converges`, async () => {
			const { pageId } = await page(Array.from({ length: 8 }, (_, i) => `block ${i}`));
			const r = rng(seed);
			const ls = [owner, writer, third].map((u, i) => link(u, `p${i}`));
			const cs = ls.map((l) => open(l, pageId));
			await waitFor(() => cs.every((c) => c.ready), 3000, "joined");
			let dropped = 0;
			for (let n = 0; n < 360; n++) {
				const i = Math.floor(r() * cs.length);
				const l = ls[i] as TestLink;
				const dice = r();
				if (dice < 0.07) {
					if (l.connected) l.hold(!l.held);
				} else if (dice < 0.1) {
					if (l.connected) l.disconnect();
					else l.reconnect();
				} else if (dice < 0.2) {
					// Commit what is typed and drop whatever can go, while frames are in flight.
					await runInLane(space.id, () => theSpace().flushContent());
					dropped += await sweep();
				}
				step(cs[i] as LiveClient, pageId, r);
				if (n % 10 === 0) await new Promise((res) => setTimeout(res, 4));
			}
			for (const l of ls) {
				l.hold(false);
				if (!l.connected) l.reconnect();
			}
			await waitFor(() => cs.every((c) => c.status === "live"), 10_000, "everyone live");
			await settle(80, 20_000);
			expect(dropped).toBeGreaterThan(10);
			const outlines = cs.map((c) => c.outline());
			expect(outlines[1]).toBe(outlines[0] as string);
			expect(outlines[2]).toBe(outlines[0] as string);
			expectSameTexts(pageId, cs);
			// Everyone undoes and redoes all they can: still one page.
			for (const c of cs) {
				let guard = 0;
				while (c.undo() && guard++ < 1000);
				await settle(40, 20_000);
				guard = 0;
				while (c.redo() && guard++ < 1000);
				await settle(40, 20_000);
			}
			await runInLane(space.id, () => theSpace().flushContent());
			dropped += await sweep();
			await settle(80, 20_000);
			const end = cs.map((c) => c.outline());
			expect(end[1]).toBe(end[0] as string);
			expect(end[2]).toBe(end[0] as string);
			expectSameTexts(pageId, cs);
			await flushed(pageId);
			expect(await dbOutline(pageId)).toBe(end[0] as string);
		}, 90_000);
	}
});

describe("the log is the space's, and so is its replay", () => {
	const rowsOf = (epoch: number) =>
		db
			.select()
			.from(outlineLiveLog)
			.where(and(eq(outlineLiveLog.spaceId, space.id), eq(outlineLiveLog.epoch, epoch)))
			.all()
			.sort((p, q) => p.seq - q.seq);

	test("a crash with three pages being edited, one document dropped and one page unloaded before it: everything typed is committed, as its author's", async () => {
		const one = await page(["one"], "One");
		const two = await page(["two", "two b"], "Two");
		const three = await page(["three"], "Three");
		const four = await page(["four"], "Four");
		const a = open(link(owner), one.pageId);
		const b = open(link(writer), two.pageId);
		const c = open(link(third), three.pageId);
		const d = open(link(third), four.pageId);
		await waitFor(() => a.ready && b.ready && c.ready && d.ready, 3000, "joined");
		const epoch = theSpace().epoch;
		const from = (await outlineStore.getSpace(space.id))?.nextSeq as number;
		// A page unloaded (committed) and a document dropped before the crash.
		type(d, four.ids[0] as string, " d");
		type(b, two.ids[1] as string, " early");
		await settle(60);
		d.dispose();
		await waitFor(() => liveSessionOf(four.pageId) === undefined, 3000, "unloaded");
		await flushed(two.pageId);
		OUTLINE_LIVE_TIMING.docIdleMs = 0;
		expect(await sweep()).toBe(1);
		OUTLINE_LIVE_TIMING.docIdleMs = saved.docIdleMs;
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		type(a, one.ids[0] as string, " a");
		type(b, two.ids[0] as string, " b");
		type(b, two.ids[1] as string, " late");
		type(c, three.ids[0] as string, " c");
		// An outside write the session merges, logged with the rest.
		await agent([{ op: "update", block: { id: three.ids[0] as string }, content: "agent: three" }]);
		await settle(60);
		await runInLane(space.id, () => theSpace().persistNow());
		const rows = rowsOf(epoch);
		expect(rows.length).toBeGreaterThan(2);
		// A text row of one block names it; snapshot and bookkeeping rows name none.
		expect(rows.some((row) => row.blockId !== null)).toBe(true);
		expect(rows[0]?.blockId).toBeNull();
		abandonLiveSessionForTests(one.pageId);
		expect(liveSpaceOf(space.id)).toBeUndefined();
		expect(await content(one.ids[0] as string)).toBe("one");
		expect(await replayLiveEpoch(space.id, epoch)).toBe("committed");
		expect(await content(one.ids[0] as string)).toBe("one a");
		expect(await content(two.ids[0] as string)).toBe("two b");
		expect(await content(two.ids[1] as string)).toBe("two b early late");
		expect(await content(three.ids[0] as string)).toBe("agent: three c");
		expect(await content(four.ids[0] as string)).toBe("four d");
		expect(rowsOf(epoch)).toHaveLength(0);
		// Each person's text is their own commit.
		const commits = await outlineStore.listCommits(space.id, { afterSeq: from - 1, limit: 1000 });
		const recovered = commits.filter((x) => x.summary === "live edit (recovered)");
		expect(new Set(recovered.slice(-3).map((x) => x.actorId))).toEqual(
			new Set([owner, writer, third]),
		);
	});

	test("opening any page of the space after a crash replays the whole space's log first", async () => {
		const one = await page(["one"], "One");
		const two = await page(["two"], "Two");
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), one.pageId);
		const b = open(link(writer), two.pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, one.ids[0] as string, " a");
		type(b, two.ids[0] as string, " b");
		await settle(60);
		await runInLane(space.id, () => theSpace().persistNow());
		const epoch = theSpace().epoch;
		abandonLiveSessionForTests(two.pageId);
		a.dispose();
		b.dispose();
		const c = open(link(third), one.pageId);
		await waitFor(() => c.ready, 3000, "joined");
		expect(c.outline()).toBe("- one a");
		expect(await content(two.ids[0] as string)).toBe("two b");
		expect(rowsOf(epoch)).toHaveLength(0);
	});
});

describe("several people on several pages with an agent that moves blocks between them (seeded)", () => {
	const SEEDS = process.env.NF_LIVE_SPACE_SEEDS
		? process.env.NF_LIVE_SPACE_SEEDS.split(",").map(Number)
		: [7, 21, 1234, 80808, 5, 99, 4242, 271828];
	for (const seed of SEEDS) {
		test(`seed ${seed}: every page's people converge on what the database holds`, async () => {
			const pages = [];
			for (let i = 0; i < 3; i++)
				pages.push(await page(Array.from({ length: 6 }, (_, n) => `p${i} block ${n}`), `P${i}`));
			const pageIds = pages.map((p) => p.pageId);
			const r = rng(seed);
			OUTLINE_LIVE_TIMING.docIdleMs = 0;
			OUTLINE_LIVE_TIMING.sweepMs = 3_600_000;
			OUTLINE_LIVE_TIMING.idleCloseMs = 60;
			// Four people: two on the first page, one on each other; one of them wanders.
			const people = [owner, writer, third, owner];
			const ls = people.map((u, i) => link(u, `p${i}`));
			const at = [0, 0, 1, 2];
			const cs = ls.map((l, i) => open(l, pageIds[at[i] as number] as string));
			await waitFor(() => cs.every((c) => c.ready), 3000, "joined");
			for (let n = 0; n < 320; n++) {
				const i = Math.floor(r() * cs.length);
				const l = ls[i] as TestLink;
				const dice = r();
				if (dice < 0.06) {
					if (l.connected) l.hold(!l.held);
				} else if (dice < 0.085) {
					if (l.connected) l.disconnect();
					else l.reconnect();
				} else if (dice < 0.2) {
					// The agent: a new block, another text, a delete, or a move to another page.
					const from = pageIds[Math.floor(r() * 3)] as string;
					const to = pageIds[Math.floor(r() * 3)] as string;
					const { blocks } = await outlineStore.listPageBlocks(from, 10_000);
					const live = blocks.filter((x) => x.id !== from);
					const pick = live[Math.floor(r() * live.length)];
					const what = r();
					const ops: OutlineOp[] = [];
					if (what < 0.2 || !pick)
						ops.push({ op: "insert", parent: { id: to }, content: `agent block ${n}` });
					else if (what < 0.4)
						ops.push({
							op: "update",
							block: { id: pick.id },
							content: `${pick.content} [agent ${n}]`,
						});
					else if (what < 0.5 && live.length > 3) ops.push({ op: "delete", block: { id: pick.id } });
					else {
						const there = (await outlineStore.listPageBlocks(to, 10_000)).blocks;
						const under = there[Math.floor(r() * there.length)];
						if (under && under.id !== pick.id)
							ops.push({ op: "move", block: { id: pick.id }, parent: { id: under.id } });
					}
					if (ops.length > 0) await agent(ops).catch(() => {});
				} else if (dice < 0.24) {
					await runInLane(space.id, async () => {
						await liveSpaceOf(space.id)?.flushContent();
					});
					if (liveSpaceOf(space.id)) await sweep();
				} else if (dice < 0.26 && i === 3) {
					// The wanderer leaves its page (which may unload) and opens another.
					(cs[3] as LiveClient).dispose();
					at[3] = Math.floor(r() * 3);
					cs[3] = open(l, pageIds[at[3]] as string);
					if (!l.connected) l.reconnect();
					l.hold(false);
					await waitFor(() => (cs[3] as LiveClient).ready, 5000, "the wanderer joined");
				}
				step(cs[i] as LiveClient, pageIds[at[i] as number] as string, r);
				if (n % 10 === 0) await new Promise((res) => setTimeout(res, 4));
			}
			for (const l of ls) {
				l.hold(false);
				if (!l.connected) l.reconnect();
			}
			await waitFor(() => cs.every((c) => c.status === "live"), 10_000, "everyone live");
			await settle(80, 20_000);
			expect(outlineLiveStats().spaces).toBe(1);
			for (let p = 0; p < 3; p++) {
				const here = cs.filter((_, i) => at[i] === p);
				if (here.length === 0) continue;
				const pageId = pageIds[p] as string;
				for (const c of here) expect(c.outline()).toBe((here[0] as LiveClient).outline());
				expectSameTexts(pageId, here);
				await flushed(pageId);
				expect(await dbOutline(pageId)).toBe((here[0] as LiveClient).outline());
			}
		}, 90_000);
	}
});

describe("fifty people on one space (printed, not asserted on time)", () => {
	test("ten pages, five people each, all typing: one session, everything converges", async () => {
		const pages = [];
		for (let i = 0; i < 10; i++) pages.push(await page(["shared", "other"], `P${i}`));
		const everyone: Array<{ c: LiveClient; p: number }> = [];
		for (let p = 0; p < 10; p++)
			for (let i = 0; i < 5; i++)
				everyone.push({
					c: open(link([owner, writer, third][i % 3] as string, `u${p}-${i}`), pages[p]?.pageId as string),
					p,
				});
		await waitFor(() => everyone.every((e) => e.c.ready), 10_000, "joined");
		const t0 = performance.now();
		for (let round = 0; round < 10; round++) {
			for (const e of everyone) type(e.c, pages[e.p]?.ids[0] as string, "x");
			await new Promise((r) => setTimeout(r, 5));
		}
		await settle(80, 30_000);
		const ms = performance.now() - t0;
		expect(outlineLiveStats()).toMatchObject({ spaces: 1, sessions: 10, participants: 50 });
		for (let p = 0; p < 10; p++) {
			const here = everyone.filter((e) => e.p === p).map((e) => e.c);
			expect(here[0]?.textOf(pages[p]?.ids[0] as string)).toBe(`shared${"x".repeat(50)}`);
			expectSameTexts(pages[p]?.pageId as string, here);
		}
		if (process.env.NF_LIVE_STRESS_LOG)
			console.log(
				`SPACE-50 ${JSON.stringify({
					ms: Math.round(ms),
					keystrokes: 500,
					applyMs: theSpace().stats.applyMs,
					mergeMs: theSpace().stats.mergeMs,
					framesOut: theSpace().stats.framesOut,
				})}`,
			);
	}, 60_000);
});
