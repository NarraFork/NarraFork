/**
 * typography-geometry.test.ts — Proves the typography knobs actually reach the
 * MEASURED geometry, and that each one moves only what it claims to.
 *
 * The tests in `typography.test.ts` pin the parameter source in isolation. These
 * pin the thing that makes the feature real: that `parseMarkdownToPreparedBlocks`
 * produces different heights, fonts and margins under a different setting. Without
 * this, every constant could still be captured at import time — the exact defect
 * this refactor exists to remove — and the unit tests would all pass.
 *
 * Each assertion also guards a specific silent failure:
 *  - a font string left at the baseline → the render layer paints scaled text into
 *    a line box measured unscaled, so rows overlap;
 *  - a knob that bleeds into another → enlarging text also loosens spacing, which
 *    the user did not ask for and cannot separate;
 *  - letter spacing that reaches paint but not measurement → wrap points move
 *    without the height model knowing.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";
import { parseMarkdownToPreparedBlocks } from "./parse-markdown";
import type { PreparedCodeBlock, PreparedInlineBlock, PreparedTableBlock } from "./prepared-block";
import { headingMetrics, typographyMetrics } from "./pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";
import { resetTypographyForTest, setTypography } from "./typography";

beforeAll(() => {
	installCanvasStub();
});

afterEach(() => {
	resetTypographyForTest();
});

/** The px size named in a font shorthand. */
function fontSize(font: string): number {
	const match = /(\d+(?:\.\d+)?)px/.exec(font);
	if (!match?.[1]) throw new Error(`unparseable font shorthand: ${font}`);
	return Number.parseFloat(match[1]);
}

function inlineBlocks(markdown: string): PreparedInlineBlock[] {
	return parseMarkdownToPreparedBlocks(markdown, undefined).filter(
		(block): block is PreparedInlineBlock => block.kind === "inline",
	);
}

function firstInline(markdown: string): PreparedInlineBlock {
	const block = inlineBlocks(markdown)[0];
	if (!block) throw new Error("no inline block produced");
	return block;
}

function firstTable(markdown: string): PreparedTableBlock {
	const block = parseMarkdownToPreparedBlocks(markdown, undefined).find(
		(b): b is PreparedTableBlock => b.kind === "table",
	);
	if (!block) throw new Error("no table block produced");
	return block;
}

describe("font scale reaches measurement", () => {
	it("scales the body font string the fragments are measured with", () => {
		const base = fontSize(firstInline("plain prose").fonts[0] ?? "");
		setTypography({ fontScalePercent: 150 });
		const scaled = fontSize(firstInline("plain prose").fonts[0] ?? "");
		// The SAME array the render layer paints from (`fonts[]`), which is what keeps
		// measurement and paint in step by construction.
		expect(scaled).toBeCloseTo(base * 1.5, 6);
	});

	it("grows the line box, so predicted heights actually change", () => {
		const before = firstInline("plain prose").lineHeight;
		setTypography({ fontScalePercent: 150 });
		const after = firstInline("plain prose").lineHeight;
		expect(after).toBeGreaterThan(before);
	});

	it("makes the same text occupy more lines at a fixed width", () => {
		const markdown = "word ".repeat(60).trim();
		const width = 320;
		const before = pretextLineMetrics(firstInline(markdown), width).lineCount;
		setTypography({ fontScalePercent: 170 });
		const after = pretextLineMetrics(firstInline(markdown), width).lineCount;
		// This is the whole claim: bigger glyphs wrap sooner, and the height model
		// KNOWS it. A CSS-only implementation would leave this number unchanged while
		// the browser wrapped differently.
		expect(after).toBeGreaterThan(before);
	});

	it("scales headings and inline code together with body text", () => {
		const beforeHeading = headingMetrics(1).size;
		const beforeCode = fontSize(typographyMetrics().font.inlineCode);
		setTypography({ fontScalePercent: 150 });
		expect(headingMetrics(1).size).toBeCloseTo(beforeHeading * 1.5, 6);
		expect(fontSize(typographyMetrics().font.inlineCode)).toBeCloseTo(beforeCode * 1.5, 6);
	});

	it("scales a fenced code block's font and line box", () => {
		const code = "```ts\nconst a = 1;\n```";
		const before = parseMarkdownToPreparedBlocks(code, undefined).find(
			(b): b is PreparedCodeBlock => b.kind === "code",
		);
		expect(before).toBeDefined();
		const beforeLine = before?.lineHeight ?? 0;

		setTypography({ fontScalePercent: 150 });
		const after = parseMarkdownToPreparedBlocks(code, undefined).find(
			(b): b is PreparedCodeBlock => b.kind === "code",
		);
		expect(after?.lineHeight ?? 0).toBeGreaterThan(beforeLine);
	});
});

describe("letter spacing reaches measurement", () => {
	it("widens the same text at a fixed width", () => {
		const markdown = "word ".repeat(60).trim();
		const width = 320;
		const before = pretextLineMetrics(firstInline(markdown), width).maxLineWidth;
		setTypography({ letterSpacingPercent: 20 });
		const after = pretextLineMetrics(firstInline(markdown), width).maxLineWidth;
		// Spacing that reached only CSS would leave the measured width untouched while
		// the painted text ran wider — the exact measure/render divergence the height
		// model exists to prevent.
		expect(after).not.toBe(before);
	});

	it("does not change the line box height", () => {
		const before = firstInline("plain prose").lineHeight;
		setTypography({ letterSpacingPercent: 20 });
		// Horizontal advance only: a taller line here would mean the knob is leaking
		// into the vertical model.
		expect(firstInline("plain prose").lineHeight).toBe(before);
	});

	it("widens a TABLE cell's max-content and min-content widths", () => {
		// The paragraph path injected spacing per piece; the table-cell path did not,
		// while the render layer painted cell fragments with spacing either way. Two
		// consequences, both silent: text overflowed its cell, and — because these two
		// numbers ARE the max-content/min-content inputs to `solveTableColumns` — every
		// column was allocated less width than the text it would receive.
		const markdown = ["| header cell |", "| --- |", "| bodyword |"].join("\n");
		const before = firstTable(markdown);
		setTypography({ letterSpacingPercent: 20 });
		const after = firstTable(markdown);

		const beforeBody = before.rows[0]?.[0];
		const afterBody = after.rows[0]?.[0];
		if (!beforeBody || !afterBody) throw new Error("expected one body cell");
		expect(afterBody.naturalWidth).toBeGreaterThan(beforeBody.naturalWidth);
		// min-content comes from `pieceMinWidth`, a separately memoised path — it has its
		// own cache key, so it can regress on its own.
		expect(afterBody.minWidth).toBeGreaterThan(beforeBody.minWidth);

		const beforeHeader = before.header[0];
		const afterHeader = after.header[0];
		if (!beforeHeader || !afterHeader) throw new Error("expected one header cell");
		expect(afterHeader.naturalWidth).toBeGreaterThan(beforeHeader.naturalWidth);
	});
});

describe("line spacing reaches measurement", () => {
	it("grows the line box without moving the font size", () => {
		const before = firstInline("plain prose");
		const beforeFont = before.fonts[0];
		setTypography({ lineHeightScalePercent: 150 });
		const after = firstInline("plain prose");
		expect(after.lineHeight).toBeGreaterThan(before.lineHeight);
		// Leading only: the glyphs must not change size, or the knob would duplicate
		// the font-scale control and the two would multiply.
		expect(after.fonts[0]).toBe(beforeFont);
	});

	it("does NOT change where lines wrap", () => {
		const markdown = "word ".repeat(60).trim();
		const width = 320;
		const before = pretextLineMetrics(firstInline(markdown), width).lineCount;
		setTypography({ lineHeightScalePercent: 200 });
		// pretext's line metrics take no line height, so leading is a pure multiplier on
		// the line COUNT. If this ever changes, prepared handles would need invalidating
		// on this knob too — today they deliberately do not.
		expect(pretextLineMetrics(firstInline(markdown), width).lineCount).toBe(before);
	});

	it("leaves block margins alone", () => {
		const markdown = "first paragraph\n\nsecond paragraph\n";
		const before = inlineBlocks(markdown)[1]?.marginTop ?? 0;
		setTypography({ lineHeightScalePercent: 200 });
		// Intra-paragraph leading vs inter-block spacing are the two knobs a reader
		// needs to separate; this pins that they do not bleed into each other.
		expect(inlineBlocks(markdown)[1]?.marginTop ?? 0).toBeCloseTo(before, 6);
	});

	it("scales headings' line boxes too", () => {
		const beforeLine = headingMetrics(1).lineHeight;
		const beforeSize = headingMetrics(1).size;
		setTypography({ lineHeightScalePercent: 150 });
		expect(headingMetrics(1).lineHeight).toBeGreaterThan(beforeLine);
		// Size captured BEFORE the change and compared across it — same independence
		// claim as the body case.
		expect(headingMetrics(1).size).toBe(beforeSize);
	});
});

describe("block spacing reaches measurement", () => {
	const markdown = "first paragraph\n\nsecond paragraph\n\n- a list item\n";

	it("scales the margin above a following block", () => {
		// Block 0 is the document's first block and always carries margin 0, so the
		// SECOND block is the one that shows contextual spacing.
		const before = inlineBlocks(markdown)[1]?.marginTop ?? 0;
		expect(before).toBeGreaterThan(0);

		setTypography({ paragraphScalePercent: 200 });
		const after = inlineBlocks(markdown)[1]?.marginTop ?? 0;
		expect(after).toBeCloseTo(before * 2, 6);
	});

	it("leaves the first block's margin at zero", () => {
		setTypography({ paragraphScalePercent: 200 });
		// Scaling must not introduce leading space at the top of a document; 0 × any
		// multiplier is still 0, and this pins that the first block keeps the 0.
		expect(inlineBlocks(markdown)[0]?.marginTop).toBe(0);
	});

	it("does not change font size or line height", () => {
		const block = firstInline(markdown);
		const beforeFont = block.fonts[0];
		const beforeLine = block.lineHeight;

		setTypography({ paragraphScalePercent: 200 });
		const after = firstInline(markdown);
		// The two knobs are independent: a reader who wants airier paragraphs must not
		// silently get larger text as well.
		expect(after.fonts[0]).toBe(beforeFont);
		expect(after.lineHeight).toBe(beforeLine);
	});
});

describe("knob independence", () => {
	it("keeps block spacing fixed when only the font scale moves", () => {
		const markdown = "first paragraph\n\nsecond paragraph\n";
		const before = inlineBlocks(markdown)[1]?.marginTop ?? 0;
		setTypography({ fontScalePercent: 180 });
		// Margins are em-derived from the BASELINE size precisely so this holds; had
		// they been resolved against the scaled size, the font knob would move spacing
		// too and the two settings could never be tuned separately.
		expect(inlineBlocks(markdown)[1]?.marginTop ?? 0).toBeCloseTo(before, 6);
	});

	it("returns to byte-identical geometry when reset to neutral", () => {
		const markdown = "# Heading\n\nbody text with `code`\n\n- item\n";
		const before = JSON.stringify(
			parseMarkdownToPreparedBlocks(markdown, undefined).map((b) => ({
				kind: b.kind,
				marginTop: b.marginTop,
				lineHeight: (b as PreparedInlineBlock).lineHeight,
				fonts: (b as PreparedInlineBlock).fonts,
			})),
		);

		setTypography({
			fontScalePercent: 140,
			letterSpacingPercent: 8,
			lineHeightScalePercent: 130,
			paragraphScalePercent: 175,
		});
		resetTypographyForTest();

		const after = JSON.stringify(
			parseMarkdownToPreparedBlocks(markdown, undefined).map((b) => ({
				kind: b.kind,
				marginTop: b.marginTop,
				lineHeight: (b as PreparedInlineBlock).lineHeight,
				fonts: (b as PreparedInlineBlock).fonts,
			})),
		);
		// An untouched install must measure EXACTLY as it did before this feature
		// existed — the refactor is only allowed to add a scaling factor of 1.
		expect(after).toBe(before);
	});
});
