/**
 * Live sessions under failure and abuse (the PR8 review): crashes at the worst moments, access
 * lost mid-join, large pages, frames no reply can carry, writes that fail half way, text that
 * cannot be normalized, misbehaving clients. Real registry, sessions, write path and log; the
 * editor's real client engine over the in-process network of `harness.ts`.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LiveClient } from "@frontend/components/outline/editor/live-client";
import { keyBetween } from "@shared/outline";
import {
	decodeLiveFrame,
	encodeLiveFrame,
	LIVE_FRAME,
	type LiveFrame,
	OUTLINE_LIVE_MAX_HANDLE,
} from "@shared/outline-live-protocol";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "../../../../db";
import { aclGrants, outlineLiveUpdates, projects, users } from "../../../../db/schema";
import { eventBus } from "../../../../lib/event-bus";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import {
	handleOutlineLiveBinary,
	type OutlineLiveWS,
	releaseOutlineLive,
} from "../../../../websocket/outline-live-ws";
import { OutlineEditTextError } from "../../edit-text-runner";
import { OutlineBusyError, OutlineWriteError } from "../../errors";
import { ensureProjectSpace } from "../../spaces";
import { outlineStore, setOutlineStore } from "../../store";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import { SpaceLane } from "../lane";
import {
	abandonLiveSessionForTests,
	closeAllLiveSessions,
	ENDED_EPOCH,
	forgetEndedSessionsForTests,
	handleLiveFrame,
	joinLive,
	liveSessionOf,
	persistAllLiveSessions,
	releaseLiveSocket,
	runInLane,
	startLiveReplay,
} from "../registry";
import { replayLiveEpoch } from "../replay";
import {
	LIVE_SYNC_ACTOR,
	OUTLINE_LIVE_BOUNDS,
	OUTLINE_LIVE_HOOKS,
	OUTLINE_LIVE_TIMING,
} from "../session";
import { client, kids, settle, struct, TestLink, TestSocket, type, waitFor } from "./harness";

const NOW = "2026-10-27T00:00:00.000Z";
const savedTiming = { ...OUTLINE_LIVE_TIMING };
const savedBounds = { ...OUTLINE_LIVE_BOUNDS };
const savedHooks = { ...OUTLINE_LIVE_HOOKS };

let owner: string;
let writer: string;
let reader: string;
let projectId: string;
let space: OutlineSpaceRow;
const clients: LiveClient[] = [];
const links: TestLink[] = [];

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function grant(principalId: string, capability: "read" | "write"): Promise<void> {
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

function link(userId: string): TestLink {
	const l = new TestLink(userId, userId);
	links.push(l);
	return l;
}

function open(l: TestLink, pageId: string, mode: "edit" | "view" = "edit"): LiveClient {
	const c = client(l, pageId, mode);
	clients.push(c);
	return c;
}

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

/** The page's log rows of its sessions (not the ended-session records under epoch 0). */
async function logRows(pageId: string): Promise<number> {
	return db
		.select()
		.from(outlineLiveUpdates)
		.where(eq(outlineLiveUpdates.pageBlockId, pageId))
		.all()
		.filter((r) => r.epoch !== 0).length;
}

async function children(id: string): Promise<string[]> {
	const b = await outlineStore.getBlock(id);
	if (!b) return [];
	const { blocks } = await outlineStore.listPageBlocks(b.pageId, 5000);
	return blocks.filter((x) => x.parentId === id && !x.deleted).map((x) => x.content);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
	owner = await user("owner");
	writer = await user("writer");
	reader = await user("reader");
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Robustness",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await grant(writer, "write");
	await grant(reader, "read");
	space = await ensureProjectSpace(projectId);
});

beforeEach(() => {
	settings.outline.enabled = true;
	Object.assign(OUTLINE_LIVE_TIMING, {
		flushIdleMs: 60_000,
		flushMaxMs: 60_000,
		persistMs: 20,
		idleCloseMs: 150,
	});
});

afterEach(async () => {
	setOutlineStore(undefined);
	Object.assign(OUTLINE_LIVE_HOOKS, savedHooks);
	for (const c of clients.splice(0)) c.dispose();
	for (const l of links.splice(0)) if (l.connected) l.disconnect();
	await closeAllLiveSessions("ended");
	Object.assign(OUTLINE_LIVE_TIMING, savedTiming);
	Object.assign(OUTLINE_LIVE_BOUNDS, savedBounds);
});

describe("crashes", () => {
	test("a crash right after a commit, before its sync row, does not repeat the text", async () => {
		const { pageId, ids } = await page(["x"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, " hel");
		await settle();
		await waitFor(() => !!liveSessionOf(pageId) && a.pending.length === 0, 3000, "logged");
		// The next append is later (the 500 ms timer in production).
		OUTLINE_LIVE_TIMING.persistMs = 60_000;
		type(a, block, "lo");
		await settle();
		const s = liveSessionOf(pageId);
		const epoch = s?.epoch as number;
		await runInLane(space.id, async () => {
			await s?.flushContent();
		});
		expect(await content(block)).toBe("x hello");
		abandonLiveSessionForTests(pageId);
		await replayLiveEpoch(pageId, epoch);
		expect(await content(block)).toBe("x hello");
		expect(await logRows(pageId)).toBe(0);
	});

	test("acknowledged typing survives a crash; what was not logged the client keeps", async () => {
		const { pageId, ids } = await page(["x"]);
		const block = ids[0] as string;
		OUTLINE_LIVE_TIMING.persistMs = 60_000;
		const la = link(owner);
		const a = open(la, pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, " typed");
		await settle();
		// Not in the log: not acknowledged.
		expect(a.pending.length).toBeGreaterThan(0);
		const epoch = liveSessionOf(pageId)?.epoch as number;
		abandonLiveSessionForTests(pageId);
		expect(await replayLiveEpoch(pageId, epoch)).toBe("empty");
		OUTLINE_LIVE_TIMING.persistMs = 20;
		la.disconnect();
		la.reconnect();
		await waitFor(() => a.status === "live" && a.pending.length === 0, 3000, "rejoined, acked");
		expect(a.textOf(block)).toBe("x typed");
		await runInLane(space.id, async () => {
			await liveSessionOf(pageId)?.flushContent();
		});
		expect(await content(block)).toBe("x typed");
	});

	test("typing logged but never acknowledged is not replayed twice after a crash", async () => {
		const { pageId, ids } = await page(["x"]);
		const block = ids[0] as string;
		const la = link(owner);
		const a = open(la, pageId);
		await waitFor(() => a.ready, 3000, "joined");
		// The socket stops reading: no acknowledgement reaches the client, the log has the text.
		la.setBuffered(OUTLINE_LIVE_BOUNDS.lagBytes + 1);
		type(a, block, " logged");
		await settle();
		await waitFor(() => (liveSessionOf(pageId)?.textOf(block) ?? "") === "x logged", 3000, "in");
		await sleep(80);
		expect(a.pending.length).toBeGreaterThan(0);
		abandonLiveSessionForTests(pageId);
		la.disconnect();
		la.reconnect();
		// The rejoin replays the log (committing the text) and tells the client so.
		await waitFor(() => a.status === "live" && a.pending.length === 0, 5000, "rejoined");
		await settle();
		expect(await content(block)).toBe("x logged");
		expect(a.textOf(block)).toBe("x logged");
	});

	test("a structural change that was refused never reaches the log", async () => {
		const { pageId, ids } = await page(["first second"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		OUTLINE_LIVE_HOOKS.write = async () => {
			throw new Error("disk I/O error");
		};
		// Enter in the middle: the block keeps "first", a new block gets "second". Refused.
		const newId = a.newId();
		const key = keyBetween(a.visible.get(block)?.orderKey ?? null, null);
		struct(
			a,
			[{ t: "i", id: newId, p: pageId, k: key, content: "second" }],
			[{ id: block, md: "first" }],
		);
		await settle();
		expect(a.stats.rejects).toBeGreaterThanOrEqual(1);
		await waitFor(
			() => (liveSessionOf(pageId)?.textOf(block) ?? "") === "first second",
			3000,
			"undone",
		);
		const epoch = liveSessionOf(pageId)?.epoch as number;
		abandonLiveSessionForTests(pageId);
		OUTLINE_LIVE_HOOKS.write = savedHooks.write;
		await replayLiveEpoch(pageId, epoch);
		expect(await content(block)).toBe("first second");
		expect((await outlineStore.getBlock(newId))?.deleted ?? true).toBe(true);
	});

	test("the startup job and a join never replay one epoch twice", async () => {
		const { pageId, ids } = await page(["x"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		const cur = a.textOf(block);
		a.commit({
			ops: [],
			bodies: [{ id: block, md: `${cur} head\n- one\n- two` }],
			kind: "typing",
			blockId: block,
			selBefore: null,
			selAfter: null,
			view: null,
		});
		await settle();
		await waitFor(() => !!liveSessionOf(pageId) && a.pending.length === 0, 3000, "logged");
		abandonLiveSessionForTests(pageId);
		for (const c of clients.splice(0)) c.dispose();
		const replay = startLiveReplay();
		const b = open(link(owner), pageId);
		await waitFor(() => b.ready, 5000, "joined after the crash");
		await replay;
		await settle();
		expect(await content(block)).toBe("x head");
		expect(await children(block)).toEqual(["one", "two"]);
		expect(await logRows(pageId)).toBeLessThanOrEqual(2);
	});
});

describe("access and joins", () => {
	test("losing access while a join waits in the lane refuses the join", async () => {
		const { pageId, ids } = await page(["guarded"]);
		const block = ids[0] as string;
		const late = await user("late");
		await grant(late, "write");
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		void runInLane(space.id, () => gate);
		const c = open(link(late), pageId);
		await sleep(50);
		await db
			.delete(aclGrants)
			.where(and(eq(aclGrants.scopeId, projectId), eq(aclGrants.principalId, late)));
		eventBus.emit({ type: "project:access_changed", projectId, reason: "members_changed" });
		await sleep(OUTLINE_LIVE_TIMING.broadcastMs + 100);
		release();
		await waitFor(() => c.ready || c.closeCode !== null, 3000, "join answered");
		expect(c.ready).toBe(false);
		expect(c.closeCode).toBe("access_denied");
		expect(await content(block)).toBe("guarded");
	});

	test("a join whose handle no frame can carry leaves nothing behind", async () => {
		const { pageId, ids } = await page(["ghost"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "a joined");
		const ghost = new TestSocket(owner, "ghost", () => {});
		await joinLive(ghost, {
			kind: LIVE_FRAME.join,
			handle: 70_000,
			n: 0,
			head: { page: pageId, mode: "view", key: "ghostkey01" },
			body: new Uint8Array(0),
		});
		expect(ghost.sent).toEqual([]);
		const session = liveSessionOf(pageId);
		expect(session?.participants.size).toBe(1);
		const b = open(link(owner), pageId);
		await waitFor(() => b.ready, 3000, "b joined");
		type(a, block, " from a");
		await settle();
		expect(b.textOf(block)).toBe("ghost from a");
		releaseLiveSocket(ghost);
		await closeAllLiveSessions("ended");
		expect(await content(block)).toBe("ghost from a");
		// Such frames do not even decode.
		const raw = encodeLiveFrame({ kind: LIVE_FRAME.join, handle: OUTLINE_LIVE_MAX_HANDLE });
		raw[2] = 0x80 | 0x70;
		const bytes = new Uint8Array([...raw.subarray(0, 3), 0x04, ...raw.subarray(3)]);
		expect(decodeLiveFrame(bytes)).toBeNull();
	});

	test("joins of one socket are rate-limited; no snapshot goes to a socket that does not read", async () => {
		const { pageId } = await page(["rate"]);
		const answers: LiveFrame[] = [];
		const s = new TestSocket(owner, "o", (f) => {
			const d = decodeLiveFrame(f);
			if (d) answers.push(d);
		});
		for (let i = 0; i < 30; i++) {
			await joinLive(s, {
				kind: LIVE_FRAME.join,
				handle: 1,
				n: 0,
				head: { page: pageId, mode: "view", key: "ratekey001" },
				body: new Uint8Array(0),
			});
		}
		const refused = answers.filter(
			(f) => f.kind === LIVE_FRAME.closed && (f.head as { code: string }).code === "unavailable",
		);
		expect(refused.length).toBeGreaterThanOrEqual(5);
		releaseLiveSocket(s);

		const slow = new TestSocket(owner, "o", (f) => {
			const d = decodeLiveFrame(f);
			if (d) answers.push(d);
		});
		slow.buffered = OUTLINE_LIVE_BOUNDS.lagBytes + 1;
		answers.length = 0;
		await joinLive(slow, {
			kind: LIVE_FRAME.join,
			handle: 2,
			n: 0,
			head: { page: pageId, mode: "view", key: "slowkey001" },
			body: new Uint8Array(0),
		});
		expect(answers.map((f) => f.kind)).toEqual([LIVE_FRAME.closed]);
		releaseLiveSocket(slow);
	});
});

describe("persistence", () => {
	test("a page over the compaction bound is not rewritten on every append", async () => {
		const big = "y".repeat(15_000);
		const { pageId } = await page(["seed"]);
		for (let i = 0; i < 60; i += 6) {
			await writeOutline({
				spaceId: space.id,
				ops: Array.from({ length: 6 }, () => ({
					op: "insert" as const,
					parent: { id: pageId },
					content: big,
				})),
				actor: { kind: "human", id: owner },
				responsibleUserId: owner,
			});
		}
		const { blocks } = await outlineStore.listPageBlocks(pageId, 2000);
		const target = blocks.find((b) => b.content === "seed")?.id as string;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 20_000, "joined");
		for (let i = 0; i < 10; i++) {
			type(a, target, "!");
			await settle(40);
		}
		await waitFor(() => a.pending.length === 0, 3000, "acked");
		const s = liveSessionOf(pageId);
		expect(s?.stats.compactions ?? 99).toBeLessThan(2);
		// The snapshot once, then a few small rows.
		expect(s?.stats.rowBytes ?? 0).toBeLessThan(1.5 * 1024 * 1024);
	}, 60_000);
});

describe("failures while committing", () => {
	test("a write from outside is refused while the live text cannot be committed", async () => {
		const { pageId, ids } = await page(["typed here", "agent target"]);
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, ids[0] as string, " and more");
		await settle();
		OUTLINE_LIVE_HOOKS.normalize = async () => {
			throw new OutlineEditTextError("OUTLINE_TEXT_BUSY", "busy", 503);
		};
		await expect(
			writeOutline({
				spaceId: space.id,
				ops: [{ op: "update", block: { id: ids[1] as string }, content: "agent text" }],
				actor: { kind: "agent", id: "narrator-x" },
				responsibleUserId: owner,
			}),
		).rejects.toBeInstanceOf(OutlineBusyError);
		expect(await content(ids[1] as string)).toBe("agent target");
		expect(liveSessionOf(pageId)?.hasUnflushed).toBe(true);
		OUTLINE_LIVE_HOOKS.normalize = savedHooks.normalize;
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: ids[1] as string }, content: "agent text" }],
			actor: { kind: "agent", id: "narrator-x" },
			responsibleUserId: owner,
		});
		expect(await content(ids[0] as string)).toBe("typed here and more");
		expect(await content(ids[1] as string)).toBe("agent text");
	});

	test("typed text in a block a transaction deletes is kept when its commit fails", async () => {
		const { pageId, ids } = await page(["doomed", "other"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, " typed");
		await settle();
		let fail = true;
		OUTLINE_LIVE_HOOKS.write = async (input, options) => {
			if (fail) throw new Error("database is locked");
			return await savedHooks.write(input, options);
		};
		struct(a, [{ t: "d", id: block }]);
		await settle();
		expect(a.stats.rejects).toBeGreaterThanOrEqual(1);
		expect(liveSessionOf(pageId)?.hasUnflushed).toBe(true);
		fail = false;
		await closeAllLiveSessions("ended");
		expect(await content(block)).toBe("doomed typed");
		expect(await logRows(pageId)).toBe(0);
	});

	test("a structural transaction written over several transactions that fails half way", async () => {
		const { pageId } = await page(["anchor"]);
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		let calls = 0;
		OUTLINE_LIVE_HOOKS.write = async (input, options) => {
			calls++;
			if (calls === 2) throw new Error("disk I/O error");
			return await savedHooks.write(input, options);
		};
		// A paste of 12 blocks of 15 KB: more than one transaction's content.
		const anchor = kids(a, pageId)[0]?.orderKey ?? null;
		let key = keyBetween(anchor, null);
		const ops = Array.from({ length: 12 }, (_, i) => {
			const op = {
				t: "i" as const,
				id: a.newId(),
				p: pageId,
				k: key,
				content: `${"z".repeat(15_000)}${i}`,
			};
			key = keyBetween(key, null);
			return op;
		});
		struct(a, ops);
		await settle();
		expect(a.stats.rejects).toBeGreaterThanOrEqual(1);
		await waitFor(() => a.ready && a.status === "live", 3000, "rebuilt");
		await settle();
		// The session holds exactly what the page holds: what was written, nothing else.
		const { blocks } = await outlineStore.listPageBlocks(pageId, 2000);
		const live = blocks.filter((b) => !b.deleted && b.parentId === pageId).map((b) => b.id);
		expect(kids(a, pageId).map((b) => b.id)).toEqual(
			live.sort((x, y) => {
				const bx = blocks.find((b) => b.id === x)?.orderKey ?? "";
				const by = blocks.find((b) => b.id === y)?.orderKey ?? "";
				return bx < by ? -1 : bx > by ? 1 : 0;
			}),
		);
		expect(live.length).toBeGreaterThan(1);
		expect(live.length).toBeLessThan(13);
	});

	test("a flush failing half way settles what was written and retries only the rest", async () => {
		const { pageId, ids } = await page(["one", "two", "three"]);
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		// Each block gets 60 KB in one go: three plans of four parts, over two transactions.
		for (const [at, id] of ids.entries()) {
			a.commit({
				ops: [],
				bodies: [
					{
						id,
						md: Array.from({ length: 4 }, (_, i) => `seg${at}p${i} ${"w ".repeat(7_000)}`).join(
							"\n\n",
						),
					},
				],
				kind: "struct",
				blockId: id,
				selBefore: null,
				selAfter: null,
				view: null,
			});
		}
		await settle();
		let calls = 0;
		OUTLINE_LIVE_HOOKS.write = async (input, options) => {
			calls++;
			if (calls === 2) throw new Error("disk I/O error");
			return await savedHooks.write(input, options);
		};
		const s = liveSessionOf(pageId);
		await runInLane(space.id, async () => {
			await s?.flushContent();
		});
		OUTLINE_LIVE_HOOKS.write = savedHooks.write;
		await runInLane(space.id, async () => {
			await s?.flushContent();
		});
		const { blocks } = await outlineStore.listPageBlocks(pageId, 2000);
		const top = blocks.filter((b) => !b.deleted && b.parentId === pageId);
		// Every part once: three blocks, three parts after each.
		expect(top.length).toBe(12);
		for (let at = 0; at < 3; at++) {
			for (let i = 0; i < 4; i++) {
				expect(top.filter((b) => b.content.startsWith(`seg${at}p${i} `)).length).toBe(1);
			}
		}
	}, 30_000);

	test("text that cannot be normalized is committed as code, and the page stays editable", async () => {
		const { pageId, ids } = await page(["fine", "evil"]);
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, ids[0] as string, " still fine");
		type(a, ids[1] as string, " <<pathological>>");
		await settle();
		OUTLINE_LIVE_HOOKS.normalize = async (texts) => {
			if (texts.some((t) => t.includes("<<pathological>>") && !t.startsWith("```")))
				throw new OutlineEditTextError("OUTLINE_TEXT_TIMEOUT", "timed out", 504);
			return await savedHooks.normalize(texts);
		};
		const s = liveSessionOf(pageId);
		const ok = await runInLane(space.id, async () => (await s?.flushContent()) ?? false);
		expect(ok).toBe(true);
		expect(await content(ids[0] as string)).toBe("fine still fine");
		expect(await content(ids[1] as string)).toBe("```\nevil <<pathological>>\n```");
	});

	test("a log whose text cannot be committed is taken over by the next session", async () => {
		const { pageId, ids } = await page(["kept"]);
		const block = ids[0] as string;
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, block, " recovered");
		await settle();
		await waitFor(() => a.pending.length === 0, 3000, "logged");
		const epoch = liveSessionOf(pageId)?.epoch as number;
		abandonLiveSessionForTests(pageId);
		for (const c of clients.splice(0)) c.dispose();
		OUTLINE_LIVE_HOOKS.normalize = async () => {
			throw new OutlineEditTextError("OUTLINE_TEXT_FAILED", "broken", 500);
		};
		expect(await replayLiveEpoch(pageId, epoch)).toBe("kept");
		// The next join opens the page anyway, with the text.
		const b = open(link(owner), pageId);
		await waitFor(() => b.ready, 3000, "joined after");
		expect(b.textOf(block)).toBe("kept recovered");
		OUTLINE_LIVE_HOOKS.normalize = savedHooks.normalize;
		await closeAllLiveSessions("ended");
		expect(await content(block)).toBe("kept recovered");
		expect(await logRows(pageId)).toBe(0);
	});
});

describe("misbehaving clients", () => {
	test("a viewer's frames are answered without queueing; a writer queueing too much is dismissed", async () => {
		const { pageId, ids } = await page(["v"]);
		const r = open(link(reader), pageId, "view");
		await waitFor(() => r.ready, 3000, "viewer joined");
		const s = liveSessionOf(pageId);
		const viewer = [...(s?.participants.values() ?? [])][0];
		const rl = links[0] as TestLink;
		handleLiveFrame(
			rl.socket,
			decodeLiveFrame(
				encodeLiveFrame({
					kind: LIVE_FRAME.update,
					handle: 1,
					n: 99,
					body: new Uint8Array(1000),
				}),
			) as LiveFrame,
		);
		expect(viewer?.queuedBytes).toBe(0);
		expect(viewer?.blocked).toBe(true);

		const sock = new TestSocket(writer, "w", () => {});
		await joinLive(sock, {
			kind: LIVE_FRAME.join,
			handle: 3,
			n: 0,
			head: { page: pageId, mode: "edit", key: "floodkey01" },
			body: new Uint8Array(0),
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((res) => {
			release = res;
		});
		void runInLane(space.id, () => gate);
		const body = new Uint8Array(200_000);
		for (let n = 1; n <= 60; n++) {
			handleLiveFrame(sock, { kind: LIVE_FRAME.update, handle: 3, n, head: null, body });
		}
		release();
		await settle();
		expect(
			sock.sent.some(
				(f) => f.kind === LIVE_FRAME.closed && (f.head as { code: string }).code === "unavailable",
			),
		).toBe(true);
		expect(await content(ids[0] as string)).toBe("v");
		releaseLiveSocket(sock);
	});

	test("a document grown past its bound restarts the session; everyone rejoins", async () => {
		const { pageId, ids } = await page(["grow"]);
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		const first = liveSessionOf(pageId);
		await waitFor(() => a.pending.length === 0, 3000, "acked");
		OUTLINE_LIVE_BOUNDS.maxDocBytes = 200;
		type(a, ids[0] as string, "x".repeat(100));
		await waitFor(() => liveSessionOf(pageId) !== first, 5000, "restarted");
		// (Restored at once: the resent update must not restart the next session too.)
		OUTLINE_LIVE_BOUNDS.maxDocBytes = savedBounds.maxDocBytes;
		await waitFor(() => !!liveSessionOf(pageId), 5000, "rejoined");
		await waitFor(() => a.status === "live" && a.pending.length === 0, 8000, "acked again");
		type(a, ids[0] as string, "y");
		await waitFor(() => a.pending.length === 0, 3000, "acked");
		OUTLINE_LIVE_BOUNDS.maxDocBytes = savedBounds.maxDocBytes;
		await settle();
		await closeAllLiveSessions("ended");
		expect(await content(ids[0] as string)).toBe(`grow${"x".repeat(100)}y`);
	}, 30_000);

	test("presence: a recipient that does not read is not encoded for, and catches up on drain", async () => {
		const { pageId, ids } = await page(["p1", "p2"]);
		const la = link(owner);
		const a = open(la, pageId);
		const lb = link(writer);
		const b = open(lb, pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		lb.setBuffered(OUTLINE_LIVE_BOUNDS.presenceDropBytes + 1);
		const before = lb.socket.sent.filter((f) => f.kind === LIVE_FRAME.presence).length;
		// A burst of selections: one presence round goes out, the last one wins.
		const s = liveSessionOf(pageId);
		const pa = [...(s?.participants.values() ?? [])].find((p) => p.userId === owner);
		for (let i = 0; i < 200; i++) {
			s?.setSelection(pa as never, { b: [ids[i % 2]] });
		}
		await sleep(OUTLINE_LIVE_TIMING.presenceMs * 3);
		expect(lb.socket.sent.filter((f) => f.kind === LIVE_FRAME.presence).length).toBe(before);
		lb.setBuffered(0);
		await waitFor(
			() => lb.socket.sent.filter((f) => f.kind === LIVE_FRAME.presence).length === before + 1,
			2000,
			"caught up",
		);
		await settle();
		const peer = [...b.presence.values()].find((p) => p.userId === owner);
		expect(peer?.sel).toEqual({ b: [ids[1] as string] });
	});
});

describe("the socket adapter", () => {
	test("selection frames are capped and rate-limited before their JSON is read", async () => {
		const { pageId } = await page(["sel"]);
		const out: LiveFrame[] = [];
		const ws: OutlineLiveWS = {
			data: { userId: owner, username: "o", userRole: "user" },
			sendBinary: (d) => {
				const f = decodeLiveFrame(d);
				if (f) out.push(f);
				return d.length;
			},
			getBufferedAmount: () => 0,
		};
		handleOutlineLiveBinary(
			ws,
			encodeLiveFrame({
				kind: LIVE_FRAME.join,
				handle: 1,
				head: { page: pageId, mode: "edit", key: "adapterkey1" },
			}),
		);
		await waitFor(() => out.some((f) => f.kind === LIVE_FRAME.joined), 3000, "joined");
		const proto = Object.getPrototypeOf(liveSessionOf(pageId)) as {
			setSelection: (...args: unknown[]) => void;
		};
		const original = proto.setSelection;
		let calls = 0;
		proto.setSelection = function (this: unknown, ...args: unknown[]) {
			calls++;
			return original.apply(this, args);
		};
		try {
			for (let i = 0; i < 500; i++) {
				handleOutlineLiveBinary(
					ws,
					encodeLiveFrame({ kind: LIVE_FRAME.selection, handle: 1, head: { s: null } }),
				);
			}
			const huge = encodeLiveFrame({
				kind: LIVE_FRAME.selection,
				handle: 1,
				head: { s: { b: Array.from({ length: 2000 }, () => "x".repeat(20)) } },
			});
			handleOutlineLiveBinary(ws, huge);
		} finally {
			proto.setSelection = original;
		}
		expect(calls).toBeLessThanOrEqual(45);
		expect(calls).toBeGreaterThan(0);
		releaseOutlineLive(ws);
	});
});

describe("the page itself", () => {
	test("deleting the page from outside ends its session", async () => {
		const { pageId } = await page(["gone soon"]);
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "delete", block: { id: pageId } }],
			actor: { kind: "agent", id: "narrator-x" },
			responsibleUserId: owner,
		});
		await waitFor(() => a.closeCode !== null || !liveSessionOf(pageId), 3000, "ended");
		await waitFor(() => a.closeCode === "access_denied", 5000, "rejoin refused");
		expect(liveSessionOf(pageId)).toBeUndefined();
	});
});

/** The session's log has its snapshot and everything so far; later typing waits (500 ms in production). */
async function logged(a: LiveClient, pageId: string, block: string): Promise<void> {
	type(a, block, "1");
	await settle();
	await waitFor(() => !!liveSessionOf(pageId) && a.pending.length === 0, 3000, "logged");
	OUTLINE_LIVE_TIMING.persistMs = 60_000;
}

/**
 * Alice types into X (applied, not logged yet, so not acknowledged), then indents Y while Bob
 * deletes it: her indent is refused and her client rebuilds from a snapshot.
 */
async function refusedAfterTyping() {
	const { pageId, ids } = await page(["X", "Y"]);
	const [x, y] = ids as [string, string];
	const la = link(owner);
	const lb = link(writer);
	const a = open(la, pageId);
	const b = open(lb, pageId);
	await waitFor(() => a.ready && b.ready, 3000, "joined");
	await logged(a, pageId, x);
	la.hold(true);
	return {
		pageId,
		x,
		y,
		a,
		b,
		la,
		lb,
		/** Bob's delete goes first, then Alice's frames. */
		async refuse() {
			struct(a, [{ t: "m", id: y, p: x, k: keyBetween(null, null) }]);
			struct(b, [{ t: "d", id: y }]);
			await waitFor(() => b.pending.length === 0 || !b.visible.get(y), 3000, "deleted");
			await settle();
			la.hold(false);
			await waitFor(() => a.stats.rejects >= 1, 3000, "refused");
			await waitFor(() => a.status === "live" && a.ready, 3000, "rebuilt");
			await settle();
		},
	};
}

describe("what the page already has of a client's transactions", () => {
	test("a refused structural change does not make the client repeat its typing", async () => {
		const t = await refusedAfterTyping();
		type(t.a, t.x, "ab");
		await sleep(30);
		type(t.a, t.x, "cd");
		await t.refuse();
		// The page applied the typing: the client keeps it, unsent, until the log has it.
		expect(t.a.pending.length).toBe(0);
		expect(t.a.awaiting.length).toBe(2);
		expect(t.a.textOf(t.x)).toBe("X1abcd");
		expect(t.b.textOf(t.x)).toBe("X1abcd");
		const s = liveSessionOf(t.pageId);
		await runInLane(space.id, async () => {
			await s?.persistNow();
		});
		await waitFor(() => t.a.awaiting.length === 0, 3000, "acknowledged");
		await runInLane(space.id, async () => {
			await s?.flushContent();
		});
		expect(await content(t.x)).toBe("X1abcd");
		expect(t.a.textOf(t.x)).toBe("X1abcd");
	});

	test("what the page applied but lost in a crash is replayed, once", async () => {
		const t = await refusedAfterTyping();
		type(t.a, t.x, "ab");
		await sleep(30);
		type(t.a, t.x, "cd");
		await t.refuse();
		expect(t.a.awaiting.length).toBe(2);
		t.b.dispose();
		t.lb.disconnect();
		// The process dies before the log has the typing.
		abandonLiveSessionForTests(t.pageId);
		OUTLINE_LIVE_TIMING.persistMs = 20;
		t.la.disconnect();
		t.la.reconnect();
		await waitFor(
			() => t.a.status === "live" && t.a.awaiting.length === 0 && t.a.pending.length === 0,
			5000,
			"rejoined, replayed, acknowledged",
		);
		await runInLane(space.id, async () => {
			await liveSessionOf(t.pageId)?.flushContent();
		});
		expect(t.a.textOf(t.x)).toBe("X1abcd");
		expect(await content(t.x)).toBe("X1abcd");
	});

	test("after a resume, a move the page already applied does not hide a later one", async () => {
		const { pageId, ids } = await page(["X", "Z", "W"]);
		const [x, z, w] = ids as [string, string, string];
		const la = link(owner);
		const a = open(la, pageId);
		await waitFor(() => a.ready, 3000, "joined");
		await logged(a, pageId, x);
		await runInLane(space.id, async () => {
			await liveSessionOf(pageId)?.flushContent();
		});
		// The log stops taking writes: Alice's move is committed, not acknowledged.
		setOutlineStore({
			...outlineStore,
			appendLiveUpdates: async () => {
				throw new Error("disk I/O error");
			},
		});
		struct(a, [{ t: "m", id: z, p: x, k: keyBetween(null, null) }]);
		await settle();
		expect((await outlineStore.getBlock(z))?.parentId).toBe(x);
		expect(a.pending.length).toBe(1);
		la.disconnect();
		la.reconnect();
		await waitFor(() => a.status === "live", 3000, "resumed");
		await settle();
		expect(a.stats.resumes).toBe(1);
		expect(a.pending.length).toBe(0);
		expect(a.awaiting.length).toBe(1);
		// Someone moves Z on: Alice sees that move, not her old one on top of it.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "move", block: { id: z }, parent: { id: w } }],
			actor: { kind: "agent", id: "narrator-x" },
			responsibleUserId: owner,
		});
		await waitFor(() => a.confirmed.get(z)?.parentId === w, 3000, "alice has the move");
		expect(a.visible.get(z)?.parentId).toBe(w);
		setOutlineStore(undefined);
		await runInLane(space.id, async () => {
			await liveSessionOf(pageId)?.persistNow();
		});
		await waitFor(() => a.awaiting.length === 0, 3000, "acknowledged");
		expect(a.visible.get(z)?.parentId).toBe(w);
	});

	for (const restart of [false, true]) {
		test(`sockets closing before a shutdown's acknowledgements, rejoin ${restart ? "after a restart" : "in the same process"}`, async () => {
			const { pageId, ids } = await page(["X"]);
			const x = ids[0] as string;
			const la = link(owner);
			const a = open(la, pageId);
			await waitFor(() => a.ready, 3000, "joined");
			await logged(a, pageId, x);
			OUTLINE_LIVE_TIMING.persistMs = 500;
			type(a, x, "ab");
			await sleep(30);
			type(a, x, "cd");
			await waitFor(() => liveSessionOf(pageId)?.textOf(x) === "X1abcd", 3000, "applied");
			expect(a.pending.length).toBe(2);
			// The worst order: connections first, then the sessions close (log, commit).
			la.disconnect();
			await closeAllLiveSessions("ended");
			expect(await content(x)).toBe("X1abcd");
			// The log keeps how far each client got, for a client that comes back later.
			const ended = db
				.select()
				.from(outlineLiveUpdates)
				.where(
					and(
						eq(outlineLiveUpdates.pageBlockId, pageId),
						eq(outlineLiveUpdates.epoch, ENDED_EPOCH),
					),
				)
				.all();
			expect(ended.length).toBe(1);
			expect(await logRows(pageId)).toBe(0);
			if (restart) forgetEndedSessionsForTests();
			la.reconnect();
			await waitFor(() => a.status === "live" && a.pending.length === 0, 3000, "rejoined");
			await settle();
			await runInLane(space.id, async () => {
				await liveSessionOf(pageId)?.flushContent();
			});
			expect(a.textOf(x)).toBe("X1abcd");
			expect(await content(x)).toBe("X1abcd");
		});
	}

	test("a client that left before its acknowledgement keeps its key past the key bound", async () => {
		OUTLINE_LIVE_BOUNDS.clientKeys = 2;
		const { pageId, ids } = await page(["X", "Y"]);
		const [x, y] = ids as [string, string];
		const la = link(owner);
		const a = open(la, pageId);
		await waitFor(() => a.ready, 3000, "joined");
		await logged(a, pageId, x);
		type(a, x, "ab");
		await sleep(30);
		type(a, x, "cd");
		await waitFor(() => liveSessionOf(pageId)?.textOf(x) === "X1abcd", 3000, "applied");
		la.disconnect();
		// The log gets Alice's typing after she left: no acknowledgement reached her.
		OUTLINE_LIVE_TIMING.persistMs = 20;
		await runInLane(space.id, async () => {
			await liveSessionOf(pageId)?.persistNow();
		});
		// More editor instances than the bound come and go, each acknowledged.
		const lb = link(writer);
		for (let i = 0; i < 4; i++) {
			const b = open(lb, pageId);
			await waitFor(() => b.ready, 3000, "joined");
			type(b, y, `${i}`);
			await waitFor(() => b.pending.length === 0, 3000, "acknowledged");
			b.dispose();
			await settle();
		}
		const s = liveSessionOf(pageId) as unknown as { keys: Map<string, number> };
		expect(s.keys.has(a.key)).toBe(true);
		expect(s.keys.size).toBeLessThanOrEqual(3);
		// The session ends while she is away; its record must still know her.
		await closeAllLiveSessions("ended");
		la.reconnect();
		await waitFor(
			() => a.status === "live" && a.pending.length === 0 && a.awaiting.length === 0,
			3000,
			"rejoined",
		);
		await settle();
		await runInLane(space.id, async () => {
			await liveSessionOf(pageId)?.flushContent();
		});
		expect(a.textOf(x)).toBe("X1abcd");
		expect(await content(x)).toBe("X1abcd");
	});

	test("client keys stay within the hard bound when none is acknowledged", async () => {
		Object.assign(OUTLINE_LIVE_BOUNDS, { clientKeys: 2, clientKeysHard: 3 });
		const { pageId, ids } = await page(["X"]);
		const x = ids[0] as string;
		const first = open(link(owner), pageId);
		await waitFor(() => first.ready, 3000, "joined");
		await logged(first, pageId, x);
		first.dispose();
		for (let i = 0; i < 5; i++) {
			const l = link(owner);
			const c = open(l, pageId);
			await waitFor(() => c.ready, 3000, "joined");
			type(c, x, `${i}`);
			await waitFor(() => liveSessionOf(pageId)?.textOf(x).endsWith(`${i}`) ?? false, 3000, "in");
			// Gone before the log (and so the acknowledgement) has it.
			l.disconnect();
			await settle();
		}
		const s = liveSessionOf(pageId) as unknown as { keys: Map<string, number> };
		expect(s.keys.size).toBe(3);
	});

	test("a shutdown logs and acknowledges what arrived before the sockets close", async () => {
		const { pageId, ids } = await page(["X"]);
		const x = ids[0] as string;
		const la = link(owner);
		const a = open(la, pageId);
		await waitFor(() => a.ready, 3000, "joined");
		await logged(a, pageId, x);
		type(a, x, "ab");
		await settle();
		expect(a.pending.length).toBe(1);
		const n = a.pending[0]?.n as number;
		// performGracefulShutdown: this step, then closeAllConnections(). The acknowledgement is
		// on the socket when the step returns, not on a timer the closing would cancel.
		await persistAllLiveSessions();
		expect(la.socket.sent.some((f) => f.kind === LIVE_FRAME.batch && f.n >= n)).toBe(true);
		await settle();
		expect(a.pending.length).toBe(0);
		la.disconnect();
		await closeAllLiveSessions("ended");
		expect(await content(x)).toBe("X1ab");
	});
});

describe("logs written around a commit", () => {
	test("an intent logged with its block's old content in one row is not cancelled by it", async () => {
		const { pageId, ids } = await page(["x"]);
		const block = ids[0] as string;
		// The session committed "x hello!" (normalized from the typed "x hello") just before it
		// died; its last row (a compaction, or its first snapshot) holds the block's old content
		// and the intent together.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: block }, content: "x hello!" }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const doc = new Y.Doc();
		const text = new Y.Text();
		doc.getMap<Y.Text>("texts").set(block, text);
		text.insert(0, "x hello");
		const epoch = 424_242;
		const at = new Date().toISOString();
		const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
		await outlineStore.appendLiveUpdates([
			{
				pageBlockId: pageId,
				epoch,
				seq: 0,
				updateB64: b64(Y.encodeStateAsUpdate(doc)),
				actorKind: "system",
				actorId: "outline-live",
				createdAt: at,
			},
			{
				pageBlockId: pageId,
				epoch,
				seq: 1,
				updateB64: b64(
					new TextEncoder().encode(
						JSON.stringify({ b: { [block]: "x" }, i: { [block]: "x hello!" } }),
					),
				),
				actorKind: "system",
				actorId: LIVE_SYNC_ACTOR,
				createdAt: at,
			},
		]);
		doc.destroy();
		expect(await replayLiveEpoch(pageId, epoch)).toBe("empty");
		expect(await content(block)).toBe("x hello!");
	});
});

describe("structure delivered in order", () => {
	test("others' changes after an own one not acknowledged yet wait for its acknowledgement", async () => {
		const { pageId, ids } = await page(["X", "Y", "Z"]);
		const [x, y, z] = ids as [string, string, string];
		const a = open(link(owner), pageId);
		const b = open(link(writer), pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await logged(a, pageId, x);
		OUTLINE_LIVE_TIMING.persistMs = 20;
		// The log stops taking writes: commits go in, acknowledgements wait.
		const base = outlineStore;
		setOutlineStore({
			...base,
			appendLiveUpdates: async () => {
				throw new Error("disk I/O error");
			},
		});
		struct(a, [{ t: "m", id: z, p: x, k: keyBetween(null, null) }]);
		await waitFor(() => b.confirmed.get(z)?.parentId === x, 3000, "bob has alice's move");
		struct(b, [{ t: "m", id: z, p: y, k: keyBetween(null, null) }]);
		await settle();
		expect((await outlineStore.getBlock(z))?.parentId).toBe(y);
		// Alice has neither her acknowledgement nor Bob's later move.
		expect(a.pending.length).toBe(1);
		expect(a.confirmed.get(z)?.parentId).toBe(pageId);
		setOutlineStore(undefined);
		await waitFor(() => a.pending.length === 0 && b.pending.length === 0, 3000, "acknowledged");
		await settle();
		expect(a.confirmed.get(z)?.parentId).toBe(y);
		expect(a.visible.get(z)?.parentId).toBe(y);
	});
});

describe("text that cannot be committed", () => {
	test("narrowing a failure past its time budget leaves untried blocks as they are", async () => {
		const { pageId, ids } = await page(["one", "slow", "three"]);
		const [one, slow, three] = ids as [string, string, string];
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, one, " ok");
		type(a, slow, " <<slow>>");
		type(a, three, " ok");
		await settle();
		let calls = 0;
		OUTLINE_LIVE_HOOKS.normalize = async (texts) => {
			calls++;
			if (texts.some((t) => t.includes("<<slow>>") && !t.startsWith("```")))
				throw new OutlineEditTextError("OUTLINE_TEXT_TIMEOUT", "timed out", 504);
			return await savedHooks.normalize(texts);
		};
		OUTLINE_LIVE_TIMING.narrowBudgetMs = 0;
		const s = liveSessionOf(pageId);
		const flush = () => runInLane(space.id, async () => (await s?.flushContent()) ?? false);
		// The batch fails; one block is tried alone, the budget is gone, the rest wait as they are.
		expect(await flush()).toBe(false);
		expect(calls).toBe(2);
		expect(await content(one)).toBe("one ok");
		expect(await content(three)).toBe("three");
		// Next: the culprit is found and goes as code; the healthy block is never fenced.
		expect(await flush()).toBe(false);
		expect(await flush()).toBe(true);
		expect(await content(slow)).toBe("```\nslow <<slow>>\n```");
		expect(await content(three)).toBe("three ok");
	});

	test("a block that fails even as code is given up on: outside writes go on, the log keeps it", async () => {
		const { pageId, ids } = await page(["fine", "never", "other"]);
		const [fine, never, other] = ids as [string, string, string];
		const a = open(link(owner), pageId);
		await waitFor(() => a.ready, 3000, "joined");
		type(a, fine, " ok");
		type(a, never, " typed");
		await settle();
		await waitFor(() => a.pending.length === 0, 3000, "logged");
		OUTLINE_LIVE_HOOKS.write = async (input, options) => {
			if (input.ops.some((op) => op.op === "update" && "id" in op.block && op.block.id === never))
				throw new OutlineWriteError("too many siblings", "OUTLINE_TOO_MANY_SIBLINGS");
			return await savedHooks.write(input, options);
		};
		const s = liveSessionOf(pageId);
		const flush = () => runInLane(space.id, async () => (await s?.flushContent()) ?? false);
		const agentWrite = () =>
			writeOutline({
				spaceId: space.id,
				ops: [{ op: "update", block: { id: other }, content: "agent text" }],
				actor: { kind: "agent", id: "narrator-x" },
				responsibleUserId: owner,
			});
		expect(await flush()).toBe(false);
		expect(await content(fine)).toBe("fine ok");
		// The barrier's flush is the second attempt: still retried, so writes wait.
		await expect(agentWrite()).rejects.toBeInstanceOf(OutlineBusyError);
		// The third failure gives up: nothing is retried, the barrier lets writes through.
		expect(await flush()).toBe(true);
		expect(s?.hasUnflushed).toBe(false);
		await agentWrite();
		expect(await content(other)).toBe("agent text");
		const epoch = s?.epoch as number;
		await closeAllLiveSessions("ended");
		expect(await content(never)).toBe("never");
		expect(await logRows(pageId)).toBeGreaterThan(0);
		// Whatever was wrong is fixed: the log's text goes in.
		OUTLINE_LIVE_HOOKS.write = savedHooks.write;
		expect(await replayLiveEpoch(pageId, epoch)).toBe("committed");
		expect(await content(never)).toBe("never typed");
		expect(await content(other)).toBe("agent text");
	});
});

describe("the lane", () => {
	test("a task queued while the lane finishes its last one runs at once", async () => {
		const lane = new SpaceLane("lane-test", async () => {});
		for (let ticks = 0; ticks < 8; ticks++) {
			await lane.run(async () => {});
			for (let i = 0; i < ticks; i++) await Promise.resolve();
			let ran = false;
			const next = lane.run(() => {
				ran = true;
			});
			await Promise.race([next, sleep(200)]);
			expect({ ticks, ran }).toEqual({ ticks, ran: true });
		}
	});
});
