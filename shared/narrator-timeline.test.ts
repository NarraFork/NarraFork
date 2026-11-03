import { describe, expect, test } from "bun:test";
import {
	partitionTimeline,
	TIMELINE_MERGED_MAX_ITEMS,
	type TimelineSegment,
} from "./narrator-timeline";

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

	test("coarsening keeps exact totals and marks merged runs", () => {
		// 1500 half-busy seconds: 3000 alternating slivers of equal length.
		const intervals = Array.from({ length: 1500 }, (_, i) => ({
			category: "tool" as const,
			startMs: i * 1000,
			endMs: i * 1000 + 500,
			itemId: `t${i}`,
		}));
		const result = partitionTimeline({ startMs: 0, endMs: 1_500_000, intervals });
		expect(result.truncated).toBe(true);
		expect(result.segments.length).toBeLessThanOrEqual(2000);
		expect(result.segments.length).toBeGreaterThan(500);
		assertContinuous(result.segments, 0, 1_500_000);
		expect(result.totals).toEqual({ tool: 750_000, overhead: 750_000 });
		const merged = result.segments.find((segment) => segment.merged);
		expect(merged?.merged?.count).toBeGreaterThan(1);
		expect(merged?.itemIds.length).toBeLessThanOrEqual(TIMELINE_MERGED_MAX_ITEMS);
	});

	test("never exceeds the cap, whatever the distribution", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		for (const max of [2, 3, 10, 101, 500]) {
			for (let round = 0; round < 5; round++) {
				const intervals = [];
				let at = 0;
				for (let i = 0; i < 3000; i++) {
					// Mostly slivers with the occasional long block.
					const length = random() < 0.02 ? 50_000 * random() : 10 * random();
					intervals.push({
						category: random() < 0.5 ? ("tool" as const) : ("model_output" as const),
						startMs: at,
						endMs: at + length,
						itemId: `i${i}`,
					});
					at += length + (random() < 0.5 ? 3 * random() : 0);
				}
				const result = partitionTimeline({ startMs: 0, endMs: at, intervals, maxSegments: max });
				expect(result.segments.length).toBeLessThanOrEqual(max);
				assertContinuous(result.segments, 0, at);
				const total = Object.values(result.totals).reduce((sum, v) => sum + (v ?? 0), 0);
				expect(total).toBeCloseTo(at, 6);
			}
		}
	});

	test("an empty or inverted window yields no segments", () => {
		expect(partitionTimeline({ startMs: 10, endMs: 10, intervals: [] }).segments).toEqual([]);
	});
});
