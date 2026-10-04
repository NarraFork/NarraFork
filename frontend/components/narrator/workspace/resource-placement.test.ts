import { describe, expect, test } from "bun:test";
import {
	computeResourceFloatingBounds,
	computeResourceSplitPlacement,
	floatingResourceBounds,
	type ResourceGroupRect,
	rankResourceTargetGroups,
	rankResourceTargets,
	resourceSplitDirection,
	selectResourceTargetGroup,
} from "./resource-placement";

function group(
	id: string,
	left: number,
	top: number,
	width = 100,
	height = 100,
): ResourceGroupRect {
	return { id, left, top, width, height };
}

const source = group("source", 200, 200, 200, 200);

// These tests use no DOM/Dockview state; callers separately enforce grid/lock eligibility.
describe("resource target geometry", () => {
	test("orders shared-edge neighbors right, left, below, above before non-neighbors", () => {
		const candidates = [
			group("above", 200, 100),
			group("left", 100, 200),
			group("below", 200, 400),
			group("right", 400, 200),
			group("near-but-not-adjacent", 250, 250),
		];
		expect(rankResourceTargetGroups(source, candidates)).toEqual([
			"right",
			"left",
			"below",
			"above",
			"near-but-not-adjacent",
		]);
		expect(selectResourceTargetGroup(source, candidates)).toBe("right");
	});

	test("prefers longer overlap before distance within one direction", () => {
		const candidates = [
			group("short-near", 400, 250, 20, 50),
			group("long-far", 400, 200, 600, 200),
		];
		expect(rankResourceTargetGroups(source, candidates)).toEqual(["long-far", "short-near"]);
	});

	test("prefers shorter distance for equal direction and overlap", () => {
		const candidates = [group("a-far", 400, 200, 500), group("z-near", 400, 200)];
		expect(rankResourceTargetGroups(source, candidates)).toEqual(["z-near", "a-far"]);
	});

	test("uses stable codepoint ids, not iteration order or locale", () => {
		const candidates = [group("z", 400, 200), group("A", 400, 200), group("a", 400, 200)];
		const original = [...candidates];
		expect(rankResourceTargetGroups(source, candidates)).toEqual(["A", "a", "z"]);
		expect(rankResourceTargetGroups(source, [...candidates].reverse())).toEqual(["A", "a", "z"]);
		expect(candidates).toEqual(original);
		expect(rankResourceTargets(source, candidates)[0]).toBe(candidates[1]);
	});

	test("accepts the divider and subpixel rounding tolerance", () => {
		const candidates = [group("right-divider", 404, 200), group("left", 100, 200)];
		expect(selectResourceTargetGroup(source, candidates)).toBe("right-divider");
		expect(selectResourceTargetGroup(source, candidates, { edgeTolerance: 0 })).toBe("left");
		expect(selectResourceTargetGroup(source, [group("rounded", 399.5, 200)])).toBe("rounded");
	});

	test("does not treat a corner touch or a diagonal as a shared edge", () => {
		const candidates = [group("corner", 400, 400), group("left", 100, 200)];
		expect(selectResourceTargetGroup(source, candidates)).toBe("left");
	});

	test("does not confuse a separated right group with a neighbor", () => {
		expect(
			selectResourceTargetGroup(source, [group("right-far", 405, 200), group("left", 100, 200)]),
		).toBe("left");
	});

	test("without shared edges falls back to nearest center, then stable id", () => {
		const candidates = [
			group("far", 800, 800),
			group("z-near", 410, 250),
			group("a-near", 410, 250),
		];
		expect(rankResourceTargetGroups(source, candidates)).toEqual(["a-near", "z-near", "far"]);
	});

	test("does not mistake coincident small rectangles for shared-edge neighbors", () => {
		const tinySource = group("source", 0, 0, 2, 2);
		const candidates = [group("coincident", 0, 0, 2, 2), group("left", -2, 0, 2, 2)];
		expect(rankResourceTargetGroups(tinySource, candidates)).toEqual(["left", "coincident"]);
	});

	test("excludes the source id even when presented with different geometry", () => {
		expect(selectResourceTargetGroup(source, [group("source", 400, 200)])).toBeNull();
		expect(selectResourceTargetGroup(source, [source, group("other", 400, 200)])).toBe("other");
	});

	test("drops invalid targets and empty ids", () => {
		const candidates = [
			group("zero-width", 400, 200, 0),
			group("zero-height", 400, 200, 100, 0),
			group("negative", 400, 200, -1),
			group("nan", Number.NaN, 200),
			group("infinite", 400, 200, Number.POSITIVE_INFINITY),
			group("", 400, 200),
		];
		expect(rankResourceTargets(source, candidates)).toEqual([]);
		expect(selectResourceTargetGroup(source, candidates)).toBeNull();
	});

	test("returns no target without valid source measurements or candidates", () => {
		const candidates = [group("right", 400, 200)];
		for (const invalid of [undefined, group("source", 0, 0, 0), group("source", 0, Number.NaN)]) {
			expect(rankResourceTargets(invalid, candidates)).toEqual([]);
			expect(selectResourceTargetGroup(invalid, candidates)).toBeNull();
		}
		expect(selectResourceTargetGroup(source, [])).toBeNull();
	});
});

describe("temporary floating bounds", () => {
	test("uses a centered 560x420 default without a source", () => {
		expect(floatingResourceBounds(1200, 800)).toEqual({ x: 320, y: 190, width: 560, height: 420 });
	});

	test("positions beside the source on the right when possible", () => {
		expect(floatingResourceBounds(1400, 900, group("s", 100, 120, 400, 500))).toEqual({
			x: 508,
			y: 120,
			width: 560,
			height: 420,
		});
	});

	test("uses the left when the right side has no room", () => {
		expect(floatingResourceBounds(1400, 900, group("s", 800, 120, 400, 500))?.x).toBe(232);
	});

	test("falls back below, then above if neither side fits", () => {
		expect(floatingResourceBounds(700, 1000, group("s", 100, 100, 500, 200))).toEqual({
			x: 100,
			y: 308,
			width: 560,
			height: 420,
		});
		expect(floatingResourceBounds(700, 1000, group("s", 100, 600, 500, 200))?.y).toBe(172);
	});

	test("clamps the orthogonal axis without giving up a usable right placement", () => {
		expect(floatingResourceBounds(1400, 900, group("s", 100, 800, 400, 100))).toEqual({
			x: 508,
			y: 480,
			width: 560,
			height: 420,
		});
	});

	test("fills the width on narrow screens and never exceeds short screens", () => {
		expect(floatingResourceBounds(320, 640, source)).toEqual({
			x: 0,
			y: 200,
			width: 320,
			height: 420,
		});
		expect(floatingResourceBounds(320, 200, source)).toEqual({
			x: 0,
			y: 0,
			width: 320,
			height: 200,
		});
	});

	test("invalid source geometry uses the centered default", () => {
		expect(floatingResourceBounds(1200, 800, group("s", Number.NaN, 0))).toEqual(
			floatingResourceBounds(1200, 800),
		);
	});

	test("rejects unavailable workspace measurements", () => {
		for (const [width, height] of [
			[0, 800],
			[1200, 0],
			[-10, 50],
			[Number.NaN, 50],
			[50, Number.POSITIVE_INFINITY],
		]) {
			expect(floatingResourceBounds(width, height)).toBeNull();
		}
	});

	test("keeps all bounds inside the workspace across screen sizes and offscreen sources", () => {
		for (const width of [1, 320, 560, 700, 1920]) {
			for (const height of [1, 200, 420, 900]) {
				for (const origin of [undefined, group("s", -500, -500), group("s", 5000, 5000), source]) {
					const bounds = computeResourceFloatingBounds({
						workspaceWidth: width,
						workspaceHeight: height,
						source: origin,
					});
					expect(bounds).not.toBeNull();
					if (!bounds) throw new Error("Expected floating bounds");
					expect(bounds.left).toBeGreaterThanOrEqual(0);
					expect(bounds.top).toBeGreaterThanOrEqual(0);
					expect(bounds.left + bounds.width).toBeLessThanOrEqual(width);
					expect(bounds.top + bounds.height).toBeLessThanOrEqual(height);
				}
			}
		}
	});
});

describe("explicit source split", () => {
	test("prefers right when both directions can satisfy both pane minimums", () => {
		expect(computeResourceSplitPlacement({ width: 1000, height: 800 })).toEqual({
			direction: "right",
			sourceSize: { width: 498, height: 800 },
			newSize: { width: 498, height: 800 },
		});
		expect(resourceSplitDirection({ width: 1000, height: 800 })).toBe("right");
	});

	test("selects below when right cannot meet width minimums", () => {
		expect(computeResourceSplitPlacement({ width: 400, height: 800 })).toEqual({
			direction: "below",
			sourceSize: { width: 400, height: 398 },
			newSize: { width: 400, height: 398 },
		});
		expect(resourceSplitDirection({ width: 400, height: 800 })).toBe("below");
	});

	test("includes the divider in exact minimum thresholds", () => {
		expect(resourceSplitDirection({ width: 564, height: 180 })).toBe("right");
		expect(resourceSplitDirection({ width: 563, height: 180 })).toBeNull();
		expect(resourceSplitDirection({ width: 280, height: 364 })).toBe("below");
		expect(resourceSplitDirection({ width: 280, height: 363 })).toBeNull();
	});

	test("does not split when even the untouched dimension cannot meet minimums", () => {
		expect(resourceSplitDirection({ width: 1000, height: 179 })).toBeNull();
		expect(resourceSplitDirection({ width: 279, height: 1000 })).toBeNull();
		expect(resourceSplitDirection({ width: 400, height: 300 })).toBeNull();
	});

	test("balances asymmetric width minimums without squeezing either pane", () => {
		expect(
			computeResourceSplitPlacement(
				{ width: 900, height: 400 },
				{
					sourceMinimum: { width: 600, height: 200 },
					resourceMinimum: { width: 280, height: 180 },
					gap: 8,
				},
			),
		).toEqual({
			direction: "right",
			sourceSize: { width: 600, height: 400 },
			newSize: { width: 292, height: 400 },
		});
	});

	test("balances asymmetric height minimums and checks the resource minimum too", () => {
		const options = {
			sourceMinimum: { width: 300, height: 180 },
			resourceMinimum: { width: 280, height: 500 },
		};
		expect(computeResourceSplitPlacement({ width: 400, height: 704 }, options)).toEqual({
			direction: "below",
			sourceSize: { width: 400, height: 200 },
			newSize: { width: 400, height: 500 },
		});
		expect(resourceSplitDirection({ width: 400, height: 600 }, options)).toBeNull();
	});

	test("supports an explicit zero divider", () => {
		expect(resourceSplitDirection({ width: 560, height: 180 }, { gap: 0 })).toBe("right");
	});

	test("rejects invalid source sizes and minimums", () => {
		for (const invalid of [
			undefined,
			{ width: 0, height: 800 },
			{ width: 1000, height: Number.NaN },
			{ width: Number.POSITIVE_INFINITY, height: 800 },
		]) {
			expect(resourceSplitDirection(invalid)).toBeNull();
		}
		expect(
			resourceSplitDirection(
				{ width: 1000, height: 800 },
				{ sourceMinimum: { width: -1, height: 100 } },
			),
		).toBeNull();
		expect(
			resourceSplitDirection(
				{ width: 1000, height: 800 },
				{ resourceMinimum: { width: 100, height: Number.NaN } },
			),
		).toBeNull();
	});
});
