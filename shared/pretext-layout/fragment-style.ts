/**
 * fragment-style.ts — The ONE place a measured text fragment becomes CSS.
 *
 * ## Why this module exists
 *
 * A fragment's geometry is decided before paint by the pretext height model, and the
 * render layer's only job is to reproduce it exactly. The `font` shorthand carries
 * size/weight/family, so passing `font: frag.font` was enough — until letter spacing
 * became configurable. Spacing is a SEPARATE CSS property that no font shorthand can
 * express, so it was measured and then never painted: the transcript's wrap points
 * moved while the visible text stayed tight.
 *
 * There are 13 fragment paint sites across 8 render modules. Each one applying the
 * property by hand is how one of them silently keeps painting unspaced text, so they
 * all go through {@link fragmentTextStyle}.
 *
 * ## The off-by-one that makes a naive fix wrong
 *
 * pretext adds spacing BETWEEN graphemes — `(n - 1) × spacing` for an n-grapheme run
 * (`addInternalLetterSpacing` in the engine). CSS `letter-spacing` adds it AFTER
 * every grapheme, including the last, so each fragment paints exactly one spacing
 * unit wider than it was measured.
 *
 * That error accumulates per fragment, not per line: a line of 12 fragments paints
 * 12 spacing units too wide. Because each fragment is an absolutely positioned
 * `inline-block` whose left edge comes from the measured layout, the visible symptom
 * is not a shifted line but overlapping text — every fragment overruns its box and
 * the next one is painted on top of the overrun.
 *
 * A negative `marginRight` of one spacing unit cancels the trailing space, which is
 * the standard remedy and keeps the painted advance equal to the measured one.
 * `marginRight` is unused elsewhere on these fragments (`marginLeft` carries
 * `gapBefore`), so there is nothing to collide with.
 */

/**
 * The CSS a fragment paints with.
 *
 * A structural type rather than React's `CSSProperties` so this module stays free of
 * React and can live beside the height model (`shared-core.guard` forbids a react
 * import here). It is assignable to `CSSProperties` at every call site.
 */
export interface FragmentTextStyle {
	font: string;
	marginLeft: number | undefined;
	whiteSpace: "pre";
	display: "inline-block";
	letterSpacing?: string;
	marginRight?: number;
}

/** A painted fragment's font + spacing, as the measure layer defined them. */
export interface FragmentStyleInput {
	/** The exact font shorthand measurement used (`block.fonts[itemIndex]`). */
	font: string;
	/** Leading gap from the measured layout. */
	gapBefore?: number;
	/**
	 * Letter spacing (px) this fragment was MEASURED with, or 0/undefined.
	 *
	 * Must be the value that went into pretext for this fragment, not a re-derived
	 * one: the setting is an em fraction, so a body run and a smaller inline-code run
	 * in the same line legitimately carry different values.
	 */
	letterSpacing?: number;
}

/**
 * CSS for one measured fragment.
 *
 * Returns the same object shape the paint sites used before (font + marginLeft +
 * `whiteSpace: "pre"` + `display: "inline-block"`), plus the spacing pair. At zero
 * spacing the two extra properties are omitted entirely, so an unscaled transcript
 * produces byte-identical style objects to the pre-feature behaviour.
 */
export function fragmentTextStyle(input: FragmentStyleInput): FragmentTextStyle {
	const base: FragmentTextStyle = {
		font: input.font,
		marginLeft: input.gapBefore,
		whiteSpace: "pre",
		display: "inline-block",
	};
	if (!input.letterSpacing) return base;
	return {
		...base,
		letterSpacing: `${input.letterSpacing}px`,
		// Cancel the trailing unit CSS adds after the final grapheme (see header).
		marginRight: -input.letterSpacing,
	};
}

/**
 * Re-exported so paint sites import their spacing derivation from the same place
 * their style helper comes from.
 *
 * The arithmetic itself lives in `@shared/pretext-layout/typography` because the
 * MEASURE side calls it too (`parse-markdown` builds pretext items with it). A local
 * copy here is precisely how the painted advance would drift from the measured one.
 */
export { letterSpacingForFont } from "./typography";
