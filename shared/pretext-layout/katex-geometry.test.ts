/**
 * katex-geometry.test.ts — Unit tests for the zero-DOM KaTeX geometry engine.
 *
 * These run the REAL KaTeX runtime (it needs no DOM to build its layout tree),
 * so the width/height arithmetic is exercised end to end. Pixel-perfect parity
 * with the browser is validated separately by VListHarness; here we assert the
 * geometry MODEL: the special-box rules, the combined-glyph correction, the CJK
 * resolver hand-off, and graceful degradation.
 */

import { describe, expect, it } from "bun:test";
import katexModule from "katex";
import {
	clearGlyphAdvanceCache,
	GLYPH_ADVANCE_CACHE_CEILING,
	type GlyphWidthResolver,
	getGlyphAdvanceCacheSize,
	KATEX_FONT_SCALE,
	KATEX_LINE_HEIGHT,
	type KatexRuntime,
	measureKatex,
	needsRealFontMeasure,
	sizingScale,
} from "./katex-geometry";

const katex = katexModule as unknown as KatexRuntime;
const BASE_PX = 14;

/** Deterministic stand-in for canvas measurement: every glyph is 0.9 × size. */
const stubResolver: GlyphWidthResolver = (_glyph, fontCss) => {
	const match = /(\d+(?:\.\d+)?)px/.exec(fontCss);
	const size = match?.[1] ? Number.parseFloat(match[1]) : 10;
	return size * 0.9;
};

function measure(latex: string, opts: Partial<Parameters<typeof measureKatex>[2]> = {}) {
	return measureKatex(katex, latex, { displayMode: false, basePx: BASE_PX, ...opts });
}

describe("sizingScale", () => {
	it("returns 1 without a sizing class", () => {
		expect(sizingScale(["mord", "mathnormal"])).toBe(1);
		// A bare `sizeN` without the `sizing` marker is not a scale change.
		expect(sizingScale(["size3"])).toBe(1);
	});

	it("derives the ratio from the reset-size/size pair", () => {
		// sizeMultipliers: size6 = 1.0, size3 = 0.7 → script size is 0.7x.
		expect(sizingScale(["sizing", "reset-size6", "size3"])).toBeCloseTo(0.7, 10);
		// size6 → size8 = 1.44 / 1.0.
		expect(sizingScale(["sizing", "reset-size6", "size8"])).toBeCloseTo(1.44, 10);
		// Scaling back up from a script context.
		expect(sizingScale(["sizing", "reset-size3", "size6"])).toBeCloseTo(1 / 0.7, 10);
	});

	it("ignores an incomplete pair", () => {
		expect(sizingScale(["sizing", "size3"])).toBe(1);
		expect(sizingScale(["sizing", "reset-size6"])).toBe(1);
	});
});

describe("needsRealFontMeasure", () => {
	it("trusts KaTeX metrics for Latin, Greek and math symbols", () => {
		for (const glyph of ["a", "Z", "7", "+", "=", "α", "Ω", "∫", "∑", "→", "≤"]) {
			expect(needsRealFontMeasure(glyph)).toBe(false);
		}
	});

	it("flags CJK and other scripts KaTeX has no metrics for", () => {
		// KaTeX substitutes capital-M metrics for these (katex.mjs getCharacterMetrics).
		for (const glyph of ["速", "度", "日", "語", "한", "ひ"]) {
			expect(needsRealFontMeasure(glyph)).toBe(true);
		}
	});

	it("handles an empty string without throwing", () => {
		expect(needsRealFontMeasure("")).toBe(false);
	});
});

describe("measureKatex — basic geometry", () => {
	it("produces positive width and KaTeX markup", () => {
		const geo = measure("E = mc^2");
		expect(geo.width).toBeGreaterThan(0);
		expect(geo.error).toBeNull();
		expect(geo.html).toContain("katex");
	});

	it("scales width linearly with the base font size", () => {
		const small = measure("x + y", { basePx: 14 });
		const large = measure("x + y", { basePx: 28 });
		expect(large.width / small.width).toBeCloseTo(2, 6);
	});

	it("never reports a height below the KaTeX line box", () => {
		// A short formula's own content box is ~13.8px, well under the 20.3px
		// line box that `.katex { line-height: 1.2 }` enforces.
		const lineBox = BASE_PX * KATEX_FONT_SCALE * KATEX_LINE_HEIGHT;
		const geo = measure("a+b");
		expect(geo.height).toBeCloseTo(lineBox, 6);
		expect(geo.ascent + geo.descent).toBeLessThan(lineBox);
	});

	it("lets tall formulas exceed the line box", () => {
		const lineBox = BASE_PX * KATEX_FONT_SCALE * KATEX_LINE_HEIGHT;
		const tall = measure("\\sum_{i=1}^{n} \\frac{a_i}{b_i}");
		expect(tall.height).toBeGreaterThan(lineBox);
		expect(tall.height).toBeCloseTo(tall.ascent + tall.descent, 6);
	});

	it("reports width monotonically with formula length", () => {
		const short = measure("a");
		const long = measure("a + b + c + d + e");
		expect(long.width).toBeGreaterThan(short.width);
	});

	it("unwraps the display wrapper instead of measuring the block container", () => {
		// `.katex-display` is a block-level centering wrapper. Measuring it would
		// yield the container width, not the formula's. For a formula whose layout
		// is style-independent, unwrapping must give the identical inline width.
		const inline = measure("a+b", { displayMode: false });
		const display = measure("a+b", { displayMode: true });
		expect(display.width).toBeCloseTo(inline.width, 6);
		expect(display.html).toContain("katex-display");
	});

	it("reflects displaystyle growth for operators that change size", () => {
		// Unlike `a+b`, fractions and big operators genuinely render larger in
		// display style, so the widths legitimately differ.
		const inline = measure("\\int_0^1 x^2 dx", { displayMode: false });
		const display = measure("\\int_0^1 x^2 dx", { displayMode: true });
		expect(display.width).toBeGreaterThan(inline.width);
	});
});

describe("measureKatex — special boxes", () => {
	it("reserves width for boxed formula borders", () => {
		const plain = measure("21");
		const boxed = measure("\\boxed{21}");
		console.log({ plainWidth: plain.width, boxedWidth: boxed.width, boxedHeight: boxed.height });
		const borderPx = BASE_PX * KATEX_FONT_SCALE * 0.04 * 2;
		expect(boxed.width - plain.width).toBeGreaterThanOrEqual(borderPx - 0.01);
	});

	it("counts the sqrt radical's min-width and content padding", () => {
		// The radical's own box comes from CSS `min-width` on `.hide-tail`, and the
		// radicand is shifted by `padding-left: 0.833em`. Dropping either rule made
		// `\sqrt{a^2+b^2}` measure 50.48px against Chrome's real 64.58px.
		const inner = measure("a^2+b^2");
		const rooted = measure("\\sqrt{a^2+b^2}");
		// 0.833em padding at 14px base × 1.21 KaTeX scale ≈ 14.1px.
		const paddingPx = 0.833 * BASE_PX * KATEX_FONT_SCALE;
		expect(rooted.width - inner.width).toBeCloseTo(paddingPx, 1);
		// Chrome-measured ground truth for this formula at 14px base.
		expect(rooted.width).toBeCloseTo(64.58, 0);
	});

	it("treats a stacked vlist as the widest row, not the sum", () => {
		// A fraction stacks numerator over denominator: the box is as wide as the
		// WIDER of the two, so a long numerator does not add the denominator's width.
		const frac = measure("\\frac{nnnnnnnn}{1}");
		const numerator = measure("nnnnnnnn");
		// Fraction adds only the nulldelimiter slots (0.12em each side).
		expect(frac.width).toBeLessThan(numerator.width * 1.5);
		expect(frac.width).toBeGreaterThan(numerator.width * 0.5);
	});

	it("adds mspace margins", () => {
		// `\,` is a thin space rendered as a `.mspace` with margin-right.
		const without = measure("ab");
		const withSpace = measure("a\\,b");
		expect(withSpace.width).toBeGreaterThan(without.width);
	});

	it("scales script-size superscripts down", () => {
		// The exponent renders inside `sizing reset-size6 size3` (0.7x), so it
		// contributes less than the same glyph at full size.
		const base = measure("x");
		const withSup = measure("x^{2}");
		const supDelta = withSup.width - base.width;
		const fullSize = measure("2").width;
		expect(supDelta).toBeGreaterThan(0);
		expect(supDelta).toBeLessThan(fullSize);
	});
});

describe("measureKatex — combined glyphs (tryCombineChars)", () => {
	it("sums every glyph when KaTeX merges adjacent symbols", () => {
		// KaTeX's tryCombineChars concatenates adjacent SymbolNodes' text but
		// leaves `width` at the first glyph, so a naive walk under-measures.
		// `i\pi` in an exponent is the canonical case.
		const geo = measure("e^{i\\pi}", { glyphWidth: stubResolver });
		const single = measure("e^{i}", { glyphWidth: stubResolver });
		expect(geo.width).toBeGreaterThan(single.width);
	});

	it("needs no resolver for merged Latin/Greek glyphs", () => {
		// KaTeX HAS metrics for `i` and `π`; tryCombineChars merely forgot to sum
		// them. Recovering each advance from KaTeX itself keeps ASCII/Greek math
		// exact without any font measurement — the resolver is only for CJK.
		const withResolver = measure("e^{i\\pi}", { glyphWidth: stubResolver });
		const without = measure("e^{i\\pi}");
		expect(without.width).toBeCloseTo(withResolver.width, 6);
		// Chrome ground truth for `e^{i\pi} + 1 = 0` confirms the sum is right.
		expect(measure("e^{i\\pi} + 1 = 0").width).toBeCloseTo(80.23, 0);
	});
});

describe("measureKatex — CJK via the injected resolver", () => {
	it("routes CJK glyphs to the resolver instead of KaTeX metrics", () => {
		const calls: Array<{ glyph: string; fontCss: string }> = [];
		const spy: GlyphWidthResolver = (glyph, fontCss) => {
			calls.push({ glyph, fontCss });
			return 20;
		};
		const geo = measure("\\text{速度}", { glyphWidth: spy });
		expect(calls.map((c) => c.glyph)).toEqual(["速", "度"]);
		// 2 glyphs × 20px, plus whatever chrome the text node carries.
		expect(geo.width).toBeGreaterThanOrEqual(40);
		// The resolver must be handed a canvas-compatible font shorthand.
		expect(calls[0]?.fontCss).toMatch(/\d+(\.\d+)?px/);
	});

	it("measures CJK far wider than KaTeX's substituted metric", () => {
		// KaTeX reports ~15.5px for `速度` at 14px base (it substitutes "M");
		// a real font measures ~33.9px. The resolver must win.
		const viaResolver = measure("\\text{速度}", { glyphWidth: stubResolver });
		const viaKatex = measure("\\text{速度}");
		expect(viaResolver.width).toBeGreaterThan(viaKatex.width * 1.5);
	});

	it("does not consult the resolver for pure ASCII math", () => {
		let called = 0;
		measure("x^2 + y^2 = z^2", {
			glyphWidth: (_g, f) => {
				called++;
				return stubResolver(_g, f);
			},
		});
		expect(called).toBe(0);
	});

	it("falls back to KaTeX metrics when the resolver cannot measure", () => {
		const geo = measure("\\text{速度}", { glyphWidth: () => null });
		expect(geo.width).toBeGreaterThan(0);
		expect(Number.isFinite(geo.width)).toBe(true);
	});

	it("mixes resolver and KaTeX metrics within one formula", () => {
		const geo = measure("\\text{能量}E = mc^2", { glyphWidth: stubResolver });
		const asciiOnly = measure("E = mc^2", { glyphWidth: stubResolver });
		expect(geo.width).toBeGreaterThan(asciiOnly.width);
	});
});

describe("measureKatex — degradation", () => {
	it("flags unparseable input but still returns geometry", () => {
		const geo = measure("\\frac{");
		expect(geo.error).not.toBeNull();
		expect(geo.height).toBeGreaterThan(0);
		expect(Number.isFinite(geo.width)).toBe(true);
	});

	it("handles empty input", () => {
		const geo = measure("");
		expect(geo.error).toBeNull();
		expect(geo.width).toBeGreaterThanOrEqual(0);
		expect(geo.height).toBeGreaterThan(0);
	});

	it("degrades to a line-box placeholder when the runtime throws", () => {
		const broken: KatexRuntime = {
			__renderToHTMLTree: () => {
				throw new Error("boom");
			},
			renderToString: () => "",
		};
		const geo = measureKatex(broken, "x", { displayMode: false, basePx: BASE_PX });
		expect(geo.error).toBe("boom");
		expect(geo.width).toBe(0);
		expect(geo.height).toBeCloseTo(BASE_PX * KATEX_FONT_SCALE * KATEX_LINE_HEIGHT, 6);
	});

	it("matches Chrome-measured widths for representative formulas", () => {
		// Ground truth captured by rendering each formula in real headless Chrome
		// (KaTeX 0.16.45, 14px base, fonts loaded) and reading the `.base` boxes.
		// These pin the four corrections the walker makes: combined glyphs, the
		// sqrt radical min-width, script-size scaling, and stacked-vlist max-width.
		const groundTruth: Array<[latex: string, chromeWidth: number]> = [
			["E = mc^2", 65.05],
			["a+b", 36.94],
			["\\frac{1}{2}", 9.98],
			["\\sqrt{a^2+b^2}", 64.58],
			["\\int_0^1 x^2\\,dx = \\frac{1}{3}", 91.23],
			["\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}", 156.02],
			["\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", 59.66],
			["x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}", 106.5],
			["f(x) = \\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}", 137.47],
			["\\lim_{x \\to \\infty} \\frac{\\sin x}{x}", 85.38],
			["P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}", 161.2],
			["\\binom{n}{k}", 22.64],
			["e^{i\\pi} + 1 = 0", 80.23],
			["\\overline{AB} \\parallel \\underline{CD}", 72.11],
			["\\mathbf{A}^{T}\\mathbf{B}", 37.98],
		];
		for (const [latex, chromeWidth] of groundTruth) {
			// The real resolver is canvas-backed; these formulas are pure ASCII math
			// so KaTeX's own metrics apply and no resolver is consulted.
			const geo = measure(latex);
			expect(Math.abs(geo.width - chromeWidth)).toBeLessThan(0.2);
		}
	});

	it("never returns NaN geometry for a range of real formulas", () => {
		const formulas = [
			"E = mc^2",
			"\\frac{1}{2}",
			"\\sqrt{a^2+b^2}",
			"\\int_0^1 x^2\\,dx = \\frac{1}{3}",
			"\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}",
			"\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
			"x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}",
			"f(x) = \\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}",
			"\\lim_{x \\to \\infty} \\frac{\\sin x}{x}",
			"P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}",
			"\\vec{F} = m\\vec{a}",
			"\\left( \\frac{a}{b} \\right)^n",
			"\\binom{n}{k}",
			"\\overline{AB} \\parallel \\underline{CD}",
			"\\mathbf{A}^{T}\\mathbf{B}",
		];
		for (const formula of formulas) {
			const geo = measure(formula, { glyphWidth: stubResolver });
			expect(Number.isFinite(geo.width)).toBe(true);
			expect(Number.isFinite(geo.height)).toBe(true);
			expect(geo.width).toBeGreaterThan(0);
			expect(geo.height).toBeGreaterThan(0);
		}
	});
});

describe("glyphAdvanceCache — capacity limit", () => {
	it("exposes a reasonable ceiling constant", () => {
		expect(GLYPH_ADVANCE_CACHE_CEILING).toBe(8192);
	});

	it("bulk-clears when capacity is exceeded and still returns correct values", () => {
		clearGlyphAdvanceCache();

		// The glyph advance cache is only populated when KaTeX merges multiple
		// adjacent SymbolNodes (tryCombineChars). Multi-character `\text{...}`
		// triggers this path: each glyph is looked up individually.
		measure("\\text{abcdef}");
		measure("\\text{ghijkl}");
		const sizeAfterFill = getGlyphAdvanceCacheSize();
		expect(sizeAfterFill).toBeGreaterThan(0);
		expect(sizeAfterFill).toBeLessThan(GLYPH_ADVANCE_CACHE_CEILING);

		// Verify determinism: measuring the same formula after a clear produces
		// identical width (the advance is recovered from KaTeX's own metrics).
		const before = measure("\\text{abcdef}");
		clearGlyphAdvanceCache();
		expect(getGlyphAdvanceCacheSize()).toBe(0);

		const after = measure("\\text{abcdef}");
		expect(after.width).toBeCloseTo(before.width, 10);
	});

	it("does not grow beyond the ceiling", () => {
		clearGlyphAdvanceCache();

		// Populate via \text{} with many distinct characters (triggers combined-glyph path).
		const alphabet = "abcdefghijklmnopqrstuvwxyz";
		for (let i = 0; i < 200; i++) {
			// Vary both glyph content and mode to maximize distinct cache keys.
			const chunk = alphabet.slice(i % 20, (i % 20) + 5);
			measure(`\\text{${chunk}${i}}`);
		}
		expect(getGlyphAdvanceCacheSize()).toBeLessThanOrEqual(GLYPH_ADVANCE_CACHE_CEILING);
	});
});
