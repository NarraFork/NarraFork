/**
 * Line-anchor scroll sync between the Monaco source editor and the rendered
 * markdown preview, modelled on VS Code's markdown scroll sync
 * (`extensions/markdown-language-features/preview-src/scroll-sync.ts`).
 *
 * Proportional (fraction-of-total-height) sync is wrong for markdown: a ten-
 * line code fence renders three pixels tall next to a one-line heading that
 * renders eighty, so the linear height map drifts by whole screens. Instead
 * the rendered document carries `data-line="<0-based source line>"` anchors
 * on block elements (injected by MarkdownContent when `sourceLines` is on),
 * and BOTH directions interpolate line numbers linearly BETWEEN neighbouring
 * anchors — exact at every block boundary, approximately right inside a block.
 *
 * The math below is DOM-free and unit-tested; the two collectors that build
 * anchors from pixels are the only DOM-touching part.
 */

export interface LineAnchor {
	/** 0-based source line the block starts on. */
	readonly line: number;
	/** Document-space pixel offset of the block's top edge inside the scroller. */
	readonly top: number;
	/** Pixel height reserved for this anchor: up to the next anchor, never overlapping. */
	readonly height: number;
}

export interface AnchorEntry {
	readonly line: number;
	readonly top: number;
	/** Raw element height; truncated to the next anchor when one follows. */
	readonly height: number;
}

/**
 * Order entries into anchors and give each a non-overlapping height (VS Code's
 * `getElementBounds` truncation: a block that CONTAINS a more deeply nested
 * anchored block only owns the pixels up to that child). Duplicate lines keep
 * the first element — later same-line blocks start at the same source line and
 * add no interpolation information.
 */
export function buildAnchors(entries: readonly AnchorEntry[]): LineAnchor[] {
	const sorted = [...entries].sort((a, b) => a.top - b.top);
	const unique: AnchorEntry[] = [];
	for (const entry of sorted) {
		if (unique.length > 0 && unique[unique.length - 1].line === entry.line) continue;
		unique.push(entry);
	}
	return unique.map((entry, i) => ({
		line: entry.line,
		top: entry.top,
		height: unique[i + 1] ? Math.max(1, unique[i + 1].top - entry.top) : Math.max(1, entry.height),
	}));
}

/**
 * The scroller offset (top edge) that reveals `line`, interpolating between
 * the anchors bracketing it — exact at every block boundary, linear inside a
 * block's line span (a deliberate refinement over VS Code, which snaps integer
 * in-between lines to the block's end and so cannot round-trip).
 * Returns null when there is nothing anchored to go by.
 */
export function scrollTopForLine(
	anchors: readonly LineAnchor[],
	line: number,
	fallbackLineHeight?: number,
): number | null {
	if (anchors.length === 0) return null;
	if (line <= 0) return 0;
	const first = anchors[0];
	if (line <= first.line) {
		// Above the first anchor: scale the document head linearly.
		return first.line > 0 ? (line / first.line) * first.top : first.top;
	}
	let previous = first;
	for (const anchor of anchors) {
		if (anchor.line === line) return anchor.top;
		if (anchor.line > line) {
			const progress = (line - previous.line) / (anchor.line - previous.line);
			return previous.top + progress * (anchor.top - previous.top);
		}
		previous = anchor;
	}
	// Below the last anchor: extend at the caller's tail line height (kept identical
	// to lineForScrollTop's so the two directions round-trip), else the last block's.
	return previous.top + (line - previous.line) * (fallbackLineHeight ?? previous.height);
}

/**
 * The fractional source line shown at scroller offset `offset` —
 * `getEditorLineNumberForPageOffset` in VS Code. `fallbackLineHeight` extends
 * the document tail past the last anchor; `lineCount` clamps the result.
 */
export function lineForScrollTop(
	anchors: readonly LineAnchor[],
	offset: number,
	lineCount: number,
	fallbackLineHeight: number,
): number {
	if (anchors.length === 0) return 0;
	const first = anchors[0];
	if (offset <= 0) return 0;
	if (offset < first.top) {
		return first.top > 0 ? first.line * (offset / first.top) : first.line;
	}
	let previous = first;
	for (let i = 1; i < anchors.length; i++) {
		const anchor = anchors[i];
		if (offset < anchor.top) {
			const progress = (offset - previous.top) / (anchor.top - previous.top);
			return previous.line + progress * (anchor.line - previous.line);
		}
		previous = anchor;
	}
	const tail = (offset - previous.top) / Math.max(1, fallbackLineHeight);
	return Math.min(lineCount, previous.line + tail);
}

/** Collect anchors from the rendered preview: every element carrying a source line. */
export function collectPreviewAnchors(scroller: HTMLElement): LineAnchor[] {
	const scrollerRect = scroller.getBoundingClientRect();
	const entries: AnchorEntry[] = [];
	for (const element of scroller.querySelectorAll("[data-line]")) {
		if (!(element instanceof HTMLElement)) continue;
		const line = Number(element.getAttribute("data-line"));
		if (Number.isNaN(line)) continue;
		const rect = element.getBoundingClientRect();
		entries.push({
			line,
			top: rect.top - scrollerRect.top + scroller.scrollTop,
			height: rect.height,
		});
	}
	return buildAnchors(entries);
}
