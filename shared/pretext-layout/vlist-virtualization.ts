/**
 * vlist-virtualization.ts — Pure virtualization math for the pretext narrator
 * list. No React, no DOM (unit-testable). Mirrors the proven approach in
 * chunk-scroll-utils.ts, but the input heights are DETERMINISTIC (produced by
 * pretext measure functions), so there is no post-hoc measurement, no height
 * cache invalidation, and no scroll-anchor compensation needed.
 *
 * Given per-item heights + gaps, we build a prefix-sum array and binary-search
 * the visible range for a given scrollTop / viewport height. The demo's
 * findVisibleRange (markdown-chat.model.ts) is the reference.
 */

/** A laid-out item: absolute top + height within the scroll canvas. */
export interface LaidOutItem {
	top: number;
	height: number;
	bottom: number;
}

export interface ListLayout {
	items: LaidOutItem[];
	/** Total canvas height (px), including top/bottom padding. */
	totalHeight: number;
}

/**
 * Lay out items vertically from deterministic heights.
 * @param heights per-item heights (px)
 * @param gap inter-item gap (px)
 * @param topPadding canvas top padding (px)
 * @param bottomPadding canvas bottom padding (px)
 */
export function layoutItems(
	heights: readonly number[],
	gap: number,
	topPadding = 0,
	bottomPadding = 0,
): ListLayout {
	const items: LaidOutItem[] = new Array(heights.length);
	let y = topPadding;
	for (let i = 0; i < heights.length; i++) {
		const height = heights[i];
		if (height === undefined) continue;
		const top = y;
		const bottom = top + height;
		items[i] = { top, height, bottom };
		y = bottom + gap;
	}
	const totalHeight = heights.length === 0 ? topPadding + bottomPadding : y - gap + bottomPadding;
	return { items, totalHeight };
}

/**
 * Binary-search the visible [start, end) item range for a viewport.
 * @param overscan extra px above/below the viewport to keep mounted.
 */
export function findVisibleRange(
	items: readonly LaidOutItem[],
	scrollTop: number,
	viewportHeight: number,
	overscan = 0,
): { start: number; end: number } {
	if (items.length === 0) return { start: 0, end: 0 };

	const minY = Math.max(0, scrollTop - overscan);
	const maxY = scrollTop + viewportHeight + overscan;

	// First item whose bottom > minY.
	let low = 0;
	let high = items.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (items[mid].bottom > minY) high = mid;
		else low = mid + 1;
	}
	const start = low;

	// First item whose top >= maxY (exclusive end).
	low = start;
	high = items.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (items[mid].top >= maxY) high = mid;
		else low = mid + 1;
	}
	return { start, end: low };
}

/**
 * Prefix-sum spacer heights for a mounted window [start, end).
 * top spacer = height above start; bottom spacer = height below end.
 */
export function spacerHeights(
	items: readonly LaidOutItem[],
	start: number,
	end: number,
	totalHeight: number,
): { top: number; bottom: number } {
	if (items.length === 0) return { top: 0, bottom: 0 };
	const clampedStart = Math.max(0, Math.min(start, items.length));
	const clampedEnd = Math.max(clampedStart, Math.min(end, items.length));
	const top = clampedStart < items.length ? items[clampedStart].top : totalHeight;
	const lastMountedBottom =
		clampedEnd > 0 && clampedEnd <= items.length ? items[clampedEnd - 1].bottom : top;
	const bottom = Math.max(0, totalHeight - lastMountedBottom);
	return { top, bottom };
}

/** Resolve the item index nearest the viewport center (for scroll-to). */
export function itemIndexAtOffset(items: readonly LaidOutItem[], offsetY: number): number {
	if (items.length === 0) return 0;
	let low = 0;
	let high = items.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (items[mid].bottom > offsetY) high = mid;
		else low = mid + 1;
	}
	return Math.min(low, items.length - 1);
}

/**
 * How many tail items arrived between the reader's last seen tail KEY and the
 * list's new tail, computed as an INDEX delta. A flat +1 under-reports a burst
 * that lands in a single commit — the normal case, since several appends often
 * coalesce into one render.
 *
 * The first page (`previousKey === ""`) is not new traffic, a shrinking or
 * replaced tail (the previous key is gone) is a prepend / cache replacement
 * rather than an arrival, and a reader who already saw the tail gets zero.
 */
export function unseenKeyArrivals(previousKey: string, nextKeys: readonly string[]): number {
	if (previousKey === "" || nextKeys.length === 0) return 0;
	const previousIndex = nextKeys.indexOf(previousKey);
	if (previousIndex < 0) return 0;
	return Math.max(0, nextKeys.length - 1 - previousIndex);
}
