/**
 * pretext-fonts.ts — Single source of truth for font strings + size/line-height
 * constants used by the pretext-based zero-DOM-measure narrator list (vlist).
 *
 * These MUST mirror the actual rendered CSS so pretext's canvas measurement
 * matches the browser's layout. Values are copied from:
 *   - Mantine v7 DEFAULT_THEME (node_modules/@mantine/core .../default-theme)
 *     fontSizes / lineHeights / headings.sizes / spacing / radius
 *   - MarkdownContent.module.css (the ground-truth markdown styles)
 *
 * The app theme (frontend/main.tsx) only overrides primaryColor + defaultRadius
 * ("sm"); it does NOT override fontFamily / fontSizes / lineHeights / headings,
 * so the Mantine defaults below are authoritative.
 *
 * IMPORTANT: pretext `font` strings follow the CSS shorthand accepted by canvas
 * `measureText`: "[style] [weight] <size>px <family>". Keep size in px.
 *
 * ## Constants are the BASELINE; `typographyMetrics()` is what to measure with
 *
 * Every `export const` below is the NEUTRAL (100%) value — the Mantine default the
 * whole height model was originally written against. They are still correct as
 * base values and as the reference the scaling is defined against, but a module
 * that captures one at import time freezes the reader's typography at whatever it
 * was when the bundle loaded.
 *
 * New code, and anything that feeds a `font` string or a line height into
 * measurement, must read {@link typographyMetrics} at MEASURE TIME instead. The
 * returned snapshot is memoised per typography generation, so calling it per
 * fragment is cheap.
 *
 * Failing to do so is silent: heights stay at the baseline while the render layer
 * paints scaled text, so rows overlap and the scrollbar lies.
 */

import {
	getTypographyRevision,
	letterSpacingPxFor,
	scaleBlockSpacing,
	scaleFontSize,
	scaleLineHeightRatio,
} from "./typography";

// ── Font families (Mantine defaults; app does not override) ──────────────────
export const SANS_FAMILY =
	"-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji";
export const MONO_FAMILY =
	"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
// Headings share the base family by default (theme.headings.fontFamily === DEFAULT_FONT_FAMILY).
export const HEADINGS_FAMILY = SANS_FAMILY;

// ── Font sizes (px) — Mantine fontSizes, 1rem = 16px ─────────────────────────
export const FONT_SIZE = {
	xs: 12,
	sm: 14,
	md: 16,
	lg: 18,
	xl: 20,
} as const;

// ── Line heights (unitless multipliers) — Mantine lineHeights ────────────────
export const LINE_HEIGHT = {
	xs: 1.4,
	sm: 1.45,
	md: 1.55, // === --mantine-line-height (base)
	lg: 1.6,
	xl: 1.65,
} as const;

/** Base line-height (--mantine-line-height) used by inline <code> etc. */
export const BASE_LINE_HEIGHT = LINE_HEIGHT.md;

// ── Heading sizes — Mantine headings.sizes (fontSize px / lineHeight) ────────
export const HEADING = {
	h1: { size: 34, lineHeight: 1.3 },
	h2: { size: 26, lineHeight: 1.35 },
	h3: { size: 22, lineHeight: 1.4 },
	h4: { size: 18, lineHeight: 1.45 },
	h5: { size: 16, lineHeight: 1.5 },
	h6: { size: 14, lineHeight: 1.5 },
} as const;

// ── Font weights — Mantine fontWeights ───────────────────────────────────────
export const FONT_WEIGHT = {
	regular: 400,
	medium: 600,
	bold: 700,
} as const;

// ── Spacing (px) — Mantine spacing, 1rem = 16px ──────────────────────────────
export const SPACING = {
	xs: 10,
	sm: 12,
	md: 16,
	lg: 20,
	xl: 32,
} as const;

// ── Radius (px) — Mantine radius; app defaultRadius = "sm" ───────────────────
export const RADIUS = {
	xs: 2,
	sm: 4,
	md: 8,
	lg: 16,
	xl: 32,
} as const;

// ── Prebuilt font strings for the common text roles ──────────────────────────
// Markdown body paragraph / list / link: 14px / 1.45, weight 400.
export const FONT_BODY = `${FONT_WEIGHT.regular} ${FONT_SIZE.sm}px ${SANS_FAMILY}`;
export const FONT_BODY_BOLD = `${FONT_WEIGHT.bold} ${FONT_SIZE.sm}px ${SANS_FAMILY}`;
export const FONT_BODY_ITALIC = `italic ${FONT_WEIGHT.regular} ${FONT_SIZE.sm}px ${SANS_FAMILY}`;
export const FONT_BODY_BOLD_ITALIC = `italic ${FONT_WEIGHT.bold} ${FONT_SIZE.sm}px ${SANS_FAMILY}`;
// Inline code: xs (12px), base line-height (1.55), monospace.
export const FONT_INLINE_CODE = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${MONO_FAMILY}`;
// Fenced code block body: xs (12px) monospace (matches <Code> fallback; used by
// system-text bash_command where the body renders at xs).
export const FONT_CODE_BLOCK = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${MONO_FAMILY}`;
/**
 * Markdown fenced-code body font size (px). The settled HighlightedCode view
 * (Shiki) renders at 11px / line-height 1.55 (HighlightedCode.module.css), so
 * the markdown code block measures + paints at 11px for visual parity — smaller
 * than the generic xs (12px) fallback used elsewhere.
 */
export const CODE_BLOCK_FONT_SIZE = 11;
/** Markdown fenced-code body font string (11px monospace, matches Shiki). */
export const FONT_MARKDOWN_CODE = `${FONT_WEIGHT.regular} ${CODE_BLOCK_FONT_SIZE}px ${MONO_FAMILY}`;
// Small dimmed metadata / xs text.
export const FONT_XS = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;

/**
 * Font size (px) every LaTeX formula is measured AND painted at.
 *
 * KaTeX sizes its own root box relatively — `.katex { font: normal 1.21em … }` —
 * so the rendered geometry depends entirely on the font size the formula's DOM
 * ancestor carries. The height model measures against this constant (katex-geometry
 * `basePx`), so the render layer MUST pin the same value on the math host: left to
 * inherit, KaTeX picks up the document default (Mantine `body` = 16px), renders
 * ~14% larger than measured, and gets clipped by the width-pinned host box.
 *
 * Body text is the reference context for a formula, hence `FONT_SIZE.sm`. Formulas
 * inside headings keep this base too — the measure layer never varies it.
 */
export const MATH_BASE_FONT_SIZE = FONT_SIZE.sm;

/** Build a heading font string for h1..h6. */
export function headingFont(level: 1 | 2 | 3 | 4 | 5 | 6): string {
	const h = HEADING[`h${level}` as keyof typeof HEADING];
	return `${FONT_WEIGHT.bold} ${h.size}px ${HEADINGS_FAMILY}`;
}

/**
 * Convert an `em` value to px against a given font size. Markdown margins are
 * expressed in em relative to the element's own font-size (CSS `em` semantics).
 */
export function emToPx(em: number, fontSizePx: number): number {
	return em * fontSizePx;
}

/**
 * Compute the rendered line box height (px) for a text role: round to match the
 * browser's integer line box. pretext returns line COUNT; multiply by this.
 */
export function lineBoxHeight(fontSizePx: number, lineHeight: number): number {
	return Math.round(fontSizePx * lineHeight);
}

// ─────────────────────────────────────────────────────────────────────────────
// Typography-aware metrics (read at MEASURE TIME — see the header note)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every size, line box and font string the markdown path needs, resolved against
 * the reader's current typography.
 *
 * A SNAPSHOT rather than a set of functions: measurement runs per fragment across
 * the whole document, and one memoised object per generation keeps that a property
 * read instead of a string rebuild. Line boxes are rounded (the browser lays out
 * integer line boxes) while font sizes stay fractional — rounding the size too
 * would quantise the scale into visible steps.
 */
export interface TypographyMetrics {
	/** Scaled font sizes, keyed like {@link FONT_SIZE}. */
	size: { xs: number; sm: number; md: number; lg: number; xl: number };
	/** Scaled fenced-code body size (baseline 11px, matching Shiki). */
	codeSize: number;
	/** Scaled math base size (the context KaTeX sizes itself against). */
	mathSize: number;
	/**
	 * Rounded line boxes per role.
	 *
	 * `xs` uses the xs line-height ratio (1.4); `xsBase` uses the BASE ratio (1.55),
	 * which a few card headers render at. They differ by ~2px at the default size, so
	 * the two are kept distinct rather than collapsed — picking the wrong one shifts
	 * every row of the affected card by a couple of pixels with nothing to flag it.
	 */
	line: { body: number; xs: number; xsBase: number; code: number; base: number };
	/** Font strings at the scaled size, by role and mark combination. */
	font: {
		body: string;
		bodyBold: string;
		bodyMedium: string;
		bodyMediumMono: string;
		bodyItalic: string;
		bodyBoldItalic: string;
		inlineCode: string;
		markdownCode: string;
		xs: string;
		xsMedium: string;
		xsBold: string;
		xsMono: string;
	};
	/** Per-role letter spacing (px). 0 when the reader has not asked for any. */
	letterSpacing: { body: number; xs: number; code: number };
	/**
	 * Scaled markdown block margins. Driven by the BLOCK-SPACING knob, not the font
	 * scale, so enlarging text does not silently also loosen the layout.
	 */
	margin: { paragraph: number; list: number; code: number; table: number };
	/** The generation this snapshot describes (folded into cache keys by callers). */
	revision: number;
}

let metricsCache: TypographyMetrics | null = null;
let metricsCacheRevision = -1;

/** Heading geometry (size + line box + font string) at the current typography. */
export interface HeadingMetrics {
	size: number;
	lineHeight: number;
	font: string;
	letterSpacing: number;
}

/**
 * The active typography metrics, memoised per generation.
 *
 * Safe to call in a hot loop: it is a revision compare plus a property read on
 * every call after the first of each generation.
 */
export function typographyMetrics(): TypographyMetrics {
	const revision = getTypographyRevision();
	if (metricsCache && metricsCacheRevision === revision) return metricsCache;

	const xs = scaleFontSize(FONT_SIZE.xs);
	const sm = scaleFontSize(FONT_SIZE.sm);
	const codeSize = scaleFontSize(CODE_BLOCK_FONT_SIZE);

	const metrics: TypographyMetrics = {
		size: {
			xs,
			sm,
			md: scaleFontSize(FONT_SIZE.md),
			lg: scaleFontSize(FONT_SIZE.lg),
			xl: scaleFontSize(FONT_SIZE.xl),
		},
		codeSize,
		// Follows the body size: a formula's reference context is body text, and the
		// render layer pins this exact value on the math host (see MATH_BASE_FONT_SIZE).
		mathSize: sm,
		// Both knobs meet here and only here: the scaled SIZE times the scaled RATIO,
		// which is what CSS `font-size` × `line-height` computes. Scaling either factor
		// elsewhere would make the two settings multiply each other.
		line: {
			body: lineBoxHeight(sm, scaleLineHeightRatio(LINE_HEIGHT.sm)),
			xs: lineBoxHeight(xs, scaleLineHeightRatio(LINE_HEIGHT.xs)),
			xsBase: lineBoxHeight(xs, scaleLineHeightRatio(BASE_LINE_HEIGHT)),
			code: lineBoxHeight(codeSize, scaleLineHeightRatio(BASE_LINE_HEIGHT)),
			base: lineBoxHeight(sm, scaleLineHeightRatio(BASE_LINE_HEIGHT)),
		},
		font: {
			body: `${FONT_WEIGHT.regular} ${sm}px ${SANS_FAMILY}`,
			bodyBold: `${FONT_WEIGHT.bold} ${sm}px ${SANS_FAMILY}`,
			bodyMedium: `${FONT_WEIGHT.medium} ${sm}px ${SANS_FAMILY}`,
			bodyMediumMono: `${FONT_WEIGHT.medium} ${sm}px ${MONO_FAMILY}`,
			bodyItalic: `italic ${FONT_WEIGHT.regular} ${sm}px ${SANS_FAMILY}`,
			bodyBoldItalic: `italic ${FONT_WEIGHT.bold} ${sm}px ${SANS_FAMILY}`,
			inlineCode: `${FONT_WEIGHT.regular} ${xs}px ${MONO_FAMILY}`,
			markdownCode: `${FONT_WEIGHT.regular} ${codeSize}px ${MONO_FAMILY}`,
			xs: `${FONT_WEIGHT.regular} ${xs}px ${SANS_FAMILY}`,
			xsMedium: `${FONT_WEIGHT.medium} ${xs}px ${SANS_FAMILY}`,
			xsBold: `${FONT_WEIGHT.bold} ${xs}px ${SANS_FAMILY}`,
			xsMono: `${FONT_WEIGHT.regular} ${xs}px ${MONO_FAMILY}`,
		},
		letterSpacing: {
			body: letterSpacingPxFor(sm),
			xs: letterSpacingPxFor(xs),
			code: letterSpacingPxFor(codeSize),
		},
		// Margins are em-derived from the BASELINE body size, then scaled by the
		// block-spacing knob — deliberately NOT by the font scale (see the interface).
		margin: {
			paragraph: scaleBlockSpacing(emToPx(0.35, FONT_SIZE.sm)),
			list: scaleBlockSpacing(emToPx(0.35, FONT_SIZE.sm)),
			code: scaleBlockSpacing(emToPx(0.35, FONT_SIZE.sm)),
			table: scaleBlockSpacing(emToPx(0.35, FONT_SIZE.sm)),
		},
		revision,
	};
	metricsCache = metrics;
	metricsCacheRevision = revision;
	return metrics;
}

/** Heading metrics for h1..h6 at the current typography. */
export function headingMetrics(level: 1 | 2 | 3 | 4 | 5 | 6): HeadingMetrics {
	const h = HEADING[`h${level}` as keyof typeof HEADING];
	const size = scaleFontSize(h.size);
	return {
		size,
		lineHeight: lineBoxHeight(size, scaleLineHeightRatio(h.lineHeight)),
		font: `${FONT_WEIGHT.bold} ${size}px ${HEADINGS_FAMILY}`,
		letterSpacing: letterSpacingPxFor(size),
	};
}

/** A scaled line box for an arbitrary (baseline) size + line-height pair. */
export function scaledLineBoxHeight(baseFontSizePx: number, lineHeight: number): number {
	return lineBoxHeight(scaleFontSize(baseFontSizePx), scaleLineHeightRatio(lineHeight));
}

/** A scaled font string built from a baseline size. */
export function scaledFont(
	weight: number,
	baseFontSizePx: number,
	family: string,
	style?: "italic",
): string {
	const size = scaleFontSize(baseFontSizePx);
	return `${style ? `${style} ` : ""}${weight} ${size}px ${family}`;
}
