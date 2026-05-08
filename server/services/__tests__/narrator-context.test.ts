import { afterEach, describe, expect, test } from "bun:test";

const { narratorContext } = await import("../narrator-context");

const originalSummarizeChunk = narratorContext._summarizeChunk.bind(narratorContext);
const summaryCalls: number[] = [];

afterEach(() => {
	narratorContext._summarizeChunk = originalSummarizeChunk;
	summaryCalls.length = 0;
});

describe("narrator compact summary", () => {
	test("falls back to cascading chunks when summary provider reports context overflow", async () => {
		const longText = "x".repeat(2_300);
		const entries = [
			{
				message: { id: "m1", role: "user", contentText: `PART_ONE ${longText}`, toolCalls: [] },
				text: `[User]: PART_ONE ${longText}`,
				pruned: false,
				dropped: false,
			},
			{
				message: {
					id: "m2",
					role: "assistant",
					contentText: `PART_TWO ${longText}`,
					toolCalls: [],
				},
				text: `[Assistant]: PART_TWO ${longText}`,
				pruned: false,
				dropped: false,
			},
		];

		narratorContext._summarizeChunk = async (_narratorId, chunkEntries, previousSummary) => {
			summaryCalls.push(chunkEntries.length);
			if (chunkEntries.length > 1) throw new Error("maximum context length exceeded");

			const markers = ["PART_ONE", "PART_TWO"].filter((marker) =>
				chunkEntries.some((entry) => entry.text.includes(marker)),
			);
			return {
				summary: [previousSummary, ...markers].filter(Boolean).join("|"),
				contextPercent: 12,
			};
		};

		const result = await narratorContext._summarizeChunkSequence(
			"n-test",
			[entries as never],
			"",
			"compact system prompt",
			"compact suffix",
			0,
			40_000,
			0,
		);

		expect(summaryCalls).toEqual([2, 1, 1]);
		expect(result.summary).toContain("PART_ONE");
		expect(result.summary).toContain("PART_TWO");
	});
});
