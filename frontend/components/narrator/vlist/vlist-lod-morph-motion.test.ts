/**
 * vlist-lod-morph-motion.test.ts — the LOD morph's keyframe shapes.
 *
 * Animation lifetime (handles, cancellation, per-unit replacement, timing) belongs to
 * `vlist-motion-scheduler.ts` and is covered by its tests. What remains here is the
 * part this module still owns, and the part where a wrong choice is silently ugly
 * rather than broken: which properties each of the three morph shapes writes.
 */

import { describe, expect, it } from "bun:test";
import { DRILL_MORPH_X_OFFSET } from "./vlist-drill-morph";
import type { LodMorphPlan } from "./vlist-lod-morph";
import { lodMorphKeyframes } from "./vlist-lod-morph-motion";

/** A plain MOVE (same component, new position): slides, never fades. */
function plan(unitId: string, deltaY: number): LodMorphPlan {
	return { unitId, deltaY, fade: false, toKind: "markdown", durationMs: 250 };
}

/** A RE-THEME (the component was swapped): slides and cross-fades. */
function swapPlan(unitId: string, deltaY: number): LodMorphPlan {
	return { unitId, deltaY, fade: true, toKind: "tool-call", durationMs: 250 };
}

describe("lodMorphKeyframes", () => {
	it("slides the new node from the old element's screen position", () => {
		const frames = lodMorphKeyframes(plan("tool-a", -200));
		expect(frames[0]).toMatchObject({ transform: "translateY(-200px)" });
		expect(frames.at(-1)).toMatchObject({ transform: "translateY(0px)" });
	});

	/**
	 * A fading morph is a RE-THEME — the same `trace-row ↔ tool-call` pair a drill handles —
	 * so it also needs the HORIZONTAL compensation. The two forms start their content at
	 * different offsets (a row leads with a chevron slot, a card with border + padding), so a
	 * Y-only morph slid the line vertically while its icon and text jumped sideways in one
	 * frame.
	 */
	it("cross-fades a re-theme and compensates X, so the swap is masked and nothing jumps", () => {
		const frames = lodMorphKeyframes(swapPlan("tool-a", -200));
		// deltaY < 0 → the card→row direction, starting at the card's lane.
		expect(frames[0]).toMatchObject({
			opacity: 0,
			transform: `translate(${-DRILL_MORPH_X_OFFSET}px, -200px)`,
		});
		expect(frames.at(-1)).toMatchObject({ opacity: 1, transform: "translate(0px, 0px)" });
	});

	it("mirrors the X sign for the opposite direction", () => {
		const frames = lodMorphKeyframes(swapPlan("tool-a", 200));
		expect(frames[0]).toMatchObject({
			transform: `translate(${DRILL_MORPH_X_OFFSET}px, 200px)`,
		});
	});

	it("does not drift sideways when the travel was dropped", () => {
		// A clipped element fades in place; there is no direction to compensate along, so an
		// X offset would be a sideways slide with nothing to justify it.
		const frames = lodMorphKeyframes(swapPlan("tool-a", 0));
		expect(frames[0]).not.toHaveProperty("transform");
	});

	/**
	 * A body that merely moved keeps its component and its content, so fading it makes
	 * unchanged prose blink once per zoom step. `opacity` must be ABSENT rather than
	 * pinned to 1: writing it hands the property to the animation for the duration,
	 * which is a needless composited layer on a node whose opacity never changes.
	 */
	it("writes no opacity at all for a plain move", () => {
		for (const frame of lodMorphKeyframes(plan("m1-b0", -200))) {
			expect(frame).not.toHaveProperty("opacity");
		}
	});

	/**
	 * The planner emits `deltaY: 0, fade: true` for a re-theme whose travel had to be
	 * dropped — an activity fold that swapped the component in place, or a nested row
	 * whose start box fell outside its clip. Writing a `translateY(0px)` pair there
	 * hands `transform` to the animation (and thus a composited layer) for nothing.
	 */
	it("fades in place without touching transform when deltaY is 0", () => {
		const frames = lodMorphKeyframes(swapPlan("tool-a", 0));
		expect(frames[0]).toEqual({ offset: 0, opacity: 0 });
		expect(frames.at(-1)).toEqual({ offset: 1, opacity: 1 });
		for (const frame of frames) {
			expect(frame).not.toHaveProperty("transform");
		}
	});

	it("animates only composited properties — never top/height/scaleY", () => {
		for (const frame of lodMorphKeyframes(plan("tool-a", -200))) {
			expect(frame).not.toHaveProperty("top");
			expect(frame).not.toHaveProperty("height");
			expect(frame).not.toHaveProperty("scale");
		}
	});

	it("produces exactly three distinct shapes", () => {
		// slide only / slide + fade / fade in place. A fourth shape would mean some
		// property is being written where it never changes.
		const slide = lodMorphKeyframes(plan("a", -10));
		const slideFade = lodMorphKeyframes(swapPlan("a", -10));
		const fadeOnly = lodMorphKeyframes(swapPlan("a", 0));
		expect(Object.keys(slide[0] ?? {}).sort()).toEqual(["offset", "transform"]);
		expect(Object.keys(slideFade[0] ?? {}).sort()).toEqual(["offset", "opacity", "transform"]);
		expect(Object.keys(fadeOnly[0] ?? {}).sort()).toEqual(["offset", "opacity"]);
	});
});
