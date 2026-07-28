/**
 * vlist-content-view-float.ts — pure geometry deciding WHERE a body's action bar
 * lives as the reader scrolls through it.
 *
 * WHY NOT `position: sticky`, AND WHY NOT A PER-FRAME `top`
 *
 * The chunked `ContentViewer` pins its bar with `sticky; top:0`, which works
 * because the bar's nearest scrollport IS the chat scroller. In the exact vlist
 * the chain differs: the virtual canvas and every row box are fixed-height
 * `overflow:hidden` boxes, so sticky would resolve against a box that never
 * scrolls and the bar would slide away with the body's head.
 *
 * The obvious repair — recompute an absolute `top` on every scroll frame — is
 * what made the bar jitter: the scroll paints immediately while the new `top`
 * only lands after React commits, so the bar visibly lags the content by a frame.
 *
 * So there are two distinct modes instead, and the mode is the only thing that
 * changes during a scroll:
 *
 *   parked   — the head is visible; the bar is an ordinary absolute overlay at
 *              the body's own top, moving with the content through plain layout
 *              (no JS, therefore no lag).
 *   floating — the head is gone; the bar becomes a `position: fixed` element
 *              PORTALED out of the list, pinned to the scroller's top edge. Its
 *              coordinates are derived from the scroller's own rect and the body's
 *              horizontal bounds, both of which are INVARIANT under vertical
 *              scrolling — so the bar simply does not move while the reader
 *              scrolls, and there is nothing left to jitter.
 *   hidden   — the body has scrolled far enough that too little of it remains to
 *              host the bar. Disappearing beats sliding the bar down the last few
 *              pixels, which would reintroduce per-frame movement.
 *
 * Being fixed and portaled also means the floating bar escapes the row's
 * `overflow:hidden` entirely, so it can never be clipped.
 */

/**
 * Reserved height (px) of the action bar: an 18px `ActionIcon size="xs"`
 * (`--ai-size-xs` = 1.125rem) plus the 4px inset above and below it.
 */
export const VIEW_ACTION_BAR_HEIGHT = 26;

/** Inset (px) between the bar and the edge it is pinned to. */
export const VIEW_ACTION_BAR_GAP = 4;

/** Gap (px) left above a body's head when jumping back to its start. */
export const VIEW_SCROLL_TO_TOP_GAP = 8;

/** Rectangles the render layer reads and hands in (this module touches no DOM). */
export interface FloatGeometry {
	/** Body top in viewport coordinates. */
	bodyTop: number;
	/** Body bottom in viewport coordinates. */
	bodyBottom: number;
	/** Body right edge in viewport coordinates. */
	bodyRight: number;
	/** Scroll container top in viewport coordinates. */
	scrollerTop: number;
	/** Viewport width (px), for converting `bodyRight` into a CSS `right`. */
	viewportWidth: number;
}

export type FloatMode = "parked" | "floating" | "hidden";

export interface FloatState {
	mode: FloatMode;
	/** Viewport `top` for the fixed bar; only meaningful when floating. */
	top: number;
	/** Viewport `right` for the fixed bar; only meaningful when floating. */
	right: number;
}

const PARKED: FloatState = { mode: "parked", top: 0, right: 0 };
const HIDDEN: FloatState = { mode: "hidden", top: 0, right: 0 };

/**
 * Resolve the bar's mode (and, when floating, its viewport coordinates).
 *
 * Note what is NOT here: any dependence on how far the body has scrolled. Once
 * floating, `top` is the scroller's own top and `right` follows the body's
 * horizontal bounds — neither moves when the reader scrolls vertically, which is
 * precisely what removes the jitter.
 */
export function resolveFloatState(
	geometry: FloatGeometry,
	barHeight: number = VIEW_ACTION_BAR_HEIGHT,
	gap: number = VIEW_ACTION_BAR_GAP,
): FloatState {
	const { bodyTop, bodyBottom, bodyRight, scrollerTop, viewportWidth } = geometry;
	if (
		!Number.isFinite(bodyTop) ||
		!Number.isFinite(bodyBottom) ||
		!Number.isFinite(bodyRight) ||
		!Number.isFinite(scrollerTop)
	) {
		return PARKED;
	}
	// Head still on screen → ordinary in-flow overlay, no JS positioning at all.
	if (bodyTop >= scrollerTop) return PARKED;
	// Too little of the body left below the fold to host the bar: hide it rather
	// than slide it, so the floating position stays constant while it IS shown.
	if (bodyBottom - scrollerTop < barHeight + gap) return HIDDEN;
	return {
		mode: "floating",
		top: scrollerTop + gap,
		right: Math.max(gap, viewportWidth - bodyRight + gap),
	};
}

/**
 * The scrollTop that brings a body's head back into view.
 *
 * Returns the ABSOLUTE target (not a delta) so the caller can hand it straight to
 * `scrollTo`, and clamps at 0 so a body near the very top cannot ask the scroller
 * for a negative position.
 */
export function resolveScrollToBodyTop(
	geometry: Pick<FloatGeometry, "bodyTop" | "scrollerTop">,
	currentScrollTop: number,
	gap: number = VIEW_SCROLL_TO_TOP_GAP,
): number {
	const delta = geometry.bodyTop - geometry.scrollerTop - gap;
	return Math.max(0, currentScrollTop + delta);
}
