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
 * ## Rows are not the only thing on the canvas
 *
 * The decorative tool-run frames are absolutely positioned SIBLINGS of the rows, sized
 * from the span of the rows they group. They are keyless and never enter the mounted-row
 * window, so the row plan cannot see them — and a frame left at its committed size while
 * its contents animate reads as a border detached from its own content. They get their
 * own plan (`planFoldFrameMotion`) with the same admission rules and a different
 * property set; see `FoldFrameMotion` for why that one is allowed to animate layout.
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
 * Geometry of one absolutely positioned box on the canvas.
 *
 * Structurally identical to a row's, and deliberately the same type: the decorative
 * tool-run frames are laid out from the very same `PretextLayoutIndex` offsets (a
 * frame's box is `items[first].top → items[last].bottom`), so there is nothing for a
 * separate shape to express. The alias exists only so a frame plan does not have to
 * be read as if it described a row.
 */
export type FoldBoxGeometry = FoldRowGeometry;

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

/**
 * The visual instruction for one decorative TOOL-RUN FRAME.
 *
 * ## Why frames need their own plan
 *
 * A grouping frame is not a row. It is a sibling box on the canvas whose geometry is
 * derived from the rows it spans (`items[first].top → items[last].bottom`), it carries
 * no `spec.key`, and it is never part of the mounted-row window. So the row plan above
 * cannot reach it: `planFoldMotion` only emits motions for keys present in both row
 * maps, and the controller resolves those keys through `[data-nf-row-key]`. The result
 * before this existed was the artifact this type fixes — expanding a card inside a run
 * left the border AT ITS FINAL SIZE from the first frame while the cards inside it were
 * still 200ms away from arriving, so the frame visibly detached from its contents.
 *
 * ## Why this one animates LAYOUT properties, unlike every row motion
 *
 * A row's motion is `transform` / `clip-path` on purpose: dozens of rows animate at
 * once, and a `height` animation on a row could feed back into the measured height
 * model (CONTRACT §0 rule 2). Neither concern applies here, and the composited
 * alternative is actively wrong:
 *
 *  - `scaleY` on a box whose visible substance IS a 1px border scales that border too,
 *    so the frame's edges thicken and its radius smears during the transition. That is
 *    a worse artifact than the jump it would replace.
 *  - The frame is `position: absolute` + `pointer-events: none` pure decoration. It has
 *    no in-flow siblings (every row is absolutely positioned too), so animating its
 *    `top`/`height` cannot reflow anything else and cannot perturb any measured height.
 *    Nothing reads its box back — `computeToolRunFrames` derives the geometry from the
 *    layout index, never from the DOM.
 *  - There are at most a handful of frames in the mounted window, versus ~40 rows.
 *
 * `from`/`to` are absolute pixel values rather than deltas so the player stays a dumb
 * WAAPI edge, and so the final keyframe restates the COMMITTED geometry — meaning a
 * cancelled animation lands exactly where React already put the element.
 */
export interface FoldFrameMotion {
	readonly key: string;
	readonly from: FoldBoxGeometry;
	readonly to: FoldBoxGeometry;
}

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
 * Turn a before/after geometry pair into per-FRAME instructions (see FoldFrameMotion).
 *
 * Mirrors `planFoldMotion`'s admission rules so a frame can never animate under
 * conditions its rows would not:
 *
 *  - present in BOTH maps, or there is no "from" box to travel from;
 *  - at least one edge visibly moved, where "visibly" is again VIEWPORT-relative, so
 *    an anchored rebuild that held the run still on screen animates nothing;
 *  - both movements within the readable bound, so a frame never slides across a
 *    distance its own rows refused to.
 *
 * Both edges are handled independently because a fold moves them independently: a fold
 * ABOVE the run moves the whole frame with its size unchanged (top moves, height does
 * not), while a fold INSIDE it grows only the bottom edge (height moves, top does not).
 * Gating on either alone would silently drop the other case, so each edge is
 * normalized on its own and the frame animates when at least one of them survived.
 *
 * The `to` box is in DOCUMENT coordinates — that is what the element's committed `top`
 * actually is — while the decision to animate at all is made in VIEWPORT coordinates.
 * `from` is then derived by walking the visible displacement back from `to`, so the
 * animation starts where the reader last saw the frame rather than where the document
 * used to have it. Without that correction, a run whose document offset shifted while
 * the anchor held it still on screen would animate from an offset the reader never saw.
 */
export function planFoldFrameMotion(input: {
	readonly before: ReadonlyMap<string, FoldBoxGeometry>;
	readonly after: ReadonlyMap<string, FoldBoxGeometry>;
	readonly beforeScrollTop: number;
	readonly afterScrollTop: number;
}): FoldFrameMotion[] {
	const { before, after, beforeScrollTop, afterScrollTop } = input;
	const scrollDelta = afterScrollTop - beforeScrollTop;
	const out: FoldFrameMotion[] = [];
	for (const [key, next] of after) {
		const prev = before.get(key);
		if (!prev) continue;
		// Visible (not document) displacement of the top edge, and the size change.
		const topDelta = animatableEdgeDelta(visualShift(prev.top, next.top, scrollDelta));
		const heightDelta = animatableEdgeDelta(prev.height - next.height);
		// Either edge being unreadable disqualifies the whole frame: animating one edge
		// while the other teleports would deform the box mid-flight.
		if (topDelta === null || heightDelta === null) continue;
		if (topDelta === 0 && heightDelta === 0) continue;
		out.push({
			key,
			from: { top: next.top + topDelta, height: next.height + heightDelta },
			to: { top: next.top, height: next.height },
		});
	}
	return out;
}

/**
 * Normalize one edge's displacement for a frame plan.
 *
 * `0` — the edge held still, or drifted by a sub-pixel amount no reader can see. It
 * still animates (from its own committed value) so the OTHER edge can travel while
 * this one stays put.
 *
 * `null` — unreadable: non-finite, or past the distance bound rows also refuse. The
 * caller drops the whole frame, matching what its rows will do.
 */
function animatableEdgeDelta(delta: number): number | null {
	if (!Number.isFinite(delta)) return null;
	const magnitude = Math.abs(delta);
	if (magnitude < FOLD_MIN_SHIFT_PX) return 0;
	if (magnitude > FOLD_MAX_SHIFT_PX) return null;
	return delta;
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
