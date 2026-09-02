/**
 * vlist-drill-morph-motion.ts — Keyframes for the drill-down header morphs planned by
 * `vlist-drill-morph.ts`.
 *
 * Split from the planner on purpose: the arithmetic is pure and unit-tested, this file
 * only shapes keyframes. It holds NO animation handles and decides no timing — the
 * single owner of both is `vlist-motion-scheduler.ts`.
 *
 * That consolidation is the point rather than tidying. A drill morph never happens
 * alone: `onToggleRow` captures a fold AND flips a trace row's drill state in ONE
 * click, so the fold (on the row's own node) and this morph (on a node INSIDE that
 * row) always play in the same frame. While the two had separate controllers their
 * lifetimes were independent — re-toggling cancelled the fold's half wholesale while
 * this half kept running to a different finish time, so one visual event came apart.
 * The scheduler cancels by scope, so one event now replaces all of it.
 *
 * ## How a morph reads
 *
 * The INCOMING line — the card header on expand, the remounted summary row on
 * collapse — starts from the OUTGOING line's screen position and slides + fades home:
 *
 *   translateY(-driftY) → translateY(0),   opacity 0 → 1
 *
 * It touches ONLY that incoming node, which React owns and which is already at its
 * committed geometry. There is no detached ghost to re-home, nothing to remove, and
 * nothing to measure — the failure modes of the earlier capture-based design (a
 * fixed-position ghost covering the rows above, a `getBoundingClientRect` read against
 * the wrong coordinate frame) are designed out.
 *
 * The scheduler runs every animation with `fill: "none"` on a node that stays mounted,
 * so a cancelled or finished morph reads the committed style and there is no cleanup
 * that can be missed.
 */

import { DRILL_MORPH_X_OFFSET, type DrillMorphPlan } from "./vlist-drill-morph";

/**
 * Keyframes for the INCOMING line: appear at the OUTGOING line's screen position
 * (`-driftY`) and slide home. A collapse's negative `driftY` becomes a positive start
 * offset, so the card header sinks down into the remounted summary row — the exact
 * reverse of the expand.
 *
 * ⚠️ NO OPACITY. An earlier version cross-faded (`opacity: 0 → 1`) and that was a bug:
 * a reader watching frame by frame sees the incoming line "blur in", which is exactly
 * the artifact §4.7's rule prohibits — a cross-fade masks a COMPONENT SWAP, and this is
 * not one the reader needs masked. The summary row and the card header carry the same
 * `Name · summary` text at the same place; the transition the reader wants here is a
 * seamless replacement plus travel, not a dissolve. Fading also fights the height
 * animation the row block plays underneath it, so the two read as one blurry event
 * instead of one solid movement.
 *
 * The TAIL CLUSTER (diff stats + duration) is the documented exception, and for the
 * opposite reason — see {@link drillTailKeyframes}.
 */

/**
 * Where a morph's line visually sits, given how far the motion it replaces had run.
 *
 * A morph travels from `-driftY` (expand) or `0` (collapse) to its committed spot, easing
 * as it goes. Interrupting it at fraction `p` therefore leaves the line at the eased point
 * between those two ends — NOT at either end. Resuming from that offset is what makes a
 * second click mid-flight continue the movement instead of snapping to the committed
 * position `fill: "none"` restores.
 *
 * `MOTION_EASING` is `ease`, i.e. `cubic-bezier(0.25, 0.1, 0.25, 1)`. Solving that
 * exactly needs Newton iteration for a value nobody can perceive to the pixel, so this
 * uses the standard smoothstep approximation: identical at both ends, within ~2% in the
 * middle, and monotonic — which is all a resume point needs to be.
 */
function easeApprox(p: number): number {
	const t = p < 0 ? 0 : p > 1 ? 1 : p;
	return t * t * (3 - 2 * t);
}

/**
 * Keyframes that RESUME an interrupted morph from where the outgoing one had reached.
 *
 * `previous` is the sample the scheduler took just before cancelling the motion this one
 * replaces (null when the scope was idle, or the environment cannot be sampled — then the
 * plan starts from its own committed endpoint, which is the pre-existing behaviour).
 */
export function drillMorphKeyframesFrom(
	plan: DrillMorphPlan,
	previous: { progress: number } | null,
): Keyframe[] {
	const frames = drillMorphKeyframes(plan);
	if (!previous) return frames;
	// The outgoing motion was this row's OPPOSITE direction (a drill flip is the only
	// thing that re-plays this scope), so where it had got to is where we start.
	//
	// Outgoing travelled `from → 0` for an expand and `0 → to` for a collapse; either way
	// the un-run remainder of its own displacement is the offset the element still holds.
	// Both axes: the outgoing motion travelled `start → 0`, so the un-run remainder of its
	// own displacement is what the element still visually holds.
	const remaining = 1 - easeApprox(previous.progress);
	const outgoingStartY = plan.kind === "collapse" ? -plan.driftY : plan.driftY;
	const heldY = outgoingStartY * remaining;
	const heldX = DRILL_MORPH_X_OFFSET * remaining;
	const first = frames[0];
	if (!first) return frames;
	return [{ ...first, transform: `translate(${heldX}px, ${heldY}px)` }, ...frames.slice(1)];
}

/**
 * Cross-fade for the TAIL CLUSTER — the diff stats and the duration readout.
 *
 * This is the one part of the line that must NOT travel, because its travel distance is
 * unknowable without measuring the DOM:
 *
 *   folded row: [icon][title][cluster][——— spacer ———]   cluster HUGS the title
 *   card:       [icon][——— title (flex:1) ———][cluster][chevron]   cluster at the RIGHT
 *
 * The gap between those two positions is `available width − rendered title width − cluster
 * width`. The measure layer never computes a rendered TEXT width, so no keyframe can be
 * derived for it. The alternatives were each worse than a fade:
 *
 *  - Make the card's summary hug too (`flex: 0 1 auto`). Tried, and reverted: it does
 *    align the two forms, but by breaking the CARD's own layout. A card is a wide,
 *    self-contained box and a right-hand column of figures belongs at its right edge. The
 *    static appearance is the requirement; the transition serves it, not the reverse.
 *  - FLIP (measure before/after, animate the delta). That reintroduces a DOM read and a
 *    forced layout into a morph deliberately built to be pure arithmetic — the same
 *    coordinate-frame fragility the module note says was designed out.
 *
 * So: fade out where it is, fade in where it belongs. This is the case §4.7's rule is
 * actually FOR — the cluster genuinely does change position discontinuously, and a fade is
 * how a swap that cannot be traced is made unobtrusive rather than jarring.
 *
 * ⚠️ DIRECTION MATTERS, and both nodes animated here belong to the CARD:
 *
 *  - expand: the card header is INCOMING (freshly mounted), so its cluster fades IN.
 *  - collapse: the card is RETAINED and animated shut, so it is OUTGOING and its cluster
 *    fades OUT. Using `0 → 1` here too would flash the cluster back to full opacity at the
 *    start of every close.
 *
 * The two are exact mirrors, which is what lets a flip mid-flight reverse cleanly:
 * `drillTailKeyframesFrom` resumes from the live opacity rather than restarting.
 */
export function drillTailKeyframes(kind: DrillMorphPlan["kind"]): Keyframe[] {
	const [from, to] = kind === "collapse" ? [1, 0] : [0, 1];
	return [
		{ offset: 0, opacity: from },
		{ offset: 1, opacity: to },
	];
}

/**
 * Tail cross-fade that RESUMES from the opacity an interrupted fade had reached.
 *
 * Without this a rapid re-toggle restarts the fade from 0 — the cluster blinks. `previous`
 * is the scheduler's sample of the motion this one replaces (null when the scope was idle).
 */
export function drillTailKeyframesFrom(
	kind: DrillMorphPlan["kind"],
	previous: { progress: number } | null,
): Keyframe[] {
	const frames = drillTailKeyframes(kind);
	if (!previous) return frames;
	// The motion being replaced ran the OPPOSITE direction, so where it had got to is where
	// this one starts. Its own start value was this one's END value, and it had travelled
	// `easeApprox(progress)` of the way from there.
	const outgoingFrom = kind === "collapse" ? 0 : 1;
	const outgoingTo = kind === "collapse" ? 1 : 0;
	const held = outgoingFrom + (outgoingTo - outgoingFrom) * easeApprox(previous.progress);
	const first = frames[0];
	if (!first) return frames;
	return [{ ...first, opacity: held }, ...frames.slice(1)];
}

/**
 * Fade for the card's BORDER during a drill transition.
 *
 * The border exists only in the card form: a folded row has none. So on expand it has to
 * arrive and on collapse it has to leave, and doing that instantly reads as the outline
 * being "switched on" a frame after the card appears. Fading it makes the box assemble as
 * one event with the line's travel.
 *
 * ⚠️ Animates `border-color`, NOT `opacity`. Opacity would be cheaper (composited), but it
 * applies to the whole element — and the element carrying the border is the card's `Paper`,
 * i.e. the entire card. Fading that fades the CONTENT too, which is the "blur in" artifact
 * the line's own motion deliberately avoids. Fading the colour of a 1px outline on one
 * small box is a bounded repaint and the only way to fade the border ALONE without adding
 * an overlay node that would have to track the card's radius exactly.
 *
 * Same shape in both directions for the same reason as the tail: a symmetric fade can be
 * interrupted and resumed without a discontinuity.
 */
export function drillBorderKeyframes(kind: DrillMorphPlan["kind"]): Keyframe[] {
	// Only ONE end is named, and it is always `transparent`; the OPAQUE end is left
	// implicit so the browser fills it from the element's own computed border colour.
	//
	// That matters because the card's border is not a single known value: it is a theme
	// variable by default and a STATUS OVERRIDE on some cards (`borderColor` prop). Naming
	// a colour here would repaint those cards in the wrong one for the duration — a fade
	// that also changes hue. An implicit keyframe cannot disagree with the committed style.
	return kind === "collapse"
		? [{ offset: 1, borderColor: "transparent" }]
		: [{ offset: 0, borderColor: "transparent" }];
}

/**
 * Border fade resumed from an interrupted one.
 *
 * Already implicit at one end (see {@link drillBorderKeyframes}), so an interruption needs
 * no arithmetic: the browser starts from whatever colour the element currently computes to.
 * `previous` is accepted only to keep the signature uniform with the other resume helpers.
 */
export function drillBorderKeyframesFrom(
	kind: DrillMorphPlan["kind"],
	_previous: { progress: number } | null,
): Keyframe[] {
	return drillBorderKeyframes(kind);
}

export function drillMorphKeyframes(plan: DrillMorphPlan): Keyframe[] {
	// COLLAPSE animates the OUTGOING line — the card's header, which is the line on
	// screen while the card is retained for the close. It starts at its committed spot
	// and travels TO where the summary line will be, so the direction is the reverse of
	// an expand's. (The summary row itself needs no motion: it takes over only after the
	// card is released, already at the committed position.)
	// X travels too. The card header's lane starts at the card's left edge while a folded
	// row's starts after its chevron slot, so a Y-only morph slid the line into place while
	// its icon and text jumped `DRILL_MORPH_X_OFFSET` sideways in a single frame. The
	// summary-line end of the movement is the OFFSET end; the card end is 0.
	const x = DRILL_MORPH_X_OFFSET;
	if (plan.kind === "collapse") {
		return [
			{ offset: 0, transform: "translate(0px, 0px)" },
			{ offset: 1, transform: `translate(${x}px, ${plan.driftY}px)` },
		];
	}
	// EXPAND animates the INCOMING card header: it appears where the summary line was
	// and slides home.
	return [
		{ offset: 0, transform: `translate(${x}px, ${-plan.driftY}px)` },
		{ offset: 1, transform: "translate(0px, 0px)" },
	];
}
