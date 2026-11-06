/**
 * How many bottom-bar icons fit, decided without a DOM.
 *
 * The bar is `[avatar] [icons…] [⋯]`. Every icon has the same width, so the split is
 * arithmetic: whatever does not fit goes into the "⋯" menu, in order. The "⋯" button
 * is always present (it also holds the layout customisation), so it is reserved first.
 */

export const NAV_BOTTOM_ICON_PX = 32;
export const NAV_BOTTOM_GAP_PX = 2;

export function navBottomFitCount(params: {
	/** Inner width of the bar in px. */
	width: number;
	/** Width taken by the avatar and the "⋯" button, gaps included. */
	reservedPx: number;
	itemCount: number;
}): number {
	const room = params.width - params.reservedPx;
	if (room <= 0) return 0;
	const fit = Math.floor((room + NAV_BOTTOM_GAP_PX) / (NAV_BOTTOM_ICON_PX + NAV_BOTTOM_GAP_PX));
	return Math.max(0, Math.min(params.itemCount, fit));
}

export function splitNavBottomItems<T>(
	items: readonly T[],
	fit: number,
): { shown: T[]; overflow: T[] } {
	return { shown: items.slice(0, fit), overflow: items.slice(fit) };
}
