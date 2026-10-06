/**
 * katex-geometry.ts — Zero-DOM geometry for KaTeX formulas.
 *
 * The vlist height model is pure arithmetic (see CONTRACT.md §0 rule 2): heights
 * come from constants + pretext line counts, never from DOM measurement. LaTeX
 * used to be excluded from that model — it was emitted as a `PreparedUnknownBlock`
 * with a fixed 64px placeholder and rendered as raw source text.
 *
 * This module closes that gap. KaTeX's `__renderToHTMLTree()` builds its layout
 * tree WITHOUT touching the DOM (it only calls `.toNode()`/`.toMarkup()` on
 * demand), and every node carries the geometry KaTeX itself used to lay it out:
 *
 *   - `height` / `depth`  — em units, above/below the baseline
 *   - `SymbolNode.width`  — glyph advance from KaTeX's built-in fontMetricsData
 *   - `italic`            — italic correction, painted as `margin-right`
 *   - inline `style`      — em-valued width/margin/padding/minWidth
 *
 * Walking that tree arithmetically reproduces the browser's rendered width to
 * ~0.05px for ASCII math (validated against real Chrome across 20 formulas).
 *
 * WHERE PRETEXT COMES IN: KaTeX has no font metrics for CJK / non-Latin scripts.
 * Its own source admits this (katex.mjs `getCharacterMetrics`: "We don't
 * typically have font metrics for Asian scripts... we only care about the height
 * of the glyph not its width") and silently substitutes the metrics of capital
 * "M". For `\text{速度}` that yields 15.53px against a real 33.88px — 118% off.
 * Those glyphs are routed to an injected `GlyphWidthResolver` (canvas-backed in
 * production, exactly what pretext does), which matches the browser to 0.01px.
 *
 * PURITY: this module never touches the DOM. Real font measurement enters only
 * through the injected resolver, so the module stays unit-testable under Bun and
 * satisfies both `shared-core.guard.test.ts` and `zero-dom-measure.guard.test.ts`.
 */

/**
 * Resolve a single glyph's advance (px) for a font KaTeX has no metrics for.
 * Return `null` when the glyph cannot be measured, so the caller can fall back.
 *
 * `fontCss` is a CSS font shorthand ("italic 400 16.94px KaTeX_Math, ...") that
 * canvas `measureText` accepts — the same contract pretext uses.
 */
export type GlyphWidthResolver = (glyph: string, fontCss: string) => number | null;

/**
 * Resolve a glyph's VERTICAL extent (px above / below the baseline) for a font
 * KaTeX has no metrics for. Return `null` when it cannot be measured.
 *
 * Needed for the same reason as `GlyphWidthResolver`: KaTeX substitutes capital
 * "M" for CJK, and M has NO descender, so a `\text{…}` run of CJK reports
 * `depth: 0` and its box is too short — the render layer then clips the glyph's
 * top and bottom. Real font metrics come from the injected resolver instead.
 */
export type GlyphVerticalResolver = (
	glyph: string,
	fontCss: string,
) => { ascent: number; descent: number } | null;

export interface KatexGeometry {
	/** Rendered width (px) at the requested base font size. */
	width: number;
	/** Rendered height (px) — never below the KaTeX line box. */
	height: number;
	/** Height above the baseline (px), for inline baseline alignment. */
	ascent: number;
	/** Depth below the baseline (px). */
	descent: number;
	/** KaTeX HTML markup; the render layer injects this directly. */
	html: string;
	/** Non-null when KaTeX could not parse the source (still renders an error node). */
	error: string | null;
}

export interface MeasureKatexOptions {
	/** Display (block, centered) vs inline math. */
	displayMode: boolean;
	/** Font size (px) of the context the formula sits in. */
	basePx: number;
	/** Real-font measurement for glyphs KaTeX has no metrics for (CJK etc.). */
	glyphWidth?: GlyphWidthResolver;
	/**
	 * Real-font VERTICAL measurement for the same glyphs. Without it a CJK run keeps
	 * KaTeX's capital-M substitute metrics (no descender) and renders clipped.
	 */
	glyphVertical?: GlyphVerticalResolver;
}

/**
 * The KaTeX runtime surface this module needs. Injected rather than imported so
 * the 584KB KaTeX bundle stays lazily loaded and tests can run without it.
 */
export interface KatexRuntime {
	__renderToHTMLTree: (latex: string, options: Record<string, unknown>) => KatexNode;
	renderToString: (latex: string, options: Record<string, unknown>) => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-glyph advance recovery
//
// KaTeX does not export `getCharacterMetrics`, so a glyph's advance is recovered
// by rendering it standalone and reading the resulting SymbolNode. Advances are
// em-relative and size-independent, so one lookup serves every font size.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capacity for the glyph advance cache. This cache only stores KaTeX-rendered
 * glyphs (Latin/Greek/symbols, not CJK), keyed by `glyph|mode`. The practical
 * working set is ~1000 entries (unique renderable glyphs × 2 modes), so 8192
 * provides wide headroom while still bounding memory in degenerate cases.
 * Overflow triggers a bulk clear — the same pattern as MeasureCache — since
 * recomputing an advance is a single cheap KaTeX `__renderToHTMLTree` call.
 */
export const GLYPH_ADVANCE_CACHE_CEILING = 8192;

/** `glyph|mode` → advance in em, or null when KaTeX cannot render it alone. */
const glyphAdvanceCache = new Map<string, number | null>();

/** Test seam: expose cache size and allow clearing for unit tests. */
export function getGlyphAdvanceCacheSize(): number {
	return glyphAdvanceCache.size;
}
export function clearGlyphAdvanceCache(): void {
	glyphAdvanceCache.clear();
}

/** LaTeX metacharacters that cannot be passed through verbatim. */
const LATEX_SPECIALS = new Set(["\\", "{", "}", "$", "&", "#", "^", "_", "~", "%"]);

function findSymbolNode(node: KatexNode, glyph: string): KatexNode | null {
	if (node.text === glyph && node.width !== undefined) return node;
	for (const child of node.children ?? []) {
		const found = findSymbolNode(child, glyph);
		if (found) return found;
	}
	return null;
}

/**
 * Advance (em) of a single glyph as KaTeX itself would lay it out, in either
 * math or text mode. Returns null when the glyph cannot be measured this way.
 */
function katexGlyphAdvance(katex: KatexRuntime, glyph: string, textMode: boolean): number | null {
	const key = `${glyph}|${textMode ? "text" : "math"}`;
	const cached = glyphAdvanceCache.get(key);
	if (cached !== undefined) return cached;

	let advance: number | null = null;
	if (!LATEX_SPECIALS.has(glyph)) {
		try {
			const source = textMode ? `\\text{${glyph}}` : glyph;
			const tree = katex.__renderToHTMLTree(source, {
				displayMode: false,
				throwOnError: false,
				output: "html",
			});
			const symbol = findSymbolNode(tree, glyph);
			const width = symbol?.width;
			if (typeof width === "number" && Number.isFinite(width)) advance = width;
		} catch {
			advance = null;
		}
	}
	// Bulk-clear at the ceiling rather than evicting one entry at a time: this is a
	// pure glyph->advance table, so a rebuild costs only the re-measure of glyphs that
	// come back. The `has(key)` check that used to guard this was counterproductive —
	// on a miss (the only path reaching here) it was always false, and once full every
	// new glyph cleared the map and left a single entry, so the next glyph cleared it
	// again. That degenerates into measuring every glyph with an empty cache.
	if (glyphAdvanceCache.size >= GLYPH_ADVANCE_CACHE_CEILING) {
		glyphAdvanceCache.clear();
	}
	glyphAdvanceCache.set(key, advance);
	return advance;
}

/** Structural view of a KaTeX domTree node (Span / SymbolNode / SvgNode / …). */
export interface KatexNode {
	classes?: string[];
	style?: Record<string, string>;
	children?: KatexNode[];
	/** Present on SymbolNode: the glyph(s) this node paints. */
	text?: string;
	/** Present on SymbolNode: advance of the FIRST glyph (see combined-chars note). */
	width?: number;
	/** Italic correction (em), painted as margin-right. */
	italic?: number;
	/** Height above baseline (em). */
	height?: number;
	/** Depth below baseline (em). */
	depth?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// KaTeX CSS constants (katex.css) — the geometry is only correct relative to
// these, so they are pinned here with their source.
// ─────────────────────────────────────────────────────────────────────────────

/** `.katex { font: normal 1.21em ... }` — em values scale by this. */
export const KATEX_FONT_SCALE = 1.21;
/** `.katex { line-height: 1.2 }` — the inline box never shrinks below this. */
export const KATEX_LINE_HEIGHT = 1.2;
/** `.katex .vlist-s { width: 2px }` — an absolute px strut, not em. */
const VLIST_S_WIDTH_PX = 2;
/** `.katex .boxpad { padding: 0 0.3em }` — horizontal fbox separation. */
const BOXPAD_HORIZONTAL_EM = 0.3;
/** `.katex .vlist-t2 { margin-right: -2px }` — cancels the vlist-s strut. */
const VLIST_T2_MARGIN_PX = -2;
/** `.katex .nulldelimiter { width: 0.12em }`. */
const NULLDELIMITER_WIDTH_EM = 0.12;
/** `sizeMultipliers` (katex.mjs) — index = sizeN - 1. */
const SIZE_MULTIPLIERS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.44, 1.728, 2.074, 2.488];

/** Classes whose box contributes no width at all (struts, overlap wrappers). */
const ZERO_WIDTH_CLASSES = new Set([
	// `.strut` / `.pstrut` only reserve vertical space.
	"strut",
	"pstrut",
	// `.llap`/`.rlap`/`.clap` are `width: 0` with absolutely-positioned content.
	"llap",
	"rlap",
	"clap",
	// `.thinbox` is `width: 0; max-width: 0`.
	"thinbox",
	// The MathML accessibility branch is `position:absolute; width:1px` (clipped).
	"katex-mathml",
]);

/**
 * `font-family` / `style` / `weight` per KaTeX CSS class (katex.css). Only the
 * classes that change the font matter — they decide which family a fallback
 * glyph measurement must use.
 */
const FONT_CLASS_MAP: Record<string, { family: string; style?: string; weight?: string }> = {
	mathnormal: { family: "KaTeX_Math", style: "italic" },
	mathit: { family: "KaTeX_Main", style: "italic" },
	mathrm: { family: "KaTeX_Main", style: "normal" },
	mathbf: { family: "KaTeX_Main", weight: "bold" },
	boldsymbol: { family: "KaTeX_Math", style: "italic", weight: "bold" },
	amsrm: { family: "KaTeX_AMS" },
	mathbb: { family: "KaTeX_AMS" },
	textbb: { family: "KaTeX_AMS" },
	mathcal: { family: "KaTeX_Caligraphic" },
	mathfrak: { family: "KaTeX_Fraktur" },
	textfrak: { family: "KaTeX_Fraktur" },
	mathboldfrak: { family: "KaTeX_Fraktur", weight: "bold" },
	textboldfrak: { family: "KaTeX_Fraktur", weight: "bold" },
	mathtt: { family: "KaTeX_Typewriter" },
	texttt: { family: "KaTeX_Typewriter" },
	mathscr: { family: "KaTeX_Script" },
	textscr: { family: "KaTeX_Script" },
	mathsf: { family: "KaTeX_SansSerif" },
	textsf: { family: "KaTeX_SansSerif" },
	mathboldsf: { family: "KaTeX_SansSerif", weight: "bold" },
	textboldsf: { family: "KaTeX_SansSerif", weight: "bold" },
	mathsfit: { family: "KaTeX_SansSerif", style: "italic" },
	mathitsf: { family: "KaTeX_SansSerif", style: "italic" },
	textitsf: { family: "KaTeX_SansSerif", style: "italic" },
	mainrm: { family: "KaTeX_Main", style: "normal" },
	textrm: { family: "KaTeX_Main" },
	textbf: { weight: "bold", family: "KaTeX_Main" },
	textit: { style: "italic", family: "KaTeX_Main" },
};

/** `.katex` default font family (katex.css `.katex { font: ... }`). */
const DEFAULT_KATEX_FAMILY = 'KaTeX_Main, "Times New Roman", serif';

/** Parse an `em`-valued CSS length. Returns null for anything else. */
function parseEm(value: string | undefined): number | null {
	if (typeof value !== "string") return null;
	const match = /^(-?\d*\.?\d+)em$/.exec(value.trim());
	if (!match?.[1]) return null;
	const parsed = Number.parseFloat(match[1]);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Font-size scale contributed by a `sizing reset-sizeN sizeM` class triple
 * (katex.css emits `font-size: <ratio>em` for every N/M pair).
 */
export function sizingScale(classes: readonly string[]): number {
	if (!classes.includes("sizing") && !classes.includes("fontsize-ensurer")) return 1;
	let from: number | null = null;
	let to: number | null = null;
	for (const cls of classes) {
		const reset = /^reset-size(\d+)$/.exec(cls);
		if (reset?.[1]) from = Number(reset[1]);
		const size = /^size(\d+)$/.exec(cls);
		if (size?.[1]) to = Number(size[1]);
	}
	if (from == null || to == null) return 1;
	const fromMul = SIZE_MULTIPLIERS[from - 1];
	const toMul = SIZE_MULTIPLIERS[to - 1];
	if (fromMul == null || toMul == null || fromMul === 0) return 1;
	return toMul / fromMul;
}

/**
 * True when KaTeX's built-in metrics cannot be trusted for this glyph.
 *
 * KaTeX only ships metrics for Latin + math symbols. For anything else
 * `getCharacterMetrics` falls back to capital "M"'s metrics on purpose — it
 * cares about height, not width — so the advance is meaningless. Codepoints
 * outside Latin/Greek/symbol ranges must be measured with a real font instead.
 */
export function needsRealFontMeasure(glyph: string): boolean {
	const cp = glyph.codePointAt(0);
	if (cp == null) return false;
	// Latin, Latin-1 supplement, Latin Extended-A/B, IPA, Greek, Cyrillic,
	// general punctuation, math operators & symbols: KaTeX has real metrics.
	if (cp <= 0x24f) return false;
	if (cp >= 0x370 && cp <= 0x3ff) return false; // Greek
	if (cp >= 0x2000 && cp <= 0x23ff) return false; // punctuation, math ops, technical
	if (cp >= 0x2500 && cp <= 0x2bff) return false; // box drawing, misc symbols, arrows
	return true;
}

/** CSS font shorthand for a node's class chain, used by the fallback resolver. */
function fontCssFor(classes: readonly string[], fontSizePx: number): string {
	let family = DEFAULT_KATEX_FAMILY;
	let style = "normal";
	let weight = "400";
	for (const cls of classes) {
		const spec = FONT_CLASS_MAP[cls];
		if (!spec) continue;
		family = spec.family;
		if (spec.style) style = spec.style;
		if (spec.weight) weight = spec.weight === "bold" ? "700" : spec.weight;
	}
	return `${style} ${weight} ${fontSizePx}px ${family}`;
}

/**
 * Accumulated width of a subtree: `em` is in ROOT em units (multiples of the
 * `.katex` font size) and `px` holds absolute pixel contributions (the handful
 * of px-valued CSS rules). Keeping them separate avoids converting mid-walk,
 * where nested `sizing` scales would distort absolute values.
 */
interface Width {
	em: number;
	px: number;
}

const ZERO: Width = { em: 0, px: 0 };

/** Compare two widths at a shared scale (em dominates; px only breaks ties). */
function wider(a: Width, b: Width): Width {
	return a.em * 1000 + a.px > b.em * 1000 + b.px ? a : b;
}

interface WalkContext {
	/** Cumulative font-size scale from nested `sizing` classes. */
	scale: number;
	/** Root font size (px) — `basePx × KATEX_FONT_SCALE`. */
	rootFontPx: number;
	glyphWidth?: GlyphWidthResolver;
	/** Runtime handle, used to recover per-glyph advances for merged nodes. */
	katex: KatexRuntime;
}

/**
 * Width of a SymbolNode.
 *
 * Two corrections over the raw `node.width`:
 *
 *  1. **Combined glyphs.** `tryCombineChars` (katex.mjs) merges adjacent
 *     SymbolNodes by concatenating `text` but leaves `width` at the FIRST
 *     glyph's advance. Without re-summing, `e^{i\pi}` renders 6.76px narrower
 *     than predicted. Per-glyph advances are recovered from the resolver.
 *  2. **Missing metrics.** Glyphs KaTeX has no metrics for (CJK) carry a
 *     substituted advance and must be measured with the real font.
 */
function symbolWidth(node: KatexNode, ctx: WalkContext): Width {
	const classes = node.classes ?? [];
	const text = node.text ?? "";
	const rawWidth = node.width ?? 0;
	const italic = node.italic ?? 0;
	const glyphs = Array.from(text);
	// `\text{...}` content renders in text mode, where KaTeX substitutes metrics
	// for scripts it has no data for.
	const textMode = classes.includes("text") || classes.some((c) => c.endsWith("_fallback"));

	// Fast path: a single glyph KaTeX has real metrics for.
	if (glyphs.length === 1 && !needsRealFontMeasure(glyphs[0] ?? "")) {
		return { em: (rawWidth + italic) * ctx.scale, px: 0 };
	}

	const fontSizePx = ctx.rootFontPx * ctx.scale;
	const fontCss = fontCssFor(classes, fontSizePx);
	let em = 0;
	let px = 0;
	let resolved = 0;
	for (const glyph of glyphs) {
		// Scripts KaTeX has no metrics for (CJK) need a real font measurement;
		// everything else is recovered from KaTeX's own per-glyph advance, which
		// stays correct even when `tryCombineChars` merged the nodes.
		if (needsRealFontMeasure(glyph)) {
			const measured = ctx.glyphWidth?.(glyph, fontCss);
			if (measured != null && Number.isFinite(measured)) {
				px += measured;
				resolved++;
			}
		} else {
			const advance = katexGlyphAdvance(ctx.katex, glyph, textMode);
			if (advance != null) {
				em += advance * ctx.scale;
				resolved++;
			}
		}
	}

	if (resolved === 0) {
		// Nothing could be measured individually — fall back to KaTeX's node metric.
		return { em: (rawWidth + italic) * ctx.scale, px: 0 };
	}
	// Cover any unresolved glyphs with a share of the node's own reported width.
	const unresolved = glyphs.length - resolved;
	if (unresolved > 0 && glyphs.length > 0) {
		em += (rawWidth / glyphs.length) * unresolved * ctx.scale;
	}
	return { em: em + italic * ctx.scale, px };
}

/** Accumulated width of any node, in root-em + absolute px. */
function nodeWidth(node: KatexNode, ctx: WalkContext): Width {
	const classes = node.classes ?? [];
	const style = node.style ?? {};

	// SymbolNode: a leaf that paints glyphs.
	if (typeof node.text === "string" && node.width !== undefined) {
		return symbolWidth(node, ctx);
	}

	for (const cls of classes) {
		if (ZERO_WIDTH_CLASSES.has(cls)) return ZERO;
	}

	const scale = ctx.scale * sizingScale(classes);
	const inner: WalkContext = { ...ctx, scale };

	// `.vlist-s` is a 2px table-cell strut (absolute, not em).
	if (classes.includes("vlist-s")) return { em: 0, px: VLIST_S_WIDTH_PX };
	// `.nulldelimiter` is a fixed-width empty delimiter slot.
	if (classes.includes("nulldelimiter")) return { em: NULLDELIMITER_WIDTH_EM * scale, px: 0 };
	// `.mspace` carries its whole width in margin-right.
	if (classes.includes("mspace")) {
		return { em: (parseEm(style.marginRight) ?? 0) * scale, px: 0 };
	}
	// `.hide-tail` (sqrt radical SVG) takes its width from CSS min-width.
	if (classes.includes("hide-tail")) {
		return { em: (parseEm(style.minWidth) ?? 0) * scale, px: 0 };
	}

	let width: Width;
	const explicitWidth = parseEm(style.width);
	if (explicitWidth != null) {
		// Rules / stretchy SVG spans declare their own width.
		width = { em: explicitWidth * scale, px: 0 };
	} else if (classes.includes("vlist-t")) {
		// `display: inline-table; table-layout: fixed` — width is the widest ROW.
		let best = ZERO;
		for (const child of node.children ?? []) best = wider(best, nodeWidth(child, inner));
		width = { ...best };
		// `.vlist-t2` cancels the vlist-s strut with a negative margin.
		if (classes.includes("vlist-t2")) width.px += VLIST_T2_MARGIN_PX;
	} else if (classes.includes("vlist")) {
		// `display: table-cell` whose children are `display: block` rows stacked
		// vertically — width is the widest row, not their sum.
		let best = ZERO;
		for (const child of node.children ?? []) best = wider(best, nodeWidth(child, inner));
		width = { ...best };
	} else {
		// Ordinary inline flow: children lay out left to right.
		width = { em: 0, px: 0 };
		for (const child of node.children ?? []) {
			const childWidth = nodeWidth(child, inner);
			width.em += childWidth.em;
			width.px += childWidth.px;
		}
	}

	// Own horizontal margins / padding (em-valued in KaTeX's output).
	for (const key of ["marginLeft", "marginRight", "paddingLeft", "paddingRight"] as const) {
		const value = parseEm(style[key]);
		if (value) width.em += value * scale;
	}
	// `.boxpad` carries the horizontal \\fboxsep padding from KaTeX's stylesheet;
	// unlike most layout chrome, it is declared only by class rather than inline
	// style, so it must be added explicitly to the measured subtree width.
	if (classes.includes("boxpad")) width.em += BOXPAD_HORIZONTAL_EM * 2 * scale;
	return width;
}

/**
 * Extra vertical extent (px) that glyphs KaTeX lacks metrics for actually paint,
 * beyond what the tree's own `height`/`depth` claim.
 *
 * KaTeX substitutes capital "M" for CJK. M has a smaller cap height than a
 * full-width CJK glyph and, crucially, NO descender — so a `\text{速度}` run
 * reports `depth: 0` and an ink box several px too short. Every affected
 * SymbolNode is re-measured with the real font and the surplus is returned, to be
 * folded into the formula's ascent/descent.
 *
 * Returns zeros when nothing needs correcting, so ASCII formulas are untouched.
 */
function verticalOverflow(
	node: KatexNode,
	ctx: WalkContext,
	resolve: GlyphVerticalResolver,
): { ascent: number; descent: number } {
	let ascent = 0;
	let descent = 0;

	const visit = (current: KatexNode, scale: number): void => {
		const classes = current.classes ?? [];
		for (const cls of classes) {
			if (ZERO_WIDTH_CLASSES.has(cls)) return;
		}
		const inner = scale * sizingScale(classes);

		if (typeof current.text === "string" && current.width !== undefined) {
			const glyphs = Array.from(current.text).filter((g) => needsRealFontMeasure(g));
			if (glyphs.length === 0) return;
			const fontCss = fontCssFor(classes, ctx.rootFontPx * inner);
			// KaTeX's claim for this node, in px at the node's own scale.
			const claimedAscent = (current.height ?? 0) * inner * ctx.rootFontPx;
			const claimedDescent = (current.depth ?? 0) * inner * ctx.rootFontPx;
			for (const glyph of glyphs) {
				const real = resolve(glyph, fontCss);
				if (!real) continue;
				const extraAscent = real.ascent - claimedAscent;
				const extraDescent = real.descent - claimedDescent;
				if (extraAscent > ascent) ascent = extraAscent;
				if (extraDescent > descent) descent = extraDescent;
			}
			return;
		}

		for (const child of current.children ?? []) visit(child, inner);
	};

	visit(node, ctx.scale);
	return { ascent: Math.max(0, ascent), descent: Math.max(0, descent) };
}

/** Root node of the rendered tree, skipping the optional `.katex-display` wrap. */
function unwrapDisplay(root: KatexNode): KatexNode {
	if (root.classes?.includes("katex-display")) {
		const inner = root.children?.[0];
		if (inner) return inner;
	}
	return root;
}

/**
 * Measure a LaTeX formula's rendered geometry without touching the DOM.
 *
 * Returns the geometry AND the HTML markup, so the render layer can paint the
 * exact thing that was measured without re-parsing.
 */
export function measureKatex(
	katex: KatexRuntime,
	latex: string,
	opts: MeasureKatexOptions,
): KatexGeometry {
	const { displayMode, basePx, glyphWidth, glyphVertical } = opts;
	const rootFontPx = basePx * KATEX_FONT_SCALE;
	const lineBox = rootFontPx * KATEX_LINE_HEIGHT;

	let tree: KatexNode;
	let html: string;
	let error: string | null = null;
	const options = { displayMode, throwOnError: false, output: "html" as const };
	try {
		tree = katex.__renderToHTMLTree(latex, options);
		html = katex.renderToString(latex, options);
	} catch (err) {
		// `throwOnError: false` already turns bad input into an error node, so
		// reaching here means something structural failed. Degrade to source text.
		return {
			width: 0,
			height: lineBox,
			ascent: lineBox,
			descent: 0,
			html: "",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// KaTeX marks unparseable input with `.katex-error` instead of throwing.
	if (html.includes("katex-error")) error = "katex parse error";

	const content = unwrapDisplay(tree);
	const walkCtx: WalkContext = { scale: 1, rootFontPx, glyphWidth, katex };
	const width = nodeWidth(content, walkCtx);
	const ascentEm = content.height ?? 0;
	const descentEm = content.depth ?? 0;
	// Glyphs KaTeX has no metrics for (CJK) paint beyond the box it reported; recover
	// the surplus from real font metrics so the render layer's `overflow: hidden` box
	// cannot shave their tops and bottoms off.
	const overflow = glyphVertical
		? verticalOverflow(content, walkCtx, glyphVertical)
		: { ascent: 0, descent: 0 };
	const ascent = ascentEm * rootFontPx + overflow.ascent;
	const descent = descentEm * rootFontPx + overflow.descent;
	const contentHeight = ascent + descent;

	return {
		width: width.em * rootFontPx + width.px,
		// The inline box never collapses below `.katex`'s own line box.
		height: Math.max(contentHeight, lineBox),
		ascent,
		descent,
		html,
		error,
	};
}
