/**
 * Global swipe-menu coordination.
 * Only one swipe menu (ContentViewer or ToolCallCard) can be open at a time.
 *
 * Extended for multi-select: when a second swipe occurs while one is already
 * revealed, we enter selection mode and select all blocks between the anchor
 * and the new target.
 */

let globalCloseSwipe: (() => void) | null = null;

export function getGlobalCloseSwipe() {
	return globalCloseSwipe;
}

export function setGlobalCloseSwipe(fn: (() => void) | null) {
	globalCloseSwipe = fn;
}

// ---------------------------------------------------------------------------
// Swipe anchor — remembers which block was swiped first
// ---------------------------------------------------------------------------

/** The blockId of the first swiped ContentViewer / ToolCallCard. */
let globalSwipeAnchor: string | null = null;

export function getGlobalSwipeAnchor() {
	return globalSwipeAnchor;
}

export function setGlobalSwipeAnchor(blockId: string | null) {
	globalSwipeAnchor = blockId;
}

// ---------------------------------------------------------------------------
// Selection notification — lets the NarratorPanel-level context know about
// range-select requests originating from individual useSwipeMenu hooks.
// ---------------------------------------------------------------------------

type SelectionRangeCallback = (anchorBlockId: string, targetBlockId: string) => void;

let globalOnSelectionRange: SelectionRangeCallback | null = null;

export function getGlobalOnSelectionRange() {
	return globalOnSelectionRange;
}

/** Called once by the NarratorPanel provider to register its handler. */
export function setGlobalOnSelectionRange(fn: SelectionRangeCallback | null) {
	globalOnSelectionRange = fn;
}
