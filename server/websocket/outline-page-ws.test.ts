/**
 * Read-only outline page subscriptions: authorized like the HTTP reads, notifications carry ids
 * only and are coalesced, limits hold, and losing access (or the switch) ends the subscription.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OutlinePageServerMessage } from "@shared/outline-page-events";
import { OUTLINE_PAGE_SUBSCRIPTION_LIMITS } from "@shared/outline-page-events";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { aclGrants, projects, users } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import { ensurePersonalSpace, ensureProjectSpace } from "../services/outline/spaces";
import type { OutlineSpaceRow } from "../services/outline/store/port";
import { writeOutline } from "../services/outline/write";
import {
	handleOutlinePageMessage,
	OUTLINE_PAGE_BACKPRESSURE_BYTES,
	OUTLINE_PAGE_COALESCE_MS,
	type OutlinePageSocket,
	outlinePageSubscriptionStats,
	releaseOutlinePageSubscriptions,
} from "./outline-page-ws";

const NOW = "2026-10-26T00:00:00.000Z";

interface FakeSocket extends OutlinePageSocket {
	frames: OutlinePageServerMessage[];
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
const quiet = () => new Promise((resolve) => setTimeout(resolve, OUTLINE_PAGE_COALESCE_MS * 3));

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
let pageA: string;
let pageB: string;

async function edit(blockId: string, content: string) {
	const result = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "update", block: { id: blockId }, content }],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	return result.commit as { id: string; seq: number };
}

function subscribe(ws: FakeSocket, subscriptionId: string, pageId: string) {
	return handleOutlinePageMessage(ws, { type: "outline_page_subscribe", subscriptionId, pageId });
}

// The preload restores settings after every test.
beforeEach(() => {
	settings.outline.enabled = true;
});

afterEach(() => {
	for (const ws of sockets.splice(0)) releaseOutlinePageSubscriptions(ws);
});

beforeAll(async () => {
	owner = await user("owner");
	reader = await user("reader");
	stranger = await user("stranger");
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Subscribed project",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
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
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "a", parent: null, content: "Page A" },
			{ op: "insert", tempId: "b", parent: null, content: "Page B" },
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	[pageA, pageB] = written.results.map((r) => r.blockId) as [string, string];
});

describe("subscribing", () => {
	test("a reader is told the current seq, then one coalesced frame per burst of commits", async () => {
		const ws = socket(reader);
		await subscribe(ws, "s1", pageA);
		const current = (await db.query.outlineSpaces.findFirst({
			where: (s, { eq }) => eq(s.id, space.id),
		})) as { nextSeq: number };
		expect(ws.frames).toEqual([
			{
				type: "outline_page_subscribed",
				subscriptionId: "s1",
				pageId: pageA,
				seq: current.nextSeq - 1,
			},
		]);
		const commits = [
			await edit(pageA, "A1"),
			await edit(pageA, "A2"),
			await edit(pageA, "A3 body"),
		];
		await edit(pageB, "B1");
		await settle(() => ws.frames.length === 2);
		await quiet();
		expect(ws.frames).toHaveLength(2);
		expect(ws.frames[1]).toEqual({
			type: "outline_page_changed",
			subscriptionId: "s1",
			pageId: pageA,
			seq: commits[2]?.seq as number,
			commitIds: commits.map((c) => c.id),
		});
		// Ids and seqs only: no content travels (the space keeps it from matching a random id).
		expect(JSON.stringify(ws.frames)).not.toContain("A3 body");
	});

	test("a page that does not exist and a page one may not read answer alike", async () => {
		const ws = socket(stranger);
		await subscribe(ws, "missing", "no-such-page");
		await subscribe(ws, "private", pageA);
		expect(ws.frames).toEqual([
			{ type: "outline_page_error", subscriptionId: "missing", code: "access_denied" },
			{ type: "outline_page_error", subscriptionId: "private", code: "access_denied" },
		]);
		const anonymous = socket(undefined);
		await subscribe(anonymous, "anon", pageA);
		expect(anonymous.frames).toEqual([
			{ type: "outline_page_error", subscriptionId: "anon", code: "unavailable" },
		]);
		expect(outlinePageSubscriptionStats().total).toBe(0);
	});

	test("a block that is not a page cannot be subscribed to", async () => {
		const personal = await ensurePersonalSpace(owner);
		const written = await writeOutline({
			spaceId: personal.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "Mine" },
				{ op: "insert", parent: { tempId: "p" }, content: "Child" },
			],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const ws = socket(owner);
		await subscribe(ws, "child", written.results[1]?.blockId as string);
		expect(ws.frames[0]).toMatchObject({ type: "outline_page_error", code: "access_denied" });
	});

	test("per-socket limit, unsubscribe and release", async () => {
		const ws = socket(owner);
		for (let i = 0; i < OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket; i++) {
			await subscribe(ws, `s${i}`, pageA);
		}
		await subscribe(ws, "one-too-many", pageA);
		expect(ws.frames.at(-1)).toEqual({
			type: "outline_page_error",
			subscriptionId: "one-too-many",
			code: "unavailable",
		});
		expect(outlinePageSubscriptionStats().total).toBe(OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket);
		// Re-subscribing under the same id replaces, it does not add.
		await subscribe(ws, "s0", pageB);
		expect(outlinePageSubscriptionStats().total).toBe(OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket);

		await handleOutlinePageMessage(ws, { type: "outline_page_unsubscribe", subscriptionId: "s1" });
		expect(outlinePageSubscriptionStats().total).toBe(
			OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket - 1,
		);
		releaseOutlinePageSubscriptions(ws);
		expect(outlinePageSubscriptionStats()).toEqual({ sockets: 0, pages: 0, total: 0 });
		const before = ws.frames.length;
		await edit(pageA, "after release");
		await quiet();
		expect(ws.frames).toHaveLength(before);
	});
});

describe("losing access", () => {
	test("a reader whose grant is removed is told access_denied and hears nothing more", async () => {
		const ws = socket(reader);
		const owners = socket(owner);
		await subscribe(ws, "r", pageA);
		await subscribe(owners, "o", pageA);
		expect(ws.frames[0]?.type).toBe("outline_page_subscribed");

		await db
			.delete(aclGrants)
			.where(and(eq(aclGrants.scopeId, projectId), eq(aclGrants.principalId, reader)));
		eventBus.emit({ type: "project:access_changed", projectId, reason: "members_changed" });
		await settle(() => ws.frames.length === 2);
		expect(ws.frames[1]).toEqual({
			type: "outline_page_error",
			subscriptionId: "r",
			code: "access_denied",
		});
		await edit(pageA, "after revocation");
		await settle(() => owners.frames.length === 2);
		await quiet();
		expect(ws.frames).toHaveLength(2);
		expect(owners.frames[1]?.type).toBe("outline_page_changed");
	});

	test("switching the outline off ends subscriptions; subscribing is refused", async () => {
		const ws = socket(owner);
		await subscribe(ws, "o", pageA);
		settings.outline.enabled = false;
		await edit(pageA, "while switched off");
		await settle(() => ws.frames.length === 2);
		expect(ws.frames[1]).toEqual({
			type: "outline_page_error",
			subscriptionId: "o",
			code: "unavailable",
		});
		await subscribe(ws, "again", pageA);
		expect(ws.frames[2]).toEqual({
			type: "outline_page_error",
			subscriptionId: "again",
			code: "unavailable",
		});
		expect(outlinePageSubscriptionStats().total).toBe(0);
	});

	test("a socket that falls behind is closed instead of missing a change", async () => {
		const ws = socket(owner);
		await subscribe(ws, "o", pageA);
		ws.buffered = OUTLINE_PAGE_BACKPRESSURE_BYTES + 1;
		await edit(pageA, "backpressure");
		await settle(() => ws.close.mock.calls.length === 1);
		expect(ws.close).toHaveBeenCalledWith(1013, "Outline backpressure; reconnect");
		expect(outlinePageSubscriptionStats().total).toBe(0);
	});
});
