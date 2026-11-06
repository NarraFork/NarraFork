/**
 * Reports end to end (汇报, outline P2 PR 11): the acceptance on SQLite, through the production
 * write path, the background job (driven slice by slice with an injected clock), the report API
 * and `/api/outline/resolve`.
 *
 * What must hold:
 *   - one day of commits makes exactly one report per person per day, each person's day cut in
 *     their own time zone (two people, two zones), around a change of daylight saving time, and
 *     across a person changing their zone: consecutive reports meet exactly (no overlap, no gap);
 *   - running the job again adds nothing; missed days are made up, at most three;
 *   - every item of a report points back to something that resolves, for that person;
 *   - what is shown follows today's read access (items and counts go when access goes);
 *   - a slice that runs out of budget stops and the next one carries on; a capped window is
 *     summarized in part and says so;
 *   - unread reports join the inbox's digest row (counted), until read.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own people and
 * spaces, and the job's memory is reset before each.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { OutlineResolveResponse } from "@shared/outline-api";
import type {
	OutlineDigestDetailResponse,
	OutlineDigestLink,
	OutlineDigestListResponse,
	OutlineDigestNowResponse,
	OutlineDigestStored,
} from "@shared/outline-digest";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../db";
import {
	aclGrants,
	narrators,
	outlineSpaces,
	projects,
	userPreferences,
	users,
} from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { logger } from "../../../lib/logger";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import { OUTLINE_DIGEST_LIMITS } from "../digest";
import {
	OUTLINE_DIGEST_JOB,
	outlineDigestBatchSizesForTests,
	requestOutlineDigestPreview,
	resetOutlineDigestJobForTests,
	runOutlineDigestSlice,
	startOutlineDigestSweepForTests,
} from "../digest-job";
import { listOutlineAttention } from "../inbox";
import type { OutlineAskJson } from "../model";
import { confirmOutlinePending, lockOutlineTask } from "../pending";
import { decideOutlinePlan, ensurePlanRoot, OUTLINE_PLAN_REVIEW_ACTOR } from "../plans";
import { revertCommit } from "../revert";
import { outlineStore } from "../store";
import type { OutlineDigestRow } from "../store/digest-port";
import type { OutlineSpaceRow } from "../store/port";
import { type OutlineOp, writeOutline } from "../write";

const SETUP = "2026-11-01T00:00:00.000Z";
const store = outlineStore;

function appAs(userId: string, role: "user" | "admin" = "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/outline", outlineRoutes);
	return app;
}

async function call<T>(
	userId: string,
	path: string,
	init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: T }> {
	const response = await appAs(userId).request(`http://localhost/outline${path}`, {
		method: init?.method ?? "GET",
		...(init?.body !== undefined
			? { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }
			: {}),
	});
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: body as T };
}

async function person(
	label: string,
	prefs?: { timeZone?: string | null; time?: string | null },
	id = generateId(),
) {
	const username = `${label}-${id.slice(0, 6)}`;
	await db
		.insert(users)
		.values({ id, username, passwordHash: "x", role: "user", createdAt: SETUP });
	if (prefs) {
		await db.insert(userPreferences).values({
			id: generateId(),
			userId: id,
			createdAt: SETUP,
			updatedAt: SETUP,
			outlineDigestTimeZone: prefs.timeZone ?? null,
			outlineDigestTime: prefs.time ?? null,
		});
	}
	return { id, username };
}

async function setZone(userId: string, timeZone: string) {
	await db
		.update(userPreferences)
		.set({ outlineDigestTimeZone: timeZone })
		.where(eq(userPreferences.userId, userId));
}

async function project(ownerUserId: string, visibility: "private" | "public" = "private") {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `Reports ${id.slice(0, 5)}`,
		ownerUserId,
		visibility,
		createdAt: SETUP,
		updatedAt: SETUP,
	});
	return {
		id,
		space: await store.ensureSpace({ kind: "project", projectId: id }, SETUP),
	};
}

async function grant(projectId: string, userId: string, capability: "read" | "write") {
	const id = generateId();
	await db.insert(aclGrants).values({
		id,
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: SETUP,
	});
	return id;
}

async function narrator(ownerUserId: string | null) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: `Session ${id.slice(0, 5)}`,
		ownerUserId,
		createdAt: SETUP,
		updatedAt: SETUP,
	});
	return id;
}

type Actor = { kind: "human" | "agent" | "system"; id: string };

async function write(
	space: OutlineSpaceRow,
	actor: Actor,
	responsibleUserId: string | null,
	at: string,
	ops: OutlineOp[],
	extra: Partial<Parameters<typeof writeOutline>[1]> = {},
) {
	return await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor,
			responsibleUserId,
			narratorId: actor.kind === "agent" ? actor.id : null,
		},
		{ store, now: () => new Date(at), ...extra },
	);
}

/** Run the job's slices at `now` until there is nothing left; how many rows were written. */
async function runJob(now: string, options: Parameters<typeof runOutlineDigestSlice>[0] = {}) {
	startOutlineDigestSweepForTests();
	let written = 0;
	for (let i = 0; i < 200; i++) {
		const slice = await runOutlineDigestSlice({
			store,
			now: () => new Date(now),
			serverTimeZone: "UTC",
			...options,
		});
		written += slice.written;
		if (!slice.more) return written;
	}
	throw new Error("the job did not settle");
}

async function dailies(userId: string): Promise<OutlineDigestRow[]> {
	const heads = await store.listDigestHeads(userId, { kind: "daily", limit: 50 });
	const rows: OutlineDigestRow[] = [];
	for (const head of heads) rows.push((await store.getDigest(head.id)) as OutlineDigestRow);
	return rows.sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));
}

async function detail(userId: string, id: string) {
	const res = await call<OutlineDigestDetailResponse>(userId, `/digests/${id}`);
	expect(res.status).toBe(200);
	return res.body;
}

/** Every link of a report's items, each with what it must resolve to. */
function linksOf(d: OutlineDigestDetailResponse): OutlineDigestLink[] {
	return [
		...d.delegated.map((i) => i.link),
		...d.knowledge.flatMap((i) => [i.link, ...i.blocks.map((b) => b.link)]),
		...d.tasks.map((i) => i.link),
		...d.plans.map((i) => i.link),
		...d.questions.map((i) => i.link),
		...d.other.map((i) => i.link),
	];
}

async function expectLinksResolve(userId: string, d: OutlineDigestDetailResponse) {
	const links = linksOf(d);
	expect(links.length).toBeGreaterThan(0);
	for (const link of links) {
		expect(link.seq).not.toBeNull();
		const byCommit = await call<OutlineResolveResponse>(
			userId,
			`/resolve?space=${encodeURIComponent(link.spaceKey)}&commit=${link.seq}`,
		);
		expect(byCommit.status).toBe(200);
		expect(byCommit.body.spaceId).toBe(link.spaceId);
		if (link.blockId) {
			expect(link.address).not.toBeNull();
			const byBlock = await call<OutlineResolveResponse>(
				userId,
				`/resolve?ref=${encodeURIComponent(link.address as string)}`,
			);
			expect(byBlock.status).toBe(200);
			expect(byBlock.body.blockId).toBe(link.blockId);
			expect(byBlock.body.spaceId).toBe(link.spaceId);
		}
	}
}

function ask(to: string): OutlineAskJson {
	return {
		to: { kind: "human", id: to },
		options: ["Keep the old format", "Switch to v2"],
		recommend: { option: 2, reason: "v2 is what the importer reads" },
	};
}

beforeEach(() => {
	settings.outline.enabled = true;
	resetOutlineDigestJobForTests();
});

describe("reports: the acceptance", () => {
	test("a day of commits: one report per person in their own zone, every item links back, idempotent", async () => {
		const alice = await person("alice", { timeZone: "Asia/Shanghai" });
		const bob = await person("bob", { timeZone: "America/New_York", time: "06:30" });
		const dave = await person("dave");
		const agent = await narrator(alice.id);
		const delegate = await narrator(alice.id);
		const session = await narrator(alice.id);
		const p = await project(alice.id);
		const bobGrant = await grant(p.id, bob.id, "write");
		const pub = await project(dave.id, "public");
		const sessionSpace = await store.ensureSpace({ kind: "session", narratorId: session }, SETUP);

		// Before alice's day (Shanghai 11-04), inside bob's (New York 11-04).
		const made = await write(
			p.space,
			{ kind: "human", id: alice.id },
			alice.id,
			"2026-11-04T10:00:00.000Z",
			[
				{ op: "insert", tempId: "page", parent: null, content: "Importer" },
				{ op: "insert", tempId: "formats", parent: { tempId: "page" }, content: "Formats we read" },
				{
					op: "insert",
					tempId: "task",
					parent: { tempId: "page" },
					content: "Ship the importer",
					task: { status: "todo" },
				},
				{
					op: "insert",
					tempId: "locked",
					parent: { tempId: "page" },
					content: "Migrate the rows",
					task: { status: "todo" },
				},
				{
					op: "insert",
					tempId: "step",
					parent: { tempId: "locked" },
					content: "Copy",
					task: { status: "todo" },
				},
			],
		);
		const [page, formats, task, locked, step] = made.results.map((r) => r.blockId) as string[];
		const A = { kind: "agent" as const, id: agent };
		// Alice's day 11-05 in Shanghai: [11-04T16:00Z, 11-05T16:00Z).
		await write(p.space, A, alice.id, "2026-11-05T01:00:00.000Z", [
			{ op: "insert", parent: { id: page as string }, content: "The parser handles a BOM" },
		]);
		const rewrite = await write(
			p.space,
			{ kind: "human", id: bob.id },
			bob.id,
			"2026-11-05T02:00:00.000Z",
			[{ op: "update", block: { id: formats as string }, content: "Formats we read: CSV and TSV" }],
		);
		const scratch = await write(p.space, A, alice.id, "2026-11-05T03:00:00.000Z", [
			{ op: "insert", parent: { id: page as string }, content: "Scratch that goes away" },
		]);
		await write(p.space, A, alice.id, "2026-11-05T03:30:00.000Z", [
			{ op: "delete", block: { id: scratch.results[0]?.blockId as string } },
		]);
		await write(p.space, A, alice.id, "2026-11-05T04:00:00.000Z", [
			{ op: "setTask", block: { id: task as string }, task: { status: "doing" } },
		]);
		await write(p.space, A, alice.id, "2026-11-05T04:10:00.000Z", [
			{ op: "setTask", block: { id: task as string }, task: { status: "done" } },
		]);
		// Bob's day 11-05 in New York starts at 05:00Z.
		await write(p.space, { kind: "human", id: alice.id }, alice.id, "2026-11-05T06:00:00.000Z", [
			{ op: "insert", parent: { id: page as string }, content: "A note alice wrote herself" },
		]);
		const asked = await write(
			p.space,
			A,
			alice.id,
			"2026-11-05T07:00:00.000Z",
			[
				{
					op: "insert",
					parent: { id: task as string },
					content: "Which format?",
					ask: ask(alice.id),
				},
			],
			{ question: { askerNarratorId: agent, askerUserId: alice.id, askerToolCallId: "call-1" } },
		);
		const question = asked.results[0]?.blockId as string;
		const relay = await write(
			p.space,
			A,
			alice.id,
			"2026-11-05T08:00:00.000Z",
			[
				{
					op: "update",
					block: { id: question },
					ask: {
						...ask(alice.id),
						answer: {
							option: 2,
							adopted: true,
							by: { kind: "human", id: alice.id },
							at: "2026-11-05T08:00:00.000Z",
							relayed: { narratorId: agent, messageId: null },
						},
					},
				},
			],
			{
				kind: "answer",
				question: {
					askerNarratorId: null,
					askerUserId: null,
					askerToolCallId: null,
					delivered: true,
				},
			},
		);
		// Bob takes his rewrite back: the fact is as it was before the day.
		await revertCommit(
			{
				commitId: rewrite.commit?.id as string,
				actor: { kind: "human", id: bob.id },
				responsibleUserId: bob.id,
			},
			{ store, now: () => new Date("2026-11-05T09:00:00.000Z") },
		);
		// A plan in alice's session: planned, then approved by the plan review in her name.
		const planned = await ensurePlanRoot({
			session,
			userId: alice.id,
			title: "Plan the importer",
			locale: "en",
			store,
			now: () => new Date("2026-11-05T10:00:00.000Z"),
		});
		const approval = await decideOutlinePlan({
			session,
			rootId: planned.root.blockId,
			round: 1,
			action: "draft",
			decider: {
				kind: "system",
				id: OUTLINE_PLAN_REVIEW_ACTOR,
				responsibleUserId: alice.id,
				approvedBy: { kind: "system", id: OUTLINE_PLAN_REVIEW_ACTOR },
			},
			locale: "en",
			store,
			now: () => new Date("2026-11-05T11:00:00.000Z"),
		});
		// A confirmation the delegate session made in alice's name.
		await lockOutlineTask({
			blockId: locked as string,
			userId: alice.id,
			delegate,
			store,
			now: () => new Date("2026-11-05T12:00:00.000Z"),
		});
		const proposed = await write(p.space, A, alice.id, "2026-11-05T12:10:00.000Z", [
			{ op: "update", block: { id: step as string }, content: "Copy the rows" },
		]);
		const confirmedPending = await confirmOutlinePending({
			pendingId: proposed.pending?.id as string,
			by: { kind: "agent", narratorId: delegate, responsibleUserId: alice.id },
			store,
			now: () => new Date("2026-11-05T12:20:00.000Z"),
		});
		expect(confirmedPending).toBeTruthy();
		const confirmedCommit = (await store.getPending([proposed.pending?.id as string]))[0]
			?.decisionCommitId;
		// Alice wrote once in someone else's public project: that space concerns her, not bob.
		await write(pub.space, { kind: "human", id: alice.id }, alice.id, "2026-11-05T13:00:00.000Z", [
			{ op: "insert", parent: null, content: "A page alice made in a public project" },
		]);
		// After alice's day, inside bob's.
		await write(p.space, A, alice.id, "2026-11-05T17:00:00.000Z", [
			{
				op: "insert",
				parent: { id: page as string },
				content: "Written after Shanghai's midnight",
			},
		]);

		// 11-05T23:30Z: 07:30 on 11-06 in Shanghai (alice's 11-05 is due); 18:30 on 11-05 in New
		// York (bob's 11-04 is due). Nobody had a report: three days each, oldest first.
		expect(await runJob("2026-11-05T23:30:00.000Z")).toBeGreaterThanOrEqual(6);
		const aliceDays = await dailies(alice.id);
		expect(aliceDays.map((d) => d.periodKey)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
		const bobDays = await dailies(bob.id);
		expect(bobDays.map((d) => d.periodKey)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
		const aliceDay = aliceDays[2] as OutlineDigestRow;
		expect([aliceDay.periodStart, aliceDay.periodEnd, aliceDay.timeZone]).toEqual([
			"2026-11-04T16:00:00.000Z",
			"2026-11-05T16:00:00.000Z",
			"Asia/Shanghai",
		]);
		// Consecutive days meet exactly, also in seqs.
		for (const days of [aliceDays, bobDays])
			for (let i = 1; i < days.length; i++)
				expect(days[i]?.periodStart).toBe(days[i - 1]?.periodEnd as string);
		// Alice's 11-04 holds only what she wrote herself: counted, nothing to read.
		expect(aliceDays[1]?.itemCount).toBe(0);
		expect(aliceDays[1]?.seenAt).not.toBeNull();
		expect(aliceDays[1]?.counts.ownEdits).toBeGreaterThan(0);

		// Running again changes nothing.
		expect(await runJob("2026-11-05T23:30:00.000Z")).toBe(0);
		expect((await dailies(alice.id)).length).toBe(3);

		const a = await detail(alice.id, aliceDay.id);
		// Knowledge: the new fact; not the rewrite bob took back, not the scratch block made and
		// deleted the same day, not what alice wrote herself (counted), not the next day's.
		expect(a.knowledge.map((k) => [k.title, k.created, k.changed])).toEqual([["Importer", 1, 0]]);
		expect(a.knowledge[0]?.blocks.map((b) => b.title)).toEqual(["The parser handles a BOM"]);
		expect(a.digest.counts.ownEdits).toBe(2);
		expect(a.spaces.map((s) => s.id).sort()).toEqual(
			[p.space.id, sessionSpace.id, pub.space.id].sort(),
		);
		// Tasks: done by an agent, a task alice manages: newly done for her.
		expect(
			a.tasks.map((t) => [t.title, t.event, t.forYou, t.newlyDoneForYou, t.executor?.id]),
		).toEqual([["Ship the importer", "done", true, true, agent]]);
		// Plans: planned, then approved as a draft by the plan review.
		expect(a.plans.map((x) => [x.event, x.round, x.approvedBy?.id ?? null])).toEqual([
			["planning", 0, null],
			["approved_draft", 1, OUTLINE_PLAN_REVIEW_ACTOR],
		]);
		// Questions: asked of alice, answered (relayed, the recommendation taken).
		expect(a.questions.map((q) => [q.title, q.event, q.toYou, q.relayed, q.adopted])).toEqual([
			["Which format?", "asked", true, false, false],
			["Which format?", "answered", true, true, true],
		]);
		// In her name: the three kinds, each standing and undoable.
		expect(a.delegated.map((d) => [d.kind, d.stands, d.canUndo]).sort()).toEqual([
			["confirmation", true, true],
			["plan_review_approval", true, true],
			["relayed_answer", true, true],
		]);
		expect(a.delegated.find((d) => d.kind === "relayed_answer")?.link.commitId).toBe(
			relay.commit?.id as string,
		);
		expect(a.delegated.find((d) => d.kind === "plan_review_approval")?.link.commitId).toBe(
			approval.result?.commit?.id as string,
		);
		// Other: bob's revert.
		expect(a.other.map((o) => [o.event, o.actor.id])).toEqual([["revert", bob.id]]);
		// The people and sessions the items name: usernames, and her own session's title.
		expect(a.names.users[bob.id]).toBe(bob.username);
		expect(a.names.users[alice.id]).toBe(alice.username);
		expect(a.names.sessions[agent]).toBe(`Session ${agent.slice(0, 5)}`);
		await expectLinksResolve(alice.id, a);
		// Nothing of the next day, nothing of text in the stored items.
		const stored = JSON.stringify(aliceDay.items);
		for (const text of ["Shanghai's midnight", "BOM", "Formats we read", "Which format"])
			expect(stored).not.toContain(text);

		// Bob's 11-04 (New York): the page and its facts as alice made them (the tasks are not
		// facts) and the BOM fact; the scratch block is not; the fact he rewrote is listed, alice
		// having written it too.
		const b4 = await detail(bob.id, (bobDays[2] as OutlineDigestRow).id);
		expect(b4.knowledge.map((k) => [k.title, k.created, k.changed])).toEqual([["Importer", 3, 0]]);
		expect(b4.knowledge[0]?.blocks.map((b) => b.title)).toEqual(["Importer"]);
		expect(b4.digest.counts.ownEdits).toBe(0);
		expect(b4.tasks.map((t) => [t.event, t.forYou, t.newlyDoneForYou])).toEqual([
			["done", false, false],
		]);
		// Alice's session did it; bob may not read it, so it stays unnamed for him.
		expect(b4.tasks[0]?.executor?.id).toBe(agent);
		expect(b4.names.sessions).toEqual({});
		await expectLinksResolve(bob.id, b4);

		// 11-06T12:00Z: 07:00 in New York, bob's 11-05 is due (and dave's in UTC); alice has
		// nothing new.
		expect(await runJob("2026-11-06T12:00:00.000Z")).toBe(2);
		expect((await dailies(alice.id)).length).toBe(3);
		expect((await dailies(dave.id)).map((d) => d.periodKey)).toEqual([
			"2026-11-02",
			"2026-11-03",
			"2026-11-04",
			"2026-11-05",
		]);
		const bobAll = await dailies(bob.id);
		expect(bobAll.map((d) => d.periodKey)).toEqual([
			"2026-11-02",
			"2026-11-03",
			"2026-11-04",
			"2026-11-05",
		]);
		const b5row = bobAll[3] as OutlineDigestRow;
		const b4row = bobAll[2] as OutlineDigestRow;
		expect(b5row.periodStart).toBe(b4row.periodEnd);
		expect(b5row.ranges[p.space.id]?.[0]).toBe(b4row.ranges[p.space.id]?.[1] as number);
		const b5 = await detail(bob.id, b5row.id);
		// Bob is not concerned by alice's session nor by the public project he did nothing in.
		expect(b5.spaces.map((s) => s.id)).toEqual([p.space.id]);
		expect(b5.knowledge.flatMap((k) => k.blocks.map((b) => b.title)).sort()).toEqual([
			"A note alice wrote herself",
			"Written after Shanghai's midnight",
		]);
		expect(b5.delegated).toEqual([]);
		expect(b5.questions.map((q) => [q.event, q.toYou])).toEqual([
			["asked", false],
			["answered", false],
		]);
		await expectLinksResolve(bob.id, b5);

		// Reports are their person's own: anyone else gets 404.
		expect((await call(dave.id, `/digests/${aliceDay.id}`)).status).toBe(404);
		const list = await call<OutlineDigestListResponse>(alice.id, "/digests?limit=2");
		expect(list.body.digests.map((d) => d.periodKey)).toEqual(["2026-11-05", "2026-11-04"]);
		expect(list.body.nextCursor).toBe("2026-11-04");
		expect(JSON.stringify(list.body)).not.toContain('"items"');
		const older = await call<OutlineDigestListResponse>(alice.id, "/digests?before=2026-11-04");
		expect(older.body.digests.map((d) => d.periodKey)).toEqual(["2026-11-03"]);

		// Today so far (alice, 11:00 in Shanghai on 11-06): continues from 11-05 in every space.
		expect(
			requestOutlineDigestPreview(alice.id, {
				now: Date.parse("2026-11-06T03:00:00.000Z"),
				kick: false,
			}),
		).toEqual({
			queued: true,
		});
		expect(
			requestOutlineDigestPreview(alice.id, {
				now: Date.parse("2026-11-06T03:00:10.000Z"),
				kick: false,
			}),
		).toEqual({
			queued: true,
		});
		await runJob("2026-11-06T03:00:00.000Z");
		const [preview] = await store.listDigestHeads(alice.id, { kind: "today", limit: 5 });
		const previewRow = (await store.getDigest(preview?.id as string)) as OutlineDigestRow;
		expect(previewRow.periodKey).toBe("2026-11-06");
		// Asked for and looked at: never an unread report in the inbox.
		expect(previewRow.seenAt).not.toBeNull();
		expect(previewRow.periodStart).toBe(aliceDay.periodEnd);
		expect(previewRow.ranges[p.space.id]?.[0]).toBe(aliceDay.ranges[p.space.id]?.[1] as number);
		const pv = await detail(alice.id, previewRow.id);
		expect(pv.knowledge.flatMap((k) => k.blocks.map((b) => b.title))).toEqual([
			"Written after Shanghai's midnight",
		]);
		// Asked again within the minute: not queued, the current preview stands.
		expect(
			requestOutlineDigestPreview(alice.id, {
				now: Date.parse("2026-11-06T03:00:20.000Z"),
				kick: false,
			}),
		).toEqual({ queued: false, reason: "recent" });
		// Asked again later: the preview is made again under the same id, which a client may hold.
		await write(p.space, A, alice.id, "2026-11-06T03:01:00.000Z", [
			{ op: "insert", parent: { id: page as string }, content: "A minute later" },
		]);
		expect(
			requestOutlineDigestPreview(alice.id, {
				now: Date.parse("2026-11-06T03:02:00.000Z"),
				kick: false,
			}),
		).toEqual({ queued: true });
		await runJob("2026-11-06T03:02:00.000Z");
		const previews = await store.listDigestHeads(alice.id, { kind: "today", limit: 5 });
		expect(previews.map((x) => x.id)).toEqual([previewRow.id]);
		expect(
			(await detail(alice.id, previewRow.id)).knowledge.flatMap((k) =>
				k.blocks.map((b) => b.title),
			),
		).toEqual(["Written after Shanghai's midnight", "A minute later"]);

		// Bob loses the project: its items and counts go from his reports, titles included.
		await db.delete(aclGrants).where(eq(aclGrants.id, bobGrant));
		const gone = await detail(bob.id, b5row.id);
		expect(gone.spaces).toEqual([]);
		expect(gone.knowledge).toEqual([]);
		expect(gone.questions).toEqual([]);
		expect(gone.digest.itemCount).toBe(0);
		expect(b5row.counts.knowledge).toBeGreaterThan(0);
		expect(gone.digest.counts).toEqual({
			delegated: 0,
			knowledge: 0,
			tasks: 0,
			plans: 0,
			questions: 0,
			other: 0,
			spaces: 0,
			ownEdits: 0,
		});
		expect(JSON.stringify(gone)).not.toContain("alice wrote herself");

		// 11-06T23:30Z, 07:30 on 11-07 in Shanghai: alice's 11-06 replaces its preview.
		await runJob("2026-11-06T23:30:00.000Z");
		const day6 = (await dailies(alice.id)).find((d) => d.periodKey === "2026-11-06");
		expect(day6?.periodStart).toBe(aliceDay.periodEnd);
		expect(await store.listDigestHeads(alice.id, { kind: "today", limit: 5 })).toEqual([]);
		expect((await call(alice.id, `/digests/${previewRow.id}`)).status).toBe(404);
		expect(
			(await detail(alice.id, day6?.id as string)).knowledge.flatMap((k) =>
				k.blocks.map((b) => b.title),
			),
		).toEqual(["Written after Shanghai's midnight", "A minute later"]);

		// Undone in one click from the report (last: the API reverts at the real time): then it no
		// longer stands, and cannot be undone again.
		const undone = await call<{ kind: string }>(alice.id, "/digests/undo", {
			method: "POST",
			body: { commitId: relay.commit?.id as string },
		});
		expect([undone.status, undone.body.kind]).toEqual([200, "relayed_answer"]);
		const after = await detail(alice.id, aliceDay.id);
		expect(after.delegated.map((d) => [d.kind, d.stands, d.canUndo]).sort()).toEqual([
			["confirmation", true, true],
			["plan_review_approval", true, true],
			["relayed_answer", false, false],
		]);
		// Bob no longer reads the project: alice's confirmation is not his to see (404, not 403).
		expect(
			(
				await call(bob.id, "/digests/undo", {
					method: "POST",
					body: { commitId: confirmedCommit as string },
				})
			).status,
		).toBe(404);
	}, 120_000);

	test("unread reports join the inbox's digest row, counted until read", async () => {
		const erin = await person("erin", { timeZone: "UTC" });
		const p = await project(erin.id);
		const agent = await narrator(erin.id);
		await write(p.space, { kind: "agent", id: agent }, erin.id, "2026-11-10T09:00:00.000Z", [
			{ op: "insert", parent: null, content: "A fact for erin" },
		]);
		const principal = { userId: erin.id, isAdmin: false };
		expect((await listOutlineAttention(principal)).some((i) => i.kind === "outline_digest")).toBe(
			false,
		);
		// Somebody with nothing that day: their (empty) report changes no inbox.
		const quiet = await person("quiet", { timeZone: "UTC" });
		const jobEvents: Array<{ userIds?: string[] }> = [];
		const onJob = (event: { userIds?: string[] }) => jobEvents.push(event);
		eventBus.on("human_attention:changed", onJob);
		try {
			await runJob("2026-11-11T08:00:00.000Z");
		} finally {
			eventBus.off("human_attention:changed", onJob);
		}
		// The job tells only the people whose inbox changed.
		expect(jobEvents.length).toBeGreaterThan(0);
		expect(jobEvents.every((e) => Array.isArray(e.userIds))).toBe(true);
		const told = jobEvents.flatMap((e) => e.userIds ?? []);
		expect(told).toContain(erin.id);
		expect(told).not.toContain(quiet.id);
		const row = (await listOutlineAttention(principal)).find((i) => i.kind === "outline_digest");
		expect(row?.id).toBe("outline:d:digest");
		expect(row?.outline).toMatchObject({ what: "digest", count: 0, reports: 1, reportItems: 1 });
		const [report] = await store.listDigestHeads(erin.id, { kind: "daily", limit: 1 });
		expect(row?.outline?.reportIds).toEqual([report?.id as string]);
		// Read: the row goes (no confirmation waits either).
		const seen = await call<{ marked: number }>(erin.id, "/digests/seen", {
			method: "POST",
			body: { ids: [report?.id as string] },
		});
		expect(seen.body.marked).toBe(1);
		expect((await listOutlineAttention(principal)).some((i) => i.kind === "outline_digest")).toBe(
			false,
		);
		// Somebody else's ids mark nothing.
		const other = await person("other");
		expect(
			(
				await call<{ marked: number }>(other.id, "/digests/seen", {
					method: "POST",
					body: { ids: [report?.id as string] },
				})
			).body.marked,
		).toBe(0);
		// Two more unread days; "Got it" marks every unread one, and tells only erin's clients.
		for (const day of ["11", "12"])
			await write(p.space, { kind: "agent", id: agent }, erin.id, `2026-11-${day}T09:00:00.000Z`, [
				{ op: "insert", parent: null, content: `Fact of 11-${day}` },
			]);
		await runJob("2026-11-13T08:00:00.000Z");
		expect(
			(await listOutlineAttention(principal)).find((i) => i.kind === "outline_digest")?.outline
				?.reports,
		).toBe(2);
		const events: Array<{ userIds?: string[] }> = [];
		const listen = (event: { userIds?: string[] }) => events.push(event);
		eventBus.on("human_attention:changed", listen);
		try {
			const all = await call<{ marked: number }>(erin.id, "/digests/seen", {
				method: "POST",
				body: { all: true },
			});
			expect(all.body.marked).toBe(2);
		} finally {
			eventBus.off("human_attention:changed", listen);
		}
		expect(events.map((e) => e.userIds)).toEqual([[erin.id]]);
		expect((await listOutlineAttention(principal)).some((i) => i.kind === "outline_digest")).toBe(
			false,
		);
		expect(
			(await call(erin.id, "/digests/seen", { method: "POST", body: { all: false } })).status,
		).toBe(400);
	}, 60_000);
});

describe("reports: days in time zones", () => {
	test("a day of 25 hours when clocks go back, cut in the person's zone", async () => {
		const fay = await person("fay", { timeZone: "America/New_York", time: "05:00" });
		const p = await project(fay.id);
		const agent = await narrator(fay.id);
		const A = { kind: "agent" as const, id: agent };
		// 2026-11-01: daylight saving ends in New York at 06:00Z (02:00 EDT → 01:00 EST).
		await write(p.space, A, fay.id, "2026-11-01T05:30:00.000Z", [
			{ op: "insert", parent: null, content: "Before the clocks went back" },
		]);
		await write(p.space, A, fay.id, "2026-11-02T04:30:00.000Z", [
			{ op: "insert", parent: null, content: "23:30 on the long day" },
		]);
		await write(p.space, A, fay.id, "2026-11-02T05:30:00.000Z", [
			{ op: "insert", parent: null, content: "00:30 on the next day" },
		]);
		// 2026-11-03T10:30Z is 05:30 EST: 11-02 is due; three days, 10-31 to 11-02.
		await runJob("2026-11-03T10:30:00.000Z");
		const days = await dailies(fay.id);
		expect(days.map((d) => d.periodKey)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
		const long = days[1] as OutlineDigestRow;
		expect([long.periodStart, long.periodEnd]).toEqual([
			"2026-11-01T04:00:00.000Z",
			"2026-11-02T05:00:00.000Z",
		]);
		expect(Date.parse(long.periodEnd) - Date.parse(long.periodStart)).toBe(25 * 3_600_000);
		const titles = async (row: OutlineDigestRow) =>
			(await detail(fay.id, row.id)).knowledge.map((k) => k.title).sort();
		expect(await titles(long)).toEqual(["23:30 on the long day", "Before the clocks went back"]);
		expect(await titles(days[2] as OutlineDigestRow)).toEqual(["00:30 on the next day"]);
		expect(days[1]?.ranges[p.space.id]).toEqual([0, 2]);
		expect(days[2]?.ranges[p.space.id]).toEqual([2, 3]);
	}, 60_000);

	test("a person changing their zone: the next day starts where the last one ended", async () => {
		const gus = await person("gus", { timeZone: "UTC" });
		const p = await project(gus.id);
		const agent = await narrator(gus.id);
		const A = { kind: "agent" as const, id: agent };
		const fact = (at: string, content: string) =>
			write(p.space, A, gus.id, at, [{ op: "insert", parent: null, content }]);
		await fact("2026-11-12T10:00:00.000Z", "UTC day 11-12");
		await runJob("2026-11-13T08:00:00.000Z");
		const before = await dailies(gus.id);
		expect(before.at(-1)?.periodKey).toBe("2026-11-12");
		// East to Tokyo (+9): Tokyo's 11-13 starts at 11-12T15:00Z, inside the UTC day already
		// reported; nothing of it comes twice.
		await setZone(gus.id, "Asia/Tokyo");
		await fact("2026-11-13T02:00:00.000Z", "Tokyo day 11-13");
		await runJob("2026-11-14T00:00:00.000Z");
		let days = await dailies(gus.id);
		const tokyo = days.at(-1) as OutlineDigestRow;
		const utc = days.at(-2) as OutlineDigestRow;
		expect(tokyo.periodKey).toBe("2026-11-13");
		expect(tokyo.timeZone).toBe("Asia/Tokyo");
		expect(tokyo.periodStart).toBe(utc.periodEnd);
		expect(tokyo.periodEnd).toBe("2026-11-13T15:00:00.000Z");
		expect(tokyo.ranges[p.space.id]?.[0]).toBe(utc.ranges[p.space.id]?.[1] as number);
		expect((await detail(gus.id, tokyo.id)).knowledge.map((k) => k.title)).toEqual([
			"Tokyo day 11-13",
		]);
		// West to Los Angeles (-8): its 11-13 is reported already (Tokyo's); its 11-14 starts at
		// Tokyo's end (11-13T15:00Z), not at LA's midnight (11-14T08:00Z): no gap.
		await setZone(gus.id, "America/Los_Angeles");
		await fact("2026-11-13T20:00:00.000Z", "Between the two midnights");
		await fact("2026-11-14T12:00:00.000Z", "LA day 11-14");
		await runJob("2026-11-15T16:00:00.000Z");
		days = await dailies(gus.id);
		const la = days.at(-1) as OutlineDigestRow;
		expect(la.periodKey).toBe("2026-11-14");
		expect(la.periodStart).toBe(tokyo.periodEnd);
		expect(la.periodEnd).toBe("2026-11-15T08:00:00.000Z");
		expect((await detail(gus.id, la.id)).knowledge.map((k) => k.title).sort()).toEqual([
			"Between the two midnights",
			"LA day 11-14",
		]);
		expect(days.map((d) => d.periodKey).filter((k) => k === "2026-11-13")).toHaveLength(1);
		// Every fact in exactly one report.
		const seen: string[] = [];
		for (const day of days)
			seen.push(...(await detail(gus.id, day.id)).knowledge.map((k) => k.title as string));
		expect(seen.sort()).toEqual(
			["Between the two midnights", "LA day 11-14", "Tokyo day 11-13", "UTC day 11-12"].sort(),
		);
	}, 60_000);

	test("a day that does not concern the person leaves the next day's window where it was", async () => {
		const lea = await person("lea", { timeZone: "UTC" });
		const owner = await person("owner");
		const pub = await project(owner.id, "public");
		const H = (id: string) => ({ kind: "human" as const, id });
		// Lea acts in someone else's public project on 11-28 and 11-30; only the owner on 11-29.
		await write(pub.space, H(lea.id), lea.id, "2026-11-28T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "lea 11-28" },
		]);
		await write(pub.space, H(owner.id), owner.id, "2026-11-29T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "owner 11-29" },
		]);
		await write(pub.space, H(lea.id), lea.id, "2026-11-30T09:00:00.000Z", [
			{ op: "insert", parent: null, content: "lea 11-30" },
		]);
		await write(pub.space, H(owner.id), owner.id, "2026-11-30T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "owner 11-30" },
		]);
		// One batch makes all three days.
		await runJob("2026-12-01T08:00:00.000Z");
		const days = await dailies(lea.id);
		expect(days.map((d) => d.periodKey)).toEqual(["2026-11-28", "2026-11-29", "2026-11-30"]);
		expect(days.map((d): [number, number] | null => d.ranges[pub.space.id] ?? null)).toEqual([
			[0, 1],
			null,
			[2, 4],
		]);
		const last = await detail(lea.id, (days[2] as OutlineDigestRow).id);
		expect(last.knowledge.map((k) => k.title)).toEqual(["owner 11-30"]);
		expect(last.digest.counts.ownEdits).toBe(1);
	}, 60_000);

	test("missed days: at most three made up, oldest first; earlier ones are not", async () => {
		const hal = await person("hal", { timeZone: "UTC" });
		const p = await project(hal.id);
		const agent = await narrator(hal.id);
		const A = { kind: "agent" as const, id: agent };
		await write(p.space, A, hal.id, "2026-11-16T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "11-16" },
		]);
		await runJob("2026-11-17T08:00:00.000Z");
		expect((await dailies(hal.id)).at(-1)?.periodKey).toBe("2026-11-16");
		for (const day of ["17", "18", "19", "20", "21"])
			await write(p.space, A, hal.id, `2026-11-${day}T10:00:00.000Z`, [
				{ op: "insert", parent: null, content: `11-${day}` },
			]);
		// Down until 11-22 08:00: 11-17 … 11-21 missed; only 11-19, 11-20, 11-21 are made.
		await runJob("2026-11-22T08:00:00.000Z");
		const days = await dailies(hal.id);
		expect(days.map((d) => d.periodKey).slice(-4)).toEqual([
			"2026-11-16",
			"2026-11-19",
			"2026-11-20",
			"2026-11-21",
		]);
		const first = days.at(-3) as OutlineDigestRow;
		expect(first.periodStart).toBe("2026-11-19T00:00:00.000Z");
		expect((await detail(hal.id, first.id)).knowledge.map((k) => k.title)).toEqual(["11-19"]);
		expect(await runJob("2026-11-22T08:00:00.000Z")).toBe(0);
	}, 60_000);
});

describe("reports: delegation (outline P2 PR 9)", () => {
	test("a task handed to a subagent, its report, and its completion for the person who made it", async () => {
		const mia = await person("mia", { timeZone: "UTC" });
		const root = await narrator(mia.id);
		const sub = await narrator(mia.id);
		const p = await project(mia.id);
		const made = await write(
			p.space,
			{ kind: "human", id: mia.id },
			mia.id,
			"2026-12-02T08:00:00.000Z",
			[
				{ op: "insert", tempId: "page", parent: null, content: "Release" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "page" },
					content: "Tag the release",
					task: { status: "todo" },
				},
			],
		);
		const taskId = made.results[1]?.blockId as string;
		// The delegation: the system, for the root, sets it in progress.
		await writeOutline(
			{
				spaceId: p.space.id,
				ops: [{ op: "setTask", block: { id: taskId }, task: { status: "doing" } }],
				actor: { kind: "system", id: "outline-delegate" },
				responsibleUserId: mia.id,
				narratorId: root,
				toolCallId: "agent-call",
			},
			{ store, now: () => new Date("2026-12-02T09:00:00.000Z") },
		);
		// The subagent's report: a block under the task, the task as it was.
		await writeOutline(
			{
				spaceId: p.space.id,
				ops: [
					{ op: "insert", tempId: "r", parent: { id: taskId }, content: "Report" },
					{ op: "insert", parent: { tempId: "r" }, content: "Tagged v1.2" },
				],
				actor: { kind: "system", id: "outline-report" },
				responsibleUserId: mia.id,
				narratorId: sub,
				toolCallId: "agent-call",
			},
			{ store, now: () => new Date("2026-12-02T10:00:00.000Z") },
		);
		// The root ticks it off.
		await write(p.space, { kind: "agent", id: root }, mia.id, "2026-12-02T11:00:00.000Z", [
			{ op: "setTask", block: { id: taskId }, task: { status: "done" } },
		]);
		await runJob("2026-12-03T08:00:00.000Z");
		const day = (await dailies(mia.id)).find(
			(d) => d.periodKey === "2026-12-02",
		) as OutlineDigestRow;
		const d = await detail(mia.id, day.id);
		expect(d.other.map((o) => [o.event, o.actor.id, o.title, o.link.blockId])).toEqual([
			["delegation", "outline-delegate", "Tag the release", taskId],
			["report", "outline-report", "Tag the release", taskId],
		]);
		expect(d.tasks.map((t) => [t.event, t.by.id, t.newlyDoneForYou])).toEqual([
			["done", root, true],
		]);
		// The report's blocks sit under a task: process, not knowledge.
		expect(d.knowledge.flatMap((k) => k.blocks.map((b) => b.title))).toEqual([]);
		await expectLinksResolve(mia.id, d);
	}, 60_000);
});

const JOB = OUTLINE_DIGEST_JOB as unknown as Record<string, number>;

/** The store with some methods replaced (a failing disk, a write that never goes through). */
function wrapStore(overrides: Partial<Record<keyof typeof store, unknown>>): typeof store {
	return new Proxy(store, {
		get(target, prop, receiver) {
			if (prop in overrides) return (overrides as Record<string | symbol, unknown>)[prop];
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as typeof store;
}

/** What the job logs as warnings while `run` runs. */
async function warningsDuring(run: () => Promise<unknown>) {
	const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
	const original = logger.warn;
	logger.warn = (msg, data) => {
		warnings.push({ msg, ...(data ? { data } : {}) });
	};
	try {
		await run();
	} finally {
		logger.warn = original;
	}
	return warnings;
}

describe("reports: the job when it is large, interrupted or fails", () => {
	test("every space is visited, however many: a page of one, one space a slice", async () => {
		const amy = await person("amy", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(amy.id) };
		const spaces = [await project(amy.id), await project(amy.id), await project(amy.id)];
		for (const [i, s] of spaces.entries())
			await write(s.space, A, amy.id, `2026-12-10T1${i}:00:00.000Z`, [
				{ op: "insert", parent: null, content: `fact ${i}` },
			]);
		const saved = JOB.spacesPerPage as number;
		JOB.spacesPerPage = 1;
		try {
			let t = 0;
			await runJob("2026-12-11T08:00:00.000Z", { clock: () => (t += 1000), budgetMs: 1500 });
		} finally {
			JOB.spacesPerPage = saved;
		}
		await runJob("2026-12-12T08:00:00.000Z");
		const days = await dailies(amy.id);
		const d10 = days.find((d) => d.periodKey === "2026-12-10") as OutlineDigestRow;
		expect(Object.keys(d10.ranges).sort()).toEqual(spaces.map((s) => s.space.id).sort());
		expect(d10.truncated).toBe(false);
		expect((await detail(amy.id, d10.id)).knowledge.map((k) => k.title).sort()).toEqual([
			"fact 0",
			"fact 1",
			"fact 2",
		]);
	}, 60_000);

	test("no report is made before every space from before the upgrade is stamped", async () => {
		const bo = await person("bo", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(bo.id) };
		const p1 = await project(bo.id);
		const p2 = await project(bo.id);
		await write(p1.space, A, bo.id, "2026-12-20T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "p1 old" },
		]);
		await write(p2.space, A, bo.id, "2026-12-20T11:00:00.000Z", [
			{ op: "insert", parent: null, content: "p2 old" },
		]);
		// As the migration leaves them: committed to, not stamped.
		await db
			.update(outlineSpaces)
			.set({ lastCommitAt: null })
			.where(inArray(outlineSpaces.id, [p1.space.id, p2.space.id]));
		resetOutlineDigestJobForTests();
		const saved = JOB.stampBatch as number;
		JOB.stampBatch = 1;
		try {
			// One space stamped per batch of the stamp: a report made after the first one would see
			// p1 only, and p2's day would be lost for good.
			await runJob("2026-12-21T08:00:00.000Z");
		} finally {
			JOB.stampBatch = saved;
		}
		const d20 = (await dailies(bo.id)).find(
			(d) => d.periodKey === "2026-12-20",
		) as OutlineDigestRow;
		expect((await detail(bo.id, d20.id)).knowledge.map((k) => k.title).sort()).toEqual([
			"p1 old",
			"p2 old",
		]);
	}, 60_000);

	test("a person deleted while their batch is in flight is skipped; the others' are written", async () => {
		const dee = await person("dee", { timeZone: "UTC" });
		const eve = await person("eve", { timeZone: "UTC" });
		const agent = await narrator(eve.id);
		const spaces = [await project(eve.id), await project(eve.id), await project(eve.id)];
		await grant(spaces[0]?.id as string, dee.id, "read");
		for (const [i, s] of spaces.entries())
			await write(s.space, { kind: "agent", id: agent }, null, `2027-02-10T1${i}:00:00.000Z`, [
				{ op: "insert", parent: null, content: `space ${i}` },
			]);
		startOutlineDigestSweepForTests();
		let calls = 0;
		const options = {
			store,
			now: () => new Date("2027-02-11T08:00:00.000Z"),
			serverTimeZone: "UTC",
			// The budget lasts until the batch is formed and one space visited.
			clock: () => (++calls <= 5 ? 0 : 10_000 * calls),
			budgetMs: 1500,
		};
		expect((await runOutlineDigestSlice(options)).written).toBe(0);
		await db.delete(users).where(eq(users.id, dee.id));
		let t = 0;
		options.clock = () => (t += 1);
		let slices = 0;
		for (; slices < 50; slices++) if (!(await runOutlineDigestSlice(options)).more) break;
		expect(slices).toBeLessThan(50);
		const days = await dailies(eve.id);
		expect(days.map((d) => d.periodKey)).toEqual(["2027-02-08", "2027-02-09", "2027-02-10"]);
		expect((await detail(eve.id, (days[2] as OutlineDigestRow).id)).knowledge).toHaveLength(3);
		// The job goes on: the next day is made as usual.
		await write(
			spaces[1]?.space as OutlineSpaceRow,
			{ kind: "agent", id: agent },
			null,
			"2027-02-11T10:00:00.000Z",
			[{ op: "insert", parent: null, content: "next day" }],
		);
		await runJob("2027-02-12T08:00:00.000Z");
		expect((await dailies(eve.id)).at(-1)?.periodKey).toBe("2027-02-11");
	}, 60_000);

	test("a space with commits but nothing in it for the person is no space with changes", async () => {
		const gil = await person("gil", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(gil.id) };
		const busy = await project(gil.id);
		await write(busy.space, A, gil.id, "2027-03-02T09:00:00.000Z", [
			{ op: "insert", parent: null, content: "a fact" },
		]);
		// Two spaces where only a block moves: commits, nothing to report.
		for (const _ of [0, 1]) {
			const quiet = await project(gil.id);
			const made = await write(
				quiet.space,
				{ kind: "human", id: gil.id },
				gil.id,
				"2027-03-01T09:00:00.000Z",
				[
					{ op: "insert", tempId: "a", parent: null, content: "page a" },
					{ op: "insert", tempId: "b", parent: null, content: "page b" },
					{ op: "insert", tempId: "c", parent: { tempId: "a" }, content: "moved" },
				],
			);
			await write(quiet.space, A, gil.id, "2027-03-02T10:00:00.000Z", [
				{
					op: "move",
					block: { id: made.results[2]?.blockId as string },
					parent: { id: made.results[1]?.blockId as string },
				},
			]);
		}
		await runJob("2027-03-03T08:00:00.000Z", {
			limits: { ...OUTLINE_DIGEST_LIMITS, spacesPerDigest: 1 },
		});
		const d2 = (await dailies(gil.id)).find(
			(d) => d.periodKey === "2027-03-02",
		) as OutlineDigestRow;
		expect(d2.counts.spaces).toBe(1);
		expect(d2.items.moreSpaces).toBe(0);
		expect(d2.truncated).toBe(false);
		expect(Object.keys(d2.ranges)).toHaveLength(3);
	}, 60_000);

	test("a batch's state does not grow with the spaces it visits", async () => {
		const zo = await person("zo", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(zo.id) };
		for (let i = 0; i < 8; i++) {
			const s = await project(zo.id);
			await write(s.space, A, zo.id, `2027-06-10T1${i}:00:00.000Z`, [
				{ op: "insert", parent: null, content: `zo ${i}` },
			]);
		}
		startOutlineDigestSweepForTests();
		let t = 0;
		let first: number | null = null;
		let most = 0;
		let slices = 0;
		for (; slices < 500; slices++) {
			const slice = await runOutlineDigestSlice({
				store,
				now: () => new Date("2027-06-11T08:00:00.000Z"),
				serverTimeZone: "UTC",
				clock: () => (t += 1000),
				budgetMs: 1500,
			});
			const sizes = outlineDigestBatchSizesForTests();
			if (sizes) {
				first ??= sizes.lastTo;
				most = Math.max(most, sizes.lastTo);
			}
			if (!slice.more) break;
		}
		// What the people's last reports said (the positions a batch starts from), and no more.
		expect(first).not.toBeNull();
		expect(most).toBe(first as number);
		const day = (await dailies(zo.id)).find(
			(d) => d.periodKey === "2027-06-10",
		) as OutlineDigestRow;
		expect(Object.keys(day.ranges)).toHaveLength(8);
	}, 60_000);

	test("a space that fails once is read again; one that keeps failing leaves the report partial", async () => {
		const fy = await person("fy", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(fy.id) };
		const bad = await project(fy.id);
		const good = await project(fy.id);
		await write(bad.space, A, fy.id, "2027-07-10T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "bad 07-10" },
		]);
		await write(good.space, A, fy.id, "2027-07-10T11:00:00.000Z", [
			{ op: "insert", parent: null, content: "good 07-10" },
		]);
		let attempts = 0;
		let failFirst = 1;
		const flaky = wrapStore({
			async listCommitRangeChanges(
				spaceId: string,
				afterSeq: number,
				toSeq: number,
				limit: number,
			) {
				if (spaceId === bad.space.id) {
					attempts++;
					if (failFirst > 0) {
						failFirst--;
						throw new Error("disk hiccup");
					}
				}
				return await store.listCommitRangeChanges(spaceId, afterSeq, toSeq, limit);
			},
		});
		// Failing once: read again, nothing lost.
		await runJob("2027-07-11T08:00:00.000Z", { store: flaky });
		expect(attempts).toBe(2);
		const d10 = (await dailies(fy.id)).find(
			(d) => d.periodKey === "2027-07-10",
		) as OutlineDigestRow;
		expect(d10.truncated).toBe(false);
		expect((await detail(fy.id, d10.id)).knowledge.map((k) => k.title).sort()).toEqual([
			"bad 07-10",
			"good 07-10",
		]);
		// Failing every time: tried twice, left out, the report says it is partial.
		await write(bad.space, A, fy.id, "2027-07-11T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "bad 07-11" },
		]);
		await write(good.space, A, fy.id, "2027-07-11T11:00:00.000Z", [
			{ op: "insert", parent: null, content: "good 07-11" },
		]);
		attempts = 0;
		failFirst = Number.POSITIVE_INFINITY;
		const warnings = await warningsDuring(() =>
			runJob("2027-07-12T08:00:00.000Z", { store: flaky }),
		);
		expect(attempts).toBe(2);
		expect(warnings.map((w) => w.msg)).toContain(
			"Outline report: a space could not be read; reports left partial",
		);
		const d11 = (await dailies(fy.id)).find(
			(d) => d.periodKey === "2027-07-11",
		) as OutlineDigestRow;
		expect(d11.truncated).toBe(true);
		expect(Object.keys(d11.ranges)).toEqual([good.space.id]);
		expect((await detail(fy.id, d11.id)).knowledge.map((k) => k.title)).toEqual(["good 07-11"]);
		// Mended: the next day goes on as usual.
		await write(bad.space, A, fy.id, "2027-07-12T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "bad 07-12" },
		]);
		await runJob("2027-07-13T08:00:00.000Z");
		const d12 = (await dailies(fy.id)).find(
			(d) => d.periodKey === "2027-07-12",
		) as OutlineDigestRow;
		expect(d12.truncated).toBe(false);
		expect((await detail(fy.id, d12.id)).knowledge.map((k) => k.title)).toEqual(["bad 07-12"]);
	}, 60_000);

	test("a person whose reports cannot be written is left alone for a while, longer each time", async () => {
		const gu = await person("gu", { timeZone: "UTC" });
		const ok = await person("ok", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(ok.id) };
		const p = await project(ok.id);
		await grant(p.id, gu.id, "read");
		await write(p.space, A, ok.id, "2027-08-10T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "shared" },
		]);
		let tries = 0;
		const failing = wrapStore({
			async insertDigest(row: OutlineDigestRow) {
				if (row.userId === gu.id) {
					tries++;
					// What a failed statement looks like: the whole query and its parameters, and
					// the driver's reason underneath.
					throw new Error(
						`Failed query: insert into "outline_digests" params: ${"x".repeat(70_000)}`,
						{
							cause: new Error("FOREIGN KEY constraint failed"),
						},
					);
				}
				return await store.insertDigest(row);
			},
		});
		const at = (minutes: number) =>
			new Date(Date.parse("2027-08-11T08:00:00.000Z") + minutes * 60_000).toISOString();
		const warnings = await warningsDuring(() => runJob(at(0), { store: failing }));
		expect(tries).toBe(1);
		expect((await dailies(ok.id)).some((d) => d.periodKey === "2027-08-10")).toBe(true);
		const logged = warnings.find((w) => w.msg.startsWith("Outline report could not be written"));
		expect(logged?.data?.error).toBe("Error: FOREIGN KEY constraint failed");
		expect(JSON.stringify(warnings)).not.toContain("xxxxxxxxxx");
		// Within five minutes: left out, nothing read for them, nothing logged.
		expect(await warningsDuring(() => runJob(at(4), { store: failing }))).toEqual([]);
		expect(tries).toBe(1);
		// After five: tried again, fails, now left for ten.
		await runJob(at(6), { store: failing });
		expect(tries).toBe(2);
		await runJob(at(15), { store: failing });
		expect(tries).toBe(2);
		// Mended: written at the next try.
		await runJob(at(17));
		expect((await dailies(gu.id)).some((d) => d.periodKey === "2027-08-10")).toBe(true);
	}, 60_000);

	test("a success clears the wait: a later failure waits five minutes again, not ten", async () => {
		const u = await person("uu", { timeZone: "UTC" });
		const p = await project(u.id);
		const A = { kind: "agent" as const, id: await narrator(u.id) };
		await write(p.space, A, u.id, "2027-11-10T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "d10" },
		]);
		let failNext = 1;
		const flaky = wrapStore({
			async insertDigest(row: OutlineDigestRow) {
				if (row.userId === u.id && failNext > 0) {
					failNext--;
					throw new Error("busy");
				}
				return await store.insertDigest(row);
			},
		});
		const keys = async () => (await dailies(u.id)).map((d) => d.periodKey);
		await runJob("2027-11-11T08:00:00.000Z", { store: flaky });
		expect(await keys()).toEqual([]);
		await runJob("2027-11-11T08:04:00.000Z", { store: flaky });
		expect(await keys()).toEqual([]);
		// Five minutes on: written; the failure is forgotten.
		await runJob("2027-11-11T08:05:30.000Z", { store: flaky });
		expect(await keys()).toEqual(["2027-11-08", "2027-11-09", "2027-11-10"]);
		// The next day fails once more: tried again after five minutes, as the first time.
		failNext = 1;
		await write(p.space, A, u.id, "2027-11-11T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "d11" },
		]);
		await runJob("2027-11-12T08:00:00.000Z", { store: flaky });
		expect((await keys()).at(-1)).toBe("2027-11-10");
		await runJob("2027-11-12T08:05:30.000Z", { store: flaky });
		expect((await keys()).at(-1)).toBe("2027-11-11");
	}, 60_000);

	test("the wait doubles up to six hours, and a restart tries again at once", async () => {
		const v = await person("vv", { timeZone: "UTC" });
		const p = await project(v.id);
		const A = { kind: "agent" as const, id: await narrator(v.id) };
		await write(p.space, A, v.id, "2027-12-10T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "d10" },
		]);
		let attempts = 0;
		let fail = true;
		const broken = wrapStore({
			async insertDigest(row: OutlineDigestRow) {
				if (row.userId === v.id) {
					attempts++;
					if (fail) throw new Error("cannot write");
				}
				return await store.insertDigest(row);
			},
		});
		const start = Date.parse("2027-12-11T08:00:00.000Z");
		const tried = async (minutes: number) => {
			const before = attempts;
			await runJob(new Date(start + minutes * 60_000).toISOString(), { store: broken });
			return attempts > before;
		};
		// Failing at 0: waits 5, 10, 20, 40, 80, 160 and 320 minutes, then 6 hours: after the
		// failure at 635 the doubled wait would be 640 minutes, and it stops at 360.
		expect(await tried(0)).toBe(true);
		for (const at of [5, 15, 35, 75, 155, 315, 635, 995, 1355]) {
			expect(await tried(at - 1)).toBe(false);
			expect(await tried(at)).toBe(true);
		}
		// A restart forgets the waits; the store works again: written at once.
		resetOutlineDigestJobForTests();
		fail = false;
		expect(await tried(1356)).toBe(true);
		expect((await dailies(v.id)).map((d) => d.periodKey)).toContain("2027-12-10");
	}, 300_000);

	test("one person whose due days cannot be worked out does not hold up the people after them", async () => {
		// Their id sorts before everyone's: the sweep meets them first.
		const first = await person("first", { timeZone: "UTC" }, `--${generateId().slice(2)}`);
		const later = await person("later", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(later.id) };
		const p = await project(later.id);
		await write(p.space, A, later.id, "2027-09-10T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "later's fact" },
		]);
		const broken = wrapStore({
			async getLatestDigestCursor(userId: string, ...rest: [never, never]) {
				if (userId === first.id) throw new Error("corrupt ranges_json");
				return await store.getLatestDigestCursor(userId, ...rest);
			},
		});
		const warnings = await warningsDuring(() =>
			runJob("2027-09-11T08:00:00.000Z", { store: broken }),
		);
		expect(warnings.map((w) => [w.msg, w.data?.userId])).toContainEqual([
			"Outline report: the days due could not be worked out; left for later",
			first.id,
		]);
		const day = (await dailies(later.id)).find(
			(d) => d.periodKey === "2027-09-10",
		) as OutlineDigestRow;
		expect((await detail(later.id, day.id)).knowledge.map((k) => k.title)).toEqual([
			"later's fact",
		]);
		expect(await dailies(first.id)).toEqual([]);
	}, 60_000);

	test("writing reports keeps to the slice's budget", async () => {
		const ru = await person("ru", { timeZone: "UTC" });
		const A = { kind: "agent" as const, id: await narrator(ru.id) };
		const p = await project(ru.id);
		await write(p.space, A, ru.id, "2027-10-10T10:00:00.000Z", [
			{ op: "insert", parent: null, content: "ru's fact" },
		]);
		startOutlineDigestSweepForTests();
		let t = 0;
		const perSlice: number[] = [];
		for (let i = 0; i < 2000; i++) {
			const slice = await runOutlineDigestSlice({
				store,
				now: () => new Date("2027-10-11T08:00:00.000Z"),
				serverTimeZone: "UTC",
				clock: () => (t += 1000),
				budgetMs: 1500,
			});
			perSlice.push(slice.written);
			if (!slice.more) break;
		}
		// Everyone in the database has days due: many people, at most one person (three days) a slice.
		expect(perSlice.reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
		expect(Math.max(...perSlice)).toBeLessThanOrEqual(3);
	}, 120_000);

	test("only the latest 30 daily reports are kept", async () => {
		const hy = await person("hy", { timeZone: "UTC" });
		for (let day = 1; day <= 30; day++) {
			const key = `2027-04-${String(day).padStart(2, "0")}`;
			await store.insertDigest({
				id: generateId(),
				userId: hy.id,
				kind: "daily",
				periodKey: key,
				timeZone: "UTC",
				periodStart: `${key}T00:00:00.000Z`,
				periodEnd: `${key}T00:00:00.000Z`,
				counts: {
					delegated: 0,
					knowledge: 0,
					tasks: 0,
					plans: 0,
					questions: 0,
					other: 0,
					spaces: 0,
					ownEdits: 0,
				},
				itemCount: 0,
				items: {
					v: 1,
					spaces: [],
					moreSpaces: 0,
					delegated: [],
					knowledge: [],
					tasks: [],
					plans: [],
					questions: [],
					other: [],
					more: { delegated: 0, knowledge: 0, tasks: 0, plans: 0, questions: 0, other: 0 },
				},
				ranges: {},
				truncated: false,
				createdAt: `${key}T07:00:00.000Z`,
				seenAt: `${key}T07:00:00.000Z`,
			});
		}
		// 04-30's end is not 05-01's start here, but the job only needs the latest to continue.
		await runJob("2027-05-02T08:00:00.000Z");
		const keys = (await dailies(hy.id)).map((d) => d.periodKey);
		expect(keys).toHaveLength(30);
		expect(keys[0]).toBe("2027-04-02");
		expect(keys.at(-1)).toBe("2027-05-01");
	}, 60_000);

	test("an answer relayed in the name of someone who only reads stands, and cannot be undone", async () => {
		const ian = await person("ian", { timeZone: "UTC" });
		const owner = await person("owner2");
		const p = await project(owner.id);
		await grant(p.id, ian.id, "read");
		const agent = await narrator(owner.id);
		const asked = await write(
			p.space,
			{ kind: "agent", id: agent },
			ian.id,
			"2027-05-10T09:00:00.000Z",
			[{ op: "insert", parent: null, content: "Which?", ask: ask(ian.id) }],
			{ question: { askerNarratorId: agent, askerUserId: ian.id, askerToolCallId: "c" } },
		);
		await write(
			p.space,
			{ kind: "agent", id: agent },
			ian.id,
			"2027-05-10T10:00:00.000Z",
			[
				{
					op: "update",
					block: { id: asked.results[0]?.blockId as string },
					ask: {
						...ask(ian.id),
						answer: {
							option: 1,
							by: { kind: "human", id: ian.id },
							at: "2027-05-10T10:00:00.000Z",
							relayed: { narratorId: agent, messageId: null },
						},
					},
				},
			],
			{
				kind: "answer",
				question: {
					askerNarratorId: null,
					askerUserId: null,
					askerToolCallId: null,
					delivered: true,
				},
			},
		);
		await runJob("2027-05-11T08:00:00.000Z");
		const day = (await dailies(ian.id)).find(
			(d) => d.periodKey === "2027-05-10",
		) as OutlineDigestRow;
		const d = await detail(ian.id, day.id);
		expect(d.delegated.map((x) => [x.kind, x.stands, x.canUndo])).toEqual([
			["relayed_answer", true, false],
		]);
	}, 60_000);
});

describe("reports: the job's bounds", () => {
	test("a slice out of budget stops and the next carries on; the result is the same", async () => {
		const ivy = await person("ivy", { timeZone: "UTC" });
		const agent = await narrator(ivy.id);
		const spaces = [await project(ivy.id), await project(ivy.id), await project(ivy.id)];
		for (const [i, s] of spaces.entries())
			await write(s.space, { kind: "agent", id: agent }, ivy.id, `2026-11-24T1${i}:00:00.000Z`, [
				{ op: "insert", parent: null, content: `space ${i}` },
			]);
		startOutlineDigestSweepForTests();
		// Each read of the clock moves it 1 s: every slice runs out after one space.
		let t = 0;
		const options = {
			store,
			now: () => new Date("2026-11-25T08:00:00.000Z"),
			serverTimeZone: "UTC",
			clock: () => (t += 1000),
			budgetMs: 1500,
		};
		const first = await runOutlineDigestSlice(options);
		expect(first).toEqual({ more: true, written: 0 });
		let slices = 1;
		let written = 0;
		for (; slices < 500; slices++) {
			const slice = await runOutlineDigestSlice(options);
			written += slice.written;
			if (!slice.more) break;
		}
		expect(slices).toBeGreaterThan(3);
		expect(written).toBeGreaterThan(0);
		const day = (await dailies(ivy.id)).find(
			(d) => d.periodKey === "2026-11-24",
		) as OutlineDigestRow;
		expect((await detail(ivy.id, day.id)).knowledge.map((k) => k.title).sort()).toEqual([
			"space 0",
			"space 1",
			"space 2",
		]);
	}, 60_000);

	test("a window past its caps is summarized in part, and says so", async () => {
		const jon = await person("jon", { timeZone: "UTC" });
		const p = await project(jon.id);
		const agent = await narrator(jon.id);
		for (let i = 0; i < 5; i++)
			await write(p.space, { kind: "agent", id: agent }, jon.id, `2026-11-26T1${i}:00:00.000Z`, [
				{ op: "insert", parent: null, content: `fact ${i}` },
			]);
		await runJob("2026-11-27T08:00:00.000Z", {
			limits: { ...OUTLINE_DIGEST_LIMITS, commitsPerSpace: 2, itemsPerSection: 1 },
		});
		const day = (await dailies(jon.id)).find(
			(d) => d.periodKey === "2026-11-26",
		) as OutlineDigestRow;
		expect(day.truncated).toBe(true);
		expect(day.items.spaces[0]?.truncated).toBe(true);
		// Two commits read; one page listed per section, the other counted.
		expect(day.items.knowledge).toHaveLength(1);
		expect(day.counts.knowledge).toBe(2);
		// The detail says per space what was counted but not listed (the page's space filter).
		const shown = await detail(jon.id, day.id);
		expect(shown.spaces.map((s) => [s.id, s.more])).toEqual([[p.space.id, { knowledge: 1 }]]);
		expect(shown.more.knowledge).toBe(1);
		// The range still covers the whole day: the next day continues after it.
		expect(day.ranges[p.space.id]).toEqual([0, 5]);
	}, 60_000);
});

describe("reports: asking for today so far", () => {
	test("not queued says why: asked within the minute, or too many asking", async () => {
		const amy = await person("amy", { timeZone: "UTC" });
		expect(requestOutlineDigestPreview(amy.id, { kick: false })).toEqual({ queued: true });
		// Still waiting in the queue: asking again is the same request.
		expect(requestOutlineDigestPreview(amy.id, { kick: false })).toEqual({ queued: true });
		await runJob(new Date().toISOString());
		const recent = await call<OutlineDigestNowResponse>(amy.id, "/digests/now", { method: "POST" });
		expect(recent.status).toBe(202);
		expect(recent.body).toMatchObject({ queued: false, reason: "recent" });
		expect(recent.body.previewId).not.toBeNull();
		// Somebody else's queue is full.
		resetOutlineDigestJobForTests();
		for (let i = 0; i < OUTLINE_DIGEST_JOB.previewQueue; i++)
			expect(requestOutlineDigestPreview(`queued-${i}`, { kick: false }).queued).toBe(true);
		const full = await call<OutlineDigestNowResponse>(amy.id, "/digests/now", { method: "POST" });
		expect([full.status, full.body]).toEqual([
			202,
			{ queued: false, reason: "queue_full", previewId: recent.body.previewId },
		]);
	}, 60_000);
});

describe("reports: names", () => {
	test("a session that is gone is not named, nor linked, even for an admin", async () => {
		const root = await person("root");
		await db.update(users).set({ role: "admin" }).where(eq(users.id, root.id));
		const p = await project(root.id);
		const kept = await narrator(root.id);
		const gone = await narrator(root.id);
		const at = "2026-11-20T10:00:00.000Z";
		const made = await write(p.space, { kind: "agent", id: kept }, root.id, at, [
			{ op: "insert", parent: null, content: "Plan the move", task: { status: "todo" } },
		]);
		const block = made.results[0]?.blockId as string;
		const commit = made.commit as { id: string; seq: number };
		await db.delete(narrators).where(eq(narrators.id, gone));
		const none = { delegated: 0, knowledge: 0, tasks: 0, plans: 0, questions: 0, other: 0 };
		const items: OutlineDigestStored = {
			v: 1,
			spaces: [
				{
					id: p.space.id,
					kind: "project",
					from: 0,
					to: commit.seq,
					commits: 1,
					truncated: false,
					deletedFacts: 0,
					ownEdits: 0,
					tasksCreated: 0,
					tasksStarted: 0,
					leaseReturned: 0,
					reviewComments: 0,
				},
			],
			moreSpaces: 0,
			delegated: [],
			knowledge: [],
			tasks: [
				{
					space: p.space.id,
					commitId: commit.id,
					seq: commit.seq,
					at,
					event: "done",
					blockId: block,
					pageId: block,
					by: { kind: "agent", id: gone },
					executor: { kind: "agent", id: kept },
					manager: null,
					goal: false,
					forYou: false,
				},
			],
			plans: [
				{
					space: p.space.id,
					commitId: commit.id,
					seq: commit.seq,
					at,
					event: "planning",
					blockId: block,
					pageId: block,
					round: 0,
					narratorId: gone,
					approvedBy: null,
				},
			],
			questions: [],
			other: [],
			more: none,
		};
		const id = generateId();
		await store.insertDigest({
			id,
			userId: root.id,
			kind: "daily",
			periodKey: "2026-11-20",
			timeZone: "UTC",
			periodStart: "2026-11-20T00:00:00.000Z",
			periodEnd: "2026-11-21T00:00:00.000Z",
			counts: { ...none, tasks: 1, plans: 1, spaces: 1, ownEdits: 0 },
			itemCount: 2,
			items,
			ranges: { [p.space.id]: [0, commit.seq] },
			truncated: false,
			createdAt: "2026-11-21T07:00:00.000Z",
			seenAt: null,
		});
		const res = await appAs(root.id, "admin").request(`http://localhost/outline/digests/${id}`);
		expect(res.status).toBe(200);
		const d = (await res.json()) as OutlineDigestDetailResponse;
		expect(Object.keys(d.names.sessions)).toEqual([kept]);
		expect(d.plans[0]?.session).toEqual({ narratorId: null, title: null, hidden: true });
		expect(d.plans[0]?.link.narratorId).toBeNull();
	}, 60_000);
});

describe("reports: settings", () => {
	test("PATCH /user-preferences takes a zone and a time, and null goes back to the default", async () => {
		const { userPreferencesRoutes } = await import("../../../routes/user-preferences");
		const kim = await person("kim");
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: kim.id, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		app.onError((error) =>
			error instanceof AppError
				? new Response(error.message, { status: error.statusCode })
				: new Response(String(error), { status: 500 }),
		);
		app.route("/p", userPreferencesRoutes);
		const patch = (body: unknown) =>
			app.request("http://localhost/p", {
				method: "PATCH",
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
			});
		const read = async () =>
			(await (await app.request("http://localhost/p")).json()) as Record<string, unknown>;
		expect(await read()).toMatchObject({ outlineDigestTimeZone: null, outlineDigestTime: null });
		expect(typeof (await read()).outlineDigestServerTimeZone).toBe("string");
		expect(
			(await patch({ outlineDigestTimeZone: "asia/shanghai", outlineDigestTime: "06:45" })).status,
		).toBe(200);
		expect(await read()).toMatchObject({
			outlineDigestTimeZone: "Asia/Shanghai",
			outlineDigestTime: "06:45",
		});
		// Other settings leave them alone.
		expect((await patch({ showTokenUsage: true })).status).toBe(200);
		expect(await read()).toMatchObject({ outlineDigestTimeZone: "Asia/Shanghai" });
		expect((await patch({ outlineDigestTimeZone: "Mars/Olympus" })).status).toBe(400);
		expect((await patch({ outlineDigestTime: "7:00" })).status).toBe(400);
		expect((await patch({ outlineDigestTimeZone: null })).status).toBe(200);
		expect(await read()).toMatchObject({ outlineDigestTimeZone: null, outlineDigestTime: "06:45" });
		const [row] = await db
			.select()
			.from(userPreferences)
			.where(and(eq(userPreferences.userId, kim.id)));
		expect(row?.outlineDigestTimeZone).toBeNull();
	});
});
