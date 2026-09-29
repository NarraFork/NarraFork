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
 *
 * `kind: "resize"` — the toggled element SHRANK. Its content box is painted at the
 * committed height with `overflow: hidden`, so without this it crops everything past the
 * new bottom edge to blank in the first frame ("the whole thing truncates the moment I
 * click"). Animate `height: fromHeight → toHeight` so the crop advances gradually. See
 * the note in `planFoldMotion` for why a fade is not the answer.
 */
export type FoldRowMotion =
	| { readonly key: string; readonly kind: "shift"; readonly fromOffset: number }
	| { readonly key: string; readonly kind: "reveal"; readonly fromInsetBottom: number }
	| {
			readonly key: string;
			readonly kind: "resize";
			readonly fromHeight: number;
			readonly toHeight: number;
	  };

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
	/**
	 * The row whose fold state the user changed; the only candidate for a reveal.
	 * Either this or `toggledKeys`.
	 */
	readonly toggledKey?: string;
	/**
	 * Several rows whose shape changed in ONE commit — the lifecycle channel's case (a
	 * live card and the trace row next to it can both settle on the same patch). Each
	 * gets the same reveal / resize treatment `toggledKey` would.
	 */
	readonly toggledKeys?: ReadonlySet<string>;
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
	const { before, after, toggledKey, toggledKeys, beforeScrollTop, afterScrollTop } = input;
	const scrollDelta = afterScrollTop - beforeScrollTop;
	const isToggled = (key: string) => key === toggledKey || toggledKeys?.has(key) === true;
	const out: FoldRowMotion[] = [];
	for (const [key, next] of after) {
		const prev = before.get(key);
		if (!prev) continue;
		if (isToggled(key)) {
			const grew = next.height - prev.height;
			// Expansion uncovers the newly added region inside the already-final box.
			if (grew > 0 && isAnimatableShift(grew)) {
				out.push({ key, kind: "reveal", fromInsetBottom: grew });
			}
			// CONTRACTION animates the element's OWN BOX, or everything past the new bottom
			// edge is cropped to blank in the very first frame.
			//
			// The shell paints a non-dynamic row's content box at `height: <committed>` with
			// `overflow: hidden`. When a fold SHRINKS the element — collapsing a card, or
			// closing a drill-down inside a trace — React commits the short height
			// immediately, so the box crops its own contents at once and the reader sees the
			// whole lower part of the element blank out on click, then reappear as the rows
			// below slide up. Nothing done to those rows can fix it: the clip is ABOVE them.
			//
			// So the toggled element holds its OLD height and travels to the committed one;
			// `overflow: hidden` then crops progressively instead of instantly.
			//
			// A cross-fade is NOT the answer here and was tried: it masks a component SWAP
			// (§4.7), and a collapse swaps nothing — the header is the same component in the
			// same place, so fading made the one part that never changed blink. Reversing the
			// reveal is also unavailable, since the expanded body is already unmounted.
			if (grew < 0 && isAnimatableShift(grew)) {
				out.push({ key, kind: "resize", fromHeight: prev.height, toHeight: next.height });
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
 * The visual instruction for one row NESTED INSIDE a trace element.
 *
 * ## Why nested rows need their own plan
 *
 * At L1/L2 a whole activity run is ONE list item, and its individual tool rows are
 * absolutely positioned blocks INSIDE it (`measured.rows[i].top`, painted with
 * `data-nf-trace-row`). `planFoldMotion` only sees top-level items, so drilling a row
 * open produced this: the trace element itself grew, everything BELOW the whole run
 * slid correctly — and the rows below the drilled one, inside the same run, teleported.
 *
 * Measured on a 3-row activity trace at 860px: drilling the middle row grows the
 * element 81.2 → 103.4px and moves the row below it from top 60.4 → 82.6px. The
 * top-level plan animates the former and has no way to express the latter.
 *
 * ## Coordinates are LOCAL to the trace element
 *
 * A nested row's `top` is relative to its own trace, and the trace's own displacement is
 * already carried by that element's `shift`. Subtracting the two would double-count, so
 * the delta here is purely `prevLocalTop - nextLocalTop` — no scrollTop, no element top.
 * A row that only moved because its whole run moved therefore yields 0 and is dropped,
 * which is correct: its parent is already animating it.
 */
export interface FoldNestedRowMotion {
	/** The trace element's `spec.key` — its `data-nf-row-key`. */
	readonly traceKey: string;
	/** The row's own key within that trace — its `data-nf-trace-row`. */
	readonly rowKey: string;
	/** `translateY(fromOffset)` → `translateY(0)`. */
	readonly fromOffset: number;
}

/**
 * The visual instruction for one nested row's own BLOCK transition.
 *
 * A drilled-in row's block IS the card: the measure layer reserves
 * `blockHeight === card.height` and `RenderToolRun` paints the box at exactly that
 * height. The two directions intentionally use different CSS properties:
 *
 *  - EXPAND: React commits the final card height immediately, so the block uses a
 *    `clip-path` reveal from the summary height. This keeps the card's content box at
 *    its final geometry instead of letting an old `height` clip it for the first frames.
 *  - COLLAPSE: the card is retained while React commits the short height, so the block
 *    uses `height` from the card size to the summary size. Its `overflow:hidden` clips the
 *    retained card progressively while rows below move by the lost height.
 *
 * `height` remains a documented exception only for collapse: the block is absolute inside
 * its trace, has no in-flow siblings, and nothing reads the animated box back. `scaleY` is
 * not an option because it would squash the card's text.
 */
export type FoldNestedRowResize =
	| {
			readonly traceKey: string;
			readonly rowKey: string;
			readonly kind: "reveal";
			readonly fromInsetBottom: number;
	  }
	| {
			readonly traceKey: string;
			readonly rowKey: string;
			readonly kind: "resize";
			readonly fromHeight: number;
			readonly toHeight: number;
	  };

/** One trace's nested rows at a committed frame, keyed by the trace's spec key. */
export interface FoldNestedRowsSnapshot {
	/** Row key → its geometry LOCAL to the trace element. */
	readonly rows: ReadonlyMap<string, { readonly top: number; readonly height: number }>;
}

/**
 * Plan the movement of rows nested inside trace elements (see FoldNestedRowMotion).
 *
 * Mirrors `planFoldMotion`'s admission rules — present in BOTH snapshots, displacement
 * readable and bounded — with two differences that follow from the coordinate space:
 *
 *  - the delta is LOCAL (see the type note), so an unmoved row inside a moved run is
 *    correctly dropped rather than animated twice;
 *  - a trace present in only one snapshot contributes nothing: at that point the run
 *    itself appeared or vanished, and its rows have no previous position on screen.
 *
 * ## Everything below the toggled row moves TOGETHER, or not at all
 *
 * ⚠️ There is deliberately NO per-row clip gate here, and an earlier version's was a
 * BUG. It rejected a row whose start box fell outside the trace's committed (post-fold)
 * height, by analogy with the L3→L2 LOD morph (§4.7). Two things are wrong with that:
 *
 *  1. **The analogy does not hold.** The LOD case rejects a node that would spend the
 *     animation hiding UNDER a clip and then pop into view. On un-drill these rows slide
 *     UP into a shrinking box: they are ARRIVING at a position inside it, visible for
 *     essentially the whole travel. Testing the start edge against the final height
 *     rejects exactly the rows that are moving correctly.
 *  2. **A per-row verdict tears the group apart.** These rows are not independent
 *     objects; they are one column of content whose top edge moved. Admitting some and
 *     rejecting others makes the survivors glide while their neighbours snap to the
 *     final offset — measured on a 4-row trace with a second card still drilled: the
 *     drilled card animated while the plain row below it jumped, so the two OVERLAPPED
 *     for the duration. That is strictly worse than the uniform jump it replaced.
 *
 * So admission is per-TRACE and all-or-nothing: every moved row in one trace animates
 * with the same duration and easing, or none of them does. The only gate is the shared
 * readable-distance bound, and one row exceeding it disqualifies the WHOLE trace — if any
 * part of the group moved too far to read as motion, the group appears at its committed
 * offsets, which keeps it internally consistent either way. (A sub-pixel row is not a
 * disqualification, it simply did not move.)
 *
 * Clipping is not a problem worth gating on: the rows travel at most the height the box
 * just lost, so a row's transient overhang is bounded by that same amount and is hidden
 * by the very `overflow: hidden` that would otherwise be the concern. Nothing escapes
 * the trace, and nothing paints over a neighbour.
 */
export function planFoldNestedRowMotion(input: {
	readonly before: ReadonlyMap<string, FoldNestedRowsSnapshot>;
	readonly after: ReadonlyMap<string, FoldNestedRowsSnapshot>;
}): FoldNestedRowMotion[] {
	const out: FoldNestedRowMotion[] = [];
	for (const [traceKey, afterTrace] of input.after) {
		const beforeTrace = input.before.get(traceKey);
		if (!beforeTrace) continue;
		// Collect this trace's moved rows first, so the decision can be made for the
		// GROUP. A per-row verdict is what let a drilled card animate while the plain row
		// below it jumped, overlapping it mid-flight.
		const moved: FoldNestedRowMotion[] = [];
		let unreadable = false;
		for (const [rowKey, next] of afterTrace.rows) {
			const prev = beforeTrace.rows.get(rowKey);
			if (prev === undefined) continue;
			const delta = prev.top - next.top;
			if (!Number.isFinite(delta)) {
				unreadable = true;
				break;
			}
			const magnitude = Math.abs(delta);
			// Sub-pixel: invisible, and animating it only costs a composited layer. Not a
			// reason to disqualify the group — those rows simply did not move.
			if (magnitude < 1) continue;
			if (magnitude > FOLD_MAX_SHIFT_PX) {
				unreadable = true;
				break;
			}
			moved.push({ traceKey, rowKey, fromOffset: delta });
		}
		// One verdict for the whole trace: all of its moved rows, or none.
		if (unreadable || moved.length === 0) continue;
		for (const motion of moved) out.push(motion);
	}
	return out;
}

/**
 * Plan the nested row BLOCK transition whose size moved (see `FoldNestedRowResize`).
 *
 * EXPAND emits a reveal inset: React has already committed the final card height, so the
 * block must not animate height from the old summary size. COLLAPSE emits a height resize:
 * the retained card would otherwise be cropped to the short height in the first frame.
 *
 * Bounded by the same readable-distance rule as everything else, and admitted per ROW
 * rather than per trace: the transition is confined to its own block (it moves no sibling —
 * the layout positions those by their own `top`, which `planFoldNestedRowMotion` handles),
 * so one row declining to animate cannot tear a group apart the way a dropped SHIFT does.
 */
export function planFoldNestedRowResize(input: {
	readonly before: ReadonlyMap<string, FoldNestedRowsSnapshot>;
	readonly after: ReadonlyMap<string, FoldNestedRowsSnapshot>;
}): FoldNestedRowResize[] {
	const out: FoldNestedRowResize[] = [];
	for (const [traceKey, afterTrace] of input.after) {
		const beforeTrace = input.before.get(traceKey);
		if (!beforeTrace) continue;
		for (const [rowKey, next] of afterTrace.rows) {
			const prev = beforeTrace.rows.get(rowKey);
			if (prev === undefined) continue;
			const delta = next.height - prev.height;
			if (!isAnimatableShift(delta)) continue;
			if (delta > 0) {
				// The expanded card is already committed at its final height. Reveal it inside
				// that final box instead of animating height from the old summary size, which
				// would make the CSS overflow clip lag behind the card content.
				out.push({ traceKey, rowKey, kind: "reveal", fromInsetBottom: delta });
			} else {
				// The closing card is retained after React commits the short row height. Resize
				// the clip box so its content closes progressively rather than vanishing.
				out.push({
					traceKey,
					rowKey,
					kind: "resize",
					fromHeight: prev.height,
					toHeight: next.height,
				});
			}
		}
	}
	return out;
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
 *
 * ## Why the LOD is a third discriminator
 *
 * An LOD switch is invisible to BOTH checks above: like a fold it only changes build
 * options, so it does not advance the document revision, and a reader who folds a card
 * and then pinch-zooms within the age bound produces exactly that pair. Without this
 * check the stale capture is consumed on the commit where the level moved, and two
 * controllers then animate ONE node's `transform` in the same frame — the fold effect
 * plays first, the LOD morph effect plays second, and which one wins is undefined
 * (the item wrapper carries `data-nf-row-key` AND `data-nf-unit`, so both resolve to
 * it).
 *
 * Rejecting the capture is also the semantically right answer independent of the
 * clash: the switch re-themed the whole document, so geometry captured under the old
 * level describes boxes that no longer exist. The fold then applies instantly while
 * the LOD morph carries the movement, which is the transition the reader's last action
 * actually asked for.
 */
export function isFoldCaptureUsable(
	capture: { documentRevision: number; capturedAt: number; lod: number } | null,
	currentRevision: number,
	now: number,
	currentLod: number,
	maxAgeMs = 400,
): boolean {
	if (!capture) return false;
	if (capture.documentRevision !== currentRevision) return false;
	if (capture.lod !== currentLod) return false;
	const age = now - capture.capturedAt;
	return age >= 0 && age <= maxAgeMs;
}
