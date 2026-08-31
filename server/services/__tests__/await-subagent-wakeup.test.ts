/**
 * What wakes a parent's `Await({ type: "agent" })` when its child settles.
 *
 * The reported failure: the user sent a message to a subagent, took it over, later
 * stopped the takeover, the subagent finished — and the parent stayed stuck in
 * `Await` until the timeout, then kept re-waiting because the result still looked
 * pending.
 *
 * The cause is that `waitForSubagentResult` listened to exactly ONE event,
 * `narrator:subagent_completed`, which is emitted by the subagent RUNNER
 * (`finalizeSubagent`) and by the parent-interrupt path. A subagent driven by the
 * GENERIC SESSION ENGINE instead — which is what a takeover and any
 * `resumeSubagent` continuation started from the subagent's own page produce —
 * ends inside `runAgentLoop`, which never emits it. Nothing else was listening, so
 * the wait could only end in a timeout.
 *
 * So these tests drive the waiter through the two engines' OBSERVABLE signals
 * rather than asserting on listener bookkeeping: the runner's dedicated event, and
 * the plain status write that every engine performs. A regression that drops the
 * status-based path fails the middle test while the first still passes, which is
 * exactly the asymmetry the bug had.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, users } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { eventBus } = await import("../../lib/event-bus");
const { waitForSubagentResult } = await import("../agent-communication");
const { clearTakenOver, markTakenOver } = await import("../subagent-takeover");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const OWNER_ID = "owner-await-wakeup";
const PARENT_ID = "parent-await-wakeup";
const SUBAGENT_ID = "subagent-await-wakeup";

/** The wait must be able to outlive the settle; keep it well past any real delay. */
const GENEROUS_TIMEOUT_MS = 5_000;

async function seedRunningSubagent(): Promise<void> {
	const now = new Date().toISOString();
	// `narrators.ownerUserId` is a real FK, so the owner row has to exist first.
	await db.insert(users).values({
		id: OWNER_ID,
		username: `${OWNER_ID}-${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	await db.insert(narrators).values([
		{
			id: PARENT_ID,
			title: "parent",
			ownerUserId: OWNER_ID,
			visibility: "private",
			status: "working",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: SUBAGENT_ID,
			title: "child",
			ownerUserId: OWNER_ID,
			visibility: "private",
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: PARENT_ID,
			aclRootNarratorId: PARENT_ID,
			status: "working",
			createdAt: now,
			updatedAt: now,
		},
	]);
}

/**
 * Settle the subagent row the way any engine does: write the terminal status.
 * No event is emitted here — each test chooses which signal to fire.
 */
async function writeSettledRow(substatus: string[] = ["unread"]): Promise<void> {
	await db
		.update(narrators)
		.set({
			status: "idle",
			substatus: JSON.stringify(substatus),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(narrators.id, SUBAGENT_ID));
}

function startWait(signal?: AbortSignal) {
	return waitForSubagentResult({
		subagentId: SUBAGENT_ID,
		parentNarratorId: PARENT_ID,
		timeoutMs: GENEROUS_TIMEOUT_MS,
		signal,
	});
}

/** Let the waiter finish its initial read and attach its listeners. */
async function afterListenersAttached(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

beforeEach(async () => {
	await seedRunningSubagent();
});

afterEach(() => {
	clearTakenOver(SUBAGENT_ID);
	cleanDb(sqlite);
});

describe("waking a parent's Await when its subagent settles", () => {
	test("the runner's own completion event ends the wait", async () => {
		const waiting = startWait();
		await afterListenersAttached();

		await writeSettledRow();
		eventBus.emit({
			type: "narrator:subagent_completed",
			narratorId: SUBAGENT_ID,
			parentNarratorId: PARENT_ID,
			toolUseId: "tool-use-1",
		});

		expect((await waiting).status).toBe("completed");
	});

	test("a plain status write ends the wait even with NO subagent_completed event", async () => {
		/*
		 * This is the reported bug. The generic session engine (takeover, and any
		 * continuation resumed from the subagent's page) settles the subagent without
		 * ever emitting `narrator:subagent_completed`. Before the fix this wait ran to
		 * its full timeout and answered "still running" about a finished child.
		 */
		const waiting = startWait();
		await afterListenersAttached();

		await writeSettledRow();
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: SUBAGENT_ID,
			status: "idle",
			substatus: ["unread"],
		});

		expect((await waiting).status).toBe("completed");
	});

	test("the real outcome is re-read, not assumed to be success", async () => {
		// The status event carries no result, so an errored run must still be
		// reported as failed rather than as a completion.
		const waiting = startWait();
		await afterListenersAttached();

		await writeSettledRow(["error"]);
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: SUBAGENT_ID,
			status: "idle",
			substatus: ["error"],
		});

		expect((await waiting).status).toBe("failed");
	});

	test("a subagent that settled during the initial read still ends the wait", async () => {
		/*
		 * The waiter's first act is an awaited DB read. A child that settles during
		 * that await emits both of its events before either listener exists, so
		 * nothing would arrive afterwards and the wait could only time out. The
		 * post-subscribe re-check is what covers this ordering — no event is emitted
		 * in this test at all.
		 */
		const waiting = startWait();
		await writeSettledRow();

		expect((await waiting).status).toBe("completed");
	});

	test("a still-running subagent's intermediate status writes do NOT end the wait", async () => {
		const waiting = startWait(AbortSignal.timeout(400));
		await afterListenersAttached();

		// `working`/`waiting` are the in-flight states: a turn boundary or a
		// permission pause must not be mistaken for the run ending.
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: SUBAGENT_ID,
			status: "waiting",
			substatus: [],
		});
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: SUBAGENT_ID,
			status: "working",
			substatus: [],
		});

		// Only the abort ends it, proving neither write was treated as terminal.
		expect((await waiting).status).toBe("aborted");
	});

	test("another subagent settling does not end this wait", async () => {
		const waiting = startWait(AbortSignal.timeout(400));
		await afterListenersAttached();

		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: "some-other-subagent",
			status: "idle",
			substatus: ["unread"],
		});
		eventBus.emit({
			type: "narrator:subagent_completed",
			narratorId: "some-other-subagent",
			parentNarratorId: PARENT_ID,
			toolUseId: "tool-use-other",
		});

		expect((await waiting).status).toBe("aborted");
	});

	test("a taken-over subagent parked in idle[taken_over] does NOT end the wait", async () => {
		/*
		 * A takeover parks the subagent in `idle[taken_over]` between the user's own
		 * turns. That is idle-shaped but is NOT the end of the run: the result is
		 * handed back only when the user stops the takeover. Ending the wait here
		 * would hand the parent a partial result while the user is still working —
		 * which is why the status path cannot simply treat "not working" as settled.
		 */
		markTakenOver(SUBAGENT_ID);
		const waiting = startWait(AbortSignal.timeout(400));
		await afterListenersAttached();

		await writeSettledRow(["taken_over"]);
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: SUBAGENT_ID,
			status: "idle",
			substatus: ["taken_over"],
		});

		expect((await waiting).status).toBe("aborted");
	});
});
