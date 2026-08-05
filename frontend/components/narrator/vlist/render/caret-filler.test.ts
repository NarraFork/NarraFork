import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { shouldFillCaretStrip } from "./caret-filler";

describe("shouldFillCaretStrip", () => {
	it("fills real strips and skips sub-pixel / absent ones", () => {
		expect(shouldFillCaretStrip(12)).toBe(true);
		expect(shouldFillCaretStrip(4.9)).toBe(true);
		expect(shouldFillCaretStrip(0.5)).toBe(true);
		// Sub-pixel bands already resolve a caret; filling them adds nodes for nothing.
		expect(shouldFillCaretStrip(0.4)).toBe(false);
		expect(shouldFillCaretStrip(0)).toBe(false);
		expect(shouldFillCaretStrip(-4)).toBe(false);
		expect(shouldFillCaretStrip(undefined)).toBe(false);
		expect(shouldFillCaretStrip(Number.NaN)).toBe(false);
		expect(shouldFillCaretStrip(Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("caret filler wiring (drag-selection regression)", () => {
	it("keeps the filler invisible, unselectable-by-a11y and height-neutral", () => {
		const source = readFileSync(`${import.meta.dir}/caret-filler.tsx`, "utf8");
		// Absolutely positioned over an existing strip → contributes no layout height.
		expect(source).toContain('position: "absolute"');
		// Must be selectable — that is the entire point.
		expect(source).toContain('userSelect: "text"');
		// Invisible: transparent 1px glyph clipped by the strip box.
		expect(source).toContain('color: "transparent"');
		expect(source).toContain('overflow: "hidden"');
		expect(source).toContain("aria-hidden");
		expect(source).toContain("\\u200b");
	});

	it("fills the paragraph-margin strip between markdown blocks", () => {
		const source = readFileSync(`${import.meta.dir}/RenderMarkdown.tsx`, "utf8");
		expect(source).toContain("CaretFiller");
		expect(source).toContain("top={blockFrame.top - marginTop}");
		expect(source).toContain("height={marginTop}");
	});

	it("stretches each text line past its glyphs so the line remainder keeps a caret", () => {
		const source = readFileSync(`${import.meta.dir}/RenderMarkdown.tsx`, "utf8");
		// `width: max-content` alone ended the line box at the last glyph, leaving the
		// rest of the line caret-less; min-width preserves the intrinsic wrap width.
		expect(source).toContain('minWidth: "max-content"');
		expect(source).toContain("width: `calc(100% - ${block.contentLeft}px)`");
	});

	it("fills the extended part of a row's hit box in the list shell", () => {
		const source = readFileSync(`${import.meta.dir}/../PretextExactMessageList.tsx`, "utf8");
		expect(source).toContain("<CaretFiller top={height} height={hitHeight - height}");
	});

	it("makes each fenced code row fill its slot, and fills the panel's padding", () => {
		// The strip the first pass missed: a code row was `top`-only, so the ~4px of
		// leading between rows (17px slot vs a `font`-shorthand `line-height: normal`
		// box) and the blank space past the last glyph resolved no caret, and a drag
		// inside a multi-line block snapped back to the top of the history.
		// RenderMarkdown.codecaret.test.tsx asserts the resulting geometry; this only
		// guards the wiring so the declarations cannot quietly disappear.
		const source = readFileSync(`${import.meta.dir}/RenderMarkdown.tsx`, "utf8");
		expect(source).toContain("lineHeight: `${block.lineHeight}px`");
		expect(source).toContain("<CaretFiller top={0} height={langTop}");
		expect(source).toContain("top={linesBottom}");
	});
});
