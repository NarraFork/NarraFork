/**
 * vlist-lod-morph-motion.ts — Plays the LOD-switch morphs planned by
 * `vlist-lod-morph.ts` onto the committed (new-level) nodes.
 *
 * Thin DOM/WAAPI edge, split from the pure planner so the geometry is unit-testable.
 * Lives in the shell layer, NOT on the measure path.
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
 *
 * ## Multi-activity controller
 *
 * All paired morphs start in the SAME frame (no stagger), keyed per `unitId`:
 * replaying the SAME unitId (a rapid re-zoom) cancels that element's stale
 * animation, while other elements run undisturbed. `fill: "none"` throughout, so a
 * cancelled or finished morph reads the committed style.
 */

import type { LodMorphPlan } from "./vlist-lod-morph";

/** Easing matches the fold transition (Mantine `<Collapse>` default). */
const MORPH_EASING = "ease";

/** The subset of Element the morph needs; keeps it testable without a real DOM. */
export interface LodMorphNode {
	animate?: (
		keyframes: Keyframe[],
		options: KeyframeAnimationOptions,
	) => { cancel: () => void } | undefined;
}

/** A running morph animation. */
export interface LodMorphHandle {
	cancel: () => void;
}

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
function morphKeyframes(deltaY: number, fade: boolean): Keyframe[] {
	const slides = deltaY !== 0;
	if (!fade) {
		return [
			{ offset: 0, transform: `translateY(${deltaY}px)` },
			{ offset: 1, transform: "translateY(0px)" },
		];
	}
	if (!slides) {
		return [
			{ offset: 0, opacity: 0 },
			{ offset: 1, opacity: 1 },
		];
	}
	return [
		{ offset: 0, opacity: 0, transform: `translateY(${deltaY}px)` },
		{ offset: 1, opacity: 1, transform: "translateY(0px)" },
	];
}

/**
 * Play one planned morph on its (new-level) node, returning the handle or null when
 * the environment has no Web Animations support — the committed geometry then stands
 * on its own. Never throws.
 */
export function playLodMorph(
	plan: LodMorphPlan,
	node: LodMorphNode | null | undefined,
): LodMorphHandle | null {
	if (!node || typeof node.animate !== "function") return null;
	try {
		const animation = node.animate(morphKeyframes(plan.deltaY, plan.fade), {
			duration: plan.durationMs,
			easing: MORPH_EASING,
			fill: "none",
		});
		return animation ? { cancel: () => animation.cancel() } : null;
	} catch {
		return null;
	}
}

/** Resolve a plan's unitId to its mounted new-level node (or null when not mounted). */
export type LodMorphNodeResolver = (unitId: string) => LodMorphNode | null | undefined;

/**
 * A per-unitId morph controller. `playAll` starts every planned morph in one frame,
 * cancelling only the SAME unitId's previous animation; `cancel()` stops all.
 */
export function createLodMorphController(): {
	playAll: (plans: readonly LodMorphPlan[], resolve: LodMorphNodeResolver) => void;
	cancel: () => void;
} {
	const active = new Map<string, LodMorphHandle>();
	const cancelOne = (unitId: string) => {
		active.get(unitId)?.cancel();
		active.delete(unitId);
	};
	return {
		playAll: (plans, resolve) => {
			for (const plan of plans) {
				cancelOne(plan.unitId);
				const handle = playLodMorph(plan, resolve(plan.unitId));
				if (handle) active.set(plan.unitId, handle);
			}
		},
		cancel: () => {
			for (const handle of active.values()) handle.cancel();
			active.clear();
		},
	};
}

/**
 * True when the environment asks for reduced motion, in which case the level switch
 * applies instantly. Read at play time, not cached.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
	} catch {
		return false;
	}
}
