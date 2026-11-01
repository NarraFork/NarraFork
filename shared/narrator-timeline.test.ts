import { describe, expect, test } from "bun:test";
import { partitionTimeline, type TimelineSegment } from "./narrator-timeline";

function assertContinuous(segments: TimelineSegment[], start: number, end: number) {
	expect(segments[0]?.startMs).toBe(start);
	expect(segments[segments.length - 1]?.endMs).toBe(end);
	for (let i = 1; i < segments.length; i++) {
		expect(segments[i].startMs).toBe(segments[i - 1].endMs);
	}
}

describe("partitionTimeline", () => {
	test("fills an empty window with overhead", () => {
		const result = partitionTimeline({ startMs: 0, endMs: 100, intervals: [] });
		expect(result.segments).toEqual([
			{ category: "overhead", startMs: 0, endMs: 100, itemIds: [] },
		]);
		expect(result.totals).toEqual({ overhead: 100 });
	});

	test("is continuous and labels gaps as overhead", () => {
		const result = partitionTimeline({
			startMs: 0,
			endMs: 100,
			intervals: [
				{ category: "model_output", startMs: 10, endMs: 40, itemId: "m1" },
				{ category: "tool", startMs: 45, endMs: 60, itemId: "t1" },
			],
		});
		assertContinuous(result.segments, 0, 100);
		expect(result.segments.map((s) => s.category)).toEqual([
			"overhead",
			"model_output",
			"overhead",
			"tool",
			"overhead",
		]);
		expect(result.totals.overhead).toBe(55);
	});

	test("waiting for the user wins over overlapping work", () => {
		const result = partitionTimeline({
			startMs: 0,
			endMs: 100,
			intervals: [
				{ category: "tool", startMs: 0, endMs: 100, itemId: "bg" },
				{ category: "permission_wait", startMs: 20, endMs: 50, itemId: "p" },
			],
		});
		assertContinuous(result.segments, 0, 100);
		expect(result.segments.map((s) => [s.category, s.startMs, s.endMs])).toEqual([
			["tool", 0, 20],
			["permission_wait", 20, 50],
			["tool", 50, 100],
		]);
	});

	test("parallel tools share one segment listing every item", () => {
		const result = partitionTimeline({
			startMs: 0,
			endMs: 30,
			intervals: [
				{ category: "tool", startMs: 0, endMs: 20, itemId: "b" },
				{ category: "tool", startMs: 0, endMs: 30, itemId: "a" },
			],
		});
		expect(result.segments).toEqual([
			{ category: "tool", startMs: 0, endMs: 20, itemIds: ["a", "b"] },
			{ category: "tool", startMs: 20, endMs: 30, itemIds: ["a"] },
		]);
	});

	test("clips intervals to the window and pads after the turn", () => {
		const result = partitionTimeline({
			startMs: 10,
			endMs: 50,
			padEndMs: 80,
			intervals: [{ category: "model_wait", startMs: 0, endMs: 20, itemId: "m" }],
		});
		assertContinuous(result.segments, 10, 80);
		expect(result.segments[0]).toEqual({
			category: "model_wait",
			startMs: 10,
			endMs: 20,
			itemIds: ["m"],
		});
		expect(result.segments[result.segments.length - 1].category).toBe("after_turn");
		expect(result.totals.after_turn).toBe(30);
	});

	test("caps the segment count while staying continuous", () => {
		const intervals = Array.from({ length: 500 }, (_, i) => ({
			category: "tool" as const,
			startMs: i * 10,
			endMs: i * 10 + 5,
			itemId: `t${i}`,
		}));
		const result = partitionTimeline({ startMs: 0, endMs: 5000, intervals, maxSegments: 100 });
		expect(result.truncated).toBe(true);
		expect(result.segments.length).toBeLessThanOrEqual(100);
		assertContinuous(result.segments, 0, 5000);
		const total = Object.values(result.totals).reduce((sum, v) => sum + (v ?? 0), 0);
		expect(total).toBe(5000);
	});

	test("an empty or inverted window yields no segments", () => {
		expect(partitionTimeline({ startMs: 10, endMs: 10, intervals: [] }).segments).toEqual([]);
	});
});
