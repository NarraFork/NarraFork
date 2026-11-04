/**
 * typography-css.ts — The reader's typography as CSS custom properties.
 *
 * ## Why this exists
 *
 * The transcript applies the 外观 · 排版 settings through the height model: pretext measures
 * with `typographyMetrics()`, and the render layer paints with the same numbers. The outline
 * surfaces use the SAME values (owner decision: 「大纲照搬对话的数值」), but most of them are
 * laid out by the browser — the live editor, the read-only tree, the task board — and the
 * mind map is measured by pretext yet painted by CSS. They all need those numbers as CSS.
 *
 * This module is the one place the numbers become CSS. Every value is read from
 * `typographyMetrics()` / `headingMetrics()`, so a stylesheet and the height model cannot
 * disagree about a size or a line box: there is no second copy to drift.
 *
 * ## Line boxes are px, not ratios
 *
 * The height model rounds every line box to whole pixels (`lineBoxHeight`), as the browser
 * does for a px line-height. A unitless ratio would let CSS lay out 14px × 1.74 = 24.36px
 * lines where measurement counted 24px — 0.36px of drift per line, which in the mind map
 * shows up as nodes whose text outgrows the box they were measured for. So every
 * `--nf-type-*-line` is the rounded px value, and sizes are the exact strings the font
 * shorthands carry (`${size}px`), so canvas and CSS resolve the same size.
 *
 * ## Letter spacing is an em fraction
 *
 * The transcript applies spacing per run as `size × percent` (`letterSpacingForFont`). CSS
 * gets the same thing from `letter-spacing: var(--nf-type-letter-spacing)` declared on each
 * text element (an `em` resolves against that element's own size; an inherited
 * `letter-spacing` would carry the parent's px instead).
 *
 * PURITY: no DOM (shared-core.guard). `frontend/lib/typography-css-vars.ts` writes these onto
 * `<html>` and keeps them current.
 */

import { headingMetrics, typographyMetrics } from "./pretext-fonts";
import { effectiveLineHeightPercent, getTypography } from "./typography";

/** The custom property names, by role. */
export const TYPOGRAPHY_CSS_VARS = {
	/** Raw multipliers (unitless) for anything that scales with a knob rather than a role. */
	fontScale: "--nf-type-font-scale",
	/** Line-height multiplier on the Mantine ratios: 1.2 at the default (120% baseline). */
	lineScale: "--nf-type-line-scale",
	/** Letter spacing as an em length (`0.02em`); declare it per text element. */
	letterSpacing: "--nf-type-letter-spacing",
	blockScale: "--nf-type-block-scale",
	/** Body text: the conversation's markdown paragraphs (14px × font scale). */
	bodySize: "--nf-type-body-size",
	bodyLine: "--nf-type-body-line",
	/** Small / meta text: the conversation's xs role (12px). */
	xsSize: "--nf-type-xs-size",
	xsLine: "--nf-type-xs-line",
	/** Inline code: the conversation's inline code (xs, monospace). */
	codeSize: "--nf-type-code-size",
	/** Fenced code: the conversation's code blocks (11px, base line box). */
	codeBlockSize: "--nf-type-code-block-size",
	codeBlockLine: "--nf-type-code-block-line",
	/** The gap between paragraphs (markdown block margin, block-spacing knob). */
	paragraphGap: "--nf-type-paragraph-gap",
} as const;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** `--nf-type-h{n}-size` / `--nf-type-h{n}-line`: the conversation's markdown headings. */
export function headingCssVar(level: HeadingLevel, part: "size" | "line"): string {
	return `--nf-type-h${level}-${part}`;
}

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

/**
 * Every typography custom property with its value at the current setting.
 *
 * Cheap enough to call on every change (a dozen string builds over memoised metrics); the
 * frontend calls it once per typography generation.
 */
export function typographyCssVariables(): Record<string, string> {
	const t = getTypography();
	const m = typographyMetrics();
	const v = TYPOGRAPHY_CSS_VARS;
	const vars: Record<string, string> = {
		[v.fontScale]: `${t.fontScalePercent / 100}`,
		[v.lineScale]: `${effectiveLineHeightPercent() / 100}`,
		[v.letterSpacing]: `${t.letterSpacingPercent / 100}em`,
		[v.blockScale]: `${t.paragraphScalePercent / 100}`,
		[v.bodySize]: `${m.size.sm}px`,
		[v.bodyLine]: `${m.line.body}px`,
		[v.xsSize]: `${m.size.xs}px`,
		[v.xsLine]: `${m.line.xs}px`,
		[v.codeSize]: `${m.size.xs}px`,
		[v.codeBlockSize]: `${m.codeSize}px`,
		[v.codeBlockLine]: `${m.line.code}px`,
		[v.paragraphGap]: `${m.margin.paragraph}px`,
	};
	for (const level of HEADING_LEVELS) {
		const h = headingMetrics(level);
		vars[headingCssVar(level, "size")] = `${h.size}px`;
		vars[headingCssVar(level, "line")] = `${h.lineHeight}px`;
	}
	return vars;
}
