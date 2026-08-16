/**
 * vlist-fold-motion.ts — Plays the fold transition planned by
 * `vlist-fold-animation.ts` onto real row nodes.
 *
 * Split from the planner on purpose: the arithmetic is pure and unit-tested, this
 * file is the thin DOM/WAAPI edge. It lives in the shell layer (like
 * `vlist-highlight.ts`), NOT on the measure path — every write targets an element that
 * has ALREADY been committed at its final geometry, so no measured height, cached
 * measurement or layout index is touched. CONTRACT §0 rule 2 is unaffected: nothing is
 * read back.
 *
 * ROWS are written with composited `transform` / `clip-path` only: dozens animate at
 * once, and a `height` write on a row could feed back into the measured height model.
 * The decorative tool-run FRAMES are the one deliberate exception — they animate `top`
 * and `height`, because `scaleY` on a box whose visible substance is a 1px border
 * smears that border and its radius. A frame is absolutely positioned, pointer-events
 * -none decoration with no in-flow siblings and no measured height, so animating its
 * layout properties cannot reflow or perturb anything (see `FoldFrameMotion`).
 *
 * Two hard requirements shaped the design:
 *
 *  - **The animation must never be able to leave a residue.** Every animation runs
 *    with `fill: "none"` and no final keyframe worth retaining, so if it is
 *    cancelled mid-flight (the reader toggles again, scrolls the row out, switches
 *    narrator) the node instantly reads its committed style. There is no cleanup
 *    that can be missed.
 *  - **A row leaving the window must not keep an animation alive.** The controller
 *    owns every handle it started and cancels them on the next play or on teardown,
 *    so a fold followed by a scroll cannot accumulate animations on detached nodes.
 */

import {
	FOLD_DURATION_MS,
	type FoldFrameMotion,
	type FoldRowGeometry,
	type FoldRowMotion,
} from "./vlist-fold-animation";

/**
 * Easing for both motions. `ease` is what Mantine `<Collapse>` uses by default, so
 * a folded card in the exact list and one in the chunked list decelerate alike.
 */
const FOLD_EASING = "ease";

/** The subset of Element this module needs; keeps it testable without a real DOM. */
export interface FoldMotionTarget {
	animate?: (
		keyframes: Keyframe[],
		options: KeyframeAnimationOptions,
	) => { cancel: () => void } | undefined;
}

/** A running fold animation. */
export interface FoldMotionHandle {
	cancel: () => void;
}

/** Resolve a row key to its currently mounted node (or null when it is not mounted). */
export type FoldMotionNodeResolver = (key: string) => FoldMotionTarget | null | undefined;

/**
 * Keyframes for a row that only MOVED: start displaced by the offset it used to be
 * at, settle at its committed position.
 *
 * `translate` (not `top`): a transform is composited, so a fold that shifts thirty
 * mounted rows costs no layout work per frame. It also composes with nothing else
 * the rows use, so there is no inline transform to preserve.
 */
function shiftKeyframes(fromOffset: number): Keyframe[] {
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
 * Because the row's own box already has its final height, the rows below it are
 * correct throughout, which is what lets their `translateY` and this clip compose
 * into one coherent movement.
 */
function revealKeyframes(fromInsetBottom: number): Keyframe[] {
	return [
		{ offset: 0, clipPath: `inset(0px 0px ${fromInsetBottom}px 0px)` },
		{ offset: 1, clipPath: "inset(0px 0px 0px 0px)" },
	];
}

/**
 * Keyframes for a decorative TOOL-RUN FRAME: travel from the box the reader last saw
 * to the box the layout just committed.
 *
 * The only place in this module that animates LAYOUT properties, and the only place
 * where that is the correct choice — see `FoldFrameMotion` for the full reasoning
 * (`scaleY` would smear the 1px border and its radius; the frame is absolutely
 * positioned decoration with no in-flow siblings and no measured height to perturb).
 *
 * The final keyframe restates the COMMITTED geometry, so together with `fill: "none"`
 * a cancelled frame animation lands exactly where React already put the element.
 */
function frameKeyframes(motion: FoldFrameMotion): Keyframe[] {
	return [
		{ offset: 0, top: `${motion.from.top}px`, height: `${motion.from.height}px` },
		{ offset: 1, top: `${motion.to.top}px`, height: `${motion.to.height}px` },
	];
}

/**
 * Start one row animation, returning its handle or null when the environment has no
 * Web Animations support (older WebViews, the linkedom test DOM) — in which case
 * the fold still works and only the transition is skipped. Never throws.
 */
export function playFoldMotion(
	node: FoldMotionTarget | null | undefined,
	motion: FoldRowMotion,
	durationMs: number = FOLD_DURATION_MS,
): FoldMotionHandle | null {
	if (!node || typeof node.animate !== "function") return null;
	const keyframes =
		motion.kind === "shift"
			? shiftKeyframes(motion.fromOffset)
			: revealKeyframes(motion.fromInsetBottom);
	return startAnimation(node, keyframes, durationMs);
}

/**
 * Start one decorative FRAME animation. Same degradation contract as
 * `playFoldMotion`: null when there is no node or no WAAPI, never throws, so a
 * frame that cannot animate simply appears at its committed box.
 */
export function playFoldFrameMotion(
	node: FoldMotionTarget | null | undefined,
	motion: FoldFrameMotion,
	durationMs: number = FOLD_DURATION_MS,
): FoldMotionHandle | null {
	if (!node || typeof node.animate !== "function") return null;
	return startAnimation(node, frameKeyframes(motion), durationMs);
}

/** The single WAAPI call both players share, so their options cannot drift apart. */
function startAnimation(
	node: FoldMotionTarget,
	keyframes: Keyframe[],
	durationMs: number,
): FoldMotionHandle | null {
	if (typeof node.animate !== "function") return null;
	try {
		const animation = node.animate(keyframes, {
			duration: durationMs,
			easing: FOLD_EASING,
			// No fill: the committed style is the truth the moment the animation ends
			// or is cancelled, so an interrupted fold can never leave a stale transform
			// or a clip that hides half a card.
			fill: "none",
		});
		return animation ? { cancel: () => animation.cancel() } : null;
	} catch {
		return null;
	}
}

/**
 * A one-fold-at-a-time controller.
 *
 * A second toggle while the first is still playing cancels every handle from the
 * first: those rows snap to their committed style (correct by construction) and
 * immediately start the new transition from the geometry they are actually at. The
 * alternative — letting both run — would have two animations writing the same
 * `transform` on one node, with the later one winning at an arbitrary offset.
 *
 * Rows and decorative frames are played through the SAME controller call, because they
 * are two halves of one visual event: a border that keeps animating after its contents
 * were cancelled (or vice versa) is exactly the detachment this transition exists to
 * remove. One `play` means one cancel boundary for both.
 */
export function createFoldMotionController(): {
	play: (
		motions: readonly FoldRowMotion[],
		resolveNode: FoldMotionNodeResolver,
		durationMs?: number,
		frames?: readonly FoldFrameMotion[],
		resolveFrameNode?: FoldMotionNodeResolver,
	) => void;
	cancel: () => void;
} {
	let active: FoldMotionHandle[] = [];
	const cancel = () => {
		for (const handle of active) handle.cancel();
		active = [];
	};
	return {
		play: (motions, resolveNode, durationMs, frames, resolveFrameNode) => {
			cancel();
			const started: FoldMotionHandle[] = [];
			for (const motion of motions) {
				const handle = playFoldMotion(resolveNode(motion.key), motion, durationMs);
				if (handle) started.push(handle);
			}
			if (frames && resolveFrameNode) {
				for (const frame of frames) {
					const handle = playFoldFrameMotion(resolveFrameNode(frame.key), frame, durationMs);
					if (handle) started.push(handle);
				}
			}
			active = started;
		},
		cancel,
	};
}

/**
 * True when the environment asks for reduced motion, in which case the fold is
 * applied instantly (the committed geometry, no transition).
 *
 * Read at play time rather than cached: the OS setting can change mid-session and
 * this is one `matchMedia` call per toggle, not per frame. Falls back to `false`
 * where `matchMedia` is unavailable so a test DOM behaves like a normal browser.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
	} catch {
		return false;
	}
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
