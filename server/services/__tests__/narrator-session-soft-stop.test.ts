import { afterEach, describe, expect, test } from "bun:test";
import {
	clearBufferedMessageSoftStopIfIdle,
	evaluateSoftStopRequest,
	rearmCutInSoftStopBeforeContinuing,
	requestBufferedMessageSoftStop,
} from "../narrator-session";
import {
	type ActiveNarrator,
	activeNarrators,
	type BufferedMessage,
	bufferedMessages,
} from "../narrator-session-state";

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
function grantedCutInStop(): ActiveNarrator {
	const active = registerActiveNarrator();
	queueMessage();
	requestBufferedMessageSoftStop(NARRATOR_ID);
	const decision = evaluateSoftStopRequest({
		bufferSoftStop: active._bufferSoftStop,
		hasPendingBufferedWork: true,
	});
	active._bufferSoftStop = decision.bufferSoftStop;
	active._bufferSoftStopTaken = decision.softStopTaken;
	return active;
}

function queueMessage(id = "queued-1"): void {
	const entry = { id, text: "cut in", bufferedAt: new Date().toISOString() } as BufferedMessage;
	bufferedMessages.set(NARRATOR_ID, [entry]);
}

afterEach(() => {
	activeNarrators.delete(NARRATOR_ID);
	bufferedMessages.delete(NARRATOR_ID);
});

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
	test("a producer that starts a new pass gives the still-queued cut-in its boundary back", () => {
		// Regression: the injection drain / chained permission feedback / review
		// git-state guard each `continue` into a FRESH pass before the buffer consumer
		// is reached. `evaluateSoftStopRequest` had already spent `_bufferSoftStop` to
		// grant this stop, so without re-arming the new pass runs with shouldStop()
		// permanently false and the queued message is stranded until the whole loop
		// ends — reported as "it says it cut in but nothing happened for ages".
		const active = grantedCutInStop();
		expect(active._bufferSoftStop).toBe(false);
		expect(active._bufferSoftStopTaken).toBe(true);

		rearmCutInSoftStopBeforeContinuing(active);

		expect(active._bufferSoftStop).toBe(true);
		// Consumed: the re-armed request now stands on its own, so the "queue emptied
		// before the pass returned" resume path must not also fire for it.
		expect(active._bufferSoftStopTaken).toBe(false);
	});

	test("the re-armed request stops the very next tool boundary", () => {
		const active = grantedCutInStop();
		rearmCutInSoftStopBeforeContinuing(active);

		expect(
			evaluateSoftStopRequest({
				bufferSoftStop: active._bufferSoftStop,
				hasPendingBufferedWork: true,
			}).stop,
		).toBe(true);
	});

	test("a cancelled cut-in is not re-armed", () => {
		// Re-arming a stop with nothing left to deliver would end the next pass at its
		// first tool call for no reason.
		const active = grantedCutInStop();
		bufferedMessages.delete(NARRATOR_ID);

		rearmCutInSoftStopBeforeContinuing(active);

		expect(active._bufferSoftStop).toBe(false);
		expect(active._bufferSoftStopTaken).toBe(true);
	});

	test("does nothing when no cut-in stop was taken", () => {
		const active = registerActiveNarrator();
		queueMessage();

		rearmCutInSoftStopBeforeContinuing(active);

		expect(active._bufferSoftStop).toBeUndefined();
	});
});

describe("clearBufferedMessageSoftStopIfIdle", () => {
	test("clears the pending soft stop once the queue is empty", () => {
		const active = registerActiveNarrator();
		queueMessage();
		expect(requestBufferedMessageSoftStop(NARRATOR_ID)).toBe(true);
		expect(active._bufferSoftStop).toBe(true);

		bufferedMessages.delete(NARRATOR_ID);
		clearBufferedMessageSoftStopIfIdle(NARRATOR_ID);

		expect(active._bufferSoftStop).toBe(false);
	});

	test("keeps the soft stop while other queued messages remain", () => {
		const active = registerActiveNarrator();
		queueMessage("queued-a");
		requestBufferedMessageSoftStop(NARRATOR_ID);

		// One of several queued messages was cancelled; the rest still need the boundary.
		queueMessage("queued-b");
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
