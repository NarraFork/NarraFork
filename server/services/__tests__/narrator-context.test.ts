import { afterEach, describe, expect, test } from "bun:test";

const { narratorContext } = await import("../narrator-context");

const originalSummarizeChunk = narratorContext._summarizeChunk.bind(narratorContext);
const summaryCalls: number[] = [];

afterEach(() => {
	narratorContext._summarizeChunk = originalSummarizeChunk;
	summaryCalls.length = 0;
});

describe("narrator compact summary", () => {
	test("oversized input is rejected for splitting without deleting tool evidence", async () => {
		const entries = [
			{
				message: { id: "tool", role: "assistant" as const, contentText: "" },
				text: `[Assistant]: [Tool calls] Read: ${"evidence".repeat(2_000)}`,
			},
		];
		const before = JSON.stringify(entries);
		await expect(
			originalSummarizeChunk("n-test", entries, "", "system", "suffix", 0, 100),
		).rejects.toThrow("maximum context length");
		expect(JSON.stringify(entries)).toBe(before);
	});

	test("single oversized message is split with both halves retained", async () => {
		const text = `FIRST ${"x".repeat(4_000)} LAST`;
		const entries = [{ message: { id: "m", role: "user" as const, contentText: text }, text }];
		narratorContext._summarizeChunk = async (
			id,
			chunk,
			previous,
			system,
			suffix,
			fixed,
			budget,
		) => {
			if (chunk.some((entry) => entry.text.length > 3_000)) {
				return originalSummarizeChunk(id, chunk, previous, system, suffix, fixed, budget);
			}
			return { summary: [previous, ...chunk.map((entry) => entry.text)].join("|") };
		};
		const result = await narratorContext._summarizeChunkSequence(
			"n-test",
			[entries],
			"",
			"system",
			"suffix",
			0,
			100,
			0,
		);
		expect(result.summary).toContain("FIRST");
		expect(result.summary).toContain("LAST");
		expect(entries[0].text).toBe(text);
	});

	test("cancellation stops before fitting or requesting a summary", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			originalSummarizeChunk("n-test", [], "", "system", "suffix", 0, 100, controller.signal),
		).rejects.toThrow("aborted");
	});

	test("falls back to cascading chunks when summary provider reports context overflow", async () => {
		const longText = "x".repeat(2_300);
		const entries = [
			{
				message: { id: "m1", role: "user", contentText: `PART_ONE ${longText}`, toolCalls: [] },
				text: `[User]: PART_ONE ${longText}`,
			},
			{
				message: {
					id: "m2",
					role: "assistant",
					contentText: `PART_TWO ${longText}`,
					toolCalls: [],
				},
				text: `[Assistant]: PART_TWO ${longText}`,
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
