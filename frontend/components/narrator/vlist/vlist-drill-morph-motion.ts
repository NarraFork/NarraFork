/**
 * vlist-drill-morph-motion.ts — Plays the drill-down header morphs planned by
 * `vlist-drill-morph.ts` onto the committed row nodes.
 *
 * Split from the planner on purpose: the arithmetic is pure and unit-tested, this
 * file is the thin DOM/WAAPI edge, living in the shell layer and NOT on the measure
 * path.
 *
 * ## How a morph reads
 *
 * The INCOMING line — the card header on expand, the remounted summary row on
 * collapse — starts from the OUTGOING line's screen position and slides + fades
 * home:
 *
 *   translateY(-driftY) → translateY(0),   opacity 0 → 1
 *
 * It touches ONLY that incoming node, which React owns and which is already at its
 * committed geometry. There is no detached ghost to re-home, nothing to remove, and
 * nothing to measure — the failure modes of the earlier capture-based design (a
 * fixed-position ghost covering the rows above, a `getBoundingClientRect` read
 * against the wrong coordinate frame) are designed out.
 *
 * ## Multi-activity controller
 *
 * Unlike the fold controller (one fold cancels the previous), drill morphs are
 * PER-ROW: expanding row A must not cancel an in-flight morph on row B. The
 * controller therefore keys its handles by `rowUid` — replaying the SAME row
 * cancels that row's stale animation, while other rows run undisturbed.
 *
 * Every animation runs with `fill: "none"` on a node that stays mounted, so a
 * cancelled or finished morph reads the committed style — there is no cleanup that
 * can be missed.
 */

import type { DrillMorphPlan } from "./vlist-drill-morph";

/** Easing matches the fold transition (Mantine `<Collapse>` default). */
const MORPH_EASING = "ease";

/** The subset of Element the morph needs; keeps it testable without a real DOM. */
export interface DrillMorphNode {
	animate?: (
		keyframes: Keyframe[],
		options: KeyframeAnimationOptions,
	) => { cancel: () => void } | undefined;
}

/** A running morph animation. */
export interface DrillMorphHandle {
	cancel: () => void;
}

/**
 * Keyframes for the INCOMING line: appear at the OUTGOING line's screen position
 * (`-driftY`), then slide + fade home. A collapse's negative `driftY` becomes a
 * positive start offset, so the card header sinks down into the remounted summary
 * row — the exact reverse of the expand.
 */
function incomingKeyframes(driftY: number): Keyframe[] {
	return [
		{ offset: 0, opacity: 0, transform: `translateY(${-driftY}px)` },
		{ offset: 1, opacity: 1, transform: "translateY(0px)" },
	];
}

/**
 * Play one planned morph on its incoming node, returning the handle or null when
 * the environment has no Web Animations support — the committed geometry then
 * stands on its own and only the transition is skipped. Never throws.
 */
export function playDrillMorph(
	plan: DrillMorphPlan,
	incoming: DrillMorphNode | null | undefined,
): DrillMorphHandle | null {
	if (!incoming || typeof incoming.animate !== "function") return null;
	try {
		const animation = incoming.animate(incomingKeyframes(plan.driftY), {
			duration: plan.durationMs,
			easing: MORPH_EASING,
			fill: "none",
		});
		return animation ? { cancel: () => animation.cancel() } : null;
	} catch {
		return null;
	}
}

/** Resolve a plan's row to its mounted incoming node (or null when not mounted). */
export type DrillMorphNodeResolver = (rowUid: string) => DrillMorphNode | null | undefined;

/**
 * A per-row morph controller.
 *
 * `playAll` starts every planned morph, cancelling only the SAME row's previous
 * animation (a rapid re-toggle of one row) while leaving other rows' morphs alone.
 * `cancel()` stops everything — called on unmount so no animation outlives the list.
 */
export function createDrillMorphController(): {
	playAll: (plans: readonly DrillMorphPlan[], resolve: DrillMorphNodeResolver) => void;
	cancel: () => void;
} {
	const active = new Map<string, DrillMorphHandle>();
	const cancelRow = (rowUid: string) => {
		active.get(rowUid)?.cancel();
		active.delete(rowUid);
	};
	return {
		playAll: (plans, resolve) => {
			for (const plan of plans) {
				// Re-toggle of the same row: cancel its stale morph so two animations never
				// write one transform. Other rows are untouched.
				cancelRow(plan.rowUid);
				const handle = playDrillMorph(plan, resolve(plan.rowUid));
				if (handle) active.set(plan.rowUid, handle);
			}
		},
		cancel: () => {
			for (const handle of active.values()) handle.cancel();
			active.clear();
		},
	};
}

/**
 * True when the environment asks for reduced motion, in which case morphs apply
 * instantly (the committed geometry, no transition). Read at play time, not cached.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
	} catch {
		return false;
	}
}
