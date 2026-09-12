/**
 * selection-anchor-overlay.ts — Should the off-screen preview strip track the
 * current SELECTION?
 *
 * The translucent strip (SwipeAnchorOverlay) already has two producers: the touch
 * swipe anchor and a running compaction marker. This adds a third for the desktop
 * case — you Ctrl/Cmd+Click a block, scroll away, and the strip keeps a handle on
 * where it was.
 *
 * The gate is deliberately narrow, and both halves are the point:
 *
 *  - SINGLE selection only. With several blocks selected the strip has no single
 *    subject: it can show one preview, so it would either pick an arbitrary member
 *    or need a different design (a count, a range). The selection toolbar already
 *    covers the multi-block case, so the strip stays out of it.
 *  - DESKTOP only. On touch the swipe anchor is already the producer for exactly
 *    this situation, and two producers racing for one strip would fight over it —
 *    the swipe path also owns `closeSwipe`, which this one has no business calling.
 *
 * Pure so the rule is unit-testable without a layout engine or a pointer.
 */

export interface SelectionOverlayGateInput {
	/** Currently selected selection-system block ids. */
	selectedBlockIds: ReadonlySet<string>;
	/** True on a mobile-width viewport, where the swipe anchor owns the strip. */
	isMobileViewport: boolean;
	/** True while a touch swipe anchor is showing its own strip. */
	hasSwipeAnchor: boolean;
}

/**
 * The single block id the strip should track, or null when it must stay away.
 *
 * Returning the id (rather than a boolean) keeps the caller from re-deriving "which
 * one" and getting a different answer than the gate did.
 */
export function resolveSelectionOverlayBlockId(input: SelectionOverlayGateInput): string | null {
	if (input.isMobileViewport) return null;
	// The swipe anchor is the older producer and owns the swipe lifecycle; never
	// contend with it.
	if (input.hasSwipeAnchor) return null;
	if (input.selectedBlockIds.size !== 1) return null;
	for (const blockId of input.selectedBlockIds) {
		return blockId || null;
	}
	return null;
}
