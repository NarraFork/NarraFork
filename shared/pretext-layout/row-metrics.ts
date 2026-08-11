/**
 * row-metrics.ts — Geometry of a BARE list row, in one place.
 *
 * A "bare row" is the unadorned single-line row the folded surfaces are built from:
 * a folded trace's item row, and (since the side-car redesign) a side-car footnote's
 * header row. They must be the same height — that is the whole point of the footnote
 * form, which exists so a system injection reads as one more line in the column
 * rather than as a coloured card shouting beside it.
 *
 * ## Why this file rather than an import
 *
 * `measure-tool-run.ts` owned these constants first. `measure-sidecar.ts` cannot
 * import them from there: `measure-tool-run → measure-tool-call → measure-sidecar`
 * is an existing dependency chain (the trace layer measures drill-down cards, which
 * measure their own side-car band), so reading upward would close a cycle. Hoisting
 * the numbers into a leaf module gives both sides one source without one depending
 * on the other.
 *
 * `measure-tool-run.ts` re-exports these under its established names
 * (`TRACE_ROW_HEIGHT` etc.) so its many callers and tests are untouched.
 *
 * Zero DOM, zero React — see CONTRACT.md §0 rule 2.
 */

import { FONT_SIZE, LINE_HEIGHT } from "./pretext-fonts";

/**
 * The xs single-line box: `12 × 1.4 = 16.8px`, kept UNROUNDED.
 *
 * Browsers lay out this fractional line box, so the raw value is the most faithful
 * prediction (JS float gives 16.799999…; tests assert with `toBeCloseTo`).
 * Deliberately different from `measure-reasoning.ts`, which rounds the xs line to 17
 * — the two use package-local names so they can never be confused for each other.
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
 * The row's content lane: `max(icon 14, chevron 12, status 12, xs line 16.8) = 16.8`.
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

/** Bare row height: `py*2 + content = 2 + 16.8 = 18.8`. */
export const BARE_ROW_HEIGHT = BARE_ROW_PADDING_Y * 2 + BARE_ROW_CONTENT;
