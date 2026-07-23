import { describe, expect, it } from "bun:test";
import {
	createLodStepThrottle,
	LOD_STEP_THROTTLE_MS,
	pinchDistance,
	resolvePinchLodStep,
	resolveWheelLodStep,
} from "./vlist-lod-gesture";

describe("resolveWheelLodStep", () => {
	it("steps down on alt+wheel-down, up on alt+wheel-up", () => {
		expect(resolveWheelLodStep({ altKey: true, deltaY: 10 })).toBe(-1);
		expect(resolveWheelLodStep({ altKey: true, deltaY: -10 })).toBe(1);
	});
	it("returns null without alt (normal scroll)", () => {
		expect(resolveWheelLodStep({ altKey: false, deltaY: 10 })).toBeNull();
		expect(resolveWheelLodStep({ altKey: false, deltaY: -10 })).toBeNull();
	});
});

describe("resolvePinchLodStep", () => {
	it("steps up on spread, down on pinch-in, null in dead zone", () => {
		expect(resolvePinchLodStep(1.5)).toBe(1);
		expect(resolvePinchLodStep(0.5)).toBe(-1);
		expect(resolvePinchLodStep(1.0)).toBeNull();
		expect(resolvePinchLodStep(1.1)).toBeNull(); // within threshold
	});
});

describe("createLodStepThrottle", () => {
	it("allows at most one step per throttle window", () => {
		const t = createLodStepThrottle(LOD_STEP_THROTTLE_MS);
		expect(t.tryStep(1000)).toBe(true); // first always allowed
		expect(t.tryStep(1050)).toBe(false); // within 140ms
		expect(t.tryStep(1139)).toBe(false); // still within
		expect(t.tryStep(1141)).toBe(true); // window elapsed
		expect(t.tryStep(1200)).toBe(false); // within new window
	});
	it("first call is always allowed regardless of clock", () => {
		const t = createLodStepThrottle();
		expect(t.tryStep(0)).toBe(true);
	});
});

describe("pinchDistance", () => {
	it("computes euclidean distance between first two touches", () => {
		expect(
			pinchDistance([
				{ clientX: 0, clientY: 0 },
				{ clientX: 3, clientY: 4 },
			]),
		).toBe(5);
	});
	it("returns 0 with fewer than two touches", () => {
		expect(pinchDistance([{ clientX: 0, clientY: 0 }])).toBe(0);
		expect(pinchDistance([])).toBe(0);
	});
});
