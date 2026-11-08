// Test-only bound for the production 180ms cubic-bezier(0.2, 0, 0, 1) transition.
export function heightTransitionStepLimit(span: number, timelineDeltaMs: number): number {
	if (!Number.isFinite(timelineDeltaMs) || timelineDeltaMs < 0)
		throw new Error("Animation timeline must be finite and monotonic");
	// x(u) = .6u - 1.2u² + 1.6u³, y(u) = 3u² - 2u³.
	// max(dy/dx) = 5(1 + sqrt(5))/4, at u = (sqrt(5) - 1)/4.
	// CSS reversal shortens distance and duration by the same factor, so this
	// speed bound still holds when an in-flight transition reverses.
	const maximumSpeed = (5 * (1 + Math.sqrt(5))) / 4;
	// Bound travel by elapsed animation time AND the full geometric range, not
	// an arbitrary fraction of it. A long dropped-frame gap can cross >75%.
	// No frame-duration floor: two reads in one timeline frame allow only the
	// existing 2px layout-rounding tolerance, and a short-gap full snap fails.
	return Math.min(span, (span * maximumSpeed * timelineDeltaMs) / 180) + 2;
}
