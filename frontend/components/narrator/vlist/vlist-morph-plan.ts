/**
 * vlist-morph-plan.ts — Turn a pair of committed frames into TARGETS for the visual-state
 * store, replacing the keyframe planners.
 *
 * ## What changed, and why it is not a refactor
 *
 * The keyframe planners answered "what animation should play?", which forced them to decide
 * a START as well as an end. That start could only come from the previous committed
 * snapshot, and under interruption the element was not there — it was wherever the cancelled
 * animation had left it. Hence a visible jump at every step of a held gesture.
 *
 * This module answers a different question: "where should this element END UP, and how far
 * is that from where the new layout puts it?" The start is not its business at all; the
 * store already knows where the element is. That single change is what makes interruption a
 * non-event instead of a case to patch.
 *
 * A target therefore describes a DISPLACEMENT to be undone, not a journey:
 *
 *   - the element has already been laid out at its new position by the exact layout;
 *   - so it is given an initial offset equal to `oldPosition − newPosition`;
 *   - and a resting target of zero, which the store converges toward.
 *
 * The reader sees the element appear where it used to be and travel to where it now belongs
 * — the same perception the old design produced, reached without ever naming a start.
 *
 * ## Admission and pairing are separate
 *
 * Deliberately two passes, because conflating them is what hid a real bug: a large activity
 * group's later members were pruned from the EXPANDED frame only (10 rows of 19px become 10
 * cards of ~400px, so they fall outside the ×3 window at one level but not the other), which
 * left them unpaired and silently un-animated. Admission is now a decision about a whole
 * render unit, taken before any pairing happens.
 */

import type { VisualTarget } from "./vlist-visual-state";

/** Bounds of the box an element is painted inside, in viewport px. */
export interface MorphClipBounds {
	readonly top: number;
	readonly bottom: number;
}

/** One element as the shell sees it in a committed frame. */
export interface MorphElement {
	/** LOD-invariant content identity. Elements without one cannot be paired. */
	readonly unitId: string | null | undefined;
	/** Fallback identity for a TOP-LEVEL element whose key is already LOD-invariant. */
	readonly key: string;
	/** Registry kind, so a component swap can be told from a plain move. */
	readonly kind: string;
	/** Position in DOCUMENT px. */
	readonly top: number;
	readonly height: number;
	/** The element's own painted box, when it is clipped by an ancestor. */
	readonly clip?: MorphClipBounds | null;
	/** True for a member of a group rather than a top-level element. */
	readonly nested?: boolean;
	/**
	 * Box of the render UNIT this element belongs to.
	 *
	 * Admission is judged on THIS, not on the element's own box, whenever it is present —
	 * see the module note on why a group must be admitted or rejected as a whole.
	 */
	readonly unitBox?: { readonly top: number; readonly height: number } | null;
}

/** An element admitted to the morph, with its geometry in viewport px. */
export interface MorphSnapshot {
	readonly unitId: string;
	readonly kind: string;
	/** Top edge in VIEWPORT px. */
	readonly viewportTop: number;
	readonly height: number;
	readonly clip: MorphClipBounds | null;
}

/** What one paired element should do. */
export interface MorphTargetPlan {
	readonly unitId: string;
	/**
	 * Offset to start from, in DOCUMENT px — the displacement the element must travel back
	 * from. Applied to the store as the element's CURRENT state; the resting target is zero.
	 */
	readonly fromOffset: { readonly x: number; readonly y: number };
	/** Where the element settles. Always the resting position for the level it is now at. */
	readonly target: VisualTarget;
	/** True when the component itself was swapped, i.e. this is a re-theme. */
	readonly reTheme: boolean;
}

/**
 * Largest displacement worth animating, in px.
 *
 * Past this a slide is a blur rather than a transition, and a level switch can move content
 * thousands of pixels. An element past the bound settles immediately at its new position.
 */
export const MORPH_MAX_SHIFT_PX = 2000;

/** Most members of one render unit that will be animated. See the plan's §3.5. */
export const MORPH_MAX_UNIT_MEMBERS = 30;

/** True when `[fromTop, fromTop+height)` overlaps the clip box at all. */
export function overlapsClip(
	clip: MorphClipBounds | null,
	fromTop: number,
	height: number,
): boolean {
	if (!clip) return true;
	return fromTop < clip.bottom && fromTop + height > clip.top;
}

/**
 * ADMISSION — choose the elements worth animating, keyed by cross-level identity.
 *
 * The window is `scrollTop − vh … scrollTop + 2·vh` (one screen of overscan each way), but
 * an element belonging to a render unit is judged on the UNIT's box. That is what keeps a
 * group animating as one thing: its folded form is ~190px and its expanded form ~4000px, so
 * judged individually the later members are absent from the expanded frame only, and an
 * element present in just one frame has nothing to pair with.
 */
export function admitElements(
	elements: readonly MorphElement[],
	scrollTop: number,
	viewportHeight: number,
): Map<string, MorphSnapshot> {
	const out = new Map<string, MorphSnapshot>();
	const minY = scrollTop - viewportHeight;
	const maxY = scrollTop + viewportHeight * 2;
	// Counted PER UNIT: the cap bounds one unit's cost, and a global budget would let an
	// early unit starve a later one for no reason the reader could perceive.
	const perUnit = new Map<string, number>();
	for (const el of elements) {
		// A nested element cannot fall back to `key`: a row key is scoped to its trace, so it
		// could collide with an unrelated top-level element's.
		const identity = el.nested ? el.unitId : el.unitId || el.key;
		if (!identity) continue;
		if (out.has(identity)) continue; // first occurrence wins
		const box = el.unitBox ?? null;
		const admitTop = box ? box.top : el.top;
		const admitHeight = box ? box.height : el.height;
		if (admitTop + admitHeight <= minY || admitTop >= maxY) continue;
		if (box) {
			const unitKey = `${box.top}:${box.height}`;
			const seen = perUnit.get(unitKey) ?? 0;
			if (seen >= MORPH_MAX_UNIT_MEMBERS) continue;
			perUnit.set(unitKey, seen + 1);
		}
		out.set(identity, {
			unitId: identity,
			kind: el.kind,
			viewportTop: el.top - scrollTop,
			height: el.height,
			clip: el.clip ? { top: el.clip.top - scrollTop, bottom: el.clip.bottom - scrollTop } : null,
		});
	}
	return out;
}

/**
 * Admit BOTH frames together, so an element visible at either level is kept at both.
 *
 * ⚠️ Admitting each frame independently is wrong, and wrong in a way that loses entire
 * groups rather than stray rows. The same content occupies wildly different extents at the
 * two levels — a 12-row activity fold is ~228px, its expanded form ~4800px — so a scroll
 * position inside the region that only EXISTS when expanded puts the folded unit entirely
 * above the window:
 *
 *     window (scrollTop 3000, vh 800): 2200 … 4600
 *     expanded unit 1000 … 5800  → intersects  ✓
 *     folded   unit 1000 … 1228  → misses      ✗   ⇒ every row unpaired ⇒ no animation
 *
 * Taking the union fixes it at the root: visibility is a property of the CONTENT, not of one
 * of its two forms, so an identity kept by either frame is kept by both. The per-unit cap
 * still applies, so the cost is unchanged.
 */
export function admitPair(
	beforeElements: readonly MorphElement[],
	afterElements: readonly MorphElement[],
	scrollTop: number,
	viewportHeight: number,
	/**
	 * `scrollTop` of the frame `beforeElements` was captured in. Defaults to `scrollTop`
	 * for callers whose scroll position did not move between the two frames.
	 *
	 * ⚠️ Load-bearing whenever the level switch CORRECTS the scroll position, which is
	 * every gesture-driven switch: the LOD anchor keeps the pointed-at content at a fixed
	 * screen position by rewriting `scrollTop`, so the two frames are expressed in
	 * different scroll origins. Element geometry is in DOCUMENT px, and converting the old
	 * frame's document offsets with the NEW frame's `scrollTop` charges the whole scroll
	 * correction to every element as apparent travel — the anchored content, which by
	 * construction did not move on screen, is displaced by the correction and animates
	 * back from it. That reads as the zoom being centred somewhere else entirely.
	 */
	previousScrollTop: number = scrollTop,
): { before: Map<string, MorphSnapshot>; after: Map<string, MorphSnapshot> } {
	const before = admitElements(beforeElements, previousScrollTop, viewportHeight);
	const after = admitElements(afterElements, scrollTop, viewportHeight);
	// Anything one side admitted, the other must supply a counterpart for — read from its own
	// full element list rather than the window, since the window is what disagreed.
	const rescue = (
		into: Map<string, MorphSnapshot>,
		from: ReadonlyMap<string, MorphSnapshot>,
		source: readonly MorphElement[],
		// Each side converts with ITS OWN frame's scroll origin, exactly as `admitElements`
		// did above. Using one origin for both would reintroduce the scroll correction as
		// phantom travel for precisely the elements the window disagreed about.
		originScrollTop: number,
	): void => {
		for (const unitId of from.keys()) {
			if (into.has(unitId)) continue;
			const el = source.find((e) => (e.nested ? e.unitId : e.unitId || e.key) === unitId);
			if (!el) continue;
			into.set(unitId, {
				unitId,
				kind: el.kind,
				viewportTop: el.top - originScrollTop,
				height: el.height,
				clip: el.clip
					? { top: el.clip.top - originScrollTop, bottom: el.clip.bottom - originScrollTop }
					: null,
			});
		}
	};
	rescue(before, after, beforeElements, previousScrollTop);
	rescue(after, before, afterElements, scrollTop);
	return { before, after };
}

/**
 * PAIRING — for each identity in both frames, the displacement to travel back from.
 *
 * `cardnessOf` maps a registry kind to how much of a card that form is, so the caller owns
 * the vocabulary of kinds and this module stays generic.
 */
export function planMorphTargets(
	before: ReadonlyMap<string, MorphSnapshot>,
	after: ReadonlyMap<string, MorphSnapshot>,
	cardnessOf: (kind: string) => number,
	xOffsetFor: (fromKind: string, toKind: string) => number = () => 0,
): MorphTargetPlan[] {
	// NOTE: both maps must have been admitted with `admitPair`, not `admitElements` alone.
	// Admitting each frame on its OWN geometry lets one level drop a whole unit that the other
	// kept — see `admitPair` for why that silently loses every row in the group.
	const out: MorphTargetPlan[] = [];
	for (const [unitId, now] of after) {
		const then = before.get(unitId);
		if (!then) continue; // nothing to travel from
		const reTheme = then.kind !== now.kind;
		const dy = then.viewportTop - now.viewportTop;
		if (!Number.isFinite(dy)) continue;
		const dx = reTheme ? xOffsetFor(then.kind, now.kind) : 0;
		const resting: VisualTarget = {
			x: 0,
			y: 0,
			opacity: 1,
			cardness: cardnessOf(now.kind),
		};
		const distance = Math.abs(dy);
		// Too far to read as travel, or nowhere to travel: settle in place. A re-theme still
		// gets its cardness transition, which is where the border and tail fades come from —
		// they are the part that still communicates the swap.
		const tooFar = distance > MORPH_MAX_SHIFT_PX;
		const clipped = !overlapsClip(now.clip, now.viewportTop + dy, now.height);
		if (distance < 1 || tooFar || clipped) {
			if (!reTheme) continue;
			out.push({
				unitId,
				// No travel, but START from the OTHER form's cardness so the swap still animates.
				fromOffset: { x: 0, y: 0 },
				target: resting,
				reTheme: true,
			});
			continue;
		}
		out.push({ unitId, fromOffset: { x: dx, y: dy }, target: resting, reTheme });
	}
	return out;
}

/**
 * The state an element should be given when a plan is applied.
 *
 * Split out so the shell does not have to know how a plan becomes a state: a travelling
 * element starts displaced and fully-formed, while a re-themed one also starts at the
 * OPPOSITE cardness so the border and tail fade across the swap.
 */
export function initialStateFor(plan: MorphTargetPlan): VisualTarget {
	return {
		x: plan.fromOffset.x,
		y: plan.fromOffset.y,
		// Never fades the LINE itself: the two forms carry the same text in the same place, so
		// a cross-fade there reads as a blur rather than a replacement. Only `cardness`-driven
		// chrome fades.
		opacity: 1,
		cardness: plan.reTheme ? 1 - plan.target.cardness : plan.target.cardness,
	};
}
