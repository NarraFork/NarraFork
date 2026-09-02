/**
 * vlist-fold-motion.ts — Keyframes and geometry capture for the fold transition
 * planned by `vlist-fold-animation.ts`.
 *
 * Split from the planner on purpose: the arithmetic is pure and unit-tested, this
 * file turns a plan into WAAPI keyframes and reshapes committed layout geometry for
 * the capture. It holds NO animation handles and decides no timing — the single owner
 * of both is `vlist-motion-scheduler.ts`, because a fold, the decorative frames it
 * moves and the drill morph that rides along with it are ONE visual event and must
 * share one cancel boundary and one time base.
 *
 * It lives in the shell layer (like `vlist-highlight.ts`), NOT on the measure path:
 * every keyframe targets an element that has ALREADY been committed at its final
 * geometry, so no measured height, cached measurement or layout index is touched.
 * CONTRACT §0 rule 2 is unaffected — nothing is read back.
 *
 * ROWS get composited `transform` / `clip-path` only: dozens animate at once, and a
 * `height` write on a row could feed back into the measured height model. The
 * decorative tool-run FRAMES are the one deliberate exception — they animate `top`
 * and `height`, because `scaleY` on a box whose visible substance is a 1px border
 * smears that border and its radius. A frame is absolutely positioned, pointer-events
 * -none decoration with no in-flow siblings and no measured height, so animating its
 * layout properties cannot reflow or perturb anything (see `FoldFrameMotion`).
 *
 * Because the scheduler runs every animation with `fill: "none"`, an interrupted fold
 * instantly reads its committed style: there is no residue and no cleanup that can be
 * missed. The frame builder's final keyframe restates the COMMITTED geometry for the
 * same reason — a cancelled frame animation lands exactly where React put it.
 */

import type { FoldFrameMotion, FoldRowGeometry, FoldRowMotion } from "./vlist-fold-animation";

/**
 * Keyframes for a row that only MOVED: start displaced by the offset it used to be
 * at, settle at its committed position.
 *
 * `translate` (not `top`): a transform is composited, so a fold that shifts thirty
 * mounted rows costs no layout work per frame. It also composes with nothing else
 * the rows use, so there is no inline transform to preserve.
 */
export function shiftKeyframes(fromOffset: number): Keyframe[] {
	return [
		{ offset: 0, transform: `translateY(${fromOffset}px)` },
		{ offset: 1, transform: "translateY(0px)" },
	];
}

/**
 * Keyframes for the TOGGLED row on EXPAND: the box is already at its final height,
 * and the newly added region is uncovered across the transition.
 *
 * Only expansion gets a reveal. On collapse the expanded body is already gone from
 * the DOM by this point, so there is nothing to clip — the motion is carried by the
 * rows below sliding up (see the note in vlist-fold-animation.ts).
 *
 * ⚠️ The inset is measured from the bottom of the node this plays ON, so that node
 * must be the row's INNER content box — the one whose height is the layout's
 * `height`. The outer row box is `hitHeight` tall (its own height plus the gap to the
 * next row, see `resolveRowHitHeight`), so playing this there starts the clip a gap's
 * worth of pixels below the card's real bottom edge and the first frame uncovers
 * content that should still be hidden. The shell resolves `data-nf-row-body` for
 * exactly this reason.
 */
export function revealKeyframes(fromInsetBottom: number): Keyframe[] {
	return [
		{ offset: 0, clipPath: `inset(0px 0px ${fromInsetBottom}px 0px)` },
		{ offset: 1, clipPath: "inset(0px 0px 0px 0px)" },
	];
}

/**
 * ⚠️ THERE IS NO COLLAPSE BUILDER, and that is a decision rather than a gap.
 *
 * Two shapes were tried and both are wrong:
 *
 *  - **Reversing the reveal** (`inset(0)` → `inset(0 0 Δ 0)`) needs the expanded body to
 *    still be in the DOM. It is not: React has already re-rendered the row from the
 *    FOLDED measurement, so there is nothing left to clip and the animation is a no-op
 *    on a box that is already short. Keeping the body mounted one extra frame would mean
 *    rendering from the previous `measured` while the layout has committed the new
 *    geometry — stale measurement data on the render path, the coupling CONTRACT §0
 *    rule 2 exists to prevent.
 *  - **Fading the row's content in** (`opacity: 0 → 1`) SHIPPED BRIEFLY AND WAS A BUG.
 *    A cross-fade masks a COMPONENT SWAP (§4.7: "只有换了组件才淡入"), and a collapse
 *    swaps nothing — the header is the same component, in the same place, with the same
 *    content on both sides of the toggle; only the body below it is unmounted. So the
 *    fade made the one part that never changed blink, on every single collapse.
 *
 * A collapse is carried by the rows BELOW sliding up while the toggled row's header
 * holds still. The header being motionless is not a shortcoming of that design, it is
 * what makes it legible: it is the fixed reference against which the closing gap is
 * read.
 */

/**
 * Keyframes for a decorative TOOL-RUN FRAME: travel from the box the reader last saw
 * to the box the layout just committed.
 *
 * The only place in this module that animates LAYOUT properties, and the only place
 * where that is the correct choice — see `FoldFrameMotion` for the full reasoning
 * (`scaleY` would smear the 1px border and its radius; the frame is absolutely
 * positioned decoration with no in-flow siblings and no measured height to perturb).
 */
export function frameKeyframes(motion: FoldFrameMotion): Keyframe[] {
	return [
		{ offset: 0, top: `${motion.from.top}px`, height: `${motion.from.height}px` },
		{ offset: 1, top: `${motion.to.top}px`, height: `${motion.to.height}px` },
	];
}

/**
 * Keyframes for a nested row BLOCK that changed size: close (or open) the block itself.
 *
 * This is what makes a drill-down CLOSE instead of vanish. A drilled row's block IS the
 * card (`blockHeight === card.height`), so React commits the 18.8px summary height in the
 * first frame and the card — header included — disappears instantly, while the rows below
 * slide up from outside the already-short box and appear to emerge from a clip line.
 * Animating the block's height fixes both at once: the card visibly closes, and the rows
 * below stay glued to its bottom edge because they travel exactly the height it lost, over
 * the same duration and easing.
 *
 * `height` is a layout property, and animating it here is the documented exemption (see
 * `FoldNestedRowResize`): the block is absolutely positioned inside its trace with no
 * in-flow siblings, every sibling row is placed by the pure layout's own `top`, and
 * nothing reads this box back. `scaleY` is NOT usable — it would squash the card's text.
 */
export function nestedResizeKeyframes(fromHeight: number, toHeight: number): Keyframe[] {
	return [
		{ offset: 0, height: `${fromHeight}px` },
		{ offset: 1, height: `${toHeight}px` },
	];
}

/** Turn one planned row motion into its keyframes. */
export function foldRowKeyframes(motion: FoldRowMotion): Keyframe[] {
	if (motion.kind === "shift") return shiftKeyframes(motion.fromOffset);
	if (motion.kind === "resize") {
		return nestedResizeKeyframes(motion.fromHeight, motion.toHeight);
	}
	return revealKeyframes(motion.fromInsetBottom);
}

/**
 * Read the geometry of the currently mounted rows straight from the exact layout.
 *
 * Deliberately NOT `getBoundingClientRect`: the layout already knows every row's
 * offset and height to the pixel, so measuring the DOM would be slower, would force
 * a synchronous layout inside a click handler, and would introduce a second source
 * of truth for a geometry the pure path owns. This helper only reshapes what the
 * layout published.
 *
 * Capture is bounded to the MOUNTED window by the caller, so the map stays small
 * (tens of entries) regardless of how long the history is.
 */
export function captureFoldGeometry(
	keys: readonly string[],
	geometryAt: (index: number) => FoldRowGeometry | undefined,
): Map<string, FoldRowGeometry> {
	const out = new Map<string, FoldRowGeometry>();
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (key === undefined) continue;
		const geometry = geometryAt(i);
		if (!geometry) continue;
		out.set(key, { top: geometry.top, height: geometry.height });
	}
	return out;
}

/**
 * Read the geometry of the decorative tool-run frames from the same layout, using the
 * SAME derivation the render pass uses: a frame's box spans its first member's `top`
 * to its last member's `bottom`.
 *
 * Deriving it here (rather than accepting boxes from the caller) is what keeps the
 * captured "before" and the committed "after" provably consistent — the artifact this
 * whole transition fixes came from two places disagreeing about a frame's geometry.
 *
 * A frame whose members the layout has no geometry for is skipped rather than
 * approximated: with no box there is nothing honest to animate from, and the plan's
 * "present in both maps" rule then drops it, so it simply appears where the rebuild
 * put it.
 *
 * NOT bounded to the mounted window on purpose: unlike a row, a frame can legitimately
 * SPAN the window (its first card scrolled off the top, its last off the bottom) and
 * still be mounted and visible. Frames are counted in single digits, so capturing all
 * of them costs nothing.
 */
/**
 * Snapshot the LOCAL tops of the rows nested inside each mounted trace element.
 *
 * At L1/L2 a whole activity run is one list item whose tool rows are absolutely
 * positioned blocks inside it, so drilling one open moves its siblings without moving
 * any top-level item. Those rows are invisible to `captureFoldGeometry`, which is why
 * they used to teleport while everything below the run slid correctly.
 *
 * Local (not document) offsets on purpose: the trace's own displacement is already
 * carried by that element's `shift`, so adding it here would animate those rows twice.
 * See `FoldNestedRowMotion`.
 *
 * Reads the measured payload the layout already produced — never the DOM.
 */
export function captureFoldNestedRows(
	keys: readonly string[],
	rowsAt: (key: string) => readonly { key: string; top: number; blockHeight: number }[] | undefined,
): Map<string, { rows: Map<string, { top: number; height: number }> }> {
	const out = new Map<string, { rows: Map<string, { top: number; height: number }> }>();
	for (const key of keys) {
		const rows = rowsAt(key);
		if (!rows || rows.length === 0) continue;
		const map = new Map<string, { top: number; height: number }>();
		for (const row of rows) {
			if (typeof row?.key !== "string" || !Number.isFinite(row.top)) continue;
			// The block's own height, so a drill-down can be animated CLOSED rather than
			// unmounted in one frame (see nestedResizeKeyframes).
			if (!Number.isFinite(row.blockHeight)) continue;
			map.set(row.key, { top: row.top, height: row.blockHeight });
		}
		if (map.size > 0) out.set(key, { rows: map });
	}
	return out;
}

export function captureFoldFrameGeometry(
	frames: readonly { key: string; start: number; end: number }[],
	geometryAt: (index: number) => { top: number; bottom: number } | undefined,
): Map<string, FoldRowGeometry> {
	const out = new Map<string, FoldRowGeometry>();
	for (const frame of frames) {
		const first = geometryAt(frame.start);
		const last = geometryAt(frame.end);
		if (!first || !last) continue;
		out.set(frame.key, { top: first.top, height: Math.max(0, last.bottom - first.top) });
	}
	return out;
}
