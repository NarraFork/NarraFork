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
