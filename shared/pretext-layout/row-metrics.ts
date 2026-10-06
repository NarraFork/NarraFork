/**
 * row-metrics.ts — Geometry of a BARE list row, in one place.
 *
 * A "bare row" is the unadorned single-line row the folded surfaces are built from,
 * such as a folded trace's item row. Every surface that uses one must render it at
 * the same height — that is what makes a folded row read as one more line in the
 * column rather than as a card shouting beside it.
 *
 * ## Why this file rather than an import
 *
 * `measure-tool-run.ts` owned these constants first, and hoisting them here kept
 * them reachable by measure modules that `measure-tool-run` itself depends on:
 * reading them back upward from a module in its own dependency chain
 * (`measure-tool-run → measure-tool-call → …`) would close a cycle. A leaf module
 * gives every side one source without any of them depending on another.
 *
 * (The original second consumer was `measure-sidecar.ts`, removed when side-car
 * footnotes were replaced by injection message rows. The leaf placement is kept: the
 * cycle argument applies to any future consumer inside that chain, and moving the
 * numbers back would be a change with no benefit.)
 *
 * `measure-tool-run.ts` re-exports these under its established names
 * (`TRACE_ROW_HEIGHT` etc.) so its many callers and tests are untouched.
 *
 * Zero DOM, zero React — see CONTRACT.md §0 rule 2.
 */

import { FONT_SIZE, LINE_HEIGHT } from "./pretext-fonts";
import { getTypographyRevision, scaleFontSize, scaleLineHeightRatio } from "./typography";

/**
 * The xs single-line box at NEUTRAL typography: `12 × 1.4 = 16.8px`, UNROUNDED.
 *
 * Browsers lay out this fractional line box, so the raw value is the most faithful
 * prediction (JS float gives 16.799999…; tests assert with `toBeCloseTo`).
 * Deliberately different from `measure-reasoning.ts`, which rounds the xs line to 17
 * — the two use package-local names so they can never be confused for each other.
 *
 * This is the BASELINE. Measurement must read {@link bareRowMetrics} so the reader's
 * font scale applies.
 */
export const BARE_XS_LINE = FONT_SIZE.xs * LINE_HEIGHT.xs;

/** A row's `<Group py={1}>` padding (top and bottom each). */
export const BARE_ROW_PADDING_Y = 1;

/** Leading chevron / dot slot glyph size. */
export const BARE_ROW_CHEVRON = 12;
/** Per-row category chip (`ThemeIcon size={14}`). */
export const BARE_ROW_ICON = 14;
/** Trailing status glyph slot. */
export const BARE_ROW_STATUS = 12;
/** Horizontal gap between a row's cells (`<Group gap={6}>`). Never affects height. */
export const BARE_ROW_GAP = 6;

/**
 * The row's content lane at NEUTRAL typography:
 * `max(icon 14, chevron 12, status 12, xs line 16.8) = 16.8`.
 *
 * The text line dominates every glyph, which is precisely why the trailing status and
 * duration cells are height-neutral: adding them cannot raise this maximum.
 */
export const BARE_ROW_CONTENT = Math.max(
	BARE_ROW_ICON,
	BARE_ROW_CHEVRON,
	BARE_ROW_STATUS,
	BARE_XS_LINE,
);

/** Bare row height at NEUTRAL typography: `py*2 + content = 2 + 16.8 = 18.8`. */
export const BARE_ROW_HEIGHT = BARE_ROW_PADDING_Y * 2 + BARE_ROW_CONTENT;

/** A bare row's geometry at the reader's current typography. */
export interface BareRowMetrics {
	/** Scaled xs line box (unrounded, see {@link BARE_XS_LINE}). */
	xsLine: number;
	/** `max(glyph slots, xsLine)` — the lane the row's cells share. */
	content: number;
	/** `py*2 + content`. */
	height: number;
}

let cache: BareRowMetrics | null = null;
let cacheRevision = -1;

/**
 * Bare-row geometry at the current typography, memoised per generation.
 *
 * Only the TEXT LINE scales. The glyph slots (chevron 12, icon 14, status 12) are
 * fixed chrome and stay put, which is the whole reason `content` is a `max` rather
 * than a sum: at the default setting the 16.8px text line already dominates every
 * glyph, so scaling text up simply widens that lead. Scaling text DOWN eventually
 * lets a glyph win the max, and the row then stops shrinking — correct behaviour,
 * because the row still has to contain a 14px icon.
 */
export function bareRowMetrics(): BareRowMetrics {
	const revision = getTypographyRevision();
	if (cache && cacheRevision === revision) return cache;
	// Deliberately UNROUNDED (see BARE_XS_LINE), and scaled on both axes so a bare row
	// follows the same leading as the prose beside it.
	const xsLine = scaleFontSize(FONT_SIZE.xs) * scaleLineHeightRatio(LINE_HEIGHT.xs);
	const content = Math.max(BARE_ROW_ICON, BARE_ROW_CHEVRON, BARE_ROW_STATUS, xsLine);
	cache = { xsLine, content, height: BARE_ROW_PADDING_Y * 2 + content };
	cacheRevision = revision;
	return cache;
}
