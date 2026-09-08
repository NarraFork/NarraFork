/**
 * measure-diff.test.ts — Height model for a structured diff body.
 *
 * A diff cannot be measured as one blob of text. Each row is its own `pre-wrap`
 * line, and the fixed line-number gutter steals horizontal room from EVERY row,
 * so the code column wraps earlier than the same text would without a gutter.
 * Measuring the joined text at the full width under-counts lines, and the box
 * then clips content the virtual list already reserved space for.
 *
 * These tests pin that model:
 *   - the gutter's character width follows the line-number columns
 *   - a narrower code column produces MORE lines (the bug being prevented)
 *   - the cap still clamps, and huge diffs stay O(cap) to measure
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { createDiffDocument } from "@shared/pretext-layout/diff-core";
import type { ToolCappedDetail } from "@shared/pretext-layout/tool-detail";
import { installCanvasStub } from "./test-canvas-stub";

// The deterministic canvas stub must be installed before any pretext-backed
// module loads (CONTRACT §5): each glyph is 0.6 × fontSize wide.
beforeAll(() => {
	installCanvasStub();
});

async function mod() {
	return import("./measure-tool-call");
}

type Row = { content: string };
const rows = (...contents: string[]): Row[] => contents.map((content) => ({ content }));

describe("diffGutterWidthChars", () => {
	it("is zero when there is no structured diff", async () => {
		const m = await mod();
		expect(m.diffGutterWidthChars(undefined)).toBe(0);
	});

	it("reserves two number columns plus a separator and the marker", async () => {
		const m = await mod();
		// `oldNo`(3) + ' '(1) + `newNo`(3) + marker(1) = 8
		expect(
			m.diffGutterWidthChars(createDiffDocument({ oldText: "a", newText: "b", startLine: 100 })),
		).toBe(8);
		expect(
			m.diffGutterWidthChars(createDiffDocument({ oldText: "a", newText: "b", startLine: 10000 })),
		).toBe(12);
	});

	it("reserves just the marker column when the diff carries no line numbers", async () => {
		const m = await mod();
		// Mirrors the chunked DiffView's bare `1.5ch` marker gutter.
		expect(m.diffGutterWidthChars(createDiffDocument({ oldText: "a", newText: "b" }))).toBe(6);
	});
});

describe("measureDiffContentHeight", () => {
	it("counts one line per row when nothing wraps", async () => {
		const m = await mod();
		const height = m.measureDiffContentHeight(rows("a", "b", "c"), 0, 400, 400);
		expect(height).toBe(3 * m.DETAIL_CONTENT_LINE_HEIGHT + m.DETAIL_BOX_CHROME_Y);
	});

	it("still counts an empty row as one line", async () => {
		const m = await mod();
		const height = m.measureDiffContentHeight(rows("a", "", "c"), 0, 400, 400);
		expect(height).toBe(3 * m.DETAIL_CONTENT_LINE_HEIGHT + m.DETAIL_BOX_CHROME_Y);
	});

	it("grows when the gutter narrows the code column", async () => {
		const m = await mod();
		// A row just wide enough to fit without a gutter must wrap once the gutter
		// takes its share. This is the regression the whole function exists for.
		const width = 200;
		const line = "x".repeat(24);
		const noGutter = m.measureDiffContentHeight(rows(line), 0, 4_000, width);
		const withGutter = m.measureDiffContentHeight(rows(line), 8, 4_000, width);
		expect(withGutter).toBeGreaterThan(noGutter);
	});

	it("scales the gutter allowance with the line-number width", async () => {
		const m = await mod();
		const width = 300;
		const line = "y".repeat(60);
		const narrow = m.measureDiffContentHeight(rows(line), 8, 4_000, width);
		const wide = m.measureDiffContentHeight(rows(line), 20, 4_000, width);
		// A wider gutter leaves less room, so the same row wraps to more lines.
		expect(wide).toBeGreaterThanOrEqual(narrow);
	});

	it("wraps a long row to several lines", async () => {
		const m = await mod();
		// 11px font, 0.6 ratio → 6.6px per glyph. At a 100px content width the
		// usable column is 100 - 12 (box chrome) = 88px ≈ 13 glyphs per line.
		const height = m.measureDiffContentHeight(rows("z".repeat(40)), 0, 4_000, 100);
		const lines = (height - m.DETAIL_BOX_CHROME_Y) / m.DETAIL_CONTENT_LINE_HEIGHT;
		expect(lines).toBeGreaterThan(1);
	});

	it("clamps at the cap", async () => {
		const m = await mod();
		const many = rows(...Array.from({ length: 500 }, (_, i) => `line ${i}`));
		expect(m.measureDiffContentHeight(many, 8, 200, 400)).toBe(200);
	});

	it("stops measuring once the cap is exceeded (bounded cost)", async () => {
		const m = await mod();
		// 5000 rows would be slow if every row were measured; the early return keeps
		// the work proportional to the cap.
		const huge = rows(...Array.from({ length: 5_000 }, (_, i) => `${i}: ${"q".repeat(200)}`));
		const started = performance.now();
		expect(m.measureDiffContentHeight(huge, 8, 200, 400)).toBe(200);
		expect(performance.now() - started).toBeLessThan(150);
	});

	it("never returns less than one line of height", async () => {
		const m = await mod();
		expect(m.measureDiffContentHeight(rows(""), 0, 200, 400)).toBe(
			m.DETAIL_CONTENT_LINE_HEIGHT + m.DETAIL_BOX_CHROME_Y,
		);
	});

	/**
	 * The loop is bounded by `min(rows, cappedUsefulLines(cap))` rather than relying
	 * on the early return to fire, which makes the cap → cost coupling explicit: the
	 * work scales with the CAP, not with the diff's length. A larger cap (plan's 400,
	 * or a viewport-derived one) raises the row budget proportionally.
	 */
	it("measures at most cappedUsefulLines rows, whatever the diff's length", async () => {
		const m = await mod();
		// Rows that cannot wrap: the line count then equals the row count exactly, so
		// the returned height reveals how many rows were consumed.
		const short = rows(...Array.from({ length: 5_000 }, () => "x"));
		const useful = m.cappedUsefulLines(200);
		expect(m.measureDiffContentHeight(short, 0, 200, 4_000)).toBe(200);
		// A diff SHORTER than the budget is measured exactly (no clamping).
		const few = rows(...Array.from({ length: useful - 2 }, () => "x"));
		expect(m.measureDiffContentHeight(few, 0, 200, 4_000)).toBe(
			(useful - 2) * m.DETAIL_CONTENT_LINE_HEIGHT + m.DETAIL_BOX_CHROME_Y,
		);
	});

	it("scales its row budget with the cap", async () => {
		const m = await mod();
		// 40 non-wrapping rows: under a 200px cap they overflow (→ cap), under a
		// 1000px cap they all fit and are counted exactly.
		const forty = rows(...Array.from({ length: 40 }, () => "x"));
		expect(m.measureDiffContentHeight(forty, 0, 200, 4_000)).toBe(200);
		expect(m.measureDiffContentHeight(forty, 0, 1_000, 4_000)).toBe(
			40 * m.DETAIL_CONTENT_LINE_HEIGHT + m.DETAIL_BOX_CHROME_Y,
		);
	});

	it("measures the gutter advance at a finite width", async () => {
		const m = await mod();
		// The gutter run must not wrap, but the width used to express that has to
		// survive arithmetic: MAX_SAFE_INTEGER overflows to Infinity / loses precision
		// inside the wrap math, which would silently corrupt the gutter allowance.
		// A 50-char gutter at a 400px width leaves a narrow code column, so a 20-char
		// row must wrap — proof the advance was computed, not lost to Infinity.
		const wide = m.measureDiffContentHeight(rows("x".repeat(20)), 50, 4_000, 400);
		const none = m.measureDiffContentHeight(rows("x".repeat(20)), 0, 4_000, 400);
		expect(Number.isFinite(wide)).toBe(true);
		expect(wide).toBeGreaterThan(none);
	});
});

describe("measureToolBody — diff document integration", () => {
	function body(oldText: string, newText: string, startLine?: number): ToolCappedDetail {
		const diffDocument = createDiffDocument({ oldText, newText, startLine });
		return {
			kind: "capped",
			cap: "diff",
			id: "diff-fixture",
			source: "input.edit",
			format: "diff",
			live: false,
			followTarget: { kind: "diff-row", focus: diffDocument.focus },
			diffDocument,
			contentLines: 1,
		};
	}

	it("measures source rows instead of an inaccurate fallback line count", async () => {
		const m = await mod();
		const measured = m.measureToolBody(body("a\nb", "a\nB"), 400);
		expect(measured.height).toBe(3 * m.DETAIL_CONTENT_LINE_HEIGHT + m.DETAIL_BOX_CHROME_Y);
	});

	it("carries only the document and matching gutter geometry, not a selected viewport", async () => {
		const m = await mod();
		const model = body("a", "b", 100);
		const measured = m.measureToolBody(model, 400);
		const block = measured.blocks[0];
		if (block?.kind !== "fixed") throw new Error("missing body geometry");
		expect(measured.model).toBe(model);
		expect(block.data?.diffGutterChars).toBe(8);
		expect(block.data?.diffLines).toBeUndefined();
		expect(measured.frame.blocks[0]?.top).toBe(0);
	});

	it("uses explicit format rather than inferring presentation from a cap", async () => {
		const m = await mod();
		const model: ToolCappedDetail = {
			kind: "capped",
			cap: "diff",
			id: "text-fixture",
			source: "output.main",
			format: "text",
			live: false,
			followTarget: { kind: "end" },
			text: "-a\n+b",
		};
		const measured = m.measureToolBody(model, 400);
		expect(measured.height).toBeGreaterThan(0);
		expect(measured.model.format).toBe("text");
	});
});
