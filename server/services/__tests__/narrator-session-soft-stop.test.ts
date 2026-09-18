import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ActiveNarrator } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const {
	clearBufferedMessageSoftStopIfIdle,
	evaluateSoftStopRequest,
	rearmCutInSoftStopBeforeContinuing,
	requestBufferedMessageSoftStop,
} = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { clearBufferedMessages, getBufferedMessages, pushBufferedMessage, removeBufferedMessage } =
	await import("../narrator-buffer");

const NARRATOR_ID = "soft-stop-test-narrator";

function registerActiveNarrator(): ActiveNarrator {
	const active = {
		narratorId: NARRATOR_ID,
		alive: true,
	} as unknown as ActiveNarrator;
	activeNarrators.set(NARRATOR_ID, active);
	return active;
}

/**
 * Reproduce the state `runAgentLoop` is in right after a pass ended early to let a
 * cut-in message through: the stop was granted (so `_bufferSoftStop` is spent) and
 * recorded as taken, while the message itself is still queued.
 */
async function grantedCutInStop(): Promise<ActiveNarrator> {
	const active = registerActiveNarrator();
	await queueMessage();
	requestBufferedMessageSoftStop(NARRATOR_ID);
	const decision = evaluateSoftStopRequest({
		bufferSoftStop: active._bufferSoftStop,
		hasPendingBufferedWork: true,
	});
	active._bufferSoftStop = decision.bufferSoftStop;
	active._bufferSoftStopTaken = decision.softStopTaken;
	return active;
}

async function queueMessage(text = "cut in"): Promise<string> {
	const entry = await pushBufferedMessage(NARRATOR_ID, text);
	expect(entry.ok).toBe(true);
	expect(getBufferedMessages(NARRATOR_ID).some((message) => message.id === entry.id)).toBe(true);
	return entry.id;
}

beforeEach(() => {
	cleanDb(sqlite);
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({
			id: NARRATOR_ID,
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		})
		.run();
});
afterEach(() => {
	clearBufferedMessages(NARRATOR_ID);
	activeNarrators.delete(NARRATOR_ID);
});
afterAll(() => mock.module("../../db", () => realDb));

describe("evaluateSoftStopRequest", () => {
	test("permission feedback always stops and consumes its flag", () => {
		expect(
			evaluateSoftStopRequest({
				feedbackSoftStop: true,
				bufferSoftStop: false,
				hasPendingBufferedWork: false,
			}),
		).toEqual({
			stop: true,
			feedbackSoftStop: false,
			bufferSoftStop: false,
			softStopTaken: false,
		});
	});

	test("a queued cut-in message stops the turn and records that the stop was taken", () => {
		expect(
			evaluateSoftStopRequest({
				feedbackSoftStop: false,
				bufferSoftStop: true,
				hasPendingBufferedWork: true,
			}),
		).toEqual({
			stop: true,
			feedbackSoftStop: false,
			bufferSoftStop: false,
			softStopTaken: true,
		});
	});

	test("a cancelled cut-in message drops the stale request and keeps the turn running", () => {
		// Regression: the queued message that raised the soft stop was cancelled before
		// the tool boundary was reached. Stopping here would end the turn with nothing
		// to resume, making the narrator look like it stopped on its own.
		expect(
			evaluateSoftStopRequest({
				feedbackSoftStop: false,
				bufferSoftStop: true,
				hasPendingBufferedWork: false,
			}),
		).toEqual({
			stop: false,
			feedbackSoftStop: false,
			bufferSoftStop: false,
			softStopTaken: false,
		});
	});

	test("feedback takes precedence and leaves the buffer request for the next boundary", () => {
		expect(
			evaluateSoftStopRequest({
				feedbackSoftStop: true,
				bufferSoftStop: true,
				hasPendingBufferedWork: true,
			}),
		).toEqual({
			stop: true,
			feedbackSoftStop: false,
			bufferSoftStop: true,
			softStopTaken: false,
		});
	});

	test("no pending request never stops the turn", () => {
		expect(
			evaluateSoftStopRequest({
				feedbackSoftStop: false,
				bufferSoftStop: false,
				hasPendingBufferedWork: true,
			}).stop,
		).toBe(false);
	});
});

describe("rearmCutInSoftStopBeforeContinuing", () => {
	test("a producer that starts a new pass gives the still-queued cut-in its boundary back", async () => {
		// Regression: the injection drain / chained permission feedback / review
		// git-state guard each `continue` into a FRESH pass before the buffer consumer
		// is reached. `evaluateSoftStopRequest` had already spent `_bufferSoftStop` to
		// grant this stop, so without re-arming the new pass runs with shouldStop()
		// permanently false and the queued message is stranded until the whole loop
		// ends — reported as "it says it cut in but nothing happened for ages".
		const active = await grantedCutInStop();
		expect(active._bufferSoftStop).toBe(false);
		expect(active._bufferSoftStopTaken).toBe(true);

		rearmCutInSoftStopBeforeContinuing(active);

		expect(active._bufferSoftStop).toBe(true);
		// Consumed: the re-armed request now stands on its own, so the "queue emptied
		// before the pass returned" resume path must not also fire for it.
		expect(active._bufferSoftStopTaken).toBe(false);
	});

	test("the re-armed request stops the very next tool boundary", async () => {
		const active = await grantedCutInStop();
		rearmCutInSoftStopBeforeContinuing(active);

		expect(
			evaluateSoftStopRequest({
				bufferSoftStop: active._bufferSoftStop,
				hasPendingBufferedWork: true,
			}).stop,
		).toBe(true);
	});

	test("a cancelled cut-in is not re-armed", async () => {
		// Re-arming a stop with nothing left to deliver would end the next pass at its
		// first tool call for no reason.
		const active = await grantedCutInStop();
		clearBufferedMessages(NARRATOR_ID);

		rearmCutInSoftStopBeforeContinuing(active);

		expect(active._bufferSoftStop).toBe(false);
		expect(active._bufferSoftStopTaken).toBe(true);
	});

	test("does nothing when no cut-in stop was taken", async () => {
		const active = registerActiveNarrator();
		await queueMessage();

		rearmCutInSoftStopBeforeContinuing(active);

		expect(active._bufferSoftStop).toBeUndefined();
	});
});

describe("clearBufferedMessageSoftStopIfIdle", () => {
	test("clears the pending soft stop once the queue is empty", async () => {
		const active = registerActiveNarrator();
		await queueMessage();
		expect(requestBufferedMessageSoftStop(NARRATOR_ID)).toBe(true);
		expect(active._bufferSoftStop).toBe(true);

		clearBufferedMessages(NARRATOR_ID);
		clearBufferedMessageSoftStopIfIdle(NARRATOR_ID);

		expect(active._bufferSoftStop).toBe(false);
	});

	test("keeps the soft stop while other queued messages remain", async () => {
		const active = registerActiveNarrator();
		const first = await queueMessage("queued-a");
		requestBufferedMessageSoftStop(NARRATOR_ID);

		// One of several queued messages was cancelled; the rest still need the boundary.
		await queueMessage("queued-b");
		expect(await removeBufferedMessage(NARRATOR_ID, first)).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID).map((message) => message.text)).toEqual(["queued-b"]);
		clearBufferedMessageSoftStopIfIdle(NARRATOR_ID);

		expect(active._bufferSoftStop).toBe(true);
	});

	test("is a no-op when no soft stop is pending", () => {
		const active = registerActiveNarrator();

		clearBufferedMessageSoftStopIfIdle(NARRATOR_ID);

		expect(active._bufferSoftStop).toBeUndefined();
	});

	test("does not throw for an unknown narrator", () => {
		expect(() => clearBufferedMessageSoftStopIfIdle("no-such-narrator")).not.toThrow();
	});
});
