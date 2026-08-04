/**
 * katex-geometry-cjk-height.test.ts — vertical metrics for scripts KaTeX has no
 * font data for (CJK).
 *
 * Same root cause as the width problem this module already solves, but on the other
 * axis. KaTeX ships no metrics for CJK, so `getCharacterMetrics` deliberately
 * substitutes capital "M" — its own source says it "only care[s] about the height of
 * the glyph not its width". That comment is optimistic: the substituted metrics are
 * wrong vertically too. `\text{速}` and `\text{M}` both come back as
 * `height 0.68333em, depth 0`, yet a real full-width CJK glyph carries a genuine
 * DESCENT below the baseline (M has none).
 *
 * Consequence in the vlist: `measureKatex` reported an ink box that was too short,
 * the render layer pinned the math host to that height with `overflow: hidden`, and
 * the top/bottom of a CJK formula was shaved off — reported on
 * `$\text{速度} = \frac{\text{距离}}{\text{时间}}$`.
 *
 * The fix routes CJK vertical metrics through the same injected real-font resolver
 * the widths already use. These tests pin the contract:
 *   1. a CJK run measures TALLER than KaTeX's M-substituted metrics claim;
 *   2. it gains a real descent (M reports zero);
 *   3. ASCII formulas are byte-identical to before (no regression on the common path);
 *   4. with no resolver injected, behaviour degrades to KaTeX's own numbers.
 */

import { describe, expect, it } from "bun:test";
import katexModule from "katex";
import {
	type GlyphVerticalResolver,
	KATEX_FONT_SCALE,
	measureKatex,
	needsRealFontMeasure,
} from "./katex-geometry";

const katex = katexModule as unknown as Parameters<typeof measureKatex>[0];
const BASE_PX = 14;

/**
 * Stand-in for the browser's font metrics. Real CJK fonts are full-width with a
 * genuine descender; these ratios mirror a typical CJK face (ascent ~0.88em,
 * descent ~0.12em of the em box) so the assertions describe real behaviour rather
 * than an arbitrary constant.
 */
const cjkVertical: GlyphVerticalResolver = (glyph, fontCss) => {
	const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(fontCss);
	const fontPx = sizeMatch ? Number.parseFloat(sizeMatch[1] as string) : BASE_PX;
	if (!needsRealFontMeasure(glyph)) return null;
	return { ascent: fontPx * 0.88, descent: fontPx * 0.12 };
};

const measure = (latex: string, withResolver: boolean) =>
	measureKatex(katex, latex, {
		displayMode: false,
		basePx: BASE_PX,
		...(withResolver ? { glyphVertical: cjkVertical } : {}),
	});

describe("KaTeX's own CJK metrics are the bug's premise", () => {
	it("reports identical vertical metrics for a CJK glyph and capital M", () => {
		// If KaTeX ever ships real CJK metrics this premise dies and the workaround
		// should be revisited — so assert it explicitly rather than assume it.
		const cjk = katex.__renderToHTMLTree("\\text{速}", {
			displayMode: false,
			throwOnError: false,
			output: "html",
		});
		const latin = katex.__renderToHTMLTree("\\text{M}", {
			displayMode: false,
			throwOnError: false,
			output: "html",
		});
		expect(cjk.height).toBe(latin.height);
		expect(cjk.depth).toBe(latin.depth);
		// And M genuinely has no descender, which is what starves the box.
		expect(latin.depth).toBe(0);
	});
});

describe("CJK vertical metrics come from the real font", () => {
	it("corrects a CJK run's baseline split even when the line box floor dominates", () => {
		// A bare `\text{速度}` has a corrected ink box (~16.9px) that is still SHORTER
		// than `.katex`'s own line box (~20.3px), so `height` is legitimately clamped by
		// that floor and cannot grow. What must change is the baseline split: KaTeX
		// claimed all of it sat above the baseline with zero descent.
		const without = measure("\\text{速度}", false);
		const withReal = measure("\\text{速度}", true);
		expect(without.descent).toBe(0);
		expect(withReal.ascent).toBeGreaterThan(without.ascent);
		expect(withReal.descent).toBeGreaterThan(without.descent);
	});

	it("measures a CJK run taller once its ink exceeds the line box", () => {
		// Stacked CJK (a fraction) does exceed the floor, so the surplus reaches
		// `height` — this is the case that was being clipped.
		const latex = "\\frac{\\text{距离}}{\\text{时间}}";
		expect(measure(latex, true).height).toBeGreaterThan(measure(latex, false).height);
	});

	it("gives a CJK run a real descent where KaTeX reported none", () => {
		const withReal = measure("\\text{速度}", true);
		expect(withReal.descent).toBeGreaterThan(0);
	});

	it("covers the reported CJK fraction so nothing is clipped", () => {
		// The exact formula that showed top/bottom clipping.
		const latex = "\\text{速度} = \\frac{\\text{距离}}{\\text{时间}}";
		const without = measure(latex, false);
		const withReal = measure(latex, true);
		expect(withReal.height).toBeGreaterThan(without.height);
		// ascent + descent must still describe the same box the height reports.
		expect(withReal.ascent + withReal.descent).toBeCloseTo(withReal.height, 5);
	});

	it("keeps the height at or above KaTeX's own line box", () => {
		const lineBox = BASE_PX * KATEX_FONT_SCALE * 1.2;
		for (const latex of ["\\text{速}", "\\text{速度} = 1", "x"]) {
			expect(measure(latex, true).height).toBeGreaterThanOrEqual(lineBox - 1e-6);
		}
	});
});

describe("no regression on the ASCII path", () => {
	it("leaves formulas without CJK byte-identical", () => {
		for (const latex of ["E = mc^2", "\\frac{a}{b}", "\\sum_{i=1}^{n} i^2", "x^2", "\\sqrt{x}"]) {
			const without = measure(latex, false);
			const withReal = measure(latex, true);
			expect(withReal.height).toBe(without.height);
			expect(withReal.ascent).toBe(without.ascent);
			expect(withReal.descent).toBe(without.descent);
			expect(withReal.width).toBe(without.width);
		}
	});

	it("degrades to KaTeX's numbers when no resolver is injected", () => {
		// The resolver is optional (server-side / test contexts have no canvas).
		const geo = measure("\\text{速度}", false);
		expect(Number.isFinite(geo.height)).toBe(true);
		expect(geo.height).toBeGreaterThan(0);
	});
});
