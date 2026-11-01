import { describe, expect, test } from "bun:test";
import type { TimelineLane } from "@shared/narrator-timeline";
import {
	branchConnectors,
	chooseTickStep,
	clampPxPerSec,
	connectorPath,
	fitPxPerSec,
	formatSpan,
	laneCenterY,
	MAX_PX_PER_SEC,
	ticks,
	timeToX,
} from "./timeline-layout";

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
