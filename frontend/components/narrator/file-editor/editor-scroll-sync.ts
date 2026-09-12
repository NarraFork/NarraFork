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
	return unique.map((entry, i) => {
		const next = unique[i + 1];
		// VS Code's getElementBounds only clips an element when the next anchored
		// element is nested inside it. A real gap between sibling blocks is kept.
		const height = next
			? Math.min(Math.max(1, entry.height), Math.max(1, next.top - entry.top))
			: Math.max(1, entry.height);
		return { line: entry.line, top: entry.top, height };
	});
}

/**
 * The scroller offset (top edge) that reveals `line`, using VS Code's
 * previous/next anchor interpolation. Returns null when there is nothing
 * anchored to go by.
 */
export function scrollTopForLine(anchors: readonly LineAnchor[], line: number): number | null {
	if (anchors.length === 0) return null;
	if (line <= 0) return 0;
	let previous = anchors[0];
	for (const anchor of anchors) {
		if (anchor.line === line) return anchor.top;
		if (anchor.line > line) {
			const progress = (line - previous.line) / (anchor.line - previous.line);
			const previousEnd = previous.top + previous.height;
			const gap = Math.max(0, anchor.top - previousEnd);
			return previousEnd + progress * gap;
		}
		previous = anchor;
	}
	// The collector adds a document-end sentinel, matching VS Code's final
	// `data-line` marker. This fallback is only for callers that provide no sentinel.
	const progressInElement = line - Math.floor(line);
	return previous.top + previous.height * progressInElement;
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
	_fallbackLineHeight = 1,
): number {
	if (anchors.length === 0) return 0;
	if (offset <= 0) return 0;
	for (let i = 0; i < anchors.length; i++) {
		const previous = anchors[i];
		const next = anchors[i + 1];
		const end = previous.top + previous.height;
		if (offset < previous.top) {
			if (!i) return 0;
			const before = anchors[i - 1];
			const progress = (offset - before.top) / Math.max(1, previous.top - before.top);
			return Math.min(lineCount, before.line + progress * (previous.line - before.line));
		}
		if (offset <= end || !next) {
			if (!next) {
				const progress = (offset - previous.top) / Math.max(1, previous.height);
				return Math.min(lineCount, previous.line + progress);
			}
			// VS Code maps the whole interval from this block's top to the next
			// block's top onto the source-line interval between their anchors.
			const progress = (offset - previous.top) / Math.max(1, next.top - previous.top);
			return Math.min(lineCount, previous.line + progress * (next.line - previous.line));
		}
	}
	return lineCount;
}

/** Collect anchors from the rendered preview: every element carrying a source line. */
export function collectPreviewAnchors(scroller: HTMLElement, lineCount?: number): LineAnchor[] {
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
	if (lineCount != null && !entries.some((entry) => entry.line === lineCount)) {
		entries.push({ line: lineCount, top: scroller.scrollHeight, height: 1 });
	}
	return buildAnchors(entries);
}
