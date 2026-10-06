/**
 * typography.ts — User-configurable typography for the exact narrator list.
 *
 * ## Why this is not a stylesheet
 *
 * The narrator transcript is laid out by the zero-DOM-measure height model
 * (CONTRACT.md §0 rule 2): every fragment's pixel width comes from canvas
 * `measureText`, and every element's height is arithmetic over those widths.
 * Font size, letter spacing and block spacing are therefore MEASUREMENT INPUTS,
 * not presentation applied afterwards.
 *
 * A CSS-only implementation (scaling `font-size` on a container) would enlarge the
 * painted glyphs while the model kept predicting the old heights: text would
 * overflow its reserved line box, the scrollbar length would be wrong, and the
 * virtualization anchors would drift. Nothing would throw — the transcript would
 * just be subtly broken. So the settings live here, upstream of measurement, and
 * both the measure layer and the render layer read them from this one module.
 *
 * ## Leaf placement
 *
 * This module imports NOTHING from its own directory. `pretext-fonts` (the font
 * strings and size constants) and `prepared-markdown-cache` (the cache key) both
 * depend on it, and `prepared-markdown-cache` registers a listener below to drop
 * its entries — reaching back into either from here would close a cycle. Same
 * reasoning as `row-metrics.ts`.
 *
 * ## Generation, not just values
 *
 * Changing a value invalidates work that is already committed: prepared blocks
 * carry baked pixel widths, the frontend's `measureCache` holds heights derived
 * from them, and the laid-out document has already placed those heights. So a
 * change bumps {@link getTypographyRevision}, which participates in the prepared
 * cache key, the layout revision and the document revision — exactly the plumbing
 * the FONT revision already uses (see prepared-markdown-cache's FONT REVISION
 * note), and for exactly the same failure mode.
 *
 * PURITY: no DOM, no `document.*` / `window.*` (enforced by shared-core.guard).
 * The frontend observes the user's preference and pushes it in via
 * {@link setTypography}.
 */

/** User-facing typography knobs, all expressed as percentages. */
export interface TypographySettings {
	/**
	 * Font-size multiplier in percent. 100 = the Mantine defaults every constant
	 * in `pretext-fonts.ts` is written against.
	 */
	fontScalePercent: number;
	/**
	 * Extra advance between graphemes, in percent OF THE FONT SIZE (i.e. an `em`
	 * fraction ×100), so one setting reads consistently across body text, headings
	 * and code rather than being a fixed pixel gap that looks heavy at 11px and
	 * invisible at 34px.
	 *
	 * Fed to pretext's own `letterSpacing` option, which accounts for it when
	 * choosing break points — a CSS-only `letter-spacing` would change where lines
	 * wrap without the model knowing.
	 */
	letterSpacingPercent: number;
	/**
	 * Line-height multiplier in percent: the spacing BETWEEN lines inside one
	 * paragraph. 100 = the Mantine line-height ratios (body 1.45, xs 1.4, base 1.55).
	 *
	 * Distinct from `paragraphScalePercent`, which spaces whole blocks APART. This one
	 * is intra-paragraph leading, so a reader can loosen dense wrapped prose without
	 * pushing paragraphs and cards away from each other.
	 *
	 * Unlike the font scale, this does NOT affect where lines wrap: pretext's
	 * `measureLineStats` / `measureRichInlineStats` take no line height, so the
	 * property is a pure multiplier on the line COUNT. That is why it never
	 * invalidates prepared handles — only the frame arithmetic downstream of them.
	 */
	lineHeightScalePercent: number;
	/**
	 * Block-spacing multiplier in percent: markdown block margins (paragraph, list,
	 * heading, code, table) and the gaps between transcript items. 100 = current
	 * spacing.
	 *
	 * Deliberately does NOT scale padding inside a card or the fixed decoration of
	 * a row: those are the box's own chrome, and stretching them would move
	 * borders and icons away from the text they belong to.
	 */
	paragraphScalePercent: number;
}

/**
 * Allowed range and default for each knob.
 *
 * The bounds are not cosmetic. Cards mix scaled text with UNSCALED fixed chrome
 * (icons, borders, capped detail boxes), so an extreme multiplier makes text
 * collide with decoration that cannot grow to accommodate it. These ranges keep
 * the mix legible in both directions; the clamp is applied on write so a hand-
 * edited preference cannot smuggle a value past it.
 */
export const TYPOGRAPHY_RANGE = {
	fontScalePercent: { min: 70, max: 180, fallback: 100 },
	// Negative tightens. Bounded harder than the positive side because a tight
	// setting eats into the glyph advance itself, where small values already read
	// as cramped.
	letterSpacingPercent: { min: -5, max: 25, fallback: 0 },
	// Floored well above zero: the line box must still contain the glyphs it wraps, and
	// a ratio under ~1 clips ascenders/descenders rather than merely tightening.
	lineHeightScalePercent: { min: 75, max: 220, fallback: 100 },
	paragraphScalePercent: { min: 50, max: 250, fallback: 100 },
} as const satisfies Record<
	keyof TypographySettings,
	{ min: number; max: number; fallback: number }
>;

/** The neutral setting: every constant in `pretext-fonts.ts` at face value. */
export const DEFAULT_TYPOGRAPHY: TypographySettings = {
	fontScalePercent: TYPOGRAPHY_RANGE.fontScalePercent.fallback,
	letterSpacingPercent: TYPOGRAPHY_RANGE.letterSpacingPercent.fallback,
	lineHeightScalePercent: TYPOGRAPHY_RANGE.lineHeightScalePercent.fallback,
	paragraphScalePercent: TYPOGRAPHY_RANGE.paragraphScalePercent.fallback,
};

/**
 * Clamp one knob, falling back to its default for non-finite input.
 *
 * Values are rounded to whole percent so that two settings which differ only by
 * float noise cannot mint two distinct cache generations for identical geometry.
 */
export function clampTypographyValue(key: keyof TypographySettings, value: number): number {
	const { min, max, fallback } = TYPOGRAPHY_RANGE[key];
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** Clamp a whole (possibly partial / untrusted) settings object. */
export function clampTypography(
	value: Partial<TypographySettings> | null | undefined,
): TypographySettings {
	return {
		fontScalePercent: clampTypographyValue(
			"fontScalePercent",
			value?.fontScalePercent ?? Number.NaN,
		),
		letterSpacingPercent: clampTypographyValue(
			"letterSpacingPercent",
			value?.letterSpacingPercent ?? Number.NaN,
		),
		lineHeightScalePercent: clampTypographyValue(
			"lineHeightScalePercent",
			value?.lineHeightScalePercent ?? Number.NaN,
		),
		paragraphScalePercent: clampTypographyValue(
			"paragraphScalePercent",
			value?.paragraphScalePercent ?? Number.NaN,
		),
	};
}

let current: TypographySettings = { ...DEFAULT_TYPOGRAPHY };
let revision = 0;
const listeners = new Set<() => void>();

/** The active typography. Read at MEASURE TIME, never captured at import time. */
export function getTypography(): TypographySettings {
	return current;
}

/**
 * Current typography generation.
 *
 * Folded into the prepared cache key, the layout revision and the document
 * revision so nothing measured under a previous setting is served afterwards.
 */
export function getTypographyRevision(): number {
	return revision;
}

/**
 * Publish new typography (clamped). Returns true when anything actually moved.
 *
 * Reports rather than acting silently for the same reason `setPreparedFontRevision`
 * does: dropping cached prepared blocks is necessary but not sufficient — the
 * caller still owns clearing the height cache and rebuilding the committed layout.
 * Listeners registered via {@link onTypographyChange} run before this returns.
 */
export function setTypography(next: Partial<TypographySettings>): boolean {
	const clamped = clampTypography({ ...current, ...next });
	if (
		clamped.fontScalePercent === current.fontScalePercent &&
		clamped.letterSpacingPercent === current.letterSpacingPercent &&
		clamped.lineHeightScalePercent === current.lineHeightScalePercent &&
		clamped.paragraphScalePercent === current.paragraphScalePercent
	) {
		return false;
	}
	current = clamped;
	revision += 1;
	for (const listener of listeners) listener();
	return true;
}

/**
 * Subscribe to typography changes (used by caches that bake the values in).
 *
 * Returns an unsubscribe. Listeners must not call `setTypography` — the notify
 * loop above iterates a live set.
 */
export function onTypographyChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Test seam: restore the neutral baseline AND rewind the generation.
 *
 * Unlike the font revision (a monotonic description of the environment), the
 * typography generation only ever gates caches that are cleared alongside it, so
 * a test may safely rewind it to get a reproducible baseline. Listeners are
 * notified so those caches drop entries minted under the previous setting.
 */
export function resetTypographyForTest(): void {
	current = { ...DEFAULT_TYPOGRAPHY };
	revision = 0;
	for (const listener of listeners) listener();
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived helpers — the ONLY sanctioned way to apply the settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scale a base font size (px).
 *
 * Kept fractional on purpose: canvas `measureText` and CSS both accept
 * fractional px, and rounding here would quantise the scale into visible steps
 * (at 14px base, every multiplier between 104% and 110% would collapse to 15px).
 * Rounding happens once, later, on the LINE BOX — which is what the browser
 * actually lays out.
 */
export function scaleFontSize(basePx: number): number {
	return (basePx * current.fontScalePercent) / 100;
}

/**
 * Extra advance (px) between graphemes at a given ALREADY-SCALED font size.
 *
 * Takes the scaled size rather than the base so callers cannot accidentally
 * apply the font multiplier twice; pass the same size that went into the font
 * string.
 */
export function letterSpacingPxFor(scaledFontSizePx: number): number {
	return (scaledFontSizePx * current.letterSpacingPercent) / 100;
}

/** The px size in a pretext/CSS font shorthand (`[style] [weight] <size>px <family>`). */
const FONT_SHORTHAND_SIZE = /(\d+(?:\.\d+)?)px/;

/**
 * Letter spacing (px) for a run of text, derived from the size in the font
 * shorthand it is measured and painted with.
 *
 * THE single derivation, used by both sides: the measure layer calls it when
 * building pretext items, and the render layer calls it when emitting CSS. Two
 * copies of this arithmetic is how the painted advance comes to disagree with the
 * measured one — and that disagreement shows up as overlapping text, with nothing
 * logged.
 *
 * The font string is the authoritative input because it is what BOTH sides actually
 * use; a role name would have to be kept in sync separately.
 *
 * Returns 0 when the reader wants no spacing, and also when the size cannot be read
 * — an unparseable shorthand means something upstream changed shape, and spacing at
 * a guessed size would be worse than none.
 */
export function letterSpacingForFont(font: string): number {
	if (current.letterSpacingPercent === 0) return 0;
	const match = FONT_SHORTHAND_SIZE.exec(font);
	if (!match?.[1]) return 0;
	const size = Number.parseFloat(match[1]);
	if (!Number.isFinite(size)) return 0;
	return (size * current.letterSpacingPercent) / 100;
}

/**
 * Scale a line-height RATIO (not a px value).
 *
 * Takes the unitless ratio (1.45, 1.4, …) because that is what the callers hold, and
 * because scaling the ratio before it meets the font size keeps the two knobs
 * independent: `lineBoxHeight(scaledSize, scaledRatio)` is the only place they
 * combine, exactly as CSS does it.
 */
export function scaleLineHeightRatio(baseRatio: number): number {
	return (baseRatio * current.lineHeightScalePercent) / 100;
}

/**
 * Scale a block-spacing value (px): markdown block margins and item gaps.
 *
 * Not for padding or fixed chrome — see {@link TypographySettings.paragraphScalePercent}.
 */
export function scaleBlockSpacing(basePx: number): number {
	return (basePx * current.paragraphScalePercent) / 100;
}

/**
 * True when the active setting is the neutral one.
 *
 * Lets hot paths skip work that provably cannot change anything — most
 * importantly, omitting pretext's `letterSpacing` option entirely at 0 so the
 * engine keeps its no-spacing fast path.
 */
export function isDefaultTypography(): boolean {
	return (
		current.fontScalePercent === DEFAULT_TYPOGRAPHY.fontScalePercent &&
		current.letterSpacingPercent === DEFAULT_TYPOGRAPHY.letterSpacingPercent &&
		current.lineHeightScalePercent === DEFAULT_TYPOGRAPHY.lineHeightScalePercent &&
		current.paragraphScalePercent === DEFAULT_TYPOGRAPHY.paragraphScalePercent
	);
}
