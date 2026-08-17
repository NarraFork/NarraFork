/**
 * Zoom threshold for mounting a live Dockview surface inside a React Flow node.
 *
 * This module once also produced an inverse-scale box (lay the host out at
 * `size * zoom`, then `scale(1 / zoom)`) to hand Dockview a nominally unscaled
 * box for its zoom-blind pointer math. That was removed: cancelling the ancestor
 * scale makes the surface's CSS-pixel width vary with zoom, so everything
 * Dockview draws at a fixed pixel size (tab strip, fonts, padding, panel minimum
 * sizes) took up a different FRACTION of the node at every zoom level. Constant
 * proportions and a zoom-independent pixel box cannot both hold; proportions win,
 * because that is what the user sees at rest. See `ChapterNodeDock`'s host.
 *
 * What survives is the low-zoom cutoff, which is a product decision rather than a
 * geometry trick: a dock rendered a few dozen pixels tall is unreadable and
 * unusable, and mounting a live surface there costs real resources (a chat
 * WebSocket, xterm instances, plugin frames) for something nobody can interact
 * with. Below the threshold the node renders a collapsed preview instead.
 *
 * Pure predicate, no React, so the edge cases are testable without a canvas.
 */

/**
 * Below this zoom a node renders a collapsed preview instead of a live Dockview
 * surface: at 0.4 an expanded node's dock is small enough that Dockview's own
 * minimum panel sizes start squeezing panels out of shape, and the text is
 * unreadable anyway.
 */
export const MIN_EFFECTIVE_ZOOM = 0.4;

/** A finite, strictly positive number (defends against React Flow's initial state). */
function isUsable(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/**
 * Whether a live Dockview surface should be mounted at this zoom.
 *
 * An unusable zoom (React Flow reports `0` before its first layout, and `NaN` if
 * a transform is mid-initialisation) answers TRUE on purpose: the alternative is
 * unmounting every dock for a frame during startup, which would tear down live
 * sessions to avoid a paint that never happens.
 */
export function isInteractiveZoom(zoom: number): boolean {
	if (!isUsable(zoom)) return true;
	return zoom >= MIN_EFFECTIVE_ZOOM;
}
