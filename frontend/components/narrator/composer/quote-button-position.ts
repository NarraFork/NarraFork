export interface QuoteButtonBox {
	top: number;
	left: number;
	right: number;
	bottom: number;
}

/**
 * `selection`: beside the selection (mouse). `touch`: below the selection, clear of the
 * selection handles; the platform menu iOS/Android draw sits above it and cannot be moved.
 */
export type QuoteButtonPlacement = "selection" | "touch";

export interface QuoteButtonSelection {
	/** Bounding box of every selected line. */
	union: QuoteButtonBox;
	/** The line rect at the end the user moved (focus). */
	end: QuoteButtonBox;
	/** Focus precedes anchor: the moved end is the selection's start. */
	backward: boolean;
}

export interface QuoteButtonLayout {
	placement: QuoteButtonPlacement;
	/** Null falls back to the composer edge. */
	selection: QuoteButtonSelection | null;
	/** Visible message area: the selection must intersect it, the button stays inside it. */
	bounds: QuoteButtonBox;
	composer: QuoteButtonBox;
	viewport: { width: number; height: number };
	size: { width: number; height: number };
}

export const QUOTE_BUTTON_GAP = 6;
/** Below the last line: room for the Android teardrop / iOS knob selection handles. */
export const QUOTE_TOUCH_HANDLE_CLEARANCE = 30;
const EDGE_MARGIN = 4;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Fixed-position top/left for the floating quote toolbar, or null when it must stay hidden.
 *
 * Mouse: outside the selected lines, below the last line for a forward selection, above
 * the first for a backward one (where the pointer ended), flipping when that side has no
 * room. Only a selection taller than the visible area gets covered, and then only at the
 * visible edge nearest the moved end.
 *
 * Touch: always below the selection past its handles, since the platform menu owns the
 * space above it; with no room there, on the composer's top edge instead.
 */
export function quoteButtonPosition(
	layout: QuoteButtonLayout,
): { top: number; left: number } | null {
	const { selection, bounds, composer, viewport, size } = layout;
	const maxLeft = Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN);
	const composerEdge = () =>
		composer.right <= composer.left
			? null
			: {
					top: Math.max(EDGE_MARGIN, composer.top - QUOTE_BUTTON_GAP - size.height),
					left: clamp(composer.right - size.width, EDGE_MARGIN, maxLeft),
				};
	if (!selection) return composerEdge();
	const { union, end, backward } = selection;
	const top = Math.max(bounds.top, EDGE_MARGIN);
	const bottom = Math.min(bounds.bottom, composer.top, viewport.height);
	// The selection scrolled out of the visible message area.
	if (union.bottom <= top || union.top >= bottom || bottom - top < size.height) return null;
	const minLeft = Math.max(EDGE_MARGIN, bounds.left);
	const horizontal = (x: number) =>
		clamp(
			x - size.width / 2,
			minLeft,
			Math.max(minLeft, Math.min(maxLeft, bounds.right - size.width)),
		);
	if (layout.placement === "touch") {
		const below = Math.max(top, union.bottom + QUOTE_TOUCH_HANDLE_CLEARANCE);
		if (below + size.height > bottom) return composerEdge();
		return { top: below, left: horizontal(backward ? end.left : end.right) };
	}
	const below = union.bottom + QUOTE_BUTTON_GAP;
	const above = union.top - QUOTE_BUTTON_GAP - size.height;
	const fitsBelow = below + size.height <= bottom;
	const fitsAbove = above >= top;
	const y = backward
		? fitsAbove
			? above
			: fitsBelow
				? below
				: top
		: fitsBelow
			? below
			: fitsAbove
				? above
				: bottom - size.height;
	return { top: y, left: horizontal(backward ? end.left : end.right) };
}
