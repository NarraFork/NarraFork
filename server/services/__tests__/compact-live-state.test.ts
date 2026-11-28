import { afterEach, describe, expect, test } from "bun:test";
import {
	appendLiveCompactDelta,
	finishLiveCompactProgress,
	liveCompactProgress,
	resetLiveCompactProgress,
	startLiveCompactProgress,
	subscribeLiveCompactProgress,
} from "../compact-live-state";

const MESSAGE_ID = "compact-live-state-test";

afterEach(() => {
	finishLiveCompactProgress(MESSAGE_ID, "failed");
});

describe("live compact detail stream", () => {
	test("replays the missed prefix before delivering later deltas", () => {
		startLiveCompactProgress(MESSAGE_ID, { model: "test", startedAt: "now" });
		appendLiveCompactDelta(MESSAGE_ID, "output", "hello", { outputChars: 5, thinkingChars: 0 });
		appendLiveCompactDelta(MESSAGE_ID, "thinking", "think", { outputChars: 5, thinkingChars: 5 });

		const events: unknown[] = [];
		const unsubscribe = subscribeLiveCompactProgress(
			MESSAGE_ID,
			{ output: 2, thinking: 0 },
			(event) => events.push(event),
		);
		expect(unsubscribe).toBeFunction();
		appendLiveCompactDelta(MESSAGE_ID, "output", " world", { outputChars: 11, thinkingChars: 5 });
		finishLiveCompactProgress(MESSAGE_ID, "compacted");

		expect(events).toEqual([
			{
				kind: "delta",
				channel: "output",
				delta: "llo",
				outputChars: 5,
				thinkingChars: 5,
			},
			{
				kind: "delta",
				channel: "thinking",
				delta: "think",
				outputChars: 5,
				thinkingChars: 5,
			},
			{
				kind: "delta",
				channel: "output",
				delta: " world",
				outputChars: 11,
				thinkingChars: 5,
			},
			{ kind: "finished", status: "compacted" },
		]);
	});

	test("rolls back failed draft text and replays the valid prefix for a stale connection", () => {
		startLiveCompactProgress(MESSAGE_ID, { model: "test", startedAt: "now" });
		appendLiveCompactDelta(MESSAGE_ID, "output", "valid draft", {
			outputChars: 11,
			thinkingChars: 0,
		});
		const originalVersion = liveCompactProgress.get(MESSAGE_ID)?.streamVersion;
		const connected: unknown[] = [];
		const stopConnected = subscribeLiveCompactProgress(
			MESSAGE_ID,
			{ output: 11, thinking: 0, streamVersion: originalVersion },
			(event) => connected.push(event),
		);

		resetLiveCompactProgress(MESSAGE_ID, {
			outputLength: 5,
			thinkingLength: 0,
			outputChars: 5,
			thinkingChars: 0,
		});
		appendLiveCompactDelta(MESSAGE_ID, "output", " retry", {
			outputChars: 11,
			thinkingChars: 0,
		});

		const reconnected: unknown[] = [];
		const stopReconnected = subscribeLiveCompactProgress(
			MESSAGE_ID,
			{ output: 11, thinking: 0, streamVersion: originalVersion },
			(event) => reconnected.push(event),
		);
		const newVersion = liveCompactProgress.get(MESSAGE_ID)?.streamVersion;
		expect(newVersion).not.toBe(originalVersion);
		expect(connected).toMatchObject([
			{ kind: "reset", streamVersion: newVersion, outputLength: 5, outputChars: 5 },
			{ kind: "delta", channel: "output", delta: " retry", outputChars: 11 },
		]);
		expect(reconnected).toMatchObject([
			{ kind: "reset", streamVersion: newVersion, outputLength: 0, outputChars: 0 },
			{ kind: "delta", channel: "output", delta: "valid retry", outputChars: 11 },
		]);
		stopConnected?.();
		stopReconnected?.();
	});

	test("separates same-marker retries from late subscribers of the previous attempt", () => {
		startLiveCompactProgress(MESSAGE_ID, { model: "old", startedAt: "now" });
		const oldVersion = liveCompactProgress.get(MESSAGE_ID)?.streamVersion;
		const stopOld = subscribeLiveCompactProgress(
			MESSAGE_ID,
			{ output: 0, thinking: 0, streamVersion: oldVersion },
			() => {},
		);
		finishLiveCompactProgress(MESSAGE_ID, "failed");

		startLiveCompactProgress(MESSAGE_ID, { model: "new", startedAt: "later" });
		const newVersion = liveCompactProgress.get(MESSAGE_ID)?.streamVersion;
		const events: unknown[] = [];
		const stopNew = subscribeLiveCompactProgress(
			MESSAGE_ID,
			{ output: 2, thinking: 1, streamVersion: oldVersion },
			(event) => events.push(event),
		);
		stopOld?.();
		appendLiveCompactDelta(MESSAGE_ID, "output", "new output", {
			outputChars: 10,
			thinkingChars: 0,
		});

		expect(newVersion).not.toBe(oldVersion);
		expect(events).toMatchObject([
			{ kind: "reset", streamVersion: newVersion, outputLength: 0, thinkingLength: 0 },
			{ kind: "delta", channel: "output", delta: "new output" },
		]);
		stopNew?.();
	});

	test("retains a bounded prefix and keeps counts authoritative", () => {
		startLiveCompactProgress(MESSAGE_ID, { model: "test", startedAt: "now" });
		const source = "a".repeat(200_005);
		appendLiveCompactDelta(MESSAGE_ID, "output", source, {
			outputChars: source.length,
			thinkingChars: 0,
		});

		const current = liveCompactProgress.get(MESSAGE_ID);
		expect(current?.output.length).toBe(200_000);
		expect(current?.output).toBe("a".repeat(200_000));
		expect(current?.outputChars).toBe(200_005);
		expect(current?.outputTruncated).toBe(true);
	});
});
