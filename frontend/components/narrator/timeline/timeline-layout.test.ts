import { describe, expect, test } from "bun:test";
import type { TimelineLane, TimelineSegment } from "@shared/narrator-timeline";
import {
	branchConnectors,
	chooseTickStep,
	clampPxPerSec,
	connectorPath,
	fitPxPerSec,
	formatSpan,
	laneCenterY,
	MAX_CONTENT_PX,
	MAX_PX_PER_SEC,
	segmentIndexAt,
	ticks,
	timeToX,
	visibleSegmentIndices,
} from "./timeline-layout";

function seg(startMs: number, endMs: number): TimelineSegment {
	return { category: "tool", startMs, endMs, itemIds: [] };
}

function lane(over: Partial<TimelineLane>): TimelineLane {
	return {
		narratorId: "n",
		title: null,
		type: "primary",
		subagentType: null,
		depth: 0,
		parentNarratorId: null,
		spawnItemId: null,
		spawnAtMs: null,
		startMs: 0,
		endMs: 10_000,
		live: false,
		segments: [],
		totals: {},
		truncated: false,
		coveredUntilMs: null,
		...over,
	};
}

describe("timeline layout", () => {
	test("fit and clamp", () => {
		expect(fitPxPerSec(10_000, 500)).toBe(50);
		expect(clampPxPerSec(1e9)).toBe(MAX_PX_PER_SEC);
		expect(fitPxPerSec(0, 500)).toBe(1);
	});

	test("time to x", () => {
		expect(timeToX(3000, 1000, 10)).toBe(20);
	});

	test("tick step keeps labels apart", () => {
		expect(chooseTickStep(10)).toBe(10_000);
		expect(chooseTickStep(1000)).toBe(100);
		expect(ticks(2500, 1000)).toEqual([0, 1000, 2000]);
	});

	test("ticks cover only the requested window and stay bounded", () => {
		expect(ticks(10_000, 1000, 2500, 5000)).toEqual([3000, 4000, 5000]);
		expect(ticks(10_000, 1000, 9500, 20_000)).toEqual([10_000]);
		expect(ticks(1e12, 1, 0, 1e12)).toHaveLength(400);
		expect(ticks(1000, 0)).toEqual([]);
	});

	test("caps zoom so the track stays within the max content width", () => {
		const spanMs = 24 * 3600_000;
		const px = clampPxPerSec(MAX_PX_PER_SEC, spanMs);
		expect((spanMs / 1000) * px).toBeLessThanOrEqual(MAX_CONTENT_PX + 1e-6);
		expect(clampPxPerSec(5, 10_000)).toBe(5);
	});

	test("draws only segments in the pixel window, merging slivers", () => {
		const segments = [
			seg(0, 1000),
			seg(1000, 1001),
			seg(1001, 1005),
			seg(1005, 3000),
			seg(3000, 9000),
		];
		// 1 px per 10 ms: the two short segments fall under one pixel, the longer one wins.
		expect(visibleSegmentIndices(segments, 0, 100, 0, 1000)).toEqual([0, 2, 3, 4]);
		expect(visibleSegmentIndices(segments, 0, 100, 150, 250)).toEqual([3]);
		expect(visibleSegmentIndices(segments, 0, 100, 900, 1000)).toEqual([]);
	});

	test("visible segment count is bounded by window width", () => {
		const segments = Array.from({ length: 100_000 }, (_, i) => seg(i, i + 1));
		const out = visibleSegmentIndices(segments, 0, 10, 0, 500);
		expect(out.length).toBeLessThanOrEqual(500);
		expect(out.length).toBeGreaterThan(0);
	});

	test("finds a segment by start", () => {
		const segments = [seg(0, 10), seg(10, 20), seg(20, 30)];
		expect(segmentIndexAt(segments, 10)).toBe(1);
		expect(segmentIndexAt(segments, 20)).toBe(2);
		expect(segmentIndexAt(segments, 15)).toBe(-1);
		expect(segmentIndexAt([], 0)).toBe(-1);
	});

	test("formats spans", () => {
		expect(formatSpan(850)).toBe("850ms");
		expect(formatSpan(12_300)).toBe("12s");
		expect(formatSpan(4_300)).toBe("4.3s");
		expect(formatSpan(245_000)).toBe("4m 05s");
		expect(formatSpan(3_720_000)).toBe("1h 02m");
	});

	test("connects each child to its parent spawn point", () => {
		const lanes = [
			lane({ narratorId: "p" }),
			lane({ narratorId: "c", parentNarratorId: "p", spawnAtMs: 2000, startMs: 2500, depth: 1 }),
			lane({ narratorId: "orphan", parentNarratorId: "gone", spawnAtMs: 1000, depth: 1 }),
		];
		const connectors = branchConnectors(lanes, 0, 10);
		expect(connectors).toHaveLength(1);
		expect(connectors[0]).toMatchObject({
			childNarratorId: "c",
			x1: 20,
			x2: 25,
			y2: laneCenterY(1),
		});
		expect(connectorPath(connectors[0])).toBe(
			`M 20 ${connectors[0].y1} L 20 ${laneCenterY(1)} L 25 ${laneCenterY(1)}`,
		);
	});
});
