/**
 * vlist-lod-morph-motion.ts — Keyframes for the LOD-switch morphs planned by
 * `vlist-lod-morph.ts`.
 *
 * Thin builder, split from the pure planner so the geometry stays unit-testable. It
 * holds NO animation handles and decides no timing — the single owner of both is
 * `vlist-motion-scheduler.ts`, which also carries the LOD switch's longer duration
 * (`LOD_MOTION_DURATION_MS`) next to the shared base so that the deviation is stated
 * in one place instead of drifting between modules.
 *
 * ## How an LOD morph reads
 *
 * An LOD switch can re-theme an element into a DIFFERENT component (a card collapses
 * into a trace row, a row expands into a card), so there is no single node to FLIP.
 * Instead the NEW node — already committed at its final geometry — starts from the
 * OLD element's screen position and slides home:
 *
 *   translateY(deltaY) → translateY(0)          [every morph]
 *   opacity 0 → 1                               [only when `plan.fade`]
 *
 * The slide carries the reader's eye from where the content was to where it went. It
 * touches ONLY the committed new node — no detached ghost of the old (unmounted)
 * element is re-homed, so there is nothing to clean up and nothing to measure.
 *
 * ## The fade is conditional, and that is not a detail
 *
 * The cross-fade exists to MASK A COMPONENT SWAP, so it is played only for a morph
 * whose `kind` changed. Most of what a level switch moves is not swapped at all —
 * markdown bodies, user bubbles, system cards keep their component and their content
 * and merely end up somewhere else. Fading those makes unchanged prose blink once per
 * zoom step, which reads as a glitch rather than as a transition. See
 * `LodMorphPlan.fade`.
 */

import { DRILL_MORPH_X_OFFSET } from "./vlist-drill-morph";
import type { LodMorphPlan } from "./vlist-lod-morph";

/**
 * Keyframes: appear at the OLD position (`deltaY`) and slide to the committed spot,
 * cross-fading only when the component itself was swapped (see the module note).
 *
 * Each property is OMITTED rather than pinned to its resting value when it is not
 * animating: writing it hands the property to the animation for the duration, and with
 * `fill: "none"` that is a needless composited layer on a node where it never changes.
 * So there are three real shapes — slide only, slide + fade, and fade in place
 * (`deltaY: 0`, which the planner emits for a re-theme whose travel was dropped).
 */
export function lodMorphKeyframes(plan: LodMorphPlan): Keyframe[] {
	const slides = plan.deltaY !== 0;
	if (!plan.fade) {
		return [
			{ offset: 0, transform: `translateY(${plan.deltaY}px)` },
			{ offset: 1, transform: "translateY(0px)" },
		];
	}
	// A FADING morph is a re-theme, i.e. exactly the trace-row ↔ tool-call pair a drill
	// morph handles — so it needs the same HORIZONTAL compensation. The two forms start
	// their content at different offsets (a row leads with a chevron slot; a card leads
	// with its border + padding), so a Y-only morph slid the line vertically while its
	// icon and text jumped `DRILL_MORPH_X_OFFSET` sideways in one frame.
	//
	// Sign follows the direction: `deltaY > 0` means the new node starts BELOW its home,
	// i.e. content moved up the document — the row→card direction, whose start is the
	// row's lane. The reverse starts at the card's.
	const x = plan.deltaY >= 0 ? DRILL_MORPH_X_OFFSET : -DRILL_MORPH_X_OFFSET;
	if (!slides) {
		// Fade in place: the planner dropped the travel (clipped element), so there is no
		// direction to compensate along either — moving X alone would be a sideways drift
		// with nothing to justify it.
		return [
			{ offset: 0, opacity: 0 },
			{ offset: 1, opacity: 1 },
		];
	}
	return [
		{ offset: 0, opacity: 0, transform: `translate(${x}px, ${plan.deltaY}px)` },
		{ offset: 1, opacity: 1, transform: "translate(0px, 0px)" },
	];
}

/**
 * LOD morph keyframes that RESUME from an interrupted one.
 *
 * A level switch can be re-triggered mid-flight (holding a zoom shortcut, or a pinch that
 * crosses two thresholds), and with `fill: "none"` the replacement otherwise starts from
 * the committed geometry the cancelled animation snapped back to — a visible jump, the same
 * one the drill morph had before it learned to resume.
 *
 * `previous` is the scheduler's sample of the motion being replaced (null when the scope was
 * idle or the environment exposes no timing).
 */
export function lodMorphKeyframesFrom(
	plan: LodMorphPlan,
	previous: { progress: number } | null,
): Keyframe[] {
	const frames = lodMorphKeyframes(plan);
	if (!previous) return frames;
	const first = frames[0];
	if (!first) return frames;
	// The outgoing motion travelled `start → 0`, so its un-run remainder is what the node
	// still visually holds. Its own start is unknown here (it was a different plan), but the
	// only thing that re-plays this scope is another switch of the SAME element, whose start
	// is this plan's endpoint mirrored — so this plan's own start, scaled by the remainder,
	// is the correct resume point.
	const remaining = 1 - easeApprox(previous.progress);
	const heldY = plan.deltaY * remaining;
	const resumed: Keyframe = { ...first };
	if (first.transform !== undefined) {
		const x = (plan.deltaY >= 0 ? DRILL_MORPH_X_OFFSET : -DRILL_MORPH_X_OFFSET) * remaining;
		resumed.transform = plan.deltaY !== 0 ? `translate(${x}px, ${heldY}px)` : "translate(0px, 0px)";
	}
	if (first.opacity !== undefined) {
		// Opacity ran 0 → 1, so the remainder is how much brightness is still missing.
		resumed.opacity = 1 - remaining;
	}
	return [resumed, ...frames.slice(1)];
}

/**
 * Smoothstep approximation of `MOTION_EASING` (`ease`), identical to the drill morph's.
 *
 * Duplicated rather than shared because these two modules are deliberately independent
 * (the drill morph must not import the LOD planner or vice versa); the function is four
 * tokens and its correctness is pinned by tests on both sides.
 */
function easeApprox(p: number): number {
	const t = p < 0 ? 0 : p > 1 ? 1 : p;
	return t * t * (3 - 2 * t);
}
