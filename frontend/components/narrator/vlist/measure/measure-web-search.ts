/**
 * measure-web-search.ts — Height model for the `web_search` block.
 *
 * Visual parity target (MessageBubble.tsx WebSearchBlock):
 *   Paper withBorder radius="sm" p="xs"                 (10px padding + 1px border)
 *     Group gap={6} wrap="nowrap" align="center"
 *       ThemeIcon size={18}                             (teal, fixed 18px)
 *       [Loader size={12}]                              (only while searching)
 *       Text size="xs" c="dimmed"                       (xs = 12px / 1.4 ≈ 17px line)
 *         <label prefix>  +  [<query span fw=500 c="teal" ml={4}>]
 *
 * The row is a single line in the common case, but the Text is NOT truncated in
 * the original component, so a long query wraps. We therefore carry the label +
 * query as one PreparedInlineBlock (pretext measures the wrapped line count) and
 * add the fixed card chrome (padding + border + icon/loader lane) arithmetically.
 *
 * Height = paddingY*2 + borderY*2 + max(iconHeight, textLineCount * xsLineHeight)
 *
 * Zero DOM. Follows the measure-markdown.ts / measure-message-bubble.ts template.
 */

import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type MeasuredElement,
	type PreparedInlineBlock,
	type RenderLod,
} from "../prepared-block";
import {
	FONT_SIZE,
	FONT_WEIGHT,
	LINE_HEIGHT,
	lineBoxHeight,
	SANS_FAMILY,
	SPACING,
} from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ── Chrome constants (px) — from CONTRACT.md §4 + MessageBubble WebSearchBlock ──
/** Paper p="xs" inner padding (10px each side). */
export const WEB_SEARCH_PADDING = SPACING.xs;
/** Paper withBorder edge (1px each side). */
export const WEB_SEARCH_BORDER = 1;
/** ThemeIcon size={18} — fixed lane height. */
export const WEB_SEARCH_ICON_SIZE = 18;
/** Loader size={12} — only shown while searching. */
export const WEB_SEARCH_LOADER_SIZE = 12;
/** Group gap={6} between icon / loader / text. */
export const WEB_SEARCH_GROUP_GAP = 6;
/** query span ml={4} — modeled as extra width before the query fragment. */
export const WEB_SEARCH_QUERY_GAP = 4;

/** xs text line box: round(12 * 1.4) = 17px. */
export const WEB_SEARCH_TEXT_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);

/** Dimmed status-prefix font (xs, weight 400). */
export const WEB_SEARCH_LABEL_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
/** Teal query font (xs, weight 500 to match fw={500}). */
export const WEB_SEARCH_QUERY_FONT = `500 ${FONT_SIZE.xs}px ${SANS_FAMILY}`;

/** Fragment class markers so the renderer can colour label vs query. */
export const WEB_SEARCH_LABEL_CLASS = "vlist-ws-label";
export const WEB_SEARCH_QUERY_CLASS = "vlist-ws-query";

/** Fixed vertical chrome (padding + border, top + bottom). */
export const WEB_SEARCH_VERTICAL_CHROME = WEB_SEARCH_PADDING * 2 + WEB_SEARCH_BORDER * 2;

export interface WebSearchBlockData {
	/** Primary query string (block.query). */
	query?: string | null;
	/** Alternative multi-query list (block.queries); joined with ", ". */
	queries?: string[] | null;
	/** Search status; anything other than "completed" means still searching. */
	status?: string | null;
	/**
	 * Translated status-prefix text (e.g. "已搜索" / "正在搜索"). Supplied by the
	 * dispatch/registry layer via i18n; falls back to an English label so the
	 * measure stays self-contained and never imports i18n across the vlist edge.
	 */
	label?: string | null;
}

/** Resolve the display query: block.query, else the joined block.queries. */
export function resolveWebSearchQuery(block: WebSearchBlockData): string | null {
	if (typeof block.query === "string" && block.query.length > 0) return block.query;
	if (Array.isArray(block.queries) && block.queries.length > 0) {
		const joined = block.queries.filter((q) => typeof q === "string" && q.length > 0).join(", ");
		return joined.length > 0 ? joined : null;
	}
	return null;
}

/** True when the block is still searching (status set and not "completed"). */
export function isWebSearchSearching(block: WebSearchBlockData): boolean {
	return !!(block.status && block.status !== "completed");
}

/** English fallback prefix when no translated label is supplied. */
function fallbackLabel(isSearching: boolean, status?: string | null): string {
	if (!isSearching) return "Searched";
	return status === "searching" ? "Searching" : "Preparing search";
}

/** Horizontal lane occupied before the text (icon + gaps + optional loader). */
export function webSearchChromeLeft(isSearching: boolean): number {
	return (
		WEB_SEARCH_ICON_SIZE +
		WEB_SEARCH_GROUP_GAP +
		(isSearching ? WEB_SEARCH_LOADER_SIZE + WEB_SEARCH_GROUP_GAP : 0)
	);
}

/**
 * Measure a web_search block at a content width. Deterministic, zero DOM.
 * @param block   web_search block data (query/queries/status/label)
 * @param contentWidth available OUTER card width in px
 * @param _lod    render LOD — web_search has no folded form, so it is ignored
 */
export function measureWebSearch(
	block: WebSearchBlockData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredElement {
	const query = resolveWebSearchQuery(block);
	const isSearching = isWebSearchSearching(block);
	const label = block.label ?? fallbackLabel(isSearching, block.status);

	const chromeLeft = webSearchChromeLeft(isSearching);
	// Inner content box width (inside padding + border).
	const innerWidth = Math.max(1, contentWidth - WEB_SEARCH_PADDING * 2 - WEB_SEARCH_BORDER * 2);

	const items: RichInlineItem[] = [
		{ text: label, font: WEB_SEARCH_LABEL_FONT, break: "normal", extraWidth: 0 },
	];
	const classNames: string[] = [WEB_SEARCH_LABEL_CLASS];
	const hrefs: Array<string | null> = [null];
	const fonts: string[] = [WEB_SEARCH_LABEL_FONT];
	if (query) {
		items.push({
			text: query,
			font: WEB_SEARCH_QUERY_FONT,
			break: "normal",
			extraWidth: 0,
		});
		classNames.push(WEB_SEARCH_QUERY_CLASS);
		hrefs.push(null);
		fonts.push(WEB_SEARCH_QUERY_FONT);
	}

	const textBlock: PreparedInlineBlock = {
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight: WEB_SEARCH_TEXT_LINE_HEIGHT,
		classNames,
		hrefs,
		fonts,
		marginTop: 0,
		// The text lane starts after the icon (+ optional loader) — this doubles as
		// the accumulateFrame line-width offset AND the render left offset.
		contentLeft: chromeLeft,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const blocks: PreparedInlineBlock[] = [textBlock];
	const frame = accumulateFrame(blocks, innerWidth, pretextLineMetrics);

	// Row height is the taller of the fixed icon lane vs the (possibly wrapped) text.
	const rowHeight = Math.max(WEB_SEARCH_ICON_SIZE, frame.contentHeight);
	const height = WEB_SEARCH_VERTICAL_CHROME + rowHeight;

	return {
		height,
		blocks,
		frame,
		contentWidth: innerWidth,
		// Card is a full-width block (not shrink-wrapped): occupies the given width.
		usedWidth: contentWidth,
	};
}

/** Parse once, measure many (e.g. on resize). Returns a reusable closure. */
export function prepareWebSearchMeasurer(
	block: WebSearchBlockData,
): (contentWidth: number, lod?: RenderLod) => MeasuredElement {
	return (contentWidth: number, lod: RenderLod = DEFAULT_RENDER_LOD) =>
		measureWebSearch(block, contentWidth, lod);
}

export const MEASURE_WEB_SEARCH_CONSTANTS = {
	WEB_SEARCH_PADDING,
	WEB_SEARCH_BORDER,
	WEB_SEARCH_ICON_SIZE,
	WEB_SEARCH_LOADER_SIZE,
	WEB_SEARCH_GROUP_GAP,
	WEB_SEARCH_QUERY_GAP,
	WEB_SEARCH_TEXT_LINE_HEIGHT,
	WEB_SEARCH_VERTICAL_CHROME,
} as const;
