/**
 * Read-only outline subscriptions by block: authorized like the HTTP reads (against the
 * space), a level is told about its own children only and a subtree about anything under it,
 * frames carry ids only and are coalesced, keys of another space match nothing, limits hold,
 * and losing access (or the switch) ends the subscription.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { OUTLINE_WATCH_LIMITS, type OutlineWatchServerMessage } from "@shared/outline-block-events";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { aclGrants, narrators, projects, users } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import { ensureProjectSpace, ensureSessionSpace } from "../services/outline/spaces";
import type { OutlineSpaceRow } from "../services/outline/store/port";
import { type OutlineOp, writeOutline } from "../services/outline/write";
import {
	handleOutlineBlockMessage,
	OUTLINE_BLOCK_BACKPRESSURE_BYTES,
	OUTLINE_BLOCK_COALESCE_MS,
	type OutlineBlockSocket,
	outlineBlockSubscriptionStats,
	releaseOutlineBlockSubscriptions,
} from "./outline-block-ws";
import { handleOutlinePageMessage, releaseOutlinePageSubscriptions } from "./outline-page-ws";

const NOW = "2026-10-26T00:00:00.000Z";

interface FakeSocket extends OutlineBlockSocket {
	frames: Array<OutlineWatchServerMessage | { type: string; [key: string]: unknown }>;
	buffered: number;
	close: ReturnType<typeof mock>;
}

const sockets: FakeSocket[] = [];

function socket(userId: string | undefined, role = "user"): FakeSocket {
	const ws: FakeSocket = {
		data: { userId, userRole: role },
		frames: [],
		buffered: 0,
		send(frame: string) {
			ws.frames.push(JSON.parse(frame));
		},
		getBufferedAmount: () => ws.buffered,
		close: mock(() => {}),
	};
	sockets.push(ws);
	return ws;
}

async function settle(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("did not settle");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Long enough for any pending coalesced frame to have gone out. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, OUTLINE_BLOCK_COALESCE_MS * 3));

async function user(label: string) {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

let owner: string;
let reader: string;
let stranger: string;
let projectId: string;
let space: OutlineSpaceRow;
let otherSpace: OutlineSpaceRow;
let sessionSpace: OutlineSpaceRow;
/** page > a > b > x, page > c. */
let page: string;
let a: string;
let b: string;
let x: string;
let c: string;
let otherPage: string;

async function commit(target: OutlineSpaceRow, ops: OutlineOp[], actor = owner) {
	const result = await writeOutline({
		spaceId: target.id,
		ops,
		actor: { kind: "human", id: actor },
		responsibleUserId: actor,
	});
	return { ...(result.commit as { id: string; seq: number }), results: result.results };
}

function watch(
	ws: FakeSocket,
	subscriptionId: string,
	spaceId: string,
	keys: { levels?: string[]; subtrees?: string[] },
) {
	return handleOutlineBlockMessage(ws, { type: "outline_watch", subscriptionId, spaceId, ...keys });
}

const changes = (ws: FakeSocket) =>
	ws.frames.filter(
		(frame): frame is Extract<OutlineWatchServerMessage, { type: "outline_watch_changed" }> =>
			frame.type === "outline_watch_changed",
	);

// The preload restores settings after every test.
beforeEach(() => {
	settings.outline.enabled = true;
});

afterEach(() => {
	for (const ws of sockets.splice(0)) {
		releaseOutlineBlockSubscriptions(ws);
		releaseOutlinePageSubscriptions(ws);
	}
});

beforeAll(async () => {
	owner = await user("owner");
	reader = await user("reader");
	stranger = await user("stranger");
	projectId = generateId();
	const otherProject = generateId();
	for (const [id, ownerUserId] of [
		[projectId, owner],
		[otherProject, stranger],
	] as const) {
		await db.insert(projects).values({
			id,
			name: `Watched ${id}`,
			ownerUserId,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
	}
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: reader,
		capability: "read",
		createdAt: NOW,
	});
	space = await ensureProjectSpace(projectId);
	otherSpace = await ensureProjectSpace(otherProject);
	const narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		title: "A private session",
		ownerUserId: owner,
		visibility: "private",
		writeAudience: "owner",
		type: "primary",
		createdAt: NOW,
		updatedAt: NOW,
	});
	sessionSpace = await ensureSessionSpace(narratorId);
	const written = await commit(space, [
		{ op: "insert", tempId: "p", parent: null, content: "Page" },
		{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
		{ op: "insert", tempId: "b", parent: { tempId: "a" }, content: "B" },
		{ op: "insert", tempId: "x", parent: { tempId: "b" }, content: "X" },
		{ op: "insert", tempId: "c", parent: { tempId: "p" }, content: "C" },
	]);
	[page, a, b, x, c] = written.results.map((r) => r.blockId) as [
		string,
		string,
		string,
		string,
		string,
	];
	const elsewhere = await commit(
		otherSpace,
		[{ op: "insert", parent: null, content: "Elsewhere" }],
		stranger,
	);
	otherPage = elsewhere.results[0]?.blockId as string;
});

describe("watching", () => {
	test("a level is told about its own children, a subtree about anything under it", async () => {
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { levels: [page, b, c], subtrees: [a, c, space.id] });
		expect(ws.frames[0]).toMatchObject({
			type: "outline_watching",
			subscriptionId: "s1",
			spaceId: space.id,
		});
		const seq0 = (ws.frames[0] as { seq: number }).seq;

		// Text of X (under page > a > b): the level of b, the subtrees of a and of the space.
		const edit = await commit(space, [{ op: "update", block: { id: x }, content: "X, edited" }]);
		expect(edit.seq).toBe(seq0 + 1);
		await settle(() => changes(ws).length === 1);
		const first = changes(ws)[0];
		expect(first).toMatchObject({
			subscriptionId: "s1",
			spaceId: space.id,
			seq: edit.seq,
			commitIds: [edit.id],
			all: false,
		});
		expect(first?.levels.sort()).toEqual([b]);
		expect(first?.subtrees.sort()).toEqual([a, space.id].sort());
		// Ids and seqs only.
		expect(JSON.stringify(first)).not.toContain("edited");

		// A burst: X moves from b to c, then C's text changes. One frame, the newest seq.
		const move = await commit(space, [{ op: "move", block: { id: x }, parent: { id: c } }]);
		const retitle = await commit(space, [{ op: "update", block: { id: c }, content: "C!" }]);
		await settle(() => changes(ws).length === 2);
		await quiet();
		expect(changes(ws)).toHaveLength(2);
		const burst = changes(ws)[1];
		expect(burst).toMatchObject({ seq: retitle.seq, commitIds: [move.id, retitle.id], all: false });
		// The move: both parents' levels, and the subtrees X left and arrived in. The retitle:
		// the level of the page (its child C changed), the subtree of C itself.
		expect(burst?.levels.sort()).toEqual([page, b, c].sort());
		expect(burst?.subtrees.sort()).toEqual([a, c, space.id].sort());
		await commit(space, [{ op: "move", block: { id: x }, parent: { id: b } }]);
		await settle(() => changes(ws).length === 3);
	});

	test("a commit that concerns nothing watched sends nothing", async () => {
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { levels: [c], subtrees: [c] });
		await commit(space, [{ op: "update", block: { id: x }, content: "X again" }]);
		await quiet();
		expect(changes(ws)).toEqual([]);
		// The top level is named by the space's id.
		const top = socket(reader);
		await watch(top, "t", space.id, { levels: [space.id] });
		await commit(space, [{ op: "update", block: { id: x }, content: "X once more" }]);
		await quiet();
		expect(changes(top)).toEqual([]);
		const added = await commit(space, [{ op: "insert", parent: null, content: "Another page" }]);
		await settle(() => changes(top).length === 1);
		expect(changes(top)[0]).toMatchObject({ levels: [space.id], subtrees: [], seq: added.seq });
		await commit(space, [{ op: "delete", block: { id: added.results[0]?.blockId as string } }]);
	});

	test("sending the subscription again replaces what it watches", async () => {
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { subtrees: [a] });
		await watch(ws, "s1", space.id, { subtrees: [c] });
		expect(ws.frames.filter((frame) => frame.type === "outline_watching")).toHaveLength(2);
		expect(outlineBlockSubscriptionStats().total).toBe(1);
		await commit(space, [{ op: "update", block: { id: x }, content: "X replaced" }]);
		await quiet();
		expect(changes(ws)).toEqual([]);
		await handleOutlineBlockMessage(ws, { type: "outline_unwatch", subscriptionId: "s1" });
		expect(outlineBlockSubscriptionStats().total).toBe(0);
	});

	test("an event without its changes, or one cut short, says everything may have changed", async () => {
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { levels: [c] });
		eventBus.emit({
			type: "outline:committed",
			spaceId: space.id,
			commitId: "commit-without-changes",
			seq: 999,
			pageIds: [],
			actorKind: "system",
			actorId: "test",
		});
		await settle(() => changes(ws).length === 1);
		expect(changes(ws)[0]).toMatchObject({ all: true, levels: [], subtrees: [], seq: 999 });
	});

	test("the page subscriptions keep working beside it", async () => {
		const ws = socket(reader);
		await handleOutlinePageMessage(ws as never, {
			type: "outline_page_subscribe",
			subscriptionId: "old",
			pageId: page,
		});
		await watch(ws, "new", space.id, { subtrees: [page] });
		const edit = await commit(space, [{ op: "update", block: { id: x }, content: "X for both" }]);
		await settle(
			() =>
				ws.frames.some((frame) => frame.type === "outline_page_changed") &&
				changes(ws).length === 1,
		);
		expect(ws.frames.find((frame) => frame.type === "outline_page_changed")).toMatchObject({
			pageId: page,
			seq: edit.seq,
		});
	});
});

describe("access", () => {
	test("a space the person may not read, or that does not exist, answers the same", async () => {
		for (const [who, spaceId] of [
			[reader, otherSpace.id],
			[reader, sessionSpace.id],
			[stranger, space.id],
			[reader, "no-such-space"],
		] as const) {
			const ws = socket(who);
			await watch(ws, "s1", spaceId, { subtrees: [spaceId] });
			expect(ws.frames).toEqual([
				{ type: "outline_watch_error", subscriptionId: "s1", code: "access_denied" },
			]);
		}
		expect(outlineBlockSubscriptionStats().total).toBe(0);
		const anonymous = socket(undefined);
		await watch(anonymous, "s1", space.id, {});
		expect(anonymous.frames[0]).toMatchObject({ code: "unavailable" });
		// Its own readers watch it.
		const mine = socket(owner);
		await watch(mine, "s1", sessionSpace.id, { subtrees: [sessionSpace.id] });
		expect(mine.frames[0]).toMatchObject({ type: "outline_watching" });
	});

	test("keys of another space match nothing: a reader of one space never hears of another", async () => {
		const ws = socket(reader);
		// Watching space A while naming the other space's blocks, and its id as a key.
		await watch(ws, "s1", space.id, {
			levels: [otherPage, otherSpace.id],
			subtrees: [otherPage, otherSpace.id],
		});
		expect(ws.frames[0]).toMatchObject({ type: "outline_watching" });
		await commit(
			otherSpace,
			[{ op: "update", block: { id: otherPage }, content: "Elsewhere, edited" }],
			stranger,
		);
		await commit(
			otherSpace,
			[{ op: "insert", parent: { id: otherPage }, content: "Elsewhere, more" }],
			stranger,
		);
		await quiet();
		expect(ws.frames).toHaveLength(1);
	});

	test("losing access ends the subscription", async () => {
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { subtrees: [space.id] });
		await db
			.delete(aclGrants)
			.where(and(eq(aclGrants.scopeId, projectId), eq(aclGrants.principalId, reader)));
		try {
			eventBus.emit({ type: "project:access_changed", projectId } as never);
			await settle(() => ws.frames.some((frame) => frame.type === "outline_watch_error"));
			expect(ws.frames.at(-1)).toEqual({
				type: "outline_watch_error",
				subscriptionId: "s1",
				code: "access_denied",
			});
			await commit(space, [{ op: "update", block: { id: x }, content: "X unseen" }]);
			await quiet();
			expect(changes(ws)).toEqual([]);
			expect(outlineBlockSubscriptionStats().total).toBe(0);
		} finally {
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType: "project",
				scopeId: projectId,
				principalType: "user",
				principalId: reader,
				capability: "read",
				createdAt: NOW,
			});
		}
	});

	test("switching the outline off ends every subscription, and refuses new ones", async () => {
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { subtrees: [space.id] });
		settings.outline.enabled = false;
		await commit(space, [{ op: "update", block: { id: x }, content: "X while off" }]);
		await settle(() => ws.frames.some((frame) => frame.type === "outline_watch_error"));
		expect(ws.frames.at(-1)).toMatchObject({ code: "unavailable" });
		const late = socket(reader);
		await watch(late, "s1", space.id, {});
		expect(late.frames).toEqual([
			{ type: "outline_watch_error", subscriptionId: "s1", code: "unavailable" },
		]);
	});
});

describe("limits", () => {
	test("subscriptions per socket and keys per subscription are bounded", async () => {
		const ws = socket(reader);
		for (let i = 0; i < OUTLINE_WATCH_LIMITS.perSocket; i++) {
			await watch(ws, `s${i}`, space.id, { subtrees: [a] });
		}
		await watch(ws, "one-more", space.id, { subtrees: [a] });
		expect(ws.frames.at(-1)).toEqual({
			type: "outline_watch_error",
			subscriptionId: "one-more",
			code: "unavailable",
		});
		expect(outlineBlockSubscriptionStats().total).toBe(OUTLINE_WATCH_LIMITS.perSocket);

		const wide = socket(reader);
		const keys = Array.from(
			{ length: OUTLINE_WATCH_LIMITS.keysPerSubscription / 2 + 1 },
			(_, i) => `k${i}`,
		);
		await watch(wide, "s1", space.id, { levels: keys, subtrees: keys.map((key) => `t${key}`) });
		expect(wide.frames).toEqual([
			{ type: "outline_watch_error", subscriptionId: "s1", code: "unavailable" },
		]);
	});

	test("a frame that would name too many keys says all instead", async () => {
		const made = await commit(space, [{ op: "insert", parent: null, content: "Wide page" }]);
		const wide = made.results[0]?.blockId as string;
		const count = OUTLINE_WATCH_LIMITS.keysPerFrame + 10;
		const ids: string[] = [];
		for (let from = 0; from < count; from += 200) {
			const batch = await commit(
				space,
				Array.from(
					{ length: Math.min(200, count - from) },
					(_, i): OutlineOp => ({ op: "insert", parent: { id: wide }, content: `w${from + i}` }),
				),
			);
			ids.push(...batch.results.map((r) => r.blockId as string));
		}
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { subtrees: ids });
		// One commit that gives every child a version: the parent is deleted.
		const gone = await commit(space, [{ op: "delete", block: { id: wide } }]);
		await settle(() => changes(ws).length === 1);
		expect(changes(ws)[0]).toMatchObject({ all: true, levels: [], subtrees: [], seq: gone.seq });
	});

	test("a socket that fell behind is closed rather than left stale", async () => {
		const ws = socket(reader);
		await watch(ws, "s1", space.id, { subtrees: [space.id] });
		ws.buffered = OUTLINE_BLOCK_BACKPRESSURE_BYTES + 1;
		await commit(space, [{ op: "update", block: { id: x }, content: "X unsent" }]);
		await settle(() => ws.close.mock.calls.length === 1);
		expect(changes(ws)).toEqual([]);
		expect(outlineBlockSubscriptionStats().total).toBe(0);
	});
});
