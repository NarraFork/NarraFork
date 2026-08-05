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
 */

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
