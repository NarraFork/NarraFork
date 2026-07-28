/**
 * narrator-compact-progress.test.ts — The compaction progress reporter's WS
 * payload: two-phase counts, correct delta→phase routing, and the throttle
 * behaviour around a phase switch.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };

let broadcasts: Array<Record<string, unknown>> = [];

mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: (_narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push(message);
	},
}));

const { createCompactProgressReporter } = await import("../narrator-compact");

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

function makeReporter(isSegment = false) {
	return createCompactProgressReporter({
		narratorId: "n-compact-progress",
		messageId: "compact-1",
		mode: "blocking",
		...(isSegment ? { isSegment: true } : {}),
	});
}

beforeEach(() => {
	broadcasts = [];
});

afterAll(() => {
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
});

describe("compact progress reporter", () => {
	test("broadcasts thinking progress before any summary text exists", async () => {
		// The regression this covers: the old de-duplication key was `outputChars`
		// alone, which stays 0 for the whole thinking window, so nothing was ever sent.
		const reporter = makeReporter();
		reporter.onReasoningDelta("r".repeat(64));
		await settle();
		reporter.finish();

		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]).toMatchObject({
			type: "compact_progress",
			messageId: "compact-1",
			phase: "thinking",
			thinkingChars: 64,
			outputChars: 0,
			mode: "blocking",
		});
	});

	test("routes text deltas to the output phase and keeps the thinking total", async () => {
		const reporter = makeReporter();
		reporter.onReasoningDelta("r".repeat(30));
		await settle();
		reporter.onTextDelta("summary text");
		reporter.finish();

		const last = broadcasts.at(-1);
		expect(last).toMatchObject({ phase: "output", thinkingChars: 30, outputChars: 12 });
	});

	test("never reverts to thinking once output started", async () => {
		const reporter = makeReporter();
		reporter.onTextDelta("abc");
		await settle();
		reporter.onReasoningDelta("a late reasoning delta");
		await settle();
		reporter.finish();

		expect(broadcasts.every((b) => b.phase === "output")).toBe(true);
		expect(broadcasts.at(-1)).toMatchObject({ outputChars: 3, thinkingChars: 22 });
	});

	test("marks a segment compaction so the right marker is patched", async () => {
		const reporter = makeReporter(true);
		reporter.onTextDelta("x");
		reporter.finish();

		expect(broadcasts.at(-1)).toMatchObject({ isSegment: true });
	});

	test("stops broadcasting after finish()", async () => {
		const reporter = makeReporter();
		reporter.onTextDelta("abc");
		reporter.finish();
		const afterFinish = broadcasts.length;

		reporter.onTextDelta("more");
		reporter.onReasoningDelta("more");
		reporter.finish();
		await settle();

		expect(broadcasts).toHaveLength(afterFinish);
	});

	test("ignores empty deltas", async () => {
		const reporter = makeReporter();
		reporter.onTextDelta("");
		reporter.onReasoningDelta("");
		reporter.finish();
		await settle();

		expect(broadcasts).toHaveLength(0);
	});
});
