import { afterEach, describe, expect, it } from "bun:test";
import { bareRowMetrics } from "@shared/pretext-layout/row-metrics";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import { headerRowHeight } from "./measure/measure-tool-call";
import {
	buildDrillSnapshots,
	DRILL_ROW_HEIGHT,
	type DrillTraceSource,
	diffDrillSnapshots,
	drillRowHeight,
	HEADER_MORPH_DURATION_MS,
} from "./vlist-drill-morph";

const HEADER = { top: 11, height: 19 }; // CARD_BORDER(1)+CARD_PADDING(10) at neutral

function trace(traceKey: string, top: number, rows: DrillTraceSource["rows"]): DrillTraceSource {
	return { traceKey, top, rows };
}

afterEach(() => {
	resetTypographyForTest();
});

describe("buildDrillSnapshots", () => {
	it("folded rows snapshot their summary-line centre", () => {
		const next = buildDrillSnapshots(
			[trace("t", 100, [{ key: "r0", top: 24.8, drilled: false, drillHeader: null }])],
			0,
		);
		const snap = next.get("t::r0");
		expect(snap?.drilled).toBe(false);
		// 100 + 24.8 + live folded height / 2
		expect(snap?.headerViewportTop).toBeCloseTo(100 + 24.8 + drillRowHeight() / 2, 5);
		expect(drillRowHeight()).toBeCloseTo(DRILL_ROW_HEIGHT, 5);
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

	it("prefers the layout's measured rowHeight over the live fallback", () => {
		const next = buildDrillSnapshots(
			[
				trace("t", 0, [
					{
						key: "r0",
						top: 0,
						rowHeight: 42,
						drilled: false,
						drillHeader: null,
					},
				]),
			],
			0,
		);
		expect(next.get("t::r0")?.headerViewportTop).toBeCloseTo(21, 5);
	});

	it("tracks typography: folded centres follow the scaled bare-row height", () => {
		setTypography({ fontScalePercent: 150, lineHeightScalePercent: 150 });
		const live = drillRowHeight();
		expect(live).toBeCloseTo(bareRowMetrics().height, 5);
		// 150% font × 150% line-height on xs: the text lane grows past the frozen 18.8.
		expect(live).toBeGreaterThan(DRILL_ROW_HEIGHT);

		const next = buildDrillSnapshots(
			[trace("t", 100, [{ key: "r0", top: 0, drilled: false, drillHeader: null }])],
			0,
		);
		expect(next.get("t::r0")?.headerViewportTop).toBeCloseTo(100 + live / 2, 5);

		// Card-header height must scale on the SAME axes, or the morph would still
		// animate to a frozen 19px endpoint after the folded side moved.
		const cardH = headerRowHeight();
		expect(cardH).toBeGreaterThan(19);
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
		const plan = plans[0];
		expect(plan).toBeDefined();
		if (!plan) return;
		expect(plan.kind).toBe("expand");
		expect(plan.rowUid).toBe("t::r0");
		// Card header centre − live summary centre.
		expect(plan.driftY).toBeCloseTo(HEADER.top + HEADER.height / 2 - drillRowHeight() / 2, 5);
		expect(plan.driftY).toBeGreaterThan(0);
		expect(plan.durationMs).toBe(HEADER_MORPH_DURATION_MS);
	});

	it("recomputes expand drift under scaled typography", () => {
		setTypography({ fontScalePercent: 140, lineHeightScalePercent: 160 });
		const foldedH = drillRowHeight();
		const cardH = headerRowHeight();
		const foldedRow = trace("t", 100, [
			{ key: "r0", top: 0, drilled: false, rowHeight: foldedH, drillHeader: null },
		]);
		const drilledRow = trace("t", 100, [
			{
				key: "r0",
				top: 0,
				drilled: true,
				rowHeight: foldedH,
				drillHeader: { top: 11, height: cardH },
			},
		]);
		const plan = diffDrillSnapshots(
			buildDrillSnapshots([foldedRow], 0),
			buildDrillSnapshots([drilledRow], 0),
		)[0];
		expect(plan).toBeDefined();
		if (!plan) return;
		expect(plan.kind).toBe("expand");
		// Centres are derived from the LIVE pair, not the frozen 18.8 / 19 pair.
		expect(plan.driftY).toBeCloseTo(11 + cardH / 2 - foldedH / 2, 5);
		expect(plan.driftY).not.toBeCloseTo(11 + 19 / 2 - DRILL_ROW_HEIGHT / 2, 1);
	});

	it("keeps collapse header travel local when pinned-bottom scrollTop changes", () => {
		const collapse = diffDrillSnapshots(
			buildDrillSnapshots(
				[
					trace("t", 100, [
						{
							key: "r0",
							top: 24.8,
							drilled: true,
							blockHeight: 400,
							drillHeader: HEADER,
						},
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
		)[0];
		expect(collapse).toBeDefined();
		if (!collapse) return;
		expect(collapse.kind).toBe("collapse");
		// Local card-header → summary delta, independent of the viewport scroll jump.
		expect(collapse.driftY).toBeCloseTo(drillRowHeight() / 2 - (HEADER.top + HEADER.height / 2), 5);
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
		const plan = diffDrillSnapshots(before, after)[0];
		expect(plan).toBeDefined();
		if (!plan) return;
		expect(plan.driftY).not.toBe(0);
	});

	it("plans one morph PER flipped row — stacked activity is native", () => {
		const before = buildDrillSnapshots(
			[
				trace("t", 0, [
					{ key: "r0", top: 0, drilled: false, drillHeader: null },
					{ key: "r1", top: drillRowHeight(), drilled: false, drillHeader: null },
				]),
			],
			0,
		);
		const after = buildDrillSnapshots(
			[
				trace("t", 0, [
					{ key: "r0", top: 0, drilled: true, drillHeader: HEADER },
					{ key: "r1", top: drillRowHeight(), drilled: true, drillHeader: HEADER },
				]),
			],
			0,
		);
		const plans = diffDrillSnapshots(before, after);
		expect(plans).toHaveLength(2);
		expect(plans.map((p) => p.rowUid).sort()).toEqual(["t::r0", "t::r1"]);
	});
});
