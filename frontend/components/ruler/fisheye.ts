/**
 * Fisheye (scroll-compression) transform for the ruler main axis.
 *
 * The center of the viewport maps 1:1 (linear), while the edges compress
 * world-space so that more content is visible at the periphery — similar
 * to the curvature of an unrolled scroll.
 *
 * All functions operate on a single axis (the ruler's main axis).
 */

/**
 * Compression strength.  k=0 → perfectly linear, k=3 → heavy compression.
 * Exposed so callers can tweak; the default (2.0) gives a pleasant scroll feel.
 */
export const FISHEYE_K = 2.0;

// Pre-compute tanh(k) once — it's constant for a given k.
const TANH_K = Math.tanh(FISHEYE_K);

/**
 * Map a world-space main-axis coordinate to a screen-space pixel position.
 *
 * @param worldMain      World-space position along the main axis
 * @param viewCenterWorld  World-space position of the viewport center
 * @param viewportSize   Screen-space size of the viewport (px) along the main axis
 * @param scale          Base zoom scale (controls how much world-space is "in view")
 * @returns Screen-space pixel position (0 = left/top edge of viewport)
 */
export function worldToScreen(
	worldMain: number,
	viewCenterWorld: number,
	viewportSize: number,
	scale: number,
): number {
	const half = viewportSize / 2;
	// Linear offset from center in screen space
	const linear = (worldMain - viewCenterWorld) * scale;
	// Normalise to [-1, 1] range relative to half-viewport
	// Use a wider mapping range so the linear zone in the center is broader
	const range = half * 1.5;
	const d = linear / range;
	// Apply tanh compression
	const compressed = (Math.tanh(d * FISHEYE_K) / TANH_K) * half;
	return half + compressed;
}

/**
 * Inverse of worldToScreen — map a screen pixel back to world-space.
 * Used for hit-testing (clicks, context menus, etc.).
 */
export function screenToWorld(
	screenMain: number,
	viewCenterWorld: number,
	viewportSize: number,
	scale: number,
): number {
	const half = viewportSize / 2;
	const compressed = screenMain - half;
	// Invert: compressed = tanh(d * k) / tanh(k) * half
	// → tanh(d * k) = compressed / half * tanh(k)
	const tanhVal = (compressed / half) * TANH_K;
	// Clamp to valid atanh range (-1, 1)
	const clamped = Math.max(-0.9999, Math.min(0.9999, tanhVal));
	const dk = Math.atanh(clamped);
	const d = dk / FISHEYE_K;
	const range = half * 1.5;
	const linear = d * range;
	return viewCenterWorld + linear / scale;
}

/**
 * Local scale factor at a given world position.
 *
 * This is the derivative of the fisheye mapping — it tells you how much
 * a small world-space interval is stretched or compressed at that point.
 * Used to determine morph phase: high localScale → card, low → dot.
 *
 * Returns a value in (0, scale].  At the viewport center it equals `scale`;
 * at the edges it approaches 0.
 */
export function localScale(
	worldMain: number,
	viewCenterWorld: number,
	viewportSize: number,
	scale: number,
): number {
	const half = viewportSize / 2;
	const range = half * 1.5;
	const linear = (worldMain - viewCenterWorld) * scale;
	const d = linear / range;
	// Derivative of tanh(d*k)/tanh(k) w.r.t. d  =  k * sech²(d*k) / tanh(k)
	// sech²(x) = 1 - tanh²(x)
	const tdk = Math.tanh(d * FISHEYE_K);
	const sech2 = 1 - tdk * tdk;
	const dCompressed_dD = (FISHEYE_K * sech2) / TANH_K;
	// Chain: dScreen/dWorld = dScreen/dD × dD/dLinear × dLinear/dWorld
	//   dScreen/dD = half  (from compressed = ... * half)
	//   dD/dLinear = 1 / range
	//   dLinear/dWorld = scale
	// But we want the "effective scale" — how many screen-px per world-unit:
	return (dCompressed_dD * half * scale) / range;
}

/**
 * Compute the world-space position of the viewport center from camera pan.
 * Convenience helper so callers don't repeat this arithmetic.
 */
export function viewCenterFromPan(mainPan: number, viewportSize: number, scale: number): number {
	// mainPan is the screen-space offset of world origin.
	// Screen center = viewportSize/2.  World position at screen center:
	//   screenCenter = worldCenter * scale + mainPan
	//   → worldCenter = (screenCenter - mainPan) / scale
	return (viewportSize / 2 - mainPan) / scale;
}

/**
 * Solve for mainPan such that a given world point maps to a given screen point
 * after a fisheye transform at the specified scale.
 *
 * i.e. find `pan` where:
 *   worldToScreen(anchorWorld, viewCenterFromPan(pan, viewport, scale), viewport, scale) === anchorScreen
 *
 * Uses Newton's method (typically converges in 3-5 iterations).
 */
export function solvePanForAnchor(
	anchorWorldMain: number,
	anchorScreenMain: number,
	viewportSize: number,
	scale: number,
): number {
	// Initial guess: linear formula
	let pan = anchorScreenMain - anchorWorldMain * scale;

	for (let i = 0; i < 8; i++) {
		const vc = viewCenterFromPan(pan, viewportSize, scale);
		const screenPos = worldToScreen(anchorWorldMain, vc, viewportSize, scale);
		const err = screenPos - anchorScreenMain;
		if (Math.abs(err) < 0.5) break;

		// Derivative: dScreenPos/dPan
		// viewCenter = (viewport/2 - pan) / scale → dVC/dPan = -1/scale
		// screenPos = f(anchorWorld, vc, ...) → dScreenPos/dVC = -localScale(anchorWorld, vc, ...)
		// (negative because moving vc right moves the screen image left)
		// dScreenPos/dPan = dScreenPos/dVC × dVC/dPan = (-ls) × (-1/scale) = ls/scale
		const ls = localScale(anchorWorldMain, vc, viewportSize, scale);
		const dScreenDPan = ls / scale;

		if (Math.abs(dScreenDPan) < 1e-6) break;
		pan -= err / dScreenDPan;
	}

	return pan;
}
