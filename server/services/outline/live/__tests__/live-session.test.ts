/**
 * Page live sessions end to end, without a browser: the editor's client engine against the
 * registry, sessions, the write path and the SQLite store, over an in-process network.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each test makes its own pages.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LiveClient } from "@frontend/components/outline/editor/live-client";
import { keyBetween } from "@shared/outline";
import { LIVE_FRAME } from "@shared/outline-live-protocol";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { aclGrants, outlineLiveUpdates, projects, users } from "../../../../db/schema";
import { eventBus } from "../../../../lib/event-bus";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { OutlineConflictError } from "../../errors";
import { ensureProjectSpace } from "../../spaces";
import { outlineStore } from "../../store";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import {
	abandonLiveSessionForTests,
	closeAllLiveSessions,
	liveSessionOf,
	outlineLiveStats,
	runInLane,
} from "../registry";
import { replayLiveEpoch } from "../replay";
import { OUTLINE_LIVE_TIMING } from "../session";
import { client, kids, settle, struct, TestLink, type, waitFor } from "./harness";

const NOW = "2026-10-27T00:00:00.000Z";
const saved = { ...OUTLINE_LIVE_TIMING };

let owner: string;
let writer: string;
let reader: string;
let projectId: string;
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

function open(l: TestLink, pageId: string, mode: "edit" | "view" = "edit"): LiveClient {
	const c = client(l, pageId, mode);
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
	reader = await user("reader");
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Live project",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	for (const [principalId, capability] of [
		[writer, "write"],
		[reader, "read"],
	] as const) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId,
			capability,
			createdAt: NOW,
		});
	}
	space = await ensureProjectSpace(projectId);
});

describe("joining", () => {
	test("an editor gets every block and its text; a reader joins as a viewer", async () => {
		const { pageId, ids } = await page(["one", "**two**", "three"]);
		const a = open(link(owner), pageId);
		const r = open(link(reader), pageId);
		await waitFor(() => a.ready && r.ready, 3000, "joined");
		expect(a.canWrite).toBe(true);
		expect(r.canWrite).toBe(false);
		expect(kids(a, pageId).map((b) => b.id)).toEqual(ids);
		expect(ids.map((id) => a.textOf(id))).toEqual(["one", "**two**", "three"]);
		// Every block has its text from the start (no lazily created texts).
		expect(a.textOf(pageId)).toBe("Page");
		expect(r.outline()).toBe(a.outline());
	});

	test("a page one may not read and a page that does not exist answer alike", async () => {
		const stranger = await user("stranger");
		const { pageId } = await page(["x"]);
		const l = link(stranger);
		const s = open(l, pageId);
		const n = open(l, "no-such-page");
		await waitFor(() => s.status === "closed" && n.status === "closed", 3000, "refused");
		expect(s.closeCode).toBe("access_denied");
		expect(n.closeCode).toBe("access_denied");
	});
});

describe("typing", () => {
	test("text reaches the others coalesced, never echoed, and is committed as the typist", async () => {
		const { pageId, ids } = await page(["hello"]);
		const block = ids[0] as string;
		const la = link(owner, "alice");
		const lb = link(writer, "bob");
		const a = open(la, pageId);
		const b = open(lb, pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		const downA = la.socket.sent.length;
		const downB = lb.socket.sent.length;
		type(a, block, " world");
		await waitFor(() => b.textOf(block) === "hello world", 3000, "text at bob");
		await settle();
		// Bob got the six keystrokes in few frames; Alice got acknowledgements, no update bytes.
		const toB = lb.socket.sent.slice(downB).filter((f) => f.kind === LIVE_FRAME.batch);
		const toA = la.socket.sent.slice(downA).filter((f) => f.kind === LIVE_FRAME.batch);
		expect(toB.length).toBeLessThanOrEqual(3);
		expect(toA.every((f) => f.body.length === 0)).toBe(true);
		expect(toA.at(-1)?.n).toBeGreaterThan(0);
		await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 3000, "flush");
		expect(await content(block)).toBe("hello world");
		const row = await outlineStore.getBlock(block);
		expect(row?.authorId).toBe(owner);
	});

	test("two people typing in one block at once both keep their text", async () => {
		const { pageId, ids } = await page(["ab"]);
		const block = ids[0] as string;
		const la = link(owner);
		const lb = link(writer);
		const a = open(la, pageId);
		const b = open(lb, pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		la.hold(true);
		lb.hold(true);
		type(a, block, "X", 1);
		type(b, block, "Y", 1);
		la.hold(false);
		lb.hold(false);
		await settle();
		const text = a.textOf(block);
		expect(text).toBe(b.textOf(block));
		expect(text.includes("X") && text.includes("Y")).toBe(true);
		await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 3000, "flush");
		expect(await content(block)).toBe(text);
	});
});

describe("structure", () => {
	test("a split (insert + truncation) is one commit, seen by everyone", async () => {
		const { pageId, ids } = await page(["first second"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		const newId = a.newId();
		const key = keyBetween(a.visible.get(block)?.orderKey ?? null, null);
		struct(
			a,
			[{ t: "i", id: newId, p: pageId, k: key, content: "second" }],
			[{ id: block, md: "first" }],
		);
		await waitFor(() => b.visible.alive(newId) !== undefined, 3000, "insert at bob");
		await settle();
		expect(b.textOf(newId)).toBe("second");
		expect(b.textOf(block)).toBe("first");
		expect(await content(block)).toBe("first");
		expect(await content(newId)).toBe("second");
		expect(a.pending).toHaveLength(0);
	});

	test("concurrent moves that would make a cycle: one is refused, both converge", async () => {
		const { pageId, ids } = await page(["X", "Y", "Z"]);
		const [x, y] = ids as [string, string];
		const la = link(owner);
		const lb = link(writer);
		const a = open(la, pageId);
		const b = open(lb, pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		la.hold(true);
		lb.hold(true);
		struct(a, [{ t: "m", id: x, p: y, k: keyBetween(null, null) }]);
		struct(b, [{ t: "m", id: y, p: x, k: keyBetween(null, null) }]);
		// Bob keeps typing after his refused move: that must survive the rebuild.
		type(b, ids[2] as string, "!");
		la.hold(false);
		await settle();
		lb.hold(false);
		await settle(60);
		expect(a.outline()).toBe(b.outline());
		expect(a.stats.rejects + b.stats.rejects).toBe(1);
		expect(b.textOf(ids[2] as string)).toBe("Z!");
		await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 3000, "flush");
		expect(await content(ids[2] as string)).toBe("Z!");
	});

	test("the person typing in a block someone deletes is told, and can bring it back", async () => {
		const { pageId, ids } = await page(["keep", "doomed"]);
		const doomed = ids[1] as string;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		a.cursorBlock = doomed;
		type(a, doomed, " text");
		await settle();
		struct(b, [{ t: "d", id: doomed }]);
		await waitFor(() => a.deleted !== null, 3000, "deleted notice");
		expect(a.deleted?.blockId).toBe(doomed);
		a.restoreDeleted();
		await waitFor(() => b.visible.alive(doomed) !== undefined, 3000, "restored");
		await settle();
		expect(b.textOf(doomed)).toBe("doomed text");
		expect(await content(doomed)).toBe("doomed text");
		expect((await outlineStore.getBlock(doomed))?.deleted).toBe(false);
	});
});

describe("undo", () => {
	test("undo takes back only one's own change", async () => {
		const { pageId, ids } = await page(["base"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		type(a, block, "A");
		await settle();
		type(b, block, "B", 0);
		await settle();
		expect(a.textOf(block)).toBe("BbaseA");
		a.undo();
		await settle();
		expect(b.textOf(block)).toBe("Bbase");
		a.redo();
		await settle();
		expect(b.textOf(block)).toBe("BbaseA");
	});

	test("a split, then typing in the new block: undone and redone, the text comes back", async () => {
		const { pageId, ids } = await page(["first second"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		const newId = a.newId();
		const key = keyBetween(a.visible.get(block)?.orderKey ?? null, null);
		struct(
			a,
			[{ t: "i", id: newId, p: pageId, k: key, content: "second" }],
			[{ id: block, md: "first" }],
		);
		await settle();
		type(a, newId, " typed");
		await settle();
		expect(b.textOf(newId)).toBe("second typed");
		a.undo();
		a.undo();
		await settle();
		expect(b.visible.alive(newId)).toBeUndefined();
		expect(b.textOf(block)).toBe("first second");
		a.redo();
		a.redo();
		await settle();
		// The new block's text is the same Yjs text throughout: redoing the typing lands in it.
		expect(b.visible.alive(newId)).toBeDefined();
		expect(b.textOf(newId)).toBe("second typed");
		expect(b.textOf(block)).toBe("first");
		await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 3000, "flush");
		expect(await content(newId)).toBe("second typed");
	});
});

describe("writes from outside", () => {
	test("an agent's write that read before someone typed is refused, nothing written", async () => {
		const { pageId, ids } = await page(["agent read this"]);
		const block = ids[0] as string;
		const read = (await outlineStore.getBlock(block))?.versionSeq as number;
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, " and more");
		await settle();
		expect(liveSessionOf(pageId)?.hasUnflushed).toBe(true);
		await expect(
			writeOutline({
				spaceId: space.id,
				ops: [{ op: "update", block: { id: block }, content: "agent text", baseVersionSeq: read }],
				actor: { kind: "agent", id: "narrator-x" },
				responsibleUserId: owner,
			}),
		).rejects.toBeInstanceOf(OutlineConflictError);
		// The person's text was committed first; the agent's never was.
		expect(await content(block)).toBe("agent read this and more");
	});

	test("an outside write reaches the session as a remote change, merged with live text", async () => {
		const { pageId, ids } = await page(["shared"]);
		const block = ids[0] as string;
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		// Alice's keystroke is still on its way when the agent writes.
		la.hold(true);
		type(a, block, " (alice)");
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "update", block: { id: block }, content: "agent: shared" },
				{ op: "insert", parent: { id: pageId }, content: "agent block" },
			],
			actor: { kind: "agent", id: "narrator-x" },
			responsibleUserId: owner,
		});
		la.hold(false);
		await settle(60);
		expect(a.textOf(block)).toBe("agent: shared (alice)");
		expect(b.textOf(block)).toBe("agent: shared (alice)");
		expect(kids(b, pageId).map((k) => b.textOf(k.id))).toContain("agent block");
		await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 3000, "flush");
		expect(await content(block)).toBe("agent: shared (alice)");
	});
});

describe("persistence", () => {
	test("updates reach the log within the persist delay; replay commits what was not", async () => {
		const { pageId, ids } = await page(["crash", "other"]);
		const block = ids[0] as string;
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, " test");
		await settle();
		const session = liveSessionOf(pageId);
		expect(session).toBeDefined();
		const epoch = session?.epoch as number;
		await waitFor(
			() =>
				db.select().from(outlineLiveUpdates).where(eq(outlineLiveUpdates.pageBlockId, pageId)).all()
					.length > 0,
			2000,
			"log rows",
		);
		expect(await content(block)).toBe("crash");
		// The process "dies" here: nothing is committed or closed.
		abandonLiveSessionForTests(pageId);
		// Outside writes after the crash: one to the typed block, one to another block.
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "update", block: { id: block }, content: "agent: crash" },
				{ op: "update", block: { id: ids[1] as string }, content: "other, by agent" },
			],
			actor: { kind: "agent", id: "n" },
			responsibleUserId: owner,
		});
		// Replay commits what was typed onto what the database has now, and drops the rows.
		expect(await replayLiveEpoch(pageId, epoch)).toBe("committed");
		expect(await content(block)).toBe("agent: crash test");
		expect(await content(ids[1] as string)).toBe("other, by agent");
		const left = db
			.select()
			.from(outlineLiveUpdates)
			.where(and(eq(outlineLiveUpdates.pageBlockId, pageId), eq(outlineLiveUpdates.epoch, epoch)))
			.all();
		expect(left).toHaveLength(0);
	});

	test("a session nobody is in closes after the idle time, committing and dropping its log", async () => {
		const { pageId, ids } = await page(["idle"]);
		const block = ids[0] as string;
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const la = link(owner);
		const a = open(la, pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, "!");
		await settle();
		la.disconnect();
		await waitFor(() => liveSessionOf(pageId) === undefined, 3000, "closed");
		expect(await content(block)).toBe("idle!");
		const left = db
			.select()
			.from(outlineLiveUpdates)
			.where(eq(outlineLiveUpdates.pageBlockId, pageId))
			.all();
		// Only the record of how far each client got (epoch 0), for a client coming back later.
		expect(left.map((r) => r.epoch)).toEqual([0]);
	});
});

describe("access", () => {
	test("a viewer's changes are refused; losing write demotes, losing read ends it", async () => {
		const { pageId, ids } = await page(["guarded"]);
		const late = await user("late");
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: late,
			capability: "write",
			createdAt: NOW,
		});
		const l = link(late);
		const c = open(l, pageId);
		await waitFor(() => c.ready && c.canWrite, 3000, "joined as editor");
		await db
			.update(aclGrants)
			.set({ capability: "read" })
			.where(and(eq(aclGrants.scopeId, projectId), eq(aclGrants.principalId, late)));
		eventBus.emit({ type: "project:access_changed", projectId, reason: "members_changed" });
		await waitFor(() => !c.canWrite, 3000, "demoted");
		type(c, ids[0] as string, "x");
		await settle();
		expect(await content(ids[0] as string)).toBe("guarded");
		await db
			.delete(aclGrants)
			.where(and(eq(aclGrants.scopeId, projectId), eq(aclGrants.principalId, late)));
		eventBus.emit({ type: "project:access_changed", projectId, reason: "members_changed" });
		await waitFor(() => c.status === "closed", 3000, "dismissed");
		expect(c.closeCode).toBe("access_denied");
	});

	test("switching the outline off ends every session after committing", async () => {
		const { pageId, ids } = await page(["off"]);
		OUTLINE_LIVE_TIMING.flushIdleMs = 60_000;
		OUTLINE_LIVE_TIMING.flushMaxMs = 60_000;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, ids[0] as string, "?");
		await settle();
		await closeAllLiveSessions("unavailable");
		expect(await content(ids[0] as string)).toBe("off?");
		expect(outlineLiveStats().sessions).toBe(0);
	});
});

describe("network", () => {
	test("a reconnect resumes the same session with a state-vector diff", async () => {
		const { pageId, ids } = await page(["offline"]);
		const block = ids[0] as string;
		const la = link(owner);
		const a = open(la, pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		la.disconnect();
		type(a, block, " A");
		type(b, block, "B ", 0);
		await settle();
		const before = la.bytesDown;
		la.reconnect();
		await waitFor(() => a.status === "live", 3000, "rejoined");
		await settle(60);
		expect(a.textOf(block)).toBe(b.textOf(block));
		expect(a.textOf(block)).toBe("B offline A");
		expect(a.stats.rebuilds).toBe(0);
		// The resume carried a diff, not the page.
		expect(la.bytesDown - before).toBeLessThan(2000);
	});

	test("a socket that falls behind gets nothing until it drains, then catches up", async () => {
		const { pageId, ids } = await page(["slow"]);
		const block = ids[0] as string;
		const la = link(owner);
		const lb = link(writer);
		const a = open(la, pageId);
		const b = open(lb, pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		lb.setBuffered(2 * 1024 * 1024);
		const sentBefore = lb.socket.sent.length;
		type(a, block, " lagging");
		await settle(80);
		expect(lb.socket.sent.length).toBe(sentBefore);
		lb.setBuffered(0);
		await waitFor(() => b.textOf(block) === "slow lagging", 3000, "caught up");
	});

	test("limits: sessions per socket", async () => {
		const l = link(owner);
		const pages = await Promise.all(Array.from({ length: 9 }, () => page(["p"])));
		const cs = pages.map((p) => open(l, p.pageId));
		await waitFor(() => cs.every((c) => c.ready || c.closeCode !== null), 5000, "answers");
		// The ninth is turned away (and retries later, as for any temporary refusal).
		expect(cs.filter((c) => !c.ready).map((c) => c.closeCode)).toEqual(["unavailable"]);
		await runInLane(space.id, () => {});
	});
});

describe("task claims", () => {
	test("ticking a task another session is doing is refused; one nobody does is claimed", async () => {
		const r = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "Plan" },
				{ op: "insert", parent: { tempId: "p" }, content: "busy", task: { status: "todo" } },
				{ op: "insert", parent: { tempId: "p" }, content: "free", task: { status: "todo" } },
			],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const [pageId, busy, free] = r.results.map((x) => x.blockId) as [string, string, string];
		const session = generateId();
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: busy }, task: { status: "doing" } }],
			actor: { kind: "agent", id: session },
			narratorId: session,
			responsibleUserId: owner,
		});
		const a = open(link(writer), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		// The same rule as every other writer: the session holds it, so starting it is refused.
		struct(a, [{ t: "k", id: busy, task: "/" }]);
		await waitFor(() => a.stats.rejects === 1, 3000, "refused");
		await settle();
		expect((await outlineStore.getTaskClaims([busy]))[0]).toMatchObject({
			holderNarratorId: session,
			epoch: 1,
		});
		struct(a, [{ t: "k", id: free, task: "/" }]);
		await settle(60);
		expect((await outlineStore.getBlock(free))?.taskJson?.status).toBe("doing");
		expect((await outlineStore.getTaskClaims([free]))[0]).toMatchObject({
			holderUserId: writer,
			holderNarratorId: null,
			expiresAt: null,
			epoch: 1,
		});
	});
});
