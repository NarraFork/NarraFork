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
	getTypography,
	getTypographyRevision,
	isDefaultTypography,
	letterSpacingPxFor,
	onTypographyChange,
	resetTypographyForTest,
	scaleBlockSpacing,
	scaleFontSize,
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
	it("is neutral, so an untouched install measures exactly as before", () => {
		// The whole point of the neutral setting is that every constant in
		// pretext-fonts.ts is written against it. A non-neutral default would silently
		// re-flow every existing narrator.
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
