/**
 * vlist-swipe-anchor.ts — Pure, DOM-free lookup of the row that owns the current
 * touch swipe ANCHOR.
 *
 * Why this exists: touch range-selection is a two-gesture interaction. The first
 * left-swipe reveals a row's menu and records that row as the global swipe anchor
 * (swipeState.setGlobalSwipeAnchor); a left-swipe on a DIFFERENT row then selects
 * everything between the two. `useSwipeMenu.onTouchStart` only treats the second
 * gesture as a range-select while BOTH the anchor and the anchor's `closeSwipe`
 * handler are registered — and both are cleared by the anchor hook's unmount
 * cleanup.
 *
 * In the virtualized list that cleanup is reached by simply SCROLLING: the canvas
 * mounts `[visible.start, visible.end)` plus a 600px overscan band, so once the
 * anchor's row passes that band React unmounts it, the anchor is dropped, and the
 * second swipe degrades into "open my own menu". The fix is to keep the anchor's
 * row mounted, exactly as the inline editor's row is kept mounted so a draft
 * survives scrolling (`resolvePinnedRowIndices`), which needs the row INDEX behind
 * an anchor blockId — what this module resolves.
 *
 * Kept pure (index arithmetic + id comparison, no geometry and no DOM) so the
 * mapping is unit-testable without a scroll container, and allocation is left to
 * the caller: `rowBlockIdsAt` may return a cached array.
 */

/**
 * Index of the row whose selection ids include `anchorBlockId`, or null when the
 * anchor is absent / not part of the loaded document (nothing to pin).
 *
 * A row can own SEVERAL selection ids: a folded trace element paints one row per
 * tool call or reasoning step and each of those rows is independently swipeable,
 * so the anchor may be a row INSIDE the element while the thing that must stay
 * mounted is the element itself. `rowBlockIdsAt` therefore reports every id the
 * element can answer for, and the first match wins.
 */
export function resolveSwipeAnchorRowIndex(
	anchorBlockId: string | null | undefined,
	itemCount: number,
	rowBlockIdsAt: (index: number) => readonly string[] | null | undefined,
): number | null {
	if (!anchorBlockId || !Number.isInteger(itemCount) || itemCount <= 0) return null;
	for (let index = 0; index < itemCount; index++) {
		const blockIds = rowBlockIdsAt(index);
		if (!blockIds) continue;
		for (const blockId of blockIds) {
			if (blockId === anchorBlockId) return index;
		}
	}
	return null;
}
