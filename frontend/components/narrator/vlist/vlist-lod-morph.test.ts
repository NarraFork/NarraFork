import { describe, expect, it } from "bun:test";
import {
	buildLodSnapshots,
	diffLodSnapshots,
	LOD_MORPH_DURATION_MS,
	type LodElementSource,
} from "./vlist-lod-morph";

function el(unitId: string | null | undefined, top: number, height: number): LodElementSource {
	return { unitId, top, height };
}

describe("buildLodSnapshots", () => {
	it("snapshots unitId-bearing elements, viewport-anchored", () => {
		const next = buildLodSnapshots([el("tool-a", 100, 40)], 0, 800);
		expect(next.get("tool-a")).toEqual({ unitId: "tool-a", viewportTop: 100, height: 40 });
	});

	it("skips elements without a unitId", () => {
		const next = buildLodSnapshots([el(null, 100, 40), el(undefined, 200, 40)], 0, 800);
		expect(next.size).toBe(0);
	});

	it("crops to the viewport×3 window (one screen above + viewport + one below)", () => {
		// viewportHeight 800, scrollTop 1600 → window is [800, 3200).
		const elements = [
			el("tool-before", 700, 40), // bottom 740 < minY 800 → out
			el("tool-in-above", 770, 40), // bottom 810 > minY → in
			el("tool-view", 1600, 40), // in
			el("tool-in-below", 3199, 40), // top 3199 < maxY 3200 → in
			el("tool-after", 3200, 40), // top >= maxY → out
		];
		const next = buildLodSnapshots(elements, 1600, 800);
		expect([...next.keys()].sort()).toEqual(["tool-in-above", "tool-in-below", "tool-view"]);
	});

	it("subtracts scrollTop so snapshots are viewport-anchored", () => {
		const a = buildLodSnapshots([el("tool-a", 1000, 40)], 0, 800);
		const b = buildLodSnapshots([el("tool-a", 1000, 40)], 480, 800);
		expect(b.get("tool-a")?.viewportTop).toBeCloseTo((a.get("tool-a")?.viewportTop ?? 0) - 480, 5);
	});

	it("keeps the first occurrence of a duplicated unitId", () => {
		const next = buildLodSnapshots([el("tool-a", 100, 40), el("tool-a", 300, 40)], 0, 800);
		expect(next.get("tool-a")?.viewportTop).toBe(100);
	});
});

describe("diffLodSnapshots", () => {
	it("plans a morph for a paired unitId that moved", () => {
		const prev = buildLodSnapshots([el("tool-a", 100, 40)], 0, 800);
		const next = buildLodSnapshots([el("tool-a", 300, 40)], 0, 800);
		const plans = diffLodSnapshots(prev, next);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toEqual({
			unitId: "tool-a",
			deltaY: -200, // before 100 − after 300 → slides down 200 into place
			durationMs: LOD_MORPH_DURATION_MS,
		});
	});

	it("plans one morph per paired element (a level switch re-themes many at once)", () => {
		const prev = buildLodSnapshots([el("a", 100, 40), el("b", 200, 40), el("c", 300, 40)], 0, 800);
		const next = buildLodSnapshots([el("a", 110, 40), el("b", 240, 40), el("c", 390, 40)], 0, 800);
		const plans = diffLodSnapshots(prev, next);
		expect(plans.map((p) => p.unitId).sort()).toEqual(["a", "b", "c"]);
		expect(plans.every((p) => p.durationMs === LOD_MORPH_DURATION_MS)).toBe(true);
	});

	it("skips a unitId present in only one frame (no counterpart to morph)", () => {
		const prev = buildLodSnapshots([el("tool-a", 100, 40)], 0, 800);
		const next = buildLodSnapshots([el("tool-b", 100, 40)], 0, 800);
		expect(diffLodSnapshots(prev, next)).toHaveLength(0);
	});

	it("skips sub-pixel moves (invisible, but still costs a layer)", () => {
		const prev = buildLodSnapshots([el("tool-a", 100, 40)], 0, 800);
		const next = buildLodSnapshots([el("tool-a", 100.4, 40)], 0, 800);
		expect(diffLodSnapshots(prev, next)).toHaveLength(0);
	});
});
