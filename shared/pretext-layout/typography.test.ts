/**
 * typography.test.ts — Pins the contract of the user-configurable typography
 * source, whose failure modes are all SILENT.
 *
 * Every assertion here stands in for a defect that produces no error: a stale
 * cache entry serves wrap points measured at a different size (text overflows its
 * reserved line box), an unclamped preference makes text collide with fixed card
 * chrome, or a generation that fails to move leaves the committed layout in place
 * while the render layer paints something else.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";
import {
	getPreparedMarkdownBlocks,
	getPreparedTextWithSegments,
	preparedMarkdownCacheStats,
	resetPreparedMarkdownCache,
} from "./prepared-markdown-cache";
import {
	clampTypography,
	clampTypographyValue,
	DEFAULT_TYPOGRAPHY,
	effectiveLineHeightPercent,
	getTypography,
	getTypographyRevision,
	isDefaultTypography,
	LEGACY_LINE_HEIGHT_RANGE,
	LINE_HEIGHT_BASELINE_PERCENT,
	legacyLineHeightPercentFrom,
	letterSpacingPxFor,
	lineHeightPercentFromLegacy,
	onTypographyChange,
	resetTypographyForTest,
	scaleBlockSpacing,
	scaleFontSize,
	scaleLineHeightRatio,
	setTypography,
	TYPOGRAPHY_RANGE,
} from "./typography";

beforeAll(() => {
	// pretext measures via canvas; without a context every prepare() throws.
	installCanvasStub();
});

beforeEach(() => {
	resetTypographyForTest();
	resetPreparedMarkdownCache();
});

describe("defaults", () => {
	it("is neutral for size, spacing and blocks; line height is the 120% baseline", () => {
		// Every size constant in pretext-fonts.ts is written against the default. Line
		// height is the one deliberate exception (LINE_HEIGHT_BASELINE_PERCENT, pinned
		// below): its 100% is the old 120%.
		expect(DEFAULT_TYPOGRAPHY).toEqual({
			fontScalePercent: 100,
			letterSpacingPercent: 0,
			lineHeightScalePercent: 100,
			paragraphScalePercent: 100,
		});
		expect(isDefaultTypography()).toBe(true);
		expect(getTypographyRevision()).toBe(0);
	});

	it("scales to identity at the default setting", () => {
		expect(scaleFontSize(14)).toBe(14);
		expect(scaleBlockSpacing(4.9)).toBe(4.9);
		// Zero is load-bearing: it lets callers omit pretext's letterSpacing option
		// entirely, keeping the engine's no-spacing fast path.
		expect(letterSpacingPxFor(14)).toBe(0);
	});
});

describe("clamping", () => {
	it("bounds each knob to its declared range", () => {
		expect(clampTypographyValue("fontScalePercent", 9999)).toBe(
			TYPOGRAPHY_RANGE.fontScalePercent.max,
		);
		expect(clampTypographyValue("fontScalePercent", 1)).toBe(TYPOGRAPHY_RANGE.fontScalePercent.min);
		expect(clampTypographyValue("letterSpacingPercent", -100)).toBe(
			TYPOGRAPHY_RANGE.letterSpacingPercent.min,
		);
		expect(clampTypographyValue("paragraphScalePercent", 1000)).toBe(
			TYPOGRAPHY_RANGE.paragraphScalePercent.max,
		);
	});

	it("falls back to the default for non-finite input", () => {
		// A hand-edited preference or a failed parse must not produce NaN geometry:
		// NaN propagates into every height and the layout collapses with no error.
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(clampTypographyValue("fontScalePercent", bad)).toBe(
				TYPOGRAPHY_RANGE.fontScalePercent.fallback,
			);
		}
		expect(clampTypography(null)).toEqual(DEFAULT_TYPOGRAPHY);
		expect(clampTypography({})).toEqual(DEFAULT_TYPOGRAPHY);
		expect(clampTypography(undefined)).toEqual(DEFAULT_TYPOGRAPHY);
	});

	it("rounds to whole percent so float noise cannot mint extra generations", () => {
		setTypography({ fontScalePercent: 120.4 });
		const first = getTypographyRevision();
		expect(getTypography().fontScalePercent).toBe(120);
		// 120.4 and 120.2 both round to 120: identical geometry must not invalidate
		// the whole transcript's cached measurements a second time.
		expect(setTypography({ fontScalePercent: 120.2 })).toBe(false);
		expect(getTypographyRevision()).toBe(first);
	});

	it("clamps on write, not just on read", () => {
		setTypography({ fontScalePercent: 9999 });
		expect(getTypography().fontScalePercent).toBe(TYPOGRAPHY_RANGE.fontScalePercent.max);
	});
});

describe("generation", () => {
	it("advances only when a value actually moves", () => {
		expect(setTypography({ fontScalePercent: 100 })).toBe(false);
		expect(getTypographyRevision()).toBe(0);

		expect(setTypography({ fontScalePercent: 130 })).toBe(true);
		expect(getTypographyRevision()).toBe(1);

		// A no-op write must not bump: the generation gates a full document rebuild,
		// so a spurious bump re-measures every message for nothing.
		expect(setTypography({ fontScalePercent: 130 })).toBe(false);
		expect(getTypographyRevision()).toBe(1);
	});

	it("merges partial updates instead of resetting the untouched knobs", () => {
		setTypography({ fontScalePercent: 130 });
		setTypography({ letterSpacingPercent: 5 });
		expect(getTypography()).toEqual({
			fontScalePercent: 130,
			letterSpacingPercent: 5,
			lineHeightScalePercent: 100,
			paragraphScalePercent: 100,
		});
	});

	it("notifies subscribers before returning", () => {
		let seen = -1;
		const off = onTypographyChange(() => {
			seen = getTypographyRevision();
		});
		setTypography({ paragraphScalePercent: 150 });
		// Synchronous notification matters: the caller clears the height cache and
		// rebuilds right after this returns, and a listener that had not yet dropped
		// its stale prepared blocks would be re-measured from them.
		expect(seen).toBe(getTypographyRevision());
		off();
		setTypography({ paragraphScalePercent: 160 });
		expect(seen).toBe(getTypographyRevision() - 1);
	});
});

describe("derived helpers", () => {
	it("scales font size fractionally rather than rounding to px", () => {
		setTypography({ fontScalePercent: 105 });
		// Rounding here would quantise the scale: every multiplier from 104% to 110%
		// would collapse to 15px at a 14px base, making the slider feel broken.
		expect(scaleFontSize(14)).toBeCloseTo(14.7, 10);
	});

	it("derives letter spacing from the SCALED size, as an em fraction", () => {
		setTypography({ fontScalePercent: 150, letterSpacingPercent: 10 });
		// Callers pass the already-scaled size, so the font multiplier cannot be
		// applied twice. 14 → 21px scaled, 10% of that = 2.1px.
		expect(letterSpacingPxFor(scaleFontSize(14))).toBeCloseTo(2.1, 10);
		// The em-fraction contract: the same setting yields proportionally less
		// spacing on a smaller role (an 11px code line), which is why the knob is a
		// percentage rather than a pixel gap.
		expect(letterSpacingPxFor(scaleFontSize(11))).toBeCloseTo(1.65, 10);
	});

	it("keeps block spacing independent of the font scale", () => {
		// The two knobs must not multiply each other: a user who enlarges text
		// without asking for looser spacing should not get both.
		setTypography({ fontScalePercent: 180, paragraphScalePercent: 100 });
		expect(scaleBlockSpacing(10)).toBe(10);
		setTypography({ paragraphScalePercent: 200 });
		expect(scaleBlockSpacing(10)).toBe(20);
	});

	it("reports non-default once any knob moves", () => {
		expect(isDefaultTypography()).toBe(true);
		setTypography({ letterSpacingPercent: 1 });
		expect(isDefaultTypography()).toBe(false);
	});
});

describe("prepared-cache invalidation", () => {
	const markdown = "A paragraph long enough to have measurable fragments.";

	it("stops serving entries prepared under a previous setting", () => {
		const first = getPreparedMarkdownBlocks(markdown, undefined, "r1");
		// Same inputs → same shared array (this is the memo working).
		expect(getPreparedMarkdownBlocks(markdown, undefined, "r1")).toBe(first);

		setTypography({ fontScalePercent: 140 });
		const after = getPreparedMarkdownBlocks(markdown, undefined, "r1");
		// A hit here would mean the transcript keeps wrap points measured at 14px
		// while the DOM paints at 19.6px — the exact measure/render divergence the
		// height model exists to prevent.
		expect(after).not.toBe(first);
	});

	it("drops retained entries rather than only keying around them", () => {
		getPreparedMarkdownBlocks(markdown, undefined, "r1");
		getPreparedTextWithSegments("plain body text", "400 14px sans-serif");
		expect(preparedMarkdownCacheStats().size).toBeGreaterThan(0);

		setTypography({ fontScalePercent: 140 });
		// Keying alone would leave the old entries in memory; sweeping a slider
		// across 70..180 would then retain ~110 copies of the whole transcript.
		expect(preparedMarkdownCacheStats().size).toBe(0);
	});

	it("keys plain-text segments on letter spacing at one font size", () => {
		const font = "400 14px sans-serif";
		const tight = getPreparedTextWithSegments("hello world", font, undefined, 0);
		const loose = getPreparedTextWithSegments("hello world", font, undefined, 1.4);
		// The font string is identical, so without letterSpacing in the key these
		// would collide and the spaced text would be measured as unspaced.
		expect(loose).not.toBe(tight);
		expect(getPreparedTextWithSegments("hello world", font, undefined, 1.4)).toBe(loose);
	});

	it("treats omitted and zero letter spacing as the same entry", () => {
		const font = "400 14px sans-serif";
		// Neutral typography must produce byte-identical prepared handles to the
		// pre-feature behaviour, including reusing the same cache slot.
		const omitted = getPreparedTextWithSegments("hello world", font);
		expect(getPreparedTextWithSegments("hello world", font, undefined, 0)).toBe(omitted);
	});
});

describe("line-height baseline: the old 120% is the new 100%", () => {
	it("measures the default exactly as the old 120% setting did", () => {
		expect(LINE_HEIGHT_BASELINE_PERCENT).toBe(120);
		expect(effectiveLineHeightPercent()).toBe(120);
		// Bit-for-bit the old arithmetic at 120% (`ratio × percent / 100`), for every
		// ratio the transcript measures with: body, xs, base, headings, notices.
		for (const ratio of [1.45, 1.4, 1.55, 1.3, 1.35, 1.5, 1.2]) {
			expect(scaleLineHeightRatio(ratio)).toBe((ratio * 120) / 100);
		}
	});

	it("multiplies the slider onto the baseline", () => {
		setTypography({ lineHeightScalePercent: 110 });
		expect(effectiveLineHeightPercent()).toBeCloseTo(132, 10);
		expect(scaleLineHeightRatio(1.45)).toBeCloseTo(1.45 * 1.32, 10);
		setTypography({ lineHeightScalePercent: TYPOGRAPHY_RANGE.lineHeightScalePercent.min });
		expect(effectiveLineHeightPercent()).toBe(72);
	});

	it("maps the old default (and nothing stored) to the new default", () => {
		// 100 is what every row saved before the rescale carries unless the reader moved
		// the slider (the INSERT wrote the default), and what "reset" wrote.
		expect(lineHeightPercentFromLegacy(100)).toBe(100);
		expect(lineHeightPercentFromLegacy(null)).toBe(100);
		expect(lineHeightPercentFromLegacy(undefined)).toBe(100);
		expect(lineHeightPercentFromLegacy(Number.NaN)).toBe(100);
	});

	it("keeps the effective line height of every value saved on the old scale", () => {
		expect(lineHeightPercentFromLegacy(120)).toBe(100);
		expect(lineHeightPercentFromLegacy(150)).toBe(125);
		expect(lineHeightPercentFromLegacy(110)).toBe(92);
		for (
			let legacy: number = LEGACY_LINE_HEIGHT_RANGE.min;
			legacy <= LEGACY_LINE_HEIGHT_RANGE.max;
			legacy += 5
		) {
			if (legacy === 100) continue;
			const next = lineHeightPercentFromLegacy(legacy);
			// Inside the new range (the old floor and ceiling still have a place)…
			expect(next).toBeGreaterThanOrEqual(TYPOGRAPHY_RANGE.lineHeightScalePercent.min);
			expect(next).toBeLessThanOrEqual(TYPOGRAPHY_RANGE.lineHeightScalePercent.max);
			// …and within half a percent of the same effective ratio (whole-percent storage).
			expect(Math.abs((next * LINE_HEIGHT_BASELINE_PERCENT) / 100 - legacy)).toBeLessThanOrEqual(
				0.6,
			);
		}
	});

	it("never moves a value twice: converting is a function of the old value only", () => {
		// The server derives on read and never writes the old column, so the same old value
		// always yields the same new one — reading it again cannot rescale it again.
		for (const legacy of [75, 95, 100, 135, 220]) {
			const once = lineHeightPercentFromLegacy(legacy);
			expect(lineHeightPercentFromLegacy(legacy)).toBe(once);
		}
	});

	it("mirrors a new-scale value onto the old scale for older builds", () => {
		expect(legacyLineHeightPercentFrom(100)).toBe(120);
		expect(legacyLineHeightPercentFrom(92)).toBe(110);
		expect(legacyLineHeightPercentFrom(125)).toBe(150);
		// The ends of the new range land on the ends of the old one.
		expect(legacyLineHeightPercentFrom(TYPOGRAPHY_RANGE.lineHeightScalePercent.min)).toBe(
			LEGACY_LINE_HEIGHT_RANGE.min,
		);
		expect(legacyLineHeightPercentFrom(TYPOGRAPHY_RANGE.lineHeightScalePercent.max)).toBe(
			LEGACY_LINE_HEIGHT_RANGE.max,
		);
		// An older build reading the mirror back converts to the same value (round trip).
		for (const v of [65, 80, 92, 100, 108, 125, 160]) {
			expect(lineHeightPercentFromLegacy(legacyLineHeightPercentFrom(v))).toBe(v);
		}
	});
});
