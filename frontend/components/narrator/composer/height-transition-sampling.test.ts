import { expect, test } from "bun:test";
import { heightTransitionStepLimit } from "./height-transition-sampling.test-support";

const span = 196;
const curve = (u: number) => ({
	time: 180 * (0.6 * u - 1.2 * u ** 2 + 1.6 * u ** 3),
	height: span * (3 * u ** 2 - 2 * u ** 3),
});

test("animation sampling accepts genuine eased travel across a dropped-frame gap", () => {
	const previous = curve(0.1);
	const current = curve(0.75);
	const travel = current.height - previous.height;
	expect(travel).toBeGreaterThan(span * 0.75);
	expect(travel).toBeLessThanOrEqual(heightTransitionStepLimit(span, current.time - previous.time));
	// Observed under four-core / 6x CPU throttling with the original sampler.
	expect(221.21875 - 54.015625).toBeLessThanOrEqual(heightTransitionStepLimit(span, 126));
});

test("animation sampling rejects same-frame and short-gap whole-range snaps", () => {
	for (const gap of [0, 1, 1000 / 60, 1000 / 30]) {
		expect(span).toBeGreaterThan(heightTransitionStepLimit(span, gap));
	}
	expect(heightTransitionStepLimit(span, 0)).toBe(2);
	// Even a partial teleport (not just a whole-range snap) must fail at zero time.
	expect(span / 10).toBeGreaterThan(heightTransitionStepLimit(span, 0));
});

test("animation sampling bounds the exact curve and shortened in-flight reversals", () => {
	for (const reversalFactor of [1, 0.75, 0.25, 0.05]) {
		for (let step = 1; step <= 100; step++) {
			const previous = curve((step - 1) / 100);
			const current = curve(step / 100);
			const gap = (current.time - previous.time) * reversalFactor;
			const travel = (current.height - previous.height) * reversalFactor;
			expect(travel).toBeLessThanOrEqual(heightTransitionStepLimit(span, gap));
		}
	}
});

test("animation sampling never treats an invalid timeline as an unlimited budget", () => {
	for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => heightTransitionStepLimit(span, delta)).toThrow("finite and monotonic");
	}
});
