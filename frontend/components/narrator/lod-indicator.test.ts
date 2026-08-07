/**
 * lod-indicator.test.ts — the LOD indicator's visibility and stepping rules.
 *
 * What this locks down: alt+wheel is unusable on notched wheels (one detent can
 * report a huge delta) and impossible without a wheel, so the indicator carries
 * real click targets. Two requirements are easy to regress:
 *   1. `pinned` must only affect longevity, never the set of controls — the
 *      indicator having two different shapes is what this replaced;
 *   2. the −/+ steppers must clamp instead of wrapping, or the ends of the scale
 *      become unreachable/jumpy.
 */

import { describe, expect, it } from "bun:test";
import {
	isAltKey,
	isLodStepDisabled,
	LOD_LEVELS,
	resolveLodFilledNotches,
	resolveLodIndicatorVisibility,
	resolveLodStepTarget,
} from "./lod-indicator";
import { MAX_RENDER_LOD, MIN_RENDER_LOD } from "./RenderLodCtx";

describe("resolveLodIndicatorVisibility", () => {
	it("stays open without fading while pinned", () => {
		expect(
			resolveLodIndicatorVisibility({ pinned: true, hovered: false, gestureVisible: false }),
		).toEqual({ visible: true, fades: false });
	});

	it("shows a self-hiding indicator for a gesture-driven change", () => {
		expect(
			resolveLodIndicatorVisibility({ pinned: false, hovered: false, gestureVisible: true }),
		).toEqual({ visible: true, fades: true });
	});

	it("does not fade when a gesture happens while pinned", () => {
		// alt+wheel sets both at once. Fading here would pull the steppers out from
		// under the pointer exactly while the user is working the scale.
		expect(
			resolveLodIndicatorVisibility({ pinned: true, hovered: false, gestureVisible: true }),
		).toEqual({ visible: true, fades: false });
	});

	it("holds open while the pointer is inside it, with no modifier held", () => {
		// Adjusting the level is rarely one click, and the user may release Alt once
		// the control is on screen. Hovering must keep it there.
		expect(
			resolveLodIndicatorVisibility({ pinned: false, hovered: true, gestureVisible: true }),
		).toEqual({ visible: true, fades: false });
	});

	it("does not let a stale hover resurrect a hidden indicator", () => {
		// Hover can only happen inside something already on screen; if a hover state
		// outlived its element, treating it as visibility would strand an empty widget.
		expect(
			resolveLodIndicatorVisibility({ pinned: false, hovered: true, gestureVisible: false }),
		).toEqual({ visible: false, fades: false });
	});

	it("hides entirely when nothing is happening", () => {
		expect(
			resolveLodIndicatorVisibility({ pinned: false, hovered: false, gestureVisible: false }),
		).toEqual({ visible: false, fades: true });
	});
});

describe("resolveLodStepTarget", () => {
	it("steps one level per click", () => {
		expect(resolveLodStepTarget(3, 1)).toBe(4);
		expect(resolveLodStepTarget(3, -1)).toBe(2);
	});

	it("clamps at both ends instead of wrapping", () => {
		expect(resolveLodStepTarget(MAX_RENDER_LOD, 1)).toBe(MAX_RENDER_LOD);
		expect(resolveLodStepTarget(MIN_RENDER_LOD, -1)).toBe(MIN_RENDER_LOD);
	});

	it("reports the end steppers as disabled", () => {
		expect(isLodStepDisabled(MAX_RENDER_LOD, 1)).toBe(true);
		expect(isLodStepDisabled(MAX_RENDER_LOD, -1)).toBe(false);
		expect(isLodStepDisabled(MIN_RENDER_LOD, -1)).toBe(true);
		expect(isLodStepDisabled(MIN_RENDER_LOD, 1)).toBe(false);
	});
});

describe("scale", () => {
	it("offers every level as a target, in ascending order", () => {
		expect(LOD_LEVELS).toEqual([1, 2, 3, 4, 5, 6]);
		expect(LOD_LEVELS[0]).toBe(MIN_RENDER_LOD);
		expect(LOD_LEVELS[LOD_LEVELS.length - 1]).toBe(MAX_RENDER_LOD);
	});

	it("fills more notches as the level rises", () => {
		expect(resolveLodFilledNotches(MIN_RENDER_LOD)).toBe(1);
		expect(resolveLodFilledNotches(MAX_RENDER_LOD)).toBe(LOD_LEVELS.length);
	});

	it("treats only the bare Alt key as the reveal modifier", () => {
		expect(isAltKey("Alt")).toBe(true);
		expect(isAltKey("a")).toBe(false);
		expect(isAltKey("Control")).toBe(false);
	});
});
