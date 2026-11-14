/**
 * Text per block (protocol version 2, `shared/outline-live-text.ts`): every block has a text
 * document of its own, made only when someone changes its text, on every end from the same seed;
 * the editor keeps ONE undo stack over the blocks' undo managers and the structure.
 *
 * The editor's real client engine against the registry, sessions, the write path and the store,
 * over the in-process network of `harness.ts`.
 *
 * What must hold:
 *  - a session makes no document until someone types, and then one for that block only, on
 *    every end; ends that make a block's document independently, at the same moment, hold the
 *    same document afterwards;
 *  - undo and redo walk one stack in the order the person worked, across blocks and across
 *    structural changes (indent, move, split, join, delete), each person taking back only their
 *    own steps while the other's stay, and redo brings back exactly what undo took;
 *  - redo after someone else edited the same block puts the text back where it was, in order
 *    (never reversed); a step whose text someone else removed undoes nothing, and never another
 *    step in its place;
 *  - a block made, typed in, moved and undone goes away and comes back with its text;
 *  - a reconnect resumes with what each block's document lacks, also for documents only one end
 *    had made and for blocks added from outside meanwhile;
 *  - an agent's commit landing in a block someone is typing in is merged, whichever end made the
 *    block's document first;
 *  - a crash is replayed from per-block log rows, also after a refused transaction left its
 *    items in a document; a log of the format before this one is kept, not misread;
 *  - a client of another protocol version is told so.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each test makes its own pages.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LiveClient } from "@frontend/components/outline/editor/live-client";
import { type ClientOp, keyBetweenLoose } from "@frontend/components/outline/editor/store";
import { keyBetween } from "@shared/outline";
import {
	decodeLiveFrame,
	decodeLiveTexts,
	LIVE_FRAME,
	LIVE_TEXT_KIND,
	type LiveFrame,
	type LiveSelWire,
	OUTLINE_LIVE_PROTOCOL_VERSION,
} from "@shared/outline-live-protocol";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "../../../../db";
import { aclGrants, outlineLiveUpdates, projects, users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { ensureProjectSpace } from "../../spaces";
import { outlineStore } from "../../store";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import {
	abandonLiveSessionForTests,
	closeAllLiveSessions,
	joinLive,
	liveSessionOf,
	persistAllLiveSessions,
	releaseLiveSocket,
} from "../registry";
import { replayLiveEpoch } from "../replay";
import {
	decodeLogTexts,
	LIVE_SYNC_ACTOR,
	type LivePage,
	OUTLINE_LIVE_HOOKS,
	OUTLINE_LIVE_TIMING,
} from "../session";
import { client, kids, settle, struct, TestLink, TestSocket, type, waitFor } from "./harness";

const NOW = "2026-11-14T00:00:00.000Z";
const saved = { ...OUTLINE_LIVE_TIMING };
const savedHooks = { ...OUTLINE_LIVE_HOOKS };

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
async function page(texts: string[]): Promise<{ pageId: string; ids: string[] }> {
	const r = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Page" },
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

async function content(id: string): Promise<string> {
	return (await outlineStore.getBlock(id))?.content ?? "<missing>";
}

/** One discrete text step (never merged with the step before, unlike typing). */
function edit(c: LiveClient, id: string, md: string): void {
	struct(c, [], [{ id, md }]);
}

function session(pageId: string): LivePage {
	const s = liveSessionOf(pageId);
	if (!s) throw new Error("no session");
	return s;
}

/**
 * What two ends must agree on about a document, from its whole state: the text, every item's
 * id and which items are deleted (not the content of deleted items, which only an end with an
 * undo manager keeps).
 */
function shape(state: Uint8Array): string {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, state);
	const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("hex");
	const out = `${doc.getText("t").toString()}\u0000${snapshot}`;
	doc.destroy();
	return out;
}

/**
 * Every end holds the same text for every block, the same document wherever two ends have one,
 * and no document has an update stuck in it.
 */
function expectSameTexts(pageId: string, cs: readonly LiveClient[]): void {
	const s = session(pageId);
	const ids = new Set<string>(s.textDocIds);
	for (const c of cs) for (const id of c.visible.blocks.keys()) ids.add(id);
	for (const id of ids) {
		const server = s.textState(id);
		expect(server?.stuck ?? false).toBe(false);
		for (const c of cs) {
			if (c.visible.get(id)) expect(c.textOf(id)).toBe(s.textOf(id));
			const mine = c.textState(id);
			expect(mine?.stuck ?? false).toBe(false);
			// A document here is the server's document, item for item.
			if (mine) expect(shape(mine.state)).toBe(server ? shape(server.state) : "<none>");
		}
	}
}

async function flushed(pageId: string): Promise<void> {
	await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 5000, "flush");
}

/** The page as the database holds it, in the outline form `LiveClient.outline` prints. */
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
		name: "Live text project",
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

describe("documents are made on demand", () => {
	test("opening a page makes none; typing makes one, for that block, on every end", async () => {
		const { pageId, ids } = await page(Array.from({ length: 40 }, (_, i) => `block ${i}`));
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		expect(session(pageId).textDocs).toBe(0);
		expect(a.textDocs).toBe(0);
		expect(b.textDocs).toBe(0);
		expect(a.textOf(ids[7] as string)).toBe("block 7");
		// The snapshot carried every text as plain seed text.
		const snapshot = la.socket.sent.find((f) => f.kind === LIVE_FRAME.joined) as LiveFrame;
		const entries = decodeLiveTexts(snapshot.body) ?? [];
		expect(entries).toHaveLength(41);
		expect(entries.every((e) => e.kind === LIVE_TEXT_KIND.seed)).toBe(true);

		type(a, ids[7] as string, "!");
		await settle();
		expect(session(pageId).textDocIds).toEqual([ids[7] as string]);
		expect(a.textDocs).toBe(1);
		expect(b.textDocs).toBe(1);
		expect(b.textOf(ids[7] as string)).toBe("block 7!");
		expectSameTexts(pageId, [a, b]);
		// Someone joining now gets that one document whole and the rest as seed text.
		const lc = link(third);
		const c = open(lc, pageId);
		await waitFor(() => c.ready, 3000, "joined");
		const later = decodeLiveTexts(
			(lc.socket.sent.find((f) => f.kind === LIVE_FRAME.joined) as LiveFrame).body,
		);
		expect(later?.filter((e) => e.kind === LIVE_TEXT_KIND.update).map((e) => e.id)).toEqual([
			ids[7] as string,
		]);
		expect(c.textOf(ids[7] as string)).toBe("block 7!");
		type(c, ids[7] as string, "?");
		type(c, ids[8] as string, "?");
		await settle();
		expect(a.textOf(ids[7] as string)).toBe("block 7!?");
		expect(a.textOf(ids[8] as string)).toBe("block 8?");
		expectSameTexts(pageId, [a, b, c]);
		await flushed(pageId);
		expect(await content(ids[7] as string)).toBe("block 7!?");
	});

	test("two people and an agent change an untouched block at the same moment: one document, every change, and undo and redo still put the text back in order", async () => {
		const { pageId, ids } = await page(["shared words here", "other"]);
		const block = ids[0] as string;
		const la = link(owner);
		const lb = link(writer);
		const a = open(la, pageId);
		const b = open(lb, pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		// Nobody has a document for the block. Each end makes its own, unseen by the others.
		la.hold(true);
		lb.hold(true);
		type(a, block, "ABC", 6);
		type(b, block, "xyz");
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: block }, content: "agent: shared words here" }],
			actor: { kind: "agent", id: "narrator-x" },
			responsibleUserId: owner,
		});
		expect(session(pageId).textDocIds).toEqual([block]);
		la.hold(false);
		lb.hold(false);
		await settle(60);
		const all = "agent: sharedABC words herexyz";
		expect(a.textOf(block)).toBe(all);
		expect(b.textOf(block)).toBe(all);
		expectSameTexts(pageId, [a, b]);
		// The typed text comes back in the order it was typed, on every end.
		expect(a.undo()).toBe(true);
		await settle();
		expect(b.textOf(block)).toBe("agent: shared words herexyz");
		expect(a.redo()).toBe(true);
		await settle();
		expect(b.textOf(block)).toBe(all);
		expect(b.undo()).toBe(true);
		expect(a.undo()).toBe(true);
		await settle();
		expect(a.textOf(block)).toBe("agent: shared words here");
		expect(b.redo()).toBe(true);
		expect(a.redo()).toBe(true);
		await settle();
		expect(a.textOf(block)).toBe(all);
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await content(block)).toBe(all);
	});

	test("a cursor in a block nobody changed is told and resolved without making its document", async () => {
		const { pageId, ids } = await page(["point at this"]);
		const block = ids[0] as string;
		OUTLINE_LIVE_TIMING.presenceMs = 5;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		a.setSelection({ anchor: { blockId: block, offset: 3 }, head: { blockId: block, offset: 8 } });
		const selOf = () => [...b.presence.values()].find((p) => p.userId === owner)?.sel ?? null;
		await waitFor(() => selOf() !== null, 3000, "the cursor");
		const sel = selOf() as Extract<LiveSelWire, { a: unknown }>;
		expect(b.resolvePos(sel.a)).toEqual({ blockId: block, offset: 3 });
		expect(b.resolvePos(sel.h)).toEqual({ blockId: block, offset: 8 });
		expect([a.textDocs, b.textDocs, session(pageId).textDocs]).toEqual([0, 0, 0]);
		// Once someone types before it, the same position follows the text.
		type(b, block, "so ", 0);
		await settle();
		expect(b.textOf(block)).toBe("so point at this");
		expect(b.resolvePos(sel.a)).toEqual({ blockId: block, offset: 6 });
		// A position told from the document resolves on the other end too.
		a.setSelection({ anchor: { blockId: block, offset: 1 }, head: { blockId: block, offset: 1 } });
		await waitFor(
			() => {
				const s = selOf();
				return !!s && "a" in s && b.resolvePos(s.a)?.offset === 1;
			},
			3000,
			"the moved cursor",
		);
	});
});

describe("one undo stack over the blocks", () => {
	test("two editors, several blocks, text and structure interleaved: each takes back only their own steps, in order, and redo restores them", async () => {
		const { pageId, ids } = await page(["one", "two", "three", "four"]);
		const [one, two, three, four] = ids as [string, string, string, string];
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		const key = (c: LiveClient, id: string) => c.visible.get(id)?.orderKey ?? null;

		// A1: text in `one`.                         B1: text in `two`.
		edit(a, one, "oneA1");
		edit(b, two, "twoB1");
		await settle();
		// A2: split `three` into "th" + a new block. B2: indent `four` under `three`.
		const split = a.newId();
		struct(
			a,
			[
				{
					t: "i",
					id: split,
					p: pageId,
					k: keyBetween(key(a, three), key(a, four)),
					content: "ree",
				},
			],
			[{ id: three, md: "th" }],
		);
		struct(b, [{ t: "m", id: four, p: three, k: keyBetween(null, null) }]);
		await settle();
		// A3: text in the new block.                 B3: text in `one`, where A typed too.
		edit(a, split, "reex");
		edit(b, one, "oneA1!");
		await settle();
		// A4: join `two` into `one`.
		struct(a, [{ t: "d", id: two }], [{ id: one, md: `${a.textOf(one)}${a.textOf(two)}` }]);
		await settle();
		// A5: move the new block to the top.         A6: delete `four`.
		struct(a, [{ t: "m", id: split, p: pageId, k: keyBetween(null, key(a, one)) }]);
		struct(a, [{ t: "d", id: four }]);
		await settle();
		const everything = ["- reex", "- oneA1!twoB1", "- th"].join("\n");
		expect(a.outline()).toBe(everything);
		expect(b.outline()).toBe(everything);
		expectSameTexts(pageId, [a, b]);

		// A takes all six steps back, newest first, one at a time.
		const walkBack = [
			["- reex", "- oneA1!twoB1", "- th", "  - four"],
			["- oneA1!twoB1", "- th", "  - four", "- reex"],
			["- oneA1!", "- twoB1", "- th", "  - four", "- reex"],
			["- oneA1!", "- twoB1", "- th", "  - four", "- ree"],
			["- oneA1!", "- twoB1", "- three", "  - four"],
			["- one!", "- twoB1", "- three", "  - four"],
		].map((lines) => lines.join("\n"));
		for (const want of walkBack) {
			expect(a.undo()).toBe(true);
			await settle();
			expect(a.outline()).toBe(want);
			expect(b.outline()).toBe(want);
		}
		expect(a.undo()).toBe(false);
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe(walkBack[5] as string);

		// …and forward again, the same states in reverse.
		for (const want of [...walkBack.slice(0, 5).reverse(), everything]) {
			expect(a.redo()).toBe(true);
			await settle();
			expect(a.outline()).toBe(want);
			expect(b.outline()).toBe(want);
		}
		expect(a.redo()).toBe(false);
		expectSameTexts(pageId, [a, b]);

		// Both walk back in turns, each seeing the other's last step, and forward again.
		for (const who of [a, b, a, b, a, b, a, a, a]) {
			expect(who.undo()).toBe(true);
			await settle();
		}
		const original = ["- one", "- two", "- three", "- four"].join("\n");
		expect(a.outline()).toBe(original);
		expect(b.outline()).toBe(original);
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe(original);
		for (const who of [a, a, a, b, a, b, b, a, a]) {
			expect(who.redo()).toBe(true);
			await settle();
		}
		expect(a.outline()).toBe(everything);
		expect(b.outline()).toBe(everything);
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe(everything);

		// B takes its three back: its text goes, wherever A's join carried the block's text; its
		// indent of a block A deleted since has nothing to undo.
		for (const want of [
			["- reex", "- oneA1twoB1", "- th"],
			["- reex", "- oneA1twoB1", "- th"],
			["- reex", "- oneA1twoB1", "- th"],
		]) {
			expect(b.undo()).toBe(true);
			await settle();
			expect(a.outline()).toBe(want.join("\n"));
		}
		expect(b.undo()).toBe(false);
		// `two` is deleted, but B's text in it is undone all the same (A's undo would show it).
		expect(a.textOf(two)).toBe("two");
		for (let i = 0; i < 3; i++) expect(b.redo()).toBe(true);
		await settle();
		expect(a.outline()).toBe(everything);
		expect(b.outline()).toBe(everything);
		expect(a.textOf(two)).toBe("twoB1");

		// Both walk back at the same moment, neither seeing the other's undos: a step whose
		// structure the other just changed is skipped, and both still end on one page.
		for (let i = 0; i < 6; i++) {
			a.undo();
			if (i < 3) b.undo();
		}
		await settle(60);
		expect(b.outline()).toBe(a.outline());
		expect(a.textOf(one)).toBe("one");
		expect(a.textOf(two)).toBe("two");
		expect(a.textOf(three)).toBe("three");
		for (let i = 0; i < 6; i++) {
			a.redo();
			if (i < 3) b.redo();
		}
		await settle(60);
		expect(b.outline()).toBe(a.outline());
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe(a.outline());
	});

	test("steps in different blocks are undone in the order made, not block by block", async () => {
		const { pageId, ids } = await page(["p", "q", "r"]);
		const [p, q, r] = ids as [string, string, string];
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		edit(a, p, "p1");
		edit(a, q, "q1");
		edit(a, p, "p12");
		edit(a, r, "r1");
		edit(a, q, "q12");
		edit(a, p, "p123");
		const states: string[] = [a.outline()];
		while (a.undo()) states.push(a.outline());
		expect(states).toEqual([
			"- p123\n- q12\n- r1",
			"- p12\n- q12\n- r1",
			"- p12\n- q1\n- r1",
			"- p12\n- q1\n- r",
			"- p1\n- q1\n- r",
			"- p1\n- q\n- r",
			"- p\n- q\n- r",
		]);
		const forward: string[] = [];
		while (a.redo()) forward.push(a.outline());
		expect(forward).toEqual(states.slice(0, 6).reverse());
		// A new change after two undos: the two can no longer be redone, in either block.
		a.undo();
		a.undo();
		expect(a.outline()).toBe("- p12\n- q1\n- r1");
		edit(a, r, "r1!");
		expect(a.redo()).toBe(false);
		edit(a, q, "q1?");
		edit(a, p, "p12?");
		while (a.undo()) {
			// All the way back.
		}
		expect(a.outline()).toBe("- p\n- q\n- r");
		await settle();
		expectSameTexts(pageId, [a]);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe("- p\n- q\n- r");
	});

	test("a change right after a redo is a step of its own, in the same block", async () => {
		const { pageId, ids } = await page(["p", "q"]);
		const [p, q] = ids as [string, string];
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		edit(a, p, "p1");
		a.undo();
		a.redo();
		// The block's undo manager must not fold this into the step just redone.
		edit(a, p, "p12");
		type(a, p, "34");
		edit(a, q, "q1");
		expect(a.outline()).toBe("- p1234\n- q1");
		const back: string[] = [];
		while (a.undo()) back.push(a.outline());
		expect(back).toEqual(["- p1234\n- q", "- p12\n- q", "- p1\n- q", "- p\n- q"]);
		a.redo();
		a.redo();
		expect(a.outline()).toBe("- p12\n- q");
		type(a, p, "!");
		expect(a.redo()).toBe(false);
		a.undo();
		expect(a.outline()).toBe("- p12\n- q");
		a.undo();
		expect(a.outline()).toBe("- p1\n- q");
		await settle();
		expectSameTexts(pageId, [a]);
	});

	test("typing in one block merges into one step; another block or a structural change starts a new one", async () => {
		const { pageId, ids } = await page(["m", "n"]);
		const [m, n] = ids as [string, string];
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, m, "abc");
		type(a, n, "xy");
		type(a, m, "def");
		expect(a.outline()).toBe("- mabcdef\n- nxy");
		a.undo();
		expect(a.outline()).toBe("- mabc\n- nxy");
		a.undo();
		expect(a.outline()).toBe("- mabc\n- n");
		a.undo();
		expect(a.outline()).toBe("- m\n- n");
		expect(a.undo()).toBe(false);
		a.redo();
		a.redo();
		a.redo();
		expect(a.outline()).toBe("- mabcdef\n- nxy");
		await settle();
		expectSameTexts(pageId, [a]);
	});

	test("redo after someone else edited the same block: the text returns where it was, in order", async () => {
		const { pageId, ids } = await page(["hello world"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, block, " brave", 5);
		await settle();
		expect(b.textOf(block)).toBe("hello brave world");
		expect(a.undo()).toBe(true);
		await settle();
		expect(b.textOf(block)).toBe("hello world");
		// Meanwhile the other person writes before and after, in the same block.
		type(b, block, "!!");
		type(b, block, "Oh, ", 0);
		await settle();
		expect(a.textOf(block)).toBe("Oh, hello world!!");
		expect(a.redo()).toBe(true);
		await settle();
		expect(a.textOf(block)).toBe("Oh, hello brave world!!");
		expect(b.textOf(block)).toBe("Oh, hello brave world!!");
		// The other person removes the word the redone text was typed after; undo and redo still
		// take and return exactly that text.
		edit(b, block, "Oh,  brave world!!");
		await settle();
		expect(a.undo()).toBe(true);
		await settle();
		expect(b.textOf(block)).toBe("Oh,  world!!");
		expect(a.redo()).toBe(true);
		await settle();
		expect(b.textOf(block)).toBe("Oh,  brave world!!");
		// Redo while the other person's keystroke is still on its way.
		expect(a.undo()).toBe(true);
		await settle();
		const lb = links[1] as TestLink;
		lb.hold(true);
		type(b, block, "So: ", 0);
		expect(a.redo()).toBe(true);
		lb.hold(false);
		await settle(60);
		expect(a.textOf(block)).toBe("So: Oh,  brave world!!");
		expect(b.textOf(block)).toBe("So: Oh,  brave world!!");
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await content(block)).toBe("So: Oh,  brave world!!");
	});

	test("a step whose text someone else removed undoes nothing, and not an earlier step instead", async () => {
		const { pageId, ids } = await page(["base", "side"]);
		const [block, side] = ids as [string, string];
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		edit(a, block, "base1");
		edit(a, side, "side1");
		edit(a, block, "base12");
		await settle();
		// The other person deletes what A's last step typed.
		edit(b, block, "base1");
		await settle();
		// A's last step has nothing left to undo: the block stays, and so does A's first step.
		expect(a.undo()).toBe(true);
		await settle();
		expect(a.outline()).toBe("- base1\n- side1");
		expect(a.undo()).toBe(true);
		expect(a.outline()).toBe("- base1\n- side");
		expect(a.undo()).toBe(true);
		expect(a.outline()).toBe("- base\n- side");
		expect(a.undo()).toBe(false);
		// Redo returns the two steps that changed something; the third has nothing to return.
		expect(a.redo()).toBe(true);
		expect(a.redo()).toBe(true);
		expect(a.outline()).toBe("- base1\n- side1");
		expect(a.redo()).toBe(true);
		expect(a.outline()).toBe("- base1\n- side1");
		await settle();
		expect(b.outline()).toBe("- base1\n- side1");
		expectSameTexts(pageId, [a, b]);
	});

	test("a block made, typed in, moved, and all of it undone and redone, while someone else types in it and next to it", async () => {
		const { pageId, ids } = await page(["first", "second"]);
		const [first, second] = ids as [string, string];
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		const made = a.newId();
		const k = keyBetween(a.visible.get(first)?.orderKey ?? null, a.visible.get(second)?.orderKey);
		struct(a, [{ t: "i", id: made, p: pageId, k, content: "" }]);
		type(a, made, "new");
		await settle();
		// An empty new block has no document until its first character.
		expect(b.textOf(made)).toBe("new");
		type(b, made, "Zb");
		type(b, first, "!");
		await settle();
		struct(a, [{ t: "m", id: made, p: second, k: keyBetween(null, null) }]);
		await settle();
		const done = "- first!\n- second\n  - newZb";
		expect(a.outline()).toBe(done);
		expect(b.outline()).toBe(done);

		expect(a.undo()).toBe(true);
		await settle();
		expect(b.outline()).toBe("- first!\n- newZb\n- second");
		expect(a.undo()).toBe(true);
		await settle();
		// Only A's own text leaves the block.
		expect(b.outline()).toBe("- first!\n- Zb\n- second");
		expect(a.undo()).toBe(true);
		await settle();
		expect(b.outline()).toBe("- first!\n- second");
		expect(b.visible.alive(made)).toBeUndefined();
		expect(a.undo()).toBe(false);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe("- first!\n- second");

		expect(a.redo()).toBe(true);
		await settle();
		// The block comes back with the text the other person left in it.
		expect(b.outline()).toBe("- first!\n- Zb\n- second");
		expect(a.redo()).toBe(true);
		await settle();
		expect(b.outline()).toBe("- first!\n- newZb\n- second");
		expect(a.redo()).toBe(true);
		await settle();
		expect(a.outline()).toBe(done);
		expect(b.outline()).toBe(done);
		expect(a.redo()).toBe(false);
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe(done);
		// Someone joining afterwards sees the same.
		const c = open(link(third), pageId);
		await waitFor(() => c.ready, 3000, "joined");
		expect(c.outline()).toBe(done);
	});

	test("undoing a delete brings the block back with its text for someone who joined after it was deleted", async () => {
		const { pageId, ids } = await page(["keep", "gone soon"]);
		const [, gone] = ids as [string, string];
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, gone, " (typed)");
		await settle();
		struct(a, [{ t: "d", id: gone }]);
		await settle();
		const b = open(link(writer), pageId);
		await waitFor(() => b.ready, 3000, "joined");
		expect(b.outline()).toBe("- keep");
		expect(a.undo()).toBe(true);
		await settle();
		expect(b.outline()).toBe("- keep\n- gone soon (typed)");
		type(b, gone, "!");
		await settle();
		expect(a.outline()).toBe("- keep\n- gone soon (typed)!");
		expectSameTexts(pageId, [a, b]);
	});
});

describe("reconnecting", () => {
	test("a resume brings each block's document up to date: ones both had, ones only one end made, and blocks added meanwhile", async () => {
		const { pageId, ids } = await page(["b0", "b1", "b2", "b3", "b4", "b5"]);
		const [b0, b1, b2, b3, b4] = ids as [string, string, string, string, string];
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		edit(a, b0, "b0 a");
		await settle();
		la.disconnect();
		// Offline: A types where both have a document and where nobody has one.
		type(a, b0, " A-off");
		type(a, b1, " A-off");
		// Meanwhile: B types where both have one, and where A has none; an agent changes a
		// block nobody typed in and adds one.
		type(b, b0, "B-on ", 0);
		type(b, b2, " B-on");
		const added = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "update", block: { id: b3 }, content: "b3 by agent" },
				{ op: "insert", parent: { id: pageId }, content: "agent block" },
			],
			actor: { kind: "agent", id: "narrator-x" },
			responsibleUserId: owner,
		});
		const agentBlock = added.results[1]?.blockId as string;
		await settle();
		const before = la.bytesDown;
		la.reconnect();
		await waitFor(() => a.status === "live", 3000, "rejoined");
		await settle(60);
		expect(a.stats.resumes).toBe(1);
		expect(a.stats.rebuilds).toBe(0);
		const want = [
			"- B-on b0 a A-off",
			"- b1 A-off",
			"- b2 B-on",
			"- b3 by agent",
			"- b4",
			"- b5",
			"- agent block",
		].join("\n");
		expect(a.outline()).toBe(want);
		expect(b.outline()).toBe(want);
		// The resume carried differences and one seed text, not the page.
		expect(la.bytesDown - before).toBeLessThan(1500);
		// Documents exist for the blocks someone changed, and no others.
		expect(new Set(session(pageId).textDocIds)).toEqual(new Set([b0, b1, b2, b3]));
		expect(a.textDocs).toBe(4);
		expectSameTexts(pageId, [a, b]);
		// The block added while A was away has the same seed everywhere: both type in it.
		type(a, agentBlock, " <a");
		type(b, agentBlock, "b> ", 0);
		type(a, b4, "!");
		await settle();
		expect(a.textOf(agentBlock)).toBe("b> agent block <a");
		expect(b.textOf(agentBlock)).toBe("b> agent block <a");
		expectSameTexts(pageId, [a, b]);
		// What A typed offline is still its own to undo, step by step.
		a.undo();
		a.undo();
		a.undo();
		a.undo();
		await settle();
		expect(b.textOf(agentBlock)).toBe("b> agent block");
		expect(b.textOf(b1)).toBe("b1");
		expect(b.textOf(b0)).toBe("B-on b0 a");
		await flushed(pageId);
		expect(await content(b0)).toBe("B-on b0 a");
	});

	test("a refused transaction: the page is rebuilt, later typing in several blocks is replayed, and every end holds the same documents", async () => {
		const { pageId, ids } = await page(["x", "y", "z"]);
		const [x, y, z] = ids as [string, string, string];
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		// B moves x under y; A, not having seen it, moves y under x: a cycle, refused.
		la.hold(true);
		struct(b, [{ t: "m", id: x, p: y, k: keyBetween(null, null) }]);
		await settle();
		struct(a, [{ t: "m", id: y, p: x, k: keyBetween(null, null) }]);
		type(a, z, " after");
		type(a, x, " too");
		la.hold(false);
		await settle(60);
		expect(a.stats.rejects).toBe(1);
		expect(a.stats.rebuilds).toBe(1);
		const want = "- y\n  - x too\n- z after";
		expect(a.outline()).toBe(want);
		expect(b.outline()).toBe(want);
		expectSameTexts(pageId, [a, b]);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe(want);
	});
});

describe("the log and its replay", () => {
	const rowsOf = (pageId: string, epoch: number) =>
		db
			.select()
			.from(outlineLiveUpdates)
			.where(and(eq(outlineLiveUpdates.pageBlockId, pageId), eq(outlineLiveUpdates.epoch, epoch)))
			.all()
			.sort((p, q) => p.seq - q.seq);

	test("rows name their blocks: a snapshot of the documents, then each new document's seed before its updates; a crash is replayed from them", async () => {
		const { pageId, ids } = await page(["crash one", "crash two", "untouched"]);
		const [one, two, untouched] = ids as [string, string, string];
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, one, " typed");
		await settle();
		await persistAllLiveSessions();
		const epoch = session(pageId).epoch;
		const first = rowsOf(pageId, epoch).filter((r) => r.actorId !== LIVE_SYNC_ACTOR);
		// The first row holds the one document there is, whole.
		const snapshot = decodeLogTexts(Buffer.from(first[0]?.updateB64 ?? "", "base64"));
		expect(snapshot?.map((e) => [e.id, e.kind])).toEqual([[one, LIVE_TEXT_KIND.update]]);
		type(b, two, " also");
		type(a, one, "!");
		await settle();
		await persistAllLiveSessions();
		const later = rowsOf(pageId, epoch)
			.filter((r) => r.actorId !== LIVE_SYNC_ACTOR)
			.slice(first.length)
			.map((r) => ({
				actor: r.actorId,
				entries: (decodeLogTexts(Buffer.from(r.updateB64, "base64")) ?? []).map((e) => [
					e.id,
					e.kind,
				]),
			}));
		// The new document's seed text comes first, in a row of the session's own.
		expect(later[0]).toEqual({ actor: "outline-live", entries: [[two, LIVE_TEXT_KIND.seed]] });
		expect(later.slice(1).sort((p, q) => (p.actor < q.actor ? -1 : 1))).toEqual(
			[
				{ actor: owner, entries: [[one, LIVE_TEXT_KIND.update]] },
				{ actor: writer, entries: [[two, LIVE_TEXT_KIND.update]] },
			].sort((p, q) => (p.actor < q.actor ? -1 : 1)),
		);
		expect(await content(one)).toBe("crash one");
		// The process "dies" here. An outside write lands before the replay.
		abandonLiveSessionForTests(pageId);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: two }, content: "agent: crash two" }],
			actor: { kind: "agent", id: "n" },
			responsibleUserId: owner,
		});
		expect(await replayLiveEpoch(pageId, epoch)).toBe("committed");
		expect(await content(one)).toBe("crash one typed!");
		expect(await content(two)).toBe("agent: crash two also");
		expect(await content(untouched)).toBe("untouched");
		expect(rowsOf(pageId, epoch)).toHaveLength(0);
		// Each person's text was committed as theirs.
		const versions = await outlineStore.listPageVersions(pageId, { afterSeq: 0, limit: 100 });
		const commitOf = async (blockId: string) => {
			const v = versions.filter((x) => x.blockId === blockId).sort((p, q) => q.fromSeq - p.fromSeq);
			const seq = v[0]?.fromSeq as number;
			return (await outlineStore.listCommits(space.id, { afterSeq: seq - 1, limit: 1 }))[0];
		};
		expect((await commitOf(one))?.actorId).toBe(owner);
		expect((await commitOf(two))?.actorId).toBe(writer);
	});

	test("typing in an empty block and in a block made in the session is replayed onto what the database holds then", async () => {
		const { pageId, ids } = await page(["", "after"]);
		const [empty] = ids as [string, string];
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		const made = a.newId();
		struct(a, [
			{
				t: "i",
				id: made,
				p: pageId,
				k: keyBetween(a.visible.get(empty)?.orderKey, null),
				content: "made",
			},
		]);
		await settle();
		expect(await content(made)).toBe("made");
		// Typed and never committed: in an empty block (no seed text) and in the new one.
		type(a, empty, "typed");
		type(a, made, " more");
		await settle();
		await persistAllLiveSessions();
		const epoch = session(pageId).epoch;
		abandonLiveSessionForTests(pageId);
		// After the crash someone else writes both blocks before the replay.
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "update", block: { id: empty }, content: "agent wrote here" },
				{ op: "update", block: { id: made }, content: "agent: made" },
			],
			actor: { kind: "agent", id: "n" },
			responsibleUserId: owner,
		});
		expect(await replayLiveEpoch(pageId, epoch)).toBe("committed");
		// Both the outside text and the typed text are there.
		const merged = await content(empty);
		expect(merged).toContain("agent wrote here");
		expect(merged).toContain("typed");
		expect(await content(made)).toBe("agent: made more");
	});

	test("a refused transaction leaves its items in the document and in the log, so typing next to them survives a crash", async () => {
		const { pageId, ids } = await page(["split me here", "tail"]);
		const [block] = ids as [string, string];
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		// A's split fails when it is written: its text change is taken back in the document.
		const write = OUTLINE_LIVE_HOOKS.write;
		let failed = 0;
		OUTLINE_LIVE_HOOKS.write = (async (...args: Parameters<typeof write>) => {
			if (failed++ === 0) throw new Error("the disk hiccuped");
			return await write(...args);
		}) as typeof write;
		const made = a.newId();
		struct(
			a,
			[
				{
					t: "i",
					id: made,
					p: pageId,
					k: keyBetween(a.visible.get(block)?.orderKey, null),
					content: " here",
				},
			],
			[{ id: block, md: "split me" }],
		);
		await settle(60);
		expect(a.stats.rejects).toBe(1);
		expect(a.lastReject?.code).toBe("failed");
		expect(a.outline()).toBe("- split me here\n- tail");
		expect(b.outline()).toBe("- split me here\n- tail");
		expect(b.visible.get(made)).toBeUndefined();
		expectSameTexts(pageId, [a, b]);
		// The other person types right where the refused change was.
		type(b, block, "!", "split me".length);
		type(b, block, "?");
		await settle();
		expect(a.outline()).toBe("- split me! here?\n- tail");
		expectSameTexts(pageId, [a, b]);
		await persistAllLiveSessions();
		const epoch = session(pageId).epoch;
		expect(await content(block)).toBe("split me here");
		abandonLiveSessionForTests(pageId);
		expect(await replayLiveEpoch(pageId, epoch)).toBe("committed");
		expect(await content(block)).toBe("split me! here?");
		expect(await dbOutline(pageId)).toBe("- split me! here?\n- tail");
	});

	test("a log of the format before this one is kept, never misread, and the page stays editable", async () => {
		const { pageId, ids } = await page(["legacy"]);
		const block = ids[0] as string;
		// One Yjs document for the page, a text per block in a map: what a session wrote before.
		const old = new Y.Doc();
		const text = new Y.Text("legacy and unsaved");
		old.getMap<Y.Text>("texts").set(block, text);
		const epoch = 77_001;
		await outlineStore.appendLiveUpdates([
			{
				pageBlockId: pageId,
				epoch,
				seq: 0,
				updateB64: Buffer.from(Y.encodeStateAsUpdate(old)).toString("base64"),
				actorKind: "system",
				actorId: "outline-live",
				createdAt: new Date().toISOString(),
			},
		]);
		old.destroy();
		expect(await replayLiveEpoch(pageId, epoch)).toBe("kept");
		expect(await content(block)).toBe("legacy");
		expect(rowsOf(pageId, epoch)).toHaveLength(1);
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, " lives");
		await settle();
		await flushed(pageId);
		expect(await content(block)).toBe("legacy lives");
		expect(rowsOf(pageId, epoch)).toHaveLength(1);
		await db.delete(outlineLiveUpdates).where(eq(outlineLiveUpdates.pageBlockId, pageId));
	});
});

describe("the protocol's version", () => {
	test("a join of another version is told it is outdated; nothing is opened for it", async () => {
		const { pageId } = await page(["v"]);
		const answers: LiveFrame[] = [];
		const s = new TestSocket(owner, "o", (f) => {
			const d = decodeLiveFrame(f);
			if (d) answers.push(d);
		});
		const join = (head: Record<string, unknown>) =>
			joinLive(s, { kind: LIVE_FRAME.join, handle: 1, n: 0, head, body: new Uint8Array(0) });
		await join({ page: pageId, mode: "edit", key: "oldclient01" });
		await join({ v: 1, page: pageId, mode: "edit", key: "oldclient01" });
		expect(answers.map((f) => [f.kind, (f.head as { code?: string }).code])).toEqual([
			[LIVE_FRAME.closed, "outdated"],
			[LIVE_FRAME.closed, "outdated"],
		]);
		expect(liveSessionOf(pageId)).toBeUndefined();
		await join({
			v: OUTLINE_LIVE_PROTOCOL_VERSION,
			page: pageId,
			mode: "edit",
			key: "newclient01",
		});
		expect(answers[2]?.kind).toBe(LIVE_FRAME.joined);
		releaseLiveSocket(s);
	});

	test("text for a block the page does not have, or two updates of one block in a frame, is refused", async () => {
		const { pageId, ids } = await page(["strict"]);
		const block = ids[0] as string;
		const la = link(owner);
		const a = open(la, pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, "!");
		await settle();
		expect(a.stats.rejects).toBe(0);
		const s = session(pageId);
		const p = [...s.participants.values()][0];
		if (!p) throw new Error("no participant");
		const { encodeLiveTexts } = await import("@shared/outline-live-protocol");
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "stray");
		const update = Y.encodeStateAsUpdate(doc);
		s.handleUpdate(
			p,
			p.lastTx + 1,
			encodeLiveTexts([{ id: "no-such-block-0001", kind: LIVE_TEXT_KIND.update, data: update }]),
		);
		expect(p.blocked).toBe(true);
		expect(s.textDocIds).toEqual([block]);
		await settle(60);
		expect(a.stats.rejects).toBe(1);
		const again = [...s.participants.values()][0];
		if (!again) throw new Error("no participant");
		s.handleUpdate(
			again,
			again.lastTx + 1,
			encodeLiveTexts([
				{ id: block, kind: LIVE_TEXT_KIND.update, data: update },
				{ id: block, kind: LIVE_TEXT_KIND.update, data: update },
			]),
		);
		expect(again.blocked).toBe(true);
		await settle(60);
		expect(a.textOf(block)).toBe("strict!");
		expect(s.textOf(block)).toBe("strict!");
	});
});

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let x = Math.imul(t ^ (t >>> 15), 1 | t);
		x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

describe("documents made lazily on every end converge (seeded, bounded)", () => {
	const ALPHABET = "abcdefghij 大纲块*`";

	/** One random step of one person: mostly text in a random block, undo and redo, some structure. */
	function step(c: LiveClient, pageId: string, r: () => number): void {
		if (!c.editable) return;
		const live = [...c.visible.blocks.values()].filter(
			(b) => c.visible.inPage(b.id) && b.id !== pageId,
		);
		const b = live[Math.floor(r() * live.length)];
		const roll = r();
		if (roll < 0.2) {
			c.undo();
			return;
		}
		if (roll < 0.34) {
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
		if (roll < 0.62) {
			const pos = Math.floor(r() * (text.length + 1));
			const ch = ALPHABET[Math.floor(r() * ALPHABET.length)] as string;
			const md = text.slice(0, pos) + ch + text.slice(pos);
			// Half as typing (merging steps), half as steps of their own.
			if (r() < 0.5) type(c, b.id, ch, pos);
			else edit(c, b.id, md);
		} else if (roll < 0.76 && text.length > 0) {
			const pos = Math.floor(r() * text.length);
			const len = 1 + Math.floor(r() * Math.min(3, text.length - pos));
			edit(c, b.id, text.slice(0, pos) + text.slice(pos + len));
		} else if (roll < 0.83) {
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
		} else if (roll < 0.88 && at > 0) {
			// Join into the previous sibling (when the block has no children).
			if (c.visible.children(b.id).length > 0) return;
			const prev = sibs[at - 1] as string;
			struct(c, [{ t: "d", id: b.id }], [{ id: prev, md: c.textOf(prev) + text }]);
		} else if (roll < 0.93 && at > 0) {
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
		} else if (roll < 0.97 && at > 0) {
			struct(c, [
				{ t: "m", id: b.id, p: parentId, k: keyBetweenLoose(keyAt(at - 2), keyAt(at - 1)) },
			]);
		} else if (live.length > 4) {
			const ops: ClientOp[] = c.visible.subtree(b.id).map((id) => ({ t: "d", id }));
			struct(c, ops.reverse());
		}
	}

	for (const seed of [3, 17, 29, 101, 257, 4099]) {
		test(`seed ${seed}: three people, holds, reconnects and an agent`, async () => {
			const { pageId, ids } = await page(
				Array.from({ length: 10 }, (_, i) => `block ${i} ${"lorem ".repeat(i % 3)}`.trim()),
			);
			const r = rng(seed);
			const ls = [owner, writer, third].map((u, i) => link(u, `p${i}`));
			const cs = ls.map((l) => open(l, pageId));
			await waitFor(() => cs.every((c) => c.ready), 3000, "joined");
			expect(session(pageId).textDocs).toBe(0);
			for (let n = 0; n < 420; n++) {
				const i = Math.floor(r() * cs.length);
				const l = ls[i] as TestLink;
				const c = cs[i] as LiveClient;
				const dice = r();
				if (dice < 0.08) {
					if (l.connected) l.hold(!l.held);
				} else if (dice < 0.1) {
					if (l.connected) l.disconnect();
					else l.reconnect();
				} else if (dice < 0.125) {
					// An agent rewrites a random block the database has (maybe one nobody typed in).
					const target = ids[Math.floor(r() * ids.length)] as string;
					const row = await outlineStore.getBlock(target);
					if (row && !row.deleted)
						await writeOutline({
							spaceId: space.id,
							ops: [
								{ op: "update", block: { id: target }, content: `${row.content} [agent ${n}]` },
							],
							actor: { kind: "agent", id: "stress-agent" },
							responsibleUserId: owner,
						}).catch(() => {
							// Refused while someone's text is being committed: fine.
						});
				}
				step(c, pageId, r);
				if (n % 12 === 0) await new Promise((res) => setTimeout(res, 4));
			}
			for (const l of ls) {
				l.hold(false);
				if (!l.connected) l.reconnect();
			}
			await waitFor(() => cs.every((c) => c.status === "live"), 10_000, "everyone live");
			await settle(60, 20_000);
			const outlines = cs.map((c) => c.outline());
			if (process.env.NF_LIVE_STRESS_LOG)
				console.log(
					`TEXT-STRESS ${JSON.stringify({
						seed,
						blocks: (cs[0] as LiveClient).visible.blocks.size,
						serverDocs: session(pageId).textDocs,
						clients: cs.map((c) => ({ docs: c.textDocs, ...c.stats })),
					})}`,
				);
			expect(outlines[1]).toBe(outlines[0] as string);
			expect(outlines[2]).toBe(outlines[0] as string);
			expectSameTexts(pageId, cs);
			// Then everyone undoes and redoes as far as they can, one at a time: still one page.
			for (const c of cs) {
				let guard = 0;
				while (c.undo() && guard++ < 1000) {
					// Back to where this person started.
				}
				await settle(40, 20_000);
				const mid = cs.map((x) => x.outline());
				expect(mid[1]).toBe(mid[0] as string);
				expect(mid[2]).toBe(mid[0] as string);
				guard = 0;
				while (c.redo() && guard++ < 1000) {
					// And forward again.
				}
				await settle(40, 20_000);
			}
			const end = cs.map((c) => c.outline());
			expect(end[1]).toBe(end[0] as string);
			expect(end[2]).toBe(end[0] as string);
			expectSameTexts(pageId, cs);
			await flushed(pageId);
			expect(await dbOutline(pageId)).toBe(end[0] as string);
		}, 90_000);
	}
});

test("kids() sees the same order on both ends after concurrent inserts into a block nobody typed in", async () => {
	const { pageId, ids } = await page(["parent"]);
	const parent = ids[0] as string;
	const la = link(owner);
	const lb = link(writer);
	const a = open(la, pageId);
	const b = open(lb, pageId);
	await waitFor(() => a.ready && b.ready, 3000, "joined");
	la.hold(true);
	lb.hold(true);
	const x = a.newId();
	const y = b.newId();
	struct(a, [{ t: "i", id: x, p: parent, k: keyBetween(null, null), content: "from a" }]);
	struct(b, [{ t: "i", id: y, p: parent, k: keyBetween(null, null), content: "from b" }]);
	type(a, x, "!");
	type(b, y, "?");
	la.hold(false);
	lb.hold(false);
	await settle(60);
	expect(kids(a, parent).map((k) => a.textOf(k.id))).toEqual(
		kids(b, parent).map((k) => b.textOf(k.id)),
	);
	expect(new Set(kids(a, parent).map((k) => a.textOf(k.id)))).toEqual(
		new Set(["from a!", "from b?"]),
	);
	expectSameTexts(pageId, [a, b]);
});
