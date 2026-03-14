const STIFFNESS = 0.15;
const DAMPING = 0.75;
const PRECISION = 0.5;

export interface AnimatedSegment {
	fromSha: string;
	currentSize: number;
	targetSize: number;
	velocity: number;
}

/**
 * Single step of a critically-damped spring physics model.
 * Uses standard spring-damper: F = -k·x - c·v
 * Tuned for ~200ms to reach 90% with no overshoot.
 */
export function springStep(
	current: number,
	target: number,
	velocity: number,
): { value: number; velocity: number } {
	const displacement = target - current;
	const springForce = displacement * STIFFNESS;
	const dampingForce = -velocity * DAMPING;
	const newVelocity = velocity + springForce + dampingForce;
	const newValue = current + newVelocity;

	if (Math.abs(displacement) < PRECISION && Math.abs(newVelocity) < PRECISION) {
		return { value: target, velocity: 0 };
	}
	return { value: newValue, velocity: newVelocity };
}
