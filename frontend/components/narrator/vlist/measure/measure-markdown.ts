/**
 * measure-markdown.ts — Reference measure function + REFERENCE TEMPLATE for all
 * vlist measure functions. It turns a markdown string into a MeasuredElement
 * with a deterministic, zero-DOM height.
 *
 * Pipeline (three layers, per prepared-block.ts):
 *   1. parseMarkdownToPreparedBlocks(md)  → PreparedBlock[]   (once, width-free)
 *   2. accumulateFrame(blocks, width, …)  → ElementFrame      (per width/LOD)
 *   3. (render layer, elsewhere)          → materialize + absolute layout
 *
 * This file is the pattern every other measure-*.ts should follow:
 *   - accept (data, contentWidth, lod, expandState)
 *   - produce prepared blocks (or reuse a cached prepared bundle)
 *   - call accumulateFrame with the shared pretext resolver
 *   - return { height, blocks, frame, usedWidth }
 */

import { MARKDOWN_CONSTANTS } from "../parse-markdown";
import { accumulateFrame, type MeasuredElement, type PreparedBlock } from "../prepared-block";
import { preparedMarkdownBlocks } from "./math-support";
import { pretextLineMetrics } from "./pretext-metrics";

// Fenced-code box chrome. The settled HighlightedCode view is `padding: xs`
// (10px) + a 1px border top/bottom. accumulateFrame adds `codePaddingY*2`, so we
// fold the border into the padding term: 10 + 1 = 11 per side → 22px total,
// matching HighlightedCode.module.css.
const CODE_PADDING_Y = 11;
const CODE_PADDING_X = 12;

export interface MeasureMarkdownOptions {
	/** Reuse already-parsed blocks (skip the marked.lexer pass). */
	preparedBlocks?: PreparedBlock[];
}

/**
 * Measure a markdown string at a content width. Deterministic, zero DOM.
 * @param markdown raw markdown text
 * @param contentWidth available inner width in px
 */
export function measureMarkdown(
	markdown: string,
	contentWidth: number,
	opts: MeasureMarkdownOptions = {},
): MeasuredElement {
	// Cross-width memo: the parse is width-independent and dominates this measure,
	// so a resize must not re-run it (see prepared-markdown-cache). The streaming
	// path still passes its own incrementally prepared blocks via `opts`.
	const blocks = opts.preparedBlocks ?? preparedMarkdownBlocks(markdown);
	const frame = accumulateFrame(blocks, contentWidth, pretextLineMetrics, {
		codePaddingX: CODE_PADDING_X,
		codePaddingY: CODE_PADDING_Y,
		codeLangExtraTop: MARKDOWN_CONSTANTS.CODE_LANG_EXTRA_TOP,
		quotePaddingY: MARKDOWN_CONSTANTS.BLOCKQUOTE_PADDING,
		quoteMarginTop: MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP,
	});
	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: frame.usedWidth,
	};
}

/** Parse once, measure many (e.g. on resize). Returns a reusable closure. */
export function prepareMarkdownMeasurer(
	markdown: string,
): (contentWidth: number) => MeasuredElement {
	const blocks = preparedMarkdownBlocks(markdown);
	return (contentWidth: number) =>
		measureMarkdown(markdown, contentWidth, { preparedBlocks: blocks });
}

export const MEASURE_MARKDOWN_CODE_PADDING = { x: CODE_PADDING_X, y: CODE_PADDING_Y } as const;
