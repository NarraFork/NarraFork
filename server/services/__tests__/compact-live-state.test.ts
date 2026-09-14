import { afterEach, describe, expect, test } from "bun:test";
import {
	appendLiveCompactDelta,
	finishLiveCompactProgress,
	liveCompactProgress,
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
