/**
 * scroll-parent.ts — Find the element that actually SCROLLS a given node.
 *
 * Extracted from `useSwipeMenu`, whose original walk compared heights only:
 *
 *     while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
 *
 * ⚠️ Scope note: that walk is NOT the cause of any known bug. Both message lists
 * lay their content out inside the wrapper's own height, so the height-only test
 * skipped the wrappers and reached the real scroller in both paths.
 *
 * It is nonetheless fragile: any ancestor that ends up overflowing while being
 * unscrollable (`overflow: hidden`, a clipped decorative canvas) silently captures
 * the walk, and every caller then measures visibility against a box its target can
 * never leave — failing silently rather than loudly. So overflow is consulted too:
 * an element qualifies only when its content overflows AND its computed
 * `overflow-y` actually permits scrolling. This mirrors the horizontal counterpart
 * already inside `useSwipeMenu` (`findHScrollable`), which skips `overflow: hidden`
 * for exactly that reason.
 */

/** Computed `overflow-y` values that let the user (or script) scroll. */
const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

/**
 * Nearest ancestor-or-self chain element that vertically scrolls `start`, or null.
 *
 * `start` is normally the row's `parentElement`: a row box is itself fixed-height
 * and clipped, so testing it would never help.
 */
export function findVerticalScrollParent(start: HTMLElement | null): HTMLElement | null {
	let current: HTMLElement | null = start;
	while (current) {
		// A zero-height box (a `display:none` / not-yet-laid-out subtree) reports
		// overflow against nothing and would be a false positive.
		if (current.clientHeight > 0 && current.scrollHeight > current.clientHeight) {
			const overflowY = getComputedStyle(current).overflowY;
			if (SCROLLABLE_OVERFLOW.has(overflowY)) return current;
		}
		current = current.parentElement;
	}
	return null;
}

/** Vertical span of a box, in viewport coordinates. */
export interface VerticalSpan {
	top: number;
	bottom: number;
}

/**
 * Which edge a swiped row has left the scroll area past, or null while any part of
 * it is still visible.
 *
 * Split out of `useSwipeMenu`'s rAF loop so the rule is testable without a layout
 * engine. Strictly "entirely outside": a row straddling an edge still shows content,
 * and a strip duplicating a visible row would flicker as the reader scrolls across
 * the boundary. The comparisons are strict (`<` / `>`) so a zero-height sliver flush
 * against the boundary counts as visible rather than toggling every frame.
 */
export function resolveSwipeAnchorOffScreen(
	row: VerticalSpan,
	visible: VerticalSpan,
): "top" | "bottom" | null {
	if (row.bottom < visible.top) return "top";
	if (row.top > visible.bottom) return "bottom";
	return null;
}
