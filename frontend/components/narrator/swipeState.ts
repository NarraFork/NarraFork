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

/**
 * Listeners notified whenever the anchor changes.
 *
 * A VIRTUALIZED list has to react to this: it mounts only the rows near the
 * viewport, so once the anchor's row scrolls past the overscan band it would be
 * unmounted — and `useSwipeMenu`'s unmount cleanup clears both the anchor and the
 * global close handler, which is exactly the pair `onTouchStart` requires to treat
 * the next swipe as a range-select. The list therefore subscribes here and pins the
 * anchor's row into its mounted window (see vlist-swipe-anchor.ts).
 */
const swipeAnchorListeners = new Set<() => void>();

export function getGlobalSwipeAnchor() {
	return globalSwipeAnchor;
}

export function setGlobalSwipeAnchor(blockId: string | null) {
	// Equality short-circuit: `useSwipeMenu` re-asserts the same anchor on every
	// reveal-effect run, and notifying on a no-op would re-render the subscriber
	// (the whole message list) for nothing.
	if (globalSwipeAnchor === blockId) return;
	globalSwipeAnchor = blockId;
	for (const listener of swipeAnchorListeners) listener();
}

/** Subscribe to anchor changes (useSyncExternalStore-shaped). */
export function subscribeGlobalSwipeAnchor(listener: () => void): () => void {
	swipeAnchorListeners.add(listener);
	return () => {
		swipeAnchorListeners.delete(listener);
	};
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

// ---------------------------------------------------------------------------
// Toggle-block callback — lets useSwipeMenu add/remove a single block
// from the selection when multi-select mode is already active.
// ---------------------------------------------------------------------------

type ToggleBlockCallback = (blockId: string) => void;

let globalToggleBlock: ToggleBlockCallback | null = null;

export function getGlobalToggleBlock() {
	return globalToggleBlock;
}

/** Called once by the NarratorPanel provider to register its handler. */
export function setGlobalToggleBlock(fn: ToggleBlockCallback | null) {
	globalToggleBlock = fn;
}

// ---------------------------------------------------------------------------
// Swipe anchor info — extended metadata for the off-screen overlay.
// When the swiped block scrolls out of view, the overlay uses this to show
// a preview and allow scrolling back.
// ---------------------------------------------------------------------------

export interface SwipeAnchorInfo {
	blockId: string;
	/** Short preview text extracted from the swiped block. */
	previewText: string;
	/** Optional Mantine text color for the pinned preview. Defaults to dimmed. */
	previewColor?: string;
	/** Reference to the swiped DOM element for cloning into the overlay. */
	element: HTMLElement;
	/** Scroll the swiped block back into view. */
	scrollBack: () => void;
	/** Close the swipe (and anchor). */
	close: () => void;
	/** Direction the block scrolled off-screen: "top" or "bottom". */
	offScreen: "top" | "bottom";
}

type SwipeAnchorInfoCallback = (info: SwipeAnchorInfo | null) => void;

let globalOnSwipeAnchorInfo: SwipeAnchorInfoCallback | null = null;

export function getGlobalOnSwipeAnchorInfo() {
	return globalOnSwipeAnchorInfo;
}

/** Called once by NarratorPanel to register its handler for off-screen overlay. */
export function setGlobalOnSwipeAnchorInfo(fn: SwipeAnchorInfoCallback | null) {
	globalOnSwipeAnchorInfo = fn;
}
