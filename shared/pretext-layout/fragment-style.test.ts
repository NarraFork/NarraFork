/**
 * fragment-style.test.ts — Letter spacing must reach PAINT, not just measurement.
 *
 * This file exists because of a shipped defect: the setting was threaded into the
 * pretext height model (wrap points moved, heights changed) but never emitted as CSS,
 * so the visible text stayed tight. Measurement and paint disagreed, which is the one
 * failure the exact-layout architecture exists to prevent — and nothing logged it.
 *
 * The second test guards the off-by-one that a naive fix introduces: pretext adds
 * spacing BETWEEN graphemes (n−1 gaps), CSS adds it after EVERY grapheme (n). Without
 * the compensating negative margin every fragment paints one spacing unit wider than
 * its measured box, and since fragments are positioned from the measured layout, the
 * symptom is overlapping text rather than a shifted line.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { fragmentTextStyle, letterSpacingForFont } from "./fragment-style";
import { resetTypographyForTest, setTypography } from "./typography";

beforeEach(() => {
	resetTypographyForTest();
});

describe("letterSpacingForFont", () => {
	it("returns 0 while the reader wants no spacing", () => {
		// Zero is load-bearing: it lets both the measure and paint sides skip the
		// property entirely, keeping an unscaled transcript byte-identical to before.
		expect(letterSpacingForFont("400 14px sans-serif")).toBe(0);
	});

	it("derives an em fraction from the size in the font shorthand", () => {
		setTypography({ letterSpacingPercent: 10 });
		expect(letterSpacingForFont("400 14px sans-serif")).toBeCloseTo(1.4, 10);
		// A smaller role in the SAME line gets proportionally less, which is why the
		// setting is a percentage rather than a pixel gap.
		expect(letterSpacingForFont("400 11px monospace")).toBeCloseTo(1.1, 10);
	});

	it("reads fractional sizes, which the font scale produces", () => {
		// The font scale is applied without rounding (105% of 14px = 14.7px), so a
		// size-parser that only accepted integers would silently return 0 for most
		// scale values — spacing would vanish at 105% but work at 150%.
		setTypography({ letterSpacingPercent: 10 });
		expect(letterSpacingForFont("400 14.7px sans-serif")).toBeCloseTo(1.47, 10);
	});

	it("returns 0 for a shorthand with no readable size", () => {
		setTypography({ letterSpacingPercent: 10 });
		// An unparseable shorthand means something upstream changed shape. Spacing at a
		// guessed size would desync paint from measure; no spacing merely looks tight.
		expect(letterSpacingForFont("inherit")).toBe(0);
	});
});

describe("fragmentTextStyle", () => {
	it("emits the base geometry unchanged at zero spacing", () => {
		const style = fragmentTextStyle({ font: "400 14px sans-serif", gapBefore: 3 });
		expect(style).toEqual({
			font: "400 14px sans-serif",
			marginLeft: 3,
			whiteSpace: "pre",
			display: "inline-block",
		});
		// Absent, not zero: an unscaled document must produce the same style object it
		// did before this feature existed.
		expect("letterSpacing" in style).toBe(false);
		expect("marginRight" in style).toBe(false);
	});

	it("paints the spacing it was measured with", () => {
		// THE regression this file is named for: without this the property never
		// reached CSS and the setting had no visible effect at all.
		const spacing = 1.4;
		const style = fragmentTextStyle({ font: "400 14px sans-serif", letterSpacing: spacing });
		expect(style.letterSpacing).toBe("1.4px");
	});

	it("cancels the trailing unit CSS adds after the last grapheme", () => {
		// pretext measured (n-1) gaps; CSS paints n. The negative margin removes the
		// extra one so the painted advance equals the measured advance.
		const spacing = 1.4;
		const style = fragmentTextStyle({ font: "400 14px sans-serif", letterSpacing: spacing });
		expect(style.marginRight).toBe(-spacing);
	});

	it("keeps the measured leading gap independent of spacing", () => {
		// `marginLeft` carries the layout's own `gapBefore`; the spacing compensation
		// must live on the RIGHT or it would corrupt the fragment's start position.
		const style = fragmentTextStyle({
			font: "400 14px sans-serif",
			gapBefore: 5,
			letterSpacing: 2,
		});
		expect(style.marginLeft).toBe(5);
		expect(style.marginRight).toBe(-2);
	});

	it("nets to the measured advance for a multi-grapheme run", () => {
		// Arithmetic check of the whole contract, at 4 graphemes:
		//   measured  = glyphs + 3 × spacing        (pretext: n-1 gaps)
		//   painted   = glyphs + 4 × spacing        (CSS: n gaps)
		//   corrected = painted + marginRight       (= measured)
		const spacing = 1.4;
		const graphemes = 4;
		const glyphWidth = 40;
		const measured = glyphWidth + (graphemes - 1) * spacing;
		const style = fragmentTextStyle({ font: "400 14px sans-serif", letterSpacing: spacing });
		const painted = glyphWidth + graphemes * spacing + (style.marginRight ?? 0);
		expect(painted).toBeCloseTo(measured, 10);
	});
});
