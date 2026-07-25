/**
 * prepared-block.ts — The core PreparedBlock model for the pretext-based
 * zero-DOM-measure narrator list (vlist).
 *
 * Design mirrors the pretext markdown-chat demo's three-layer separation:
 *
 *   1. Prepared layer  (once, width-independent): parse data + pretext
 *      prepareRichInline()/prepareWithSegments() precompute. Produces
 *      PreparedBlock[] — no final coordinates yet.
 *   2. Frame layer      (recomputed on width/LOD change): pure arithmetic via
 *      measureRichInlineStats()/measureLineStats() → line counts → per-block
 *      height/top → element total height.
 *   3. Layout/render    (only when on-screen): walkRichInlineLineRanges()/
 *      layoutWithLines() to materialize fragments; absolute-position render.
 *
 * The universal height formula:
 *   height = fixed_chrome(padding/margin/icon/gap/border)
 *          + Σ(block text line count × line box height)
 * where "line count" is produced by pretext pure arithmetic (zero DOM).
 *
 * ZERO DOM MEASUREMENT: no getBoundingClientRect / offsetHeight / ResizeObserver
 * anywhere in the prepared→frame pipeline. The only controlled exception is a
 * small set of intrinsically-unpredictable blocks (mermaid / katex / images of
 * unknown intrinsic size) — see UnknownBlock below.
 */

import type { PreparedTextWithSegments } from "@chenglou/pretext";
import type { PreparedRichInline } from "@chenglou/pretext/rich-inline";

// ─────────────────────────────────────────────────────────────────────────────
// Render LOD (mirrors RenderLodCtx). Height models MUST take LOD as input.
// L1 (most folded) .. L6 (most detailed). Default L5.
// ─────────────────────────────────────────────────────────────────────────────
export type RenderLod = 1 | 2 | 3 | 4 | 5 | 6;
export const DEFAULT_RENDER_LOD: RenderLod = 5;

// ─────────────────────────────────────────────────────────────────────────────
// PreparedBlock — width-independent, produced once per data item.
// A message/tool/system element is modeled as an ordered list of PreparedBlocks.
// Each concrete block carries whatever pretext prepared handle it needs plus the
// fixed-chrome metadata required to place it.
// ─────────────────────────────────────────────────────────────────────────────

/** Common fields shared by every prepared block. */
export interface PreparedBlockBase {
	/** Top margin (px) applied before this block within its element. First
	 * block in an element typically uses 0. */
	marginTop: number;
	/** Horizontal content offset (px) for list/blockquote nesting. */
	contentLeft: number;
	/** Left offsets (px) of blockquote rails to draw, one per nesting depth. */
	quoteRailLefts: number[];
	/** Optional list/task marker text (bullet, "1.", checkbox) or null. */
	markerText: string | null;
	/** Left offset (px) of the marker relative to the element, or null. */
	markerLeft: number | null;
	/** CSS class for the marker, or null. */
	markerClassName: string | null;
}

/** Inline rich-text block (paragraph, heading, list item text, quote text). */
export interface PreparedInlineBlock extends PreparedBlockBase {
	kind: "inline";
	/** pretext prepared rich-inline flow (already measured segment widths). */
	flow: PreparedRichInline;
	/** Line box height (px) for this block's text role. */
	lineHeight: number;
	/** Per-fragment CSS class names, indexed by rich-inline itemIndex. */
	classNames: string[];
	/** Per-fragment hrefs (null when not a link), indexed by itemIndex. */
	hrefs: Array<string | null>;
	/**
	 * Per-fragment CSS `font` shorthand, indexed by rich-inline itemIndex. The
	 * render layer MUST apply the exact same font string pretext measured with,
	 * otherwise rendered wrapping drifts from the predicted height.
	 */
	fonts: string[];
	/**
	 * Optional render-only payload (kept small; no heavy data). Height-neutral —
	 * geometry never consults it. Used e.g. to carry a spec-task's status/lock
	 * glyph so the render layer can draw it in the reserved indent lane.
	 */
	data?: Record<string, unknown>;
}

/** Fenced code block (pre-wrap monospace). */
export interface PreparedCodeBlock extends PreparedBlockBase {
	kind: "code";
	/** pretext prepared pre-wrap text with segments. */
	prepared: PreparedTextWithSegments;
	/** Code line box height (px). */
	lineHeight: number;
	/** Optional language label (adds top padding when present). */
	lang: string | null;
}

/** Horizontal rule / divider. */
export interface PreparedRuleBlock extends PreparedBlockBase {
	kind: "rule";
	/** Fixed rule row height (px). */
	height: number;
}

/**
 * A block with fixed height that never depends on text flow (icons rows, single
 * dimmed lines, badges, image placeholders with known aspect ratio, tool detail
 * regions capped by maxHeight, etc.). Height is provided directly.
 */
export interface PreparedFixedBlock extends PreparedBlockBase {
	kind: "fixed";
	/** Exact height (px), fully determined without text measurement. */
	height: number;
	/** Opaque tag for the renderer to know what to draw. */
	tag: string;
	/** Optional payload the renderer needs (kept small; no heavy data). */
	data?: Record<string, unknown>;
}

/**
 * A block whose height cannot be predicted purely (mermaid / katex / image of
 * unknown intrinsic size). Uses a conservative placeholder height; the renderer
 * may perform a ONE-TIME local measurement to refine it (the single controlled
 * exception to the zero-DOM-measure rule). Never use for ordinary text/markdown.
 */
export interface PreparedUnknownBlock extends PreparedBlockBase {
	kind: "unknown";
	/** Conservative placeholder height (px) used until refined. */
	placeholderHeight: number;
	/** What kind of unpredictable content this is. */
	tag: "mermaid" | "katex" | "image-unknown";
	/** Opaque payload for the renderer + local-measure refinement. */
	data?: Record<string, unknown>;
}

export type PreparedBlock =
	| PreparedInlineBlock
	| PreparedCodeBlock
	| PreparedRuleBlock
	| PreparedFixedBlock
	| PreparedUnknownBlock;

// ─────────────────────────────────────────────────────────────────────────────
// Frame layer — per-block resolved geometry at a concrete content width.
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockFrame {
	/** Index into the source PreparedBlock[]. */
	index: number;
	/** Resolved top offset (px) within the element content box. */
	top: number;
	/** Resolved height (px). */
	height: number;
	/** Widest rendered line (px) — used for user-bubble shrink-wrap. */
	usedWidth: number;
}

export interface ElementFrame {
	/** Per-block resolved geometry, parallel to the PreparedBlock[]. */
	blocks: BlockFrame[];
	/** Total element content height (sum of blocks + inter-block margins). */
	contentHeight: number;
	/** Widest used content width across blocks (px). */
	usedWidth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measure result — what every measureXxx() function returns.
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasuredElement {
	/** Total element height (px), including the element's own outer chrome. */
	height: number;
	/** The prepared blocks (for later render materialization). */
	blocks: PreparedBlock[];
	/** Resolved frame at the width the measure was run for. */
	frame: ElementFrame;
	/** Content width (px) the frame was computed at (render layer re-materializes
	 * line ranges at this same width). */
	contentWidth: number;
	/** Widest content width used (px) — for shrink-wrap containers. */
	usedWidth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Height accumulator — the universal Frame-layer routine. Given prepared blocks
// and a per-block line-count resolver, produces the ElementFrame. The resolver
// isolates the pretext calls so this stays trivially unit-testable with a stub.
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockLineMetrics {
	/** Number of text lines this block wraps to at the given width. */
	lineCount: number;
	/** Widest rendered line (px). */
	maxLineWidth: number;
}

/**
 * Resolve line metrics for one prepared block at a content width. For inline/code
 * blocks this calls pretext (measureRichInlineStats / measureLineStats). For
 * fixed/rule/unknown blocks it is ignored (their height is intrinsic).
 */
export type LineMetricsResolver = (
	block: PreparedInlineBlock | PreparedCodeBlock,
	contentWidth: number,
) => BlockLineMetrics;

/**
 * Accumulate an ElementFrame from prepared blocks at a concrete content width.
 * Pure arithmetic given the resolver — zero DOM.
 */
export function accumulateFrame(
	blocks: readonly PreparedBlock[],
	contentWidth: number,
	resolveMetrics: LineMetricsResolver,
	opts: {
		codePaddingY?: number;
		codePaddingX?: number;
		codeLangExtraTop?: number;
		quotePaddingY?: number;
		quoteMarginTop?: number;
	} = {},
): ElementFrame {
	const codePaddingY = opts.codePaddingY ?? 0;
	const codePaddingX = opts.codePaddingX ?? 0;
	const codeLangExtraTop = opts.codeLangExtraTop ?? 0;
	const quotePaddingY = opts.quotePaddingY ?? 0;
	const quoteMarginTop = opts.quoteMarginTop ?? 0;

	const frames: BlockFrame[] = new Array(blocks.length);
	let y = 0;
	let usedWidth = 0;

	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block) continue;
		y += block.marginTop;

		let height: number;
		let blockUsedWidth: number;

		switch (block.kind) {
			case "inline": {
				const lineWidth = Math.max(1, contentWidth - block.contentLeft);
				const { lineCount, maxLineWidth } = resolveMetrics(block, lineWidth);
				height = lineCount * block.lineHeight;
				if (block.quoteRailLefts.length > 0) {
					height += quotePaddingY * 2 + quoteMarginTop;
				}
				blockUsedWidth = block.contentLeft + maxLineWidth;
				break;
			}
			case "code": {
				const boxWidth = Math.max(1, contentWidth - block.contentLeft);
				const innerWidth = Math.max(1, boxWidth - codePaddingX * 2);
				const { lineCount, maxLineWidth } = resolveMetrics(block, innerWidth);
				const langTop = block.lang != null ? codeLangExtraTop : 0;
				height = lineCount * block.lineHeight + codePaddingY * 2 + langTop;
				blockUsedWidth = block.contentLeft + maxLineWidth + codePaddingX * 2;
				break;
			}
			case "rule":
				height = block.height;
				blockUsedWidth = block.contentLeft;
				break;
			case "fixed":
				height = block.height;
				blockUsedWidth = block.contentLeft;
				break;
			case "unknown":
				height = block.placeholderHeight;
				blockUsedWidth = block.contentLeft;
				break;
		}

		frames[index] = { index, top: y, height, usedWidth: blockUsedWidth };
		y += height;
		if (blockUsedWidth > usedWidth) usedWidth = blockUsedWidth;
	}

	return { blocks: frames, contentHeight: y, usedWidth };
}
