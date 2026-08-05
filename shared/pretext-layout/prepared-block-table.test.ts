/**
 * prepared-block-table.test.ts — The table column solver and table geometry.
 *
 * Tables are the one markdown shape whose real CSS layout (`table-layout: auto`)
 * is not reproducible arithmetically, so the vlist path solves columns itself and
 * paints without a `<table>`. These tests pin the solver's three regimes and the
 * height model built on top of them.
 *
 * The resolver is injected, so no canvas / pretext stub is needed here: intrinsic
 * widths are supplied directly and line counts come from a fake that derives them
 * from the width it is handed. That keeps the assertions about the MODEL (which is
 * what can regress) rather than about font metrics.
 */

import { describe, expect, it } from "bun:test";
import type {
	LineMetricsResolver,
	PreparedTableBlock,
	PreparedTableCell,
	TableMetrics,
} from "./prepared-block";
import { accumulateFrame, layoutTable, solveTableColumns } from "./prepared-block";

const base = {
	marginTop: 0,
	contentLeft: 0,
	quoteRailLefts: [],
	markerText: null,
	markerLeft: null,
	markerClassName: null,
};

const METRICS: TableMetrics = { paddingX: 10, paddingY: 7, rowBorder: 1, scrollbarHeight: 12 };

/** A cell carrying only the two intrinsic widths the solver reads. */
function cell(naturalWidth: number, minWidth: number): PreparedTableCell {
	return {
		flow: {} as PreparedTableCell["flow"],
		classNames: [],
		hrefs: [],
		fonts: [],
		naturalWidth,
		minWidth,
	};
}

function table(
	header: PreparedTableCell[],
	rows: PreparedTableCell[][],
	overrides: Partial<PreparedTableBlock> = {},
): PreparedTableBlock {
	let columns = header.length;
	for (const row of rows) if (row.length > columns) columns = row.length;
	return {
		...base,
		kind: "table",
		header,
		rows,
		align: new Array(columns).fill(null),
		columns,
		lineHeight: 20,
		...overrides,
	};
}

/**
 * Line-count fake driven by a per-cell hint carried on the flow handle. Decoupling
 * the line count from the solved width lets a test state "this cell needs N lines"
 * without also having to predict what the solver will hand it.
 */
const hintedLines: LineMetricsResolver = (block) => ({
	lineCount:
		block.kind === "inline" ? ((block.flow as unknown as { __lines?: number }).__lines ?? 1) : 1,
	maxLineWidth: 0,
});

/** A cell that reports a fixed line count through `hintedLines`. */
function cellOfLines(lines: number): PreparedTableCell {
	return { ...cell(50, 20), flow: { __lines: lines } as unknown as PreparedTableCell["flow"] };
}

const oneLine: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

describe("solveTableColumns — regime 1: natural widths fit", () => {
	it("uses natural widths verbatim when they fit the budget", () => {
		const block = table([cell(100, 20), cell(80, 20)], []);
		// budget = 400 - 2 columns * 20 chrome = 360; natural total = 180 → fits.
		expect(solveTableColumns(block, 400, METRICS)).toEqual([100, 80]);
	});

	it("takes the widest cell in a column, header included", () => {
		const block = table([cell(50, 10), cell(30, 10)], [[cell(120, 10), cell(20, 10)]]);
		expect(solveTableColumns(block, 500, METRICS)).toEqual([120, 30]);
	});

	it("accounts for per-column padding in the budget", () => {
		// natural total 360; chrome for 2 columns = 40. At 400 available the budget is
		// exactly 360, so natural still fits (boundary case).
		const block = table([cell(180, 20), cell(180, 20)], []);
		expect(solveTableColumns(block, 400, METRICS)).toEqual([180, 180]);
		// One px less and it must shrink.
		expect(solveTableColumns(block, 399, METRICS)).not.toEqual([180, 180]);
	});
});

describe("solveTableColumns — regime 2: shrink proportional to slack", () => {
	it("squeezes a high-slack column more than a low-slack one", () => {
		// budget = 300 - 40 = 260. natural total = 400, min total = 130 → regime 2.
		// excess = 140, slack = 270 (200-100 and 200-30).
		const block = table([cell(200, 100), cell(200, 30)], []);
		const [a, b] = solveTableColumns(block, 300, METRICS);
		// Column A has slack 100/270 of the total, B has 170/270, so B loses more.
		expect(a).toBeGreaterThan(b as number);
		// Neither drops below its own min.
		expect(a).toBeGreaterThanOrEqual(100);
		expect(b).toBeGreaterThanOrEqual(30);
	});

	it("never returns a column narrower than its min width", () => {
		const block = table([cell(400, 90), cell(400, 90)], []);
		const widths = solveTableColumns(block, 260, METRICS);
		for (const width of widths) expect(width).toBeGreaterThanOrEqual(90);
	});

	it("leaves a zero-slack column at its natural width", () => {
		// Column A cannot shrink at all (natural === min), so the whole excess must
		// come out of column B.
		const block = table([cell(120, 120), cell(300, 50)], []);
		const [a, b] = solveTableColumns(block, 300, METRICS);
		expect(a).toBe(120);
		expect(b).toBeLessThan(300);
	});
});

/**
 * Rounding must never make a FITTING table claim to overflow.
 *
 * Both fitting regimes round individual columns up somewhere (regime 1 ceils every
 * natural width; regime 2 ceils the min floor), and each ceil can add just under
 * 1px. Across N columns that accumulates past `layoutTable`'s 0.5px tolerance, so a
 * table whose real widths fit was handed a horizontal scroll container plus a 12px
 * scrollbar reservation of empty space below it. Real fonts produce fractional
 * intrinsic widths for essentially every cell, so this was not a corner case.
 *
 * Both sides call the same solver, so this never caused measure/render DRIFT — it is
 * pinned because the visible damage (a stray scrollbar, a 12px gap) appeared on
 * ordinary tables.
 */
describe("solveTableColumns — fractional widths must not fake an overflow", () => {
	it("keeps a regime-1 table inside its budget despite per-column ceils", () => {
		// 10 columns of natural 50.4 → Σceil = 510 > budget 505, yet Σnatural = 504 fits.
		const cells = Array.from({ length: 10 }, () => cell(50.4, 20));
		const block = table(cells, []);
		const widths = solveTableColumns(block, 705, METRICS);
		const total = widths.reduce((sum, w) => sum + w + METRICS.paddingX * 2, 0);
		expect(total).toBeLessThanOrEqual(705);
		expect(layoutTable(block, 705, oneLine, METRICS).overflowing).toBe(false);
	});

	it("keeps a regime-2 table inside its budget when min floors are ceil-ed", () => {
		// 10 rigid fractional columns (nat === min === 50.4) plus one elastic column:
		// each ceil-ed floor adds 0.6px, so the solved total overshot by 6px.
		const cells = [...Array.from({ length: 10 }, () => cell(50.4, 50.4)), cell(100, 20)];
		const block = table(cells, []);
		const widths = solveTableColumns(block, 820, METRICS);
		const total = widths.reduce((sum, w) => sum + w + METRICS.paddingX * 2, 0);
		expect(total).toBeLessThanOrEqual(820);
		const layout = layoutTable(block, 820, oneLine, METRICS);
		expect(layout.overflowing).toBe(false);
		// No scrollbar reservation either — one single-line header row only.
		expect(layout.height).toBe(35);
	});

	it("never reclaims a column below its min floor", () => {
		const cells = [...Array.from({ length: 10 }, () => cell(50.4, 50.4)), cell(100, 20)];
		const widths = solveTableColumns(table(cells, []), 820, METRICS);
		for (let c = 0; c < widths.length; c++) {
			expect(widths[c]).toBeGreaterThanOrEqual(Math.ceil(cells[c]?.minWidth ?? 0));
		}
	});

	it("still reports overflow when the ceil-ed floors genuinely do not fit", () => {
		// Σmin (399.6) is just under the budget (400) but Σceil(min) is 400+ … the
		// reclaim loop bottoms out on the floors and overflow is the honest answer.
		const cells = Array.from({ length: 8 }, () => cell(49.95, 49.95));
		const block = table(cells, []);
		const widths = solveTableColumns(block, 560, METRICS);
		for (const width of widths) expect(width).toBeGreaterThanOrEqual(50);
	});
});

describe("solveTableColumns — regime 3: even min widths overflow", () => {
	it("falls back to min widths so the table can scroll", () => {
		const block = table([cell(500, 200), cell(500, 200)], []);
		// budget = 200 - 40 = 160 < min total 400 → min widths, table overflows.
		expect(solveTableColumns(block, 200, METRICS)).toEqual([200, 200]);
	});

	it("returns an empty result for a table with no columns", () => {
		expect(solveTableColumns(table([], []), 400, METRICS)).toEqual([]);
	});
});

describe("layoutTable — row heights and overflow", () => {
	it("gives every single-line row the same chrome-inclusive height", () => {
		const block = table([cell(100, 20)], [[cell(80, 20)], [cell(60, 20)]]);
		const layout = layoutTable(block, 400, oneLine, METRICS);
		// 1 line * 20 + paddingY*2 (14) + rowBorder (1) = 35 per row.
		expect(layout.rowHeights).toEqual([35, 35, 35]);
		// header + 2 body rows, no overflow → no scrollbar reservation.
		expect(layout.height).toBe(105);
		expect(layout.overflowing).toBe(false);
	});

	it("sizes a row by its TALLEST cell", () => {
		const block = table([], [[cellOfLines(1), cellOfLines(3), cellOfLines(2)]]);
		const layout = layoutTable(block, 400, hintedLines, METRICS);
		// The 3-line cell decides the row: 3 * 20 + paddingY*2 (14) + border (1) = 75.
		expect(layout.rowHeights).toEqual([75]);
	});

	it("sizes each row independently", () => {
		const block = table([], [[cellOfLines(1)], [cellOfLines(4)], [cellOfLines(2)]]);
		const layout = layoutTable(block, 400, hintedLines, METRICS);
		expect(layout.rowHeights).toEqual([35, 95, 55]);
		expect(layout.height).toBe(185);
	});

	it("reserves scrollbar height only when the table overflows", () => {
		const wide = table([cell(500, 200), cell(500, 200)], []);
		const overflow = layoutTable(wide, 200, oneLine, METRICS);
		expect(overflow.overflowing).toBe(true);
		// One header row (35) + the 12px reservation.
		expect(overflow.height).toBe(47);

		const narrow = table([cell(50, 20), cell(50, 20)], []);
		const fits = layoutTable(narrow, 400, oneLine, METRICS);
		expect(fits.overflowing).toBe(false);
		expect(fits.height).toBe(35);
	});

	it("omits the header row when the table has none", () => {
		const block = table([], [[cell(50, 20)]]);
		const layout = layoutTable(block, 400, oneLine, METRICS);
		expect(layout.rowHeights).toHaveLength(1);
	});

	it("reports a table width that includes every column's padding", () => {
		const block = table([cell(100, 20), cell(80, 20)], []);
		const layout = layoutTable(block, 400, oneLine, METRICS);
		// (100 + 20) + (80 + 20) = 220.
		expect(layout.tableWidth).toBe(220);
	});
});

describe("accumulateFrame — table blocks", () => {
	it("places a table block and reports its solved height", () => {
		const block = table([cell(100, 20)], [[cell(80, 20)]]);
		const frame = accumulateFrame([block], 400, oneLine, { table: METRICS });
		// Two single-line rows at 35 each.
		expect(frame.contentHeight).toBe(70);
		expect(frame.blocks[0]?.height).toBe(70);
	});

	it("never reports more used width than the box, so a shrink-wrap cannot stretch", () => {
		const block = table([cell(900, 400), cell(900, 400)], []);
		const frame = accumulateFrame([block], 300, oneLine, { table: METRICS });
		expect(frame.usedWidth).toBeLessThanOrEqual(300);
	});

	it("honours contentLeft when the table is nested in a list or quote", () => {
		const block = table([cell(50, 20)], [], { contentLeft: 40 });
		const frame = accumulateFrame([block], 400, oneLine, { table: METRICS });
		// The table's box is 360 wide, so its 70px content still fits at natural width.
		expect(frame.blocks[0]?.usedWidth).toBe(40 + 70);
	});
});
