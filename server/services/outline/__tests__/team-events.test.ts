/**
 * Team events (outline P2 PR 10a, design v2 §D) on SQLite: the store scenarios shared with
 * PostgreSQL (`team-events-scenarios.ts`: who is told of which event, and whether it wakes), then
 * what goes through the session runtime: the row (a `sys` row under an id derived from the
 * commit, never written twice), the wake rules (plan mode, a run stopped by its person or an
 * error, a person's commit), the wake limit with its one later wake, the re-push after a start
 * (bounded, and waking only a row still unread), the PostgreSQL branch of the delivery, the
 * listener's order, what team activity no longer repeats, and the current-tasks view's section.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * The wake goes through the injection scheduler seam and the limit's clock is replaced; nothing
 * runs a model, and nothing sleeps.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { foldHandle } from "../../../../shared/narrator-handle";
import { readTestMessageContent } from "../../../../tests/setup";
import { db, sqlite as testSqlite } from "../../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	users,
} from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import * as injection from "../../narrator-injection";
import { type InjectionScheduler, setInjectionScheduler } from "../../narrator-injection";
import * as refsStore from "../../narrator-refs/store";
import { invalidateTaskBackend } from "../../task-source";
import { outlineTasksView, resetOutlineViewCache } from "../../task-source/outline-views";
import { resetOutlineAssignedForTests } from "../assigned";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import { OUTLINE_TASK_FINISHED_SOURCE } from "../task-finished";
import { readOutlineTeamActivity, resetOutlineTeamActivityForTests } from "../team-activity";
import {
	deliverOutlineTeamEvents,
	OUTLINE_TEAM_EVENT_LIMITS,
	OUTLINE_TEAM_SOURCE,
	outlineTeamMessageId,
	repushRecentOutlineTeamEvents,
	settleOutlineTeamEventsForTests,
	startOutlineTeamEvents,
} from "../team-events";
import {
	hasDeferredTeamWake,
	OUTLINE_TEAM_WAKE_LIMITS,
	type OutlineTeamWakeClock,
	resetOutlineTeamWakeForTests,
	setOutlineTeamWakeClock,
	takeTeamWake,
	teamWakesLeft,
	wakeForTeam,
} from "../team-wake";
import { type OutlineOp, type OutlineOpResult, writeOutline } from "../write";
import { OUTLINE_TEAM_EVENTS_SCENARIOS, type TeamEventsContext } from "./team-events-scenarios";

const NOW = "2026-11-10T00:00:00.000Z";

/** A clock the tests move, and timers they fire: nothing waits for real time. */
function fakeClock() {
	let now = Date.parse("2026-11-10T08:00:00.000Z");
	const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
	const clock: OutlineTeamWakeClock = {
		now: () => now,
		after(ms, fn) {
			const timer = { at: now + ms, fn, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	};
	return {
		clock,
		pending: () => timers.filter((t) => !t.cancelled).length,
		/** Move the clock and run every timer that is due, in order. */
		async advance(ms: number) {
			now += ms;
			for (;;) {
				const due = timers
					.filter((t) => !t.cancelled && t.at <= now)
					.sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				due.cancelled = true;
				due.fn();
				// The wake a timer starts is asynchronous: let it finish.
				for (let i = 0; i < 20; i++) await Promise.resolve();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		},
	};
}

let wakes: string[] = [];
let started = true;
let previousScheduler: InjectionScheduler | null = null;
let time = fakeClock();
let previousClock: OutlineTeamWakeClock | null = null;

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	invalidateSessionReadScopes();
	resetOutlineTeamActivityForTests();
	resetOutlineAssignedForTests();
	resetOutlineViewCache();
	wakes = [];
	started = true;
	previousScheduler = setInjectionScheduler({
		requestSoftStop: () => false,
		wakeIfIdle: async (narratorId) => {
			wakes.push(narratorId);
			return { started };
		},
	});
	time = fakeClock();
	resetOutlineTeamWakeForTests();
	previousClock = setOutlineTeamWakeClock(time.clock);
});

afterEach(async () => {
	await settleOutlineTeamEventsForTests();
	setInjectionScheduler(previousScheduler);
	resetOutlineTeamWakeForTests();
	setOutlineTeamWakeClock(previousClock);
});

const ctx: TeamEventsContext = {
	async person(name) {
		const id = generateId();
		const username = `${name}${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}`;
		await db
			.insert(users)
			.values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
		return { id, username };
	},
	async project(owner) {
		const id = generateId();
		await db.insert(projects).values({
			id,
			name: `team-${id}`,
			ownerUserId: owner,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		return id;
	},
	async session(owner, projectId, options) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			title: options.title,
			ownerUserId: owner,
			taskBackend: options.backend ?? "outline",
			visibility: "private",
			contextProjectId: projectId,
			status: options.archived ? "archived" : "idle",
			...(options.handle ? { handle: options.handle, handleFold: foldHandle(options.handle) } : {}),
			createdAt: NOW,
			updatedAt: NOW,
		});
		return id;
	},
	async subagent(root, owner, projectId) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			type: "subagent",
			title: "Helper",
			ownerUserId: owner,
			parentNarratorId: root,
			aclRootNarratorId: root,
			taskBackend: "outline",
			contextProjectId: projectId,
			status: "idle",
			createdAt: NOW,
			updatedAt: NOW,
		});
		return id;
	},
};

describe("what a commit is read as (shared with PostgreSQL)", () => {
	for (const scenario of OUTLINE_TEAM_EVENTS_SCENARIOS)
		test(scenario.name, async () => {
			await scenario.run(ctx);
		});
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the session runtime
// ─────────────────────────────────────────────────────────────────────────────

interface Commit {
	results: OutlineOpResult[];
	event: {
		spaceId: string;
		commitId: string;
		seq: number;
		actorKind: "agent" | "human";
		actorId: string;
	};
}

async function commit(
	spaceId: string,
	who: { agent: string; owner: string } | { person: string },
	ops: OutlineOp[],
	at?: Date,
): Promise<Commit> {
	const actor =
		"agent" in who
			? { kind: "agent" as const, id: who.agent }
			: { kind: "human" as const, id: who.person };
	const result = await writeOutline(
		{
			spaceId,
			ops,
			actor,
			responsibleUserId: "agent" in who ? who.owner : who.person,
			...("agent" in who ? { narratorId: who.agent } : {}),
		},
		at ? { now: () => at } : {},
	);
	if (!result.commit) throw new Error("nothing committed");
	return {
		results: result.results,
		event: {
			spaceId,
			commitId: result.commit.id,
			seq: result.commit.seq,
			actorKind: actor.kind,
			actorId: actor.id,
		},
	};
}

const assignTo = (title: string, narratorId: string): OutlineOp => ({
	op: "insert",
	parent: null,
	content: title,
	task: { status: "todo", assignee: `agent:${narratorId}` },
});

/** The team rows of a session, oldest first. */
async function rows(narratorId: string) {
	const found = await db
		.select({
			id: narratorMessages.id,
			role: narratorMessages.role,
			createdBy: narratorMessages.createdBy,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(narratorMessageRefs.seq);
	return found.flatMap((row) =>
		readTestMessageContent(testSqlite, row.id)
			.filter(
				(b) =>
					b.type === "system_injection" &&
					(b.source === OUTLINE_TEAM_SOURCE || b.source === OUTLINE_TASK_FINISHED_SOURCE),
			)
			.map((b) => ({
				id: row.id,
				role: row.role,
				createdBy: row.createdBy,
				source: String(b.source),
				text: String(b.modelText),
			})),
	);
}

async function pair() {
	const owner = await ctx.person("lead");
	const projectId = await ctx.project(owner.id);
	const space = await ensureProjectSpace(projectId);
	const planner = await ctx.session(owner.id, projectId, { title: "Planner" });
	const worker = await ctx.session(owner.id, projectId, { title: "Worker" });
	return { owner, projectId, space, planner, worker, by: { agent: planner, owner: owner.id } };
}

describe("the row and its wake", () => {
	test("an agent's hand-over: a system row under the commit's id that wakes the idle session; delivered again it writes and wakes nothing", async () => {
		const { space, worker, by } = await pair();
		const written = await commit(space.id, by, [assignTo("Fix the build", worker)]);
		const first = await deliverOutlineTeamEvents(written.event);
		expect(first).toEqual({ told: [worker], woke: 1, deferred: 0 });
		const [row, ...rest] = await rows(worker);
		expect(rest).toEqual([]);
		expect(row).toMatchObject({ role: "sys", createdBy: null, source: OUTLINE_TEAM_SOURCE });
		expect(row?.id).toBe(outlineTeamMessageId(written.event, worker));
		expect(row?.text).toContain('Assigned to this session by session "Planner"');
		expect(wakes).toEqual([worker]);

		const again = await deliverOutlineTeamEvents(written.event);
		expect(again).toEqual({ told: [worker], woke: 0, deferred: 0 });
		expect(await rows(worker)).toHaveLength(1);
		expect(wakes).toEqual([worker]);
	});

	test("plan mode, or a last run stopped by its person or by an error: the row is written, nobody is woken", async () => {
		for (const [change, expectWake] of [
			[{ traits: ["plan"] as string[] }, false],
			[{ lastStopReason: "user_interrupt" as const }, false],
			[{ lastStopReason: "error" as const }, false],
			[{ lastStopReason: "normal" as const }, true],
		] as const) {
			const { space, worker, by } = await pair();
			await db.update(narrators).set(change).where(eq(narrators.id, worker));
			wakes = [];
			const result = await deliverOutlineTeamEvents(
				(await commit(space.id, by, [assignTo("Take this", worker)])).event,
			);
			expect(result.told).toEqual([worker]);
			expect(await rows(worker)).toHaveLength(1);
			expect(wakes).toEqual(expectWake ? [worker] : []);
			expect(result.woke).toBe(expectWake ? 1 : 0);
			// Not waiting for room either: it is not owed a wake at all.
			expect(hasDeferredTeamWake(worker)).toBe(false);
		}
	});

	test("a running session is not started: the row waits for its next tool boundary, and the wake is not counted", async () => {
		const { space, worker, by } = await pair();
		started = false;
		const result = await deliverOutlineTeamEvents(
			(await commit(space.id, by, [assignTo("While you run", worker)])).event,
		);
		expect(result).toEqual({ told: [worker], woke: 0, deferred: 0 });
		expect(await rows(worker)).toHaveLength(1);
		expect(teamWakesLeft(worker)).toBe(OUTLINE_TEAM_WAKE_LIMITS.perWindow);
	});

	test("a person's commit records and wakes nobody", async () => {
		const { owner, space, worker } = await pair();
		const result = await deliverOutlineTeamEvents(
			(await commit(space.id, { person: owner.id }, [assignTo("From a person", worker)])).event,
		);
		expect(result).toEqual({ told: [worker], woke: 0, deferred: 0 });
		const [row] = await rows(worker);
		expect(row).toMatchObject({ role: "sys", createdBy: null });
		expect(row?.text).toContain(`Assigned to this session by ${owner.username}`);
		expect(wakes).toEqual([]);
	});

	test("PostgreSQL: written through deliverInjection without a chosen id, nothing woken", async () => {
		const { space, worker, by } = await pair();
		const port = spyOn(refsStore, "getNarratorMessageRefsPort").mockReturnValue(
			{} as ReturnType<typeof refsStore.getNarratorMessageRefsPort>,
		);
		const deliver = spyOn(injection, "deliverInjection").mockResolvedValue({
			messageId: "pg-row",
			turnText: null,
			started: false,
			interjected: false,
		});
		try {
			const result = await deliverOutlineTeamEvents(
				(await commit(space.id, by, [assignTo("On PostgreSQL", worker)])).event,
			);
			expect(result).toEqual({ told: [worker], woke: 0, deferred: 0 });
			expect(deliver).toHaveBeenCalledTimes(1);
			const [target, options] = deliver.mock.calls[0] ?? [];
			expect(target).toBe(worker);
			expect(options).toMatchObject({ schedule: "none", role: "sys", source: OUTLINE_TEAM_SOURCE });
			expect(options).not.toHaveProperty("messageId");
		} finally {
			port.mockRestore();
			deliver.mockRestore();
		}
		expect(wakes).toEqual([]);
	});
});

describe("the wake limit", () => {
	test(`${OUTLINE_TEAM_WAKE_LIMITS.perWindow} wakes a minute; the next row is written without one, and one wake follows when there is room`, async () => {
		const { space, worker, by } = await pair();
		for (let i = 0; i < OUTLINE_TEAM_WAKE_LIMITS.perWindow; i++) {
			const result = await deliverOutlineTeamEvents(
				(await commit(space.id, by, [assignTo(`Task ${i}`, worker)])).event,
			);
			expect(result.woke).toBe(1);
			await time.advance(1000);
		}
		expect(wakes).toHaveLength(OUTLINE_TEAM_WAKE_LIMITS.perWindow);
		// Two more within the minute: both rows are written, neither wakes, one timer waits.
		const seventh = await deliverOutlineTeamEvents(
			(await commit(space.id, by, [assignTo("Seventh", worker)])).event,
		);
		const eighth = await deliverOutlineTeamEvents(
			(await commit(space.id, by, [assignTo("Eighth", worker)])).event,
		);
		expect(seventh).toEqual({ told: [worker], woke: 0, deferred: 1 });
		expect(eighth).toEqual({ told: [worker], woke: 0, deferred: 1 });
		expect(await rows(worker)).toHaveLength(OUTLINE_TEAM_WAKE_LIMITS.perWindow + 2);
		expect(wakes).toHaveLength(OUTLINE_TEAM_WAKE_LIMITS.perWindow);
		expect(time.pending()).toBe(1);
		// Not yet: the oldest wake of the window is 6 seconds old.
		await time.advance(30_000);
		expect(wakes).toHaveLength(OUTLINE_TEAM_WAKE_LIMITS.perWindow);
		// The window has room again: one wake for both rows.
		await time.advance(30_000);
		expect(wakes).toHaveLength(OUTLINE_TEAM_WAKE_LIMITS.perWindow + 1);
		expect(hasDeferredTeamWake(worker)).toBe(false);
		expect(time.pending()).toBe(0);
	});

	test("the later wake is dropped when the session read the row meanwhile", async () => {
		const { space, worker, by } = await pair();
		for (let i = 0; i < OUTLINE_TEAM_WAKE_LIMITS.perWindow; i++)
			expect(takeTeamWake(worker)).toBe(true);
		const result = await deliverOutlineTeamEvents(
			(await commit(space.id, by, [assignTo("Late", worker)])).event,
		);
		expect(result.deferred).toBe(1);
		// Something came after the row in its history (its person spoke, a run answered).
		await injection.deliverInjection(worker, { content: "hello", source: "test", role: "user" });
		await time.advance(OUTLINE_TEAM_WAKE_LIMITS.windowMs + 1000);
		expect(wakes).toEqual([]);
		expect(hasDeferredTeamWake(worker)).toBe(false);
		// A wake that started nothing is not counted against the session.
		expect(teamWakesLeft(worker)).toBe(OUTLINE_TEAM_WAKE_LIMITS.perWindow);
	});

	test("the limit is per session, and the window slides", async () => {
		const calls: string[] = [];
		const wake = (id: string) => async () => {
			calls.push(id);
			return true;
		};
		for (let i = 0; i < OUTLINE_TEAM_WAKE_LIMITS.perWindow; i++)
			expect(await wakeForTeam("a", wake("a"))).toEqual({ woke: true, deferred: false });
		expect(await wakeForTeam("b", wake("b"))).toEqual({ woke: true, deferred: false });
		expect(await wakeForTeam("a", wake("a"))).toEqual({ woke: false, deferred: true });
		// A second deferral replaces the first: one later wake.
		expect(await wakeForTeam("a", wake("a2"))).toEqual({ woke: false, deferred: true });
		expect(time.pending()).toBe(1);
		await time.advance(OUTLINE_TEAM_WAKE_LIMITS.windowMs + 1);
		expect(calls.filter((c) => c === "a2")).toHaveLength(1);
		expect(calls.filter((c) => c === "a")).toHaveLength(OUTLINE_TEAM_WAKE_LIMITS.perWindow);
		// The six of the first minute have left the window; the later wake counts in the new one.
		expect(teamWakesLeft("a")).toBe(OUTLINE_TEAM_WAKE_LIMITS.perWindow - 1);
	});
});

describe("the re-push after a start", () => {
	test("a commit whose row was never written is told once; pushed again, nothing more is written", async () => {
		const { space, worker, by } = await pair();
		// The re-push covers every recent space (other cases' too): this session's wakes.
		const mine = () => wakes.filter((id) => id === worker);
		// The process stopped between the commit and its row: nothing was delivered.
		const at = new Date("2026-11-10T07:55:00.000Z");
		await commit(space.id, by, [assignTo("Lost in the stop", worker)], at);
		expect(await rows(worker)).toEqual([]);
		const now = new Date("2026-11-10T08:00:00.000Z");
		const first = await repushRecentOutlineTeamEvents({ now });
		await settleOutlineTeamEventsForTests();
		expect(first.commits).toBeGreaterThanOrEqual(1);
		expect(await rows(worker)).toHaveLength(1);
		expect(mine()).toEqual([worker]);
		await repushRecentOutlineTeamEvents({ now });
		await settleOutlineTeamEventsForTests();
		expect(await rows(worker)).toHaveLength(1);
		// Still the last row of an idle session: the wake is tried again, nothing is written.
		expect(mine()).toEqual([worker, worker]);
	});

	test("a row written before the stop: woken again only while it is still the session's last row", async () => {
		const { space, worker, by } = await pair();
		const at = new Date("2026-11-10T07:58:00.000Z");
		const now = new Date("2026-11-10T08:00:00.000Z");
		// Written, and the wake did not start a turn (the stop cut it off).
		started = false;
		await deliverOutlineTeamEvents(
			(await commit(space.id, by, [assignTo("Written, not woken", worker)], at)).event,
		);
		const mine = () => wakes.filter((id) => id === worker);
		expect(mine()).toEqual([worker]);
		started = true;
		await repushRecentOutlineTeamEvents({ now });
		await settleOutlineTeamEventsForTests();
		expect(await rows(worker)).toHaveLength(1);
		expect(mine()).toEqual([worker, worker]);
		// The session went on since (a row follows it): the re-push leaves it alone.
		await injection.deliverInjection(worker, { content: "next", source: "test", role: "user" });
		await repushRecentOutlineTeamEvents({ now });
		await settleOutlineTeamEventsForTests();
		expect(mine()).toEqual([worker, worker]);
	});

	test("bounded: only commits of the last 15 minutes, the newest of a space, spaces by the commit-time index", async () => {
		const { space, worker, by } = await pair();
		const now = new Date("2026-11-10T09:00:00.000Z");
		const old = new Date(now.getTime() - OUTLINE_TEAM_EVENT_LIMITS.repushWindowMs - 60_000);
		await commit(space.id, by, [assignTo("Too old", worker)], old);
		const listed = spyOn(outlineStore, "listSpacesCommittedSince");
		const commits = spyOn(outlineStore, "listCommits");
		try {
			// A space last committed to before the window is not even listed.
			const before = await repushRecentOutlineTeamEvents({ now });
			await settleOutlineTeamEventsForTests();
			expect(await rows(worker)).toEqual([]);
			expect(listed.mock.calls[0]?.[0]).toBe(
				new Date(now.getTime() - OUTLINE_TEAM_EVENT_LIMITS.repushWindowMs).toISOString(),
			);
			expect(listed.mock.calls[0]?.[1]).toMatchObject({ limit: 50 });
			expect(commits.mock.calls.some(([id]) => id === space.id)).toBe(false);
			expect(before.spaces).toBeLessThanOrEqual(OUTLINE_TEAM_EVENT_LIMITS.repushSpaces);

			// More recent commits than one space pushes: the newest ones, each within the window.
			const recent = new Date(now.getTime() - 60_000);
			const extra = 3;
			for (let i = 0; i < OUTLINE_TEAM_EVENT_LIMITS.repushCommitsPerSpace + extra; i++)
				await commit(space.id, by, [assignTo(`Recent ${i}`, worker)], recent);
			commits.mockClear();
			const pushed = await repushRecentOutlineTeamEvents({ now });
			await settleOutlineTeamEventsForTests();
			const ofSpace = commits.mock.calls.filter(([id]) => id === space.id);
			expect(ofSpace).toHaveLength(1);
			expect(ofSpace[0]?.[1]).toMatchObject({
				limit: OUTLINE_TEAM_EVENT_LIMITS.repushCommitsPerSpace,
			});
			expect(pushed.commits).toBeGreaterThanOrEqual(
				OUTLINE_TEAM_EVENT_LIMITS.repushCommitsPerSpace,
			);
			const told = await rows(worker);
			expect(told).toHaveLength(OUTLINE_TEAM_EVENT_LIMITS.repushCommitsPerSpace);
			// The oldest of the recent ones were left out, and the one before the window too.
			expect(told.some((r) => r.text.includes("Too old"))).toBe(false);
			expect(told.some((r) => r.text.includes("Recent 0\n"))).toBe(false);
			expect(told.at(-1)?.text).toContain(
				`Recent ${OUTLINE_TEAM_EVENT_LIMITS.repushCommitsPerSpace + extra - 1}`,
			);
		} finally {
			listed.mockRestore();
			commits.mockRestore();
		}
	});

	test("the space listing reads the commit-time index, not the table", () => {
		const plan = testSqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT id FROM outline_spaces WHERE last_commit_at >= ? ORDER BY last_commit_at, id LIMIT 50",
			)
			.all("2026-11-10T00:00:00.000Z") as Array<{ detail: string }>;
		expect(plan.map((row) => row.detail).join("\n")).toMatch(/USING (COVERING )?INDEX/);
	});
});

describe("the listener", () => {
	test("hears commits once started, a space's commits in order, and nothing while the outline is off", async () => {
		startOutlineTeamEvents();
		startOutlineTeamEvents();
		const { space, worker, by } = await pair();
		for (let i = 0; i < 5; i++) await commit(space.id, by, [assignTo(`In order ${i}`, worker)]);
		await settleOutlineTeamEventsForTests();
		const told = await rows(worker);
		expect(told.map((r) => r.text.match(/In order \d/)?.[0])).toEqual(
			[0, 1, 2, 3, 4].map((i) => `In order ${i}`),
		);
		settings.outline.enabled = false;
		try {
			await commit(space.id, by, [assignTo("Switched off", worker)]);
			await settleOutlineTeamEventsForTests();
			expect(await rows(worker)).toHaveLength(5);
		} finally {
			settings.outline.enabled = true;
		}
	});
});

describe("what else knows of it", () => {
	test("team activity does not repeat what a team row told the session", async () => {
		const { owner, space, worker, by } = await pair();
		// The project task page: what team activity reads task-level changes of.
		const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000);
		const page = await commit(
			space.id,
			{ agent: worker, owner: owner.id },
			[
				{ op: "insert", tempId: "page", parent: null, content: "Tasks", alias: "tasks" },
				{
					op: "insert",
					parent: { tempId: "page" },
					content: "Created by the worker",
					task: { status: "todo" },
				},
			],
			at(1),
		);
		const pageId = (page.results[0] as OutlineOpResult).blockId;
		const task = page.results[1] as OutlineOpResult;
		// Another session ends that task, hands the worker two more (one created for it, one
		// existing), and adds one that concerns nobody in particular.
		const existing = await commit(
			space.id,
			by,
			[
				{
					op: "insert",
					parent: { id: pageId },
					content: "Handed over later",
					task: { status: "todo" },
				},
			],
			at(2),
		);
		await commit(
			space.id,
			by,
			[
				{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
				{
					op: "insert",
					parent: { id: pageId },
					content: "Created for the worker",
					task: { status: "todo", assignee: `agent:${worker}` },
				},
				{
					op: "setTask",
					block: { id: (existing.results[0] as OutlineOpResult).blockId },
					task: { assignee: `agent:${worker}` },
				},
				{
					op: "insert",
					parent: { id: pageId },
					content: "Someone else's",
					task: { status: "todo" },
				},
			],
			at(3),
		);
		const look = await readOutlineTeamActivity(worker, {
			locale: "en",
			now: at(4).getTime(),
		});
		const text = look?.content ?? "";
		// Not told by any row: still team activity.
		expect(text).toContain("Someone else's");
		// Told by the team row of that commit: the task it created ending, the hand-overs to it.
		expect(text).not.toContain("Created by the worker");
		expect(text).not.toContain("Created for the worker");
		expect(text).not.toContain("handed");
	});

	test("the current-tasks view lists what was assigned and not started, until the session takes it up", async () => {
		const { owner, space, worker, by } = await pair();
		await ensureSessionSpace(worker);
		expect(await outlineTasksView(worker, "en")).toBeNull();
		const written = await commit(space.id, by, [assignTo("Take the on-call", worker)]);
		const task = written.results[0] as OutlineOpResult;
		await deliverOutlineTeamEvents(written.event);
		await settleOutlineTeamEventsForTests();
		resetOutlineViewCache();
		const view = await outlineTasksView(worker, "en");
		expect(view).toContain(
			`Assigned to you, not started (set one in progress when you take it up):\n- [ ] \`${task.address}\` Take the on-call`,
		);
		expect(await outlineTasksView(worker, "zh-CN")).toContain("指派给你、还没开始");
		// It takes the task up: its own work in progress, no longer "assigned, not started".
		await commit(space.id, { agent: worker, owner: owner.id }, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		const after = await outlineTasksView(worker, "en");
		expect(after).not.toContain("Assigned to you");
		expect(after).toContain("In progress:");
	});

	test("after a restart the view finds what names the session in its project, by one bounded read", async () => {
		const { space, worker, by } = await pair();
		// Assigned, and the process restarted before any notice was noted in memory.
		const written = await commit(space.id, by, [assignTo("Assigned before the restart", worker)]);
		resetOutlineAssignedForTests();
		resetOutlineViewCache();
		const open = spyOn(outlineStore, "listOpenTasks");
		try {
			expect(await outlineTasksView(worker, "en")).toContain(
				`\`${(written.results[0] as OutlineOpResult).address}\` Assigned before the restart`,
			);
			const scans = open.mock.calls.filter(([id]) => id === space.id).length;
			expect(scans).toBe(1);
			resetOutlineViewCache();
			await outlineTasksView(worker, "en");
			// Once per session and process: the second read looks the task up by its id.
			expect(open.mock.calls.filter(([id]) => id === space.id)).toHaveLength(scans);
		} finally {
			open.mockRestore();
		}
	});
});
