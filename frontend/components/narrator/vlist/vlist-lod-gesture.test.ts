import { describe, expect, it } from "bun:test";
import {
	createLodFocusPoint,
	createLodStepThrottle,
	LOD_FOCUS_TTL_MS,
	LOD_STEP_THROTTLE_MS,
	pinchCenterY,
	pinchDistance,
	resolveLodFocusOffset,
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
	it("returns null when the gesture is disabled, even with alt held", () => {
		// The settings toggle (narrafork_lod_alt_gesture). Null — not a no-op step —
		// is what lets the wheel event fall through to normal scrolling: the caller
		// only calls preventDefault when a direction was resolved.
		expect(resolveWheelLodStep({ altKey: true, deltaY: 10 }, false)).toBeNull();
		expect(resolveWheelLodStep({ altKey: true, deltaY: -10 }, false)).toBeNull();
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

describe("pinchCenterY", () => {
	it("returns the vertical midpoint of the first two touches", () => {
		expect(pinchCenterY([{ clientY: 100 }, { clientY: 300 }])).toBe(200);
	});
	it("returns null with fewer than two touches (no focus point)", () => {
		expect(pinchCenterY([{ clientY: 100 }])).toBeNull();
		expect(pinchCenterY([])).toBeNull();
	});
});

describe("LOD focus point", () => {
	it("stores the gesture point relative to the scroll container's top", () => {
		// Container starts 80px down the page; a gesture at clientY 300 is 220px
		// below the container's own top edge.
		expect(createLodFocusPoint(300, 80, 1_000)).toEqual({ viewportOffset: 220, at: 1_000 });
	});

	it("derives the document offset from the LIVE scrollTop, not the captured one", () => {
		// The pointer does not move while the document scrolls under it, so the same
		// screen position maps to a different document offset at a new scrollTop.
		const focus = createLodFocusPoint(300, 80, 1_000);
		expect(resolveLodFocusOffset(focus, 1_050, 500)).toBe(720);
		expect(resolveLodFocusOffset(focus, 1_050, 900)).toBe(1_120);
	});

	it("keeps the point valid across a fast repeated zoom", () => {
		const focus = createLodFocusPoint(300, 80, 1_000);
		// Several throttled steps land well inside the TTL.
		expect(resolveLodFocusOffset(focus, 1_000 + LOD_STEP_THROTTLE_MS * 3, 0)).toBe(220);
	});

	it("expires so an unrelated later rebuild anchors on the viewport top", () => {
		const focus = createLodFocusPoint(300, 80, 1_000);
		expect(resolveLodFocusOffset(focus, 1_000 + LOD_FOCUS_TTL_MS + 1, 0)).toBeUndefined();
	});

	it("reports no focus when no gesture captured one", () => {
		expect(resolveLodFocusOffset(null, 1_000, 400)).toBeUndefined();
	});
});
