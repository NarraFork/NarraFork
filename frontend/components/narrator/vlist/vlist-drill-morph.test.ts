import { describe, expect, it } from "bun:test";
import {
	buildDrillSnapshots,
	DRILL_ROW_HEIGHT,
	type DrillTraceSource,
	diffDrillSnapshots,
	HEADER_MORPH_DURATION_MS,
} from "./vlist-drill-morph";

const HEADER = { top: 11, height: 19 }; // CARD_BORDER(1)+CARD_PADDING(10), HEADER_ROW_HEIGHT(19)

function trace(traceKey: string, top: number, rows: DrillTraceSource["rows"]): DrillTraceSource {
	return { traceKey, top, rows };
}

describe("buildDrillSnapshots", () => {
	it("folded rows snapshot their summary-line centre", () => {
		const next = buildDrillSnapshots(
			[trace("t", 100, [{ key: "r0", top: 24.8, drilled: false, drillHeader: null }])],
			0,
		);
		const snap = next.get("t::r0");
		expect(snap?.drilled).toBe(false);
		// 100 + 24.8 + 18.8/2
		expect(snap?.headerViewportTop).toBeCloseTo(100 + 24.8 + DRILL_ROW_HEIGHT / 2, 5);
	});

	it("drilled rows snapshot their card-header centre", () => {
		const next = buildDrillSnapshots(
			[trace("t", 100, [{ key: "r0", top: 24.8, drilled: true, drillHeader: HEADER }])],
			0,
		);
		const snap = next.get("t::r0");
		expect(snap?.drilled).toBe(true);
		// 100 + 24.8 + 11 + 19/2
		expect(snap?.headerViewportTop).toBeCloseTo(100 + 24.8 + HEADER.top + HEADER.height / 2, 5);
	});

	it("subtracts scrollTop so snapshots are viewport-anchored", () => {
		const rows: DrillTraceSource["rows"] = [
			{ key: "r0", top: 24.8, drilled: false, drillHeader: null },
		];
		const noScroll = buildDrillSnapshots([trace("t", 500, rows)], 0);
		const scrolled = buildDrillSnapshots([trace("t", 500, rows)], 480);
		expect(scrolled.get("t::r0")?.headerViewportTop).toBeCloseTo(
			(noScroll.get("t::r0")?.headerViewportTop ?? 0) - 480,
			5,
		);
	});

	it("keys snapshots by trace::row so rows in different traces never collide", () => {
		const next = buildDrillSnapshots(
			[
				trace("a", 0, [{ key: "r0", top: 0, drilled: false, drillHeader: null }]),
				trace("b", 40, [{ key: "r0", top: 0, drilled: false, drillHeader: null }]),
			],
			0,
		);
		expect(next.has("a::r0")).toBe(true);
		expect(next.has("b::r0")).toBe(true);
		expect(next.get("a::r0")?.headerViewportTop).not.toBe(next.get("b::r0")?.headerViewportTop);
	});
});

describe("diffDrillSnapshots", () => {
	const folded = trace("t", 100, [{ key: "r0", top: 24.8, drilled: false, drillHeader: null }]);
	const drilled = trace("t", 100, [{ key: "r0", top: 24.8, drilled: true, drillHeader: HEADER }]);

	it("plans an expand morph when a row flips folded → drilled", () => {
		const plans = diffDrillSnapshots(
			buildDrillSnapshots([folded], 0),
			buildDrillSnapshots([drilled], 0),
		);
		expect(plans).toHaveLength(1);
		const plan = plans[0]!;
		expect(plan.kind).toBe("expand");
		expect(plan.rowUid).toBe("t::r0");
		// Card header centre − summary centre = (11 + 9.5) − 9.4 = 11.1 (DOWN).
		expect(plan.driftY).toBeCloseTo(HEADER.top + HEADER.height / 2 - DRILL_ROW_HEIGHT / 2, 5);
		expect(plan.driftY).toBeGreaterThan(0);
		expect(plan.durationMs).toBe(HEADER_MORPH_DURATION_MS);
	});

	it("keeps collapse header travel local when pinned-bottom scrollTop changes", () => {
		const collapse = diffDrillSnapshots(
			buildDrillSnapshots(
				[
					trace("t", 100, [
						{ key: "r0", top: 24.8, drilled: true, blockHeight: 400, drillHeader: HEADER },
					]),
				],
				1000,
			),
			buildDrillSnapshots(
				[
					trace("t", 100, [
						{
							key: "r0",
							top: 24.8,
							drilled: false,
							blockHeight: DRILL_ROW_HEIGHT,
							drillHeader: null,
						},
					]),
				],
				600,
			),
		)[0]!;
		expect(collapse.kind).toBe("collapse");
		// The viewport moved by 400px, but the header morph remains the local
		// card-header → summary delta, so it stays inside the shrinking clip.
		expect(collapse.driftY).toBeCloseTo(-11.1, 5);
	});

	it("drops expand travel when the old summary is outside the after block clip", () => {
		const before = buildDrillSnapshots(
			[
				trace("t", 100, [
					{
						key: "r0",
						top: 24.8,
						drilled: false,
						blockHeight: DRILL_ROW_HEIGHT,
						drillHeader: null,
					},
				]),
			],
			0,
		);
		const after = buildDrillSnapshots(
			[
				trace("t", 100, [
					{ key: "r0", top: 24.8, drilled: true, blockHeight: 400, drillHeader: HEADER },
				]),
			],
			500,
		);
		expect(diffDrillSnapshots(before, after)[0]).toMatchObject({ kind: "expand", driftY: 0 });
	});

	it("keeps expand travel when the old summary still overlaps the after block", () => {
		const before = buildDrillSnapshots(
			[
				trace("t", 100, [
					{
						key: "r0",
						top: 24.8,
						drilled: false,
						blockHeight: DRILL_ROW_HEIGHT,
						drillHeader: null,
					},
				]),
			],
			0,
		);
		const after = buildDrillSnapshots(
			[
				trace("t", 100, [
					{ key: "r0", top: 24.8, drilled: true, blockHeight: 400, drillHeader: HEADER },
				]),
			],
			100,
		);
		const plan = diffDrillSnapshots(before, after)[0]!;
		expect(plan.driftY).not.toBe(0);
	});

	it("plans one morph PER flipped row — stacked activity is native", () => {
		const before = buildDrillSnapshots(
			[
				trace("t", 0, [
					{ key: "r0", top: 0, drilled: false, drillHeader: null },
					{ key: "r1", top: 18.8, drilled: false, drillHeader: null },
				]),
			],
			0,
		);
		// Both rows drill in the same frame (e.g. a fast double-toggle).
		const after = buildDrillSnapshots(
			[
				trace("t", 0, [
					{ key: "r0", top: 0, drilled: true, drillHeader: HEADER },
					{ key: "r1", top: 218.8, drilled: true, drillHeader: HEADER },
				]),
			],
			0,
		);
		const plans = diffDrillSnapshots(before, after);
		expect(plans.map((p) => p.rowUid).sort()).toEqual(["t::r0", "t::r1"]);
		expect(plans.every((p) => p.kind === "expand")).toBe(true);
	});

	it("skips rows that did not flip", () => {
		const a = buildDrillSnapshots([folded], 0);
		const b = buildDrillSnapshots([folded], 0);
		expect(diffDrillSnapshots(a, b)).toHaveLength(0);
	});

	it("skips rows present in only one frame (no counterpart to morph)", () => {
		const before = buildDrillSnapshots([folded], 0);
		const after = buildDrillSnapshots(
			[
				trace("t", 100, [
					{ key: "r0", top: 24.8, drilled: false, drillHeader: null },
					// A NEW row appears drilled — nothing to morph from, so it is skipped.
					{ key: "r1", top: 43.6, drilled: true, drillHeader: HEADER },
				]),
			],
			0,
		);
		expect(diffDrillSnapshots(before, after)).toHaveLength(0);
	});
});
