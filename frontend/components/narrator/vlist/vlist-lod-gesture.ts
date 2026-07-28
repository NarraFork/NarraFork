/**
 * vlist-lod-gesture.ts — Pure decision logic for LOD-step gestures (alt+wheel +
 * two-finger pinch), mirroring ChunkedMessageList's wheel/pinch handlers.
 *
 * Kept DOM-free + pure so the direction/throttle decisions are unit-testable;
 * PretextMessageList wires these to real wheel/touch listeners and forwards the
 * resulting direction to `onLodStep` (which drives NarratorPanel's stepUp/down).
 *
 * Parity with ChunkedMessageList:
 *   - alt+wheel: deltaY>0 → step -1 (less detail), else → +1 (more detail).
 *   - pinch: spread ratio>1.2 → +1, <1/1.2 → -1 (reset baseline each step).
 *   - 140ms throttle so one flick/pinch doesn't skip multiple LOD levels.
 */

export type LodStepDir = 1 | -1;

/** ChunkedMessageList's LOD step throttle window. */
export const LOD_STEP_THROTTLE_MS = 140;
/** Pinch ratio threshold: spread beyond this (or its inverse) triggers a step. */
export const PINCH_RATIO_THRESHOLD = 1.2;

/**
 * Resolve the LOD step direction from an alt+wheel event, or null when the event
 * is not an LOD gesture (no alt held).
 */
export function resolveWheelLodStep(e: { altKey: boolean; deltaY: number }): LodStepDir | null {
	if (!e.altKey) return null;
	return e.deltaY > 0 ? -1 : 1;
}

/**
 * Resolve the LOD step direction from a pinch distance ratio (current/baseline),
 * or null when the change is within the dead zone.
 */
export function resolvePinchLodStep(ratio: number): LodStepDir | null {
	if (ratio > PINCH_RATIO_THRESHOLD) return 1;
	if (ratio < 1 / PINCH_RATIO_THRESHOLD) return -1;
	return null;
}

/**
 * Create a throttle gate for LOD steps. `tryStep(now)` returns true at most once
 * per `throttleMs`, advancing its internal timestamp only when it returns true.
 */
export function createLodStepThrottle(throttleMs: number = LOD_STEP_THROTTLE_MS): {
	tryStep: (now: number) => boolean;
} {
	let lastAt = Number.NEGATIVE_INFINITY;
	return {
		tryStep(now: number): boolean {
			if (now - lastAt < throttleMs) return false;
			lastAt = now;
			return true;
		},
	};
}

/** Euclidean distance between the first two active touch points (0 if <2). */
export function pinchDistance(
	touches: ReadonlyArray<{ clientX: number; clientY: number }>,
): number {
	const a = touches[0];
	const b = touches[1];
	if (!a || !b) return 0;
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** Viewport-relative Y midpoint of the first two touches (0 if <2). */
export function pinchCenterY(touches: ReadonlyArray<{ clientY: number }>): number | null {
	const a = touches[0];
	const b = touches[1];
	if (!a || !b) return null;
	return (a.clientY + b.clientY) / 2;
}

/**
 * The gesture point an LOD rebuild should keep visually fixed, stored relative to
 * the SCROLL CONTAINER's top rather than as a document offset.
 *
 * Screen-relative is the right frame: the pointer does not move while the
 * document scrolls under it, so the document offset is re-derived from the live
 * scrollTop at rebuild time (see resolveLodFocusOffset).
 *
 * Captured when the gesture fires and consumed by the rebuild one React commit
 * later, so it carries a timestamp: a rebuild triggered by something else
 * entirely (a resize, a live patch) must not reuse a stale pointer.
 */
export interface LodFocusPoint {
	/** The point's offset from the scroll container's top edge, in px. */
	viewportOffset: number;
	/** Capture timestamp (ms), compared against LOD_FOCUS_TTL_MS. */
	at: number;
}

/**
 * How long a captured focus point stays valid. Generously longer than the step
 * throttle (so a fast repeated zoom keeps the same anchor point) yet far shorter
 * than any human pause, so an unrelated later rebuild never inherits it.
 */
export const LOD_FOCUS_TTL_MS = 1000;

/**
 * Build the focus point for a gesture at viewport-relative `clientY`.
 * `viewportTop` is the scroll container's own top in viewport coordinates, so the
 * result is independent of where the list sits on the page.
 */
export function createLodFocusPoint(
	clientY: number,
	viewportTop: number,
	now: number,
): LodFocusPoint {
	return { viewportOffset: clientY - viewportTop, at: now };
}

/**
 * Resolve the focus offset a rebuild may use, or `undefined` when there is none
 * (no gesture, or the captured point has expired). Falls back to nothing rather
 * than to a guess: the anchor layer then keeps its viewport-top behavior.
 */
export function resolveLodFocusOffset(
	focus: LodFocusPoint | null,
	now: number,
	scrollTop: number,
): number | undefined {
	if (!focus) return undefined;
	if (now - focus.at > LOD_FOCUS_TTL_MS) return undefined;
	// Scrolling between capture and rebuild moves the document under the pointer;
	// the pointer is still at the same SCREEN position, so re-derive the document
	// offset from the live scrollTop.
	return scrollTop + focus.viewportOffset;
}
