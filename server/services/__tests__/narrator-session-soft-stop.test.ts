import { afterEach, describe, expect, test } from "bun:test";
import {
	clearBufferedMessageSoftStopIfIdle,
	evaluateSoftStopRequest,
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
