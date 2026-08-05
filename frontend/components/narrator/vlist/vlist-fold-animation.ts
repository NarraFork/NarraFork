/**
 * vlist-fold-animation.ts — The PURE arithmetic behind the exact list's
 * expand/collapse transition.
 *
 * ## Why this exists
 *
 * The chunked path folds a card with Mantine's `<Collapse>`: the body stays in
 * normal flow and the browser animates its `height`, so everything under it slides
 * for free. The exact canvas cannot do that. Every row is absolutely positioned at
 * an offset the pure layout computed (`top`/`height` from `PretextLayoutIndex`), so
 * a toggle takes the shortest possible path from one committed geometry to the
 * next: the document rebuilds, React writes new `top` values, and the whole column
 * jumps in a single frame. Correct, and visually abrupt.
 *
 * The fix cannot be a CSS transition on `top`/`height`, for three reasons:
 *
 *  1. Rows MOUNT AND UNMOUNT as the window shifts. A row that enters the window
 *     already at its new offset has no previous value to transition from, so it
 *     would either not animate or animate from wherever the browser last saw that
 *     key — visible as rows flying in from stale positions.
 *  2. `top` and `height` are layout properties. Animating them on up to ~40 mounted
 *     rows means a layout pass per frame for the whole canvas.
 *  3. A blanket transition would also fire for every geometry change the CONTRACT
 *     insists must be invisible: live WS patches, older pages, width settles. Those
 *     rebuilds are anchored precisely so nothing appears to move; animating them
 *     would turn each into a visible slide. The transition therefore has to be
 *     opt-in per user action, which is what this module plans.
 *
 * So this is a FLIP (First-Last-Invert-Play): read each row's offset BEFORE the
 * toggle, let React commit the new geometry as it already does, then play each row
 * from `translateY(oldVisualTop - newVisualTop)` back to `translateY(0)`. The
 * committed DOM is always the truth; the transform is a purely visual, composited
 * lie that decays to nothing. Nothing here touches the measurement cache, the
 * layout index or React state — exactly the contract `vlist-highlight.ts` follows.
 *
 * ## Everything is computed in VIEWPORT coordinates, not document coordinates
 *
 * A fold rebuild is anchored (`captureCoordinatorAnchor` → `restorePretextLayoutAnchor`),
 * so expanding a card ABOVE the viewport top answers the +Δ document shift with a
 * +Δ `scrollTop` write: the mounted rows do not move on screen at all. Planning from
 * raw `top` values would invent a Δ-pixel slide for rows that visibly stayed put —
 * the exact artifact the anchor exists to prevent. Subtracting each side's scrollTop
 * makes the plan agree with what the reader sees, and collapses that case to "no
 * animation", which is correct.
 *
 * ## Why expand and collapse are not symmetric
 *
 * On EXPAND the grown body is present in the post-commit DOM, so the toggled row can
 * hold its final box (rows below it are already correct) while a `clip-path` uncovers
 * the new region — that reads as the body unrolling inside a fixed frame, which is
 * what `<Collapse>` looks like. `clip-path` is composited and, unlike `height`,
 * cannot feed back into layout, so no measured height is perturbed (CONTRACT §0
 * rule 2 stays intact).
 *
 * On COLLAPSE the expanded body is GONE by then: React re-rendered the row from the
 * folded measurement, so there is nothing left to clip away and a reveal animation
 * would be a no-op on an empty box. Rather than clone the old subtree (a deep
 * `cloneNode` of a 400px card, synchronously, inside a click handler) the collapse
 * is carried by the rows BELOW sliding up from where they were — the card header
 * stays fixed and the gap it left closes over 200ms. So collapse emits shifts only,
 * and this asymmetry is deliberate rather than an omission.
 *
 * DOM-free by design so it is unit-testable: this module computes WHAT to animate,
 * `vlist-fold-motion.ts` performs it.
 */

/** How long a fold transition lasts. Matches Mantine `<Collapse>`'s 200ms default. */
export const FOLD_DURATION_MS = 200;

/**
 * Largest delta (px) still worth animating.
 *
 * A toggle can move the rows below it by tens of thousands of pixels. Sliding across
 * that distance in 200ms is a blur, not a transition, and it makes the reader lose
 * the line they were on. Past this bound the row simply appears at its new offset —
 * the same thing that happens today, which is acceptable precisely because the
 * movement is too large to read as motion anyway.
 */
export const FOLD_MAX_SHIFT_PX = 2000;

/** Sub-pixel deltas are invisible; animating them only costs a composited layer. */
const FOLD_MIN_SHIFT_PX = 1;

/** Geometry of one row as committed by the exact layout. */
export interface FoldRowGeometry {
	readonly top: number;
	readonly height: number;
}

/**
 * The visual instruction for one row, in the frame right after React committed the
 * new geometry.
 *
 * `kind: "shift"` — the row did not change size, it only moved on screen because
 * something above it did. Play `translateY(fromOffset) → translateY(0)`.
 *
 * `kind: "reveal"` — the toggled row grew. Play
 * `clip-path: inset(0 0 <fromInsetBottom>px 0) → inset(0)`, so the box holds its
 * final height while the new content is uncovered.
 */
export type FoldRowMotion =
	| { readonly key: string; readonly kind: "shift"; readonly fromOffset: number }
	| { readonly key: string; readonly kind: "reveal"; readonly fromInsetBottom: number };

/** What `planFoldMotion` needs to know about the interaction that caused the change. */
export interface FoldMotionPlanInput {
	/** Row geometry BEFORE the toggle, keyed by `spec.key`. */
	readonly before: ReadonlyMap<string, FoldRowGeometry>;
	/** Row geometry AFTER the toggle, keyed by `spec.key`. */
	readonly after: ReadonlyMap<string, FoldRowGeometry>;
	/** The row whose fold state the user changed; the only candidate for a reveal. */
	readonly toggledKey: string;
	/** Viewport scroll offset before the toggle. */
	readonly beforeScrollTop: number;
	/**
	 * Viewport scroll offset after the anchored rebuild committed its correction.
	 * Read live from the container, because that correction is what decides whether
	 * a document shift is visible at all (see the module note).
	 */
	readonly afterScrollTop: number;
}

/**
 * Turn a before/after geometry pair into per-row visual instructions.
 *
 * Only rows present in BOTH maps are animated. A row that was not mounted before
 * the toggle has no "from" state to invert, and inventing one is what makes FLIP
 * implementations fling rows in from off-screen; a row that is gone after the
 * toggle has nothing left to animate.
 *
 * The returned list is sparse on purpose: rows that did not visibly move are
 * omitted, so a fold near the tail costs a handful of animations rather than one
 * per mounted row.
 */
export function planFoldMotion(input: FoldMotionPlanInput): FoldRowMotion[] {
	const { before, after, toggledKey, beforeScrollTop, afterScrollTop } = input;
	const scrollDelta = afterScrollTop - beforeScrollTop;
	const out: FoldRowMotion[] = [];
	for (const [key, next] of after) {
		const prev = before.get(key);
		if (!prev) continue;
		if (key === toggledKey) {
			const grew = next.height - prev.height;
			// Only expansion gets a reveal; on collapse there is nothing left to
			// uncover (see the module note).
			if (grew > 0 && isAnimatableShift(grew)) {
				out.push({ key, kind: "reveal", fromInsetBottom: grew });
			}
			// NO `continue`: the toggled row can need BOTH. Expanding a card while
			// pinned to the bottom answers the growth with a scrollTop write, so the
			// card's header visibly travels upward at the same time as its body
			// unrolls. The two are different properties (`transform` vs `clip-path`) on
			// a box that is already at its final height, so they compose into one
			// coherent movement — and dropping the shift here left the one row that
			// most obviously moved as the only one that teleported.
		}
		// On-screen displacement, not document displacement: the anchored rebuild may
		// have absorbed the whole document shift into scrollTop.
		const delta = visualShift(prev.top, next.top, scrollDelta);
		if (!isAnimatableShift(delta)) continue;
		out.push({ key, kind: "shift", fromOffset: delta });
	}
	return out;
}

/**
 * Where a row USED to be relative to where it is now, as the reader saw it.
 *
 * `(prevTop - prevScrollTop) - (nextTop - nextScrollTop)`, rearranged so the caller
 * only has to supply the scroll delta.
 */
export function visualShift(prevTop: number, nextTop: number, scrollDelta: number): number {
	return prevTop - nextTop + scrollDelta;
}

/** True when a delta is large enough to be worth animating and small enough to read. */
export function isAnimatableShift(delta: number): boolean {
	if (!Number.isFinite(delta)) return false;
	const magnitude = Math.abs(delta);
	return magnitude >= FOLD_MIN_SHIFT_PX && magnitude <= FOLD_MAX_SHIFT_PX;
}

/**
 * Whether a captured before-state is still usable for the commit that just landed.
 *
 * A capture is taken in the click handler and consumed in the layout effect of the
 * commit that click produced. Anything else that rebuilds the document in between
 * (a live WS patch, an older page, a reload) invalidates it: the geometry delta
 * would then mix the user's fold with a change they did not make, and the FLIP would
 * animate rows that should simply have appeared where the rebuild put them.
 *
 * The document revision is the discriminator — it advances on every structural
 * change but NOT on a fold (a fold only changes build options), which is exactly
 * the distinction needed. The age bound is the backstop for the case no revision can
 * catch: a click whose rebuild never commits (an error, a narrator switch) must not
 * leave a capture lying around for a much later commit to consume.
 */
export function isFoldCaptureUsable(
	capture: { documentRevision: number; capturedAt: number } | null,
	currentRevision: number,
	now: number,
	maxAgeMs = 400,
): boolean {
	if (!capture) return false;
	if (capture.documentRevision !== currentRevision) return false;
	const age = now - capture.capturedAt;
	return age >= 0 && age <= maxAgeMs;
}
