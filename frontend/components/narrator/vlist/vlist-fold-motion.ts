/**
 * vlist-fold-motion.ts — Plays the fold transition planned by
 * `vlist-fold-animation.ts` onto real row nodes.
 *
 * Split from the planner on purpose: the arithmetic is pure and unit-tested, this
 * file is the thin DOM/WAAPI edge. It lives in the shell layer (like
 * `vlist-highlight.ts`), NOT on the measure path — every write here is a
 * composited `transform` / `clip-path` on a row that has ALREADY been committed at
 * its final geometry, so no measured height, cached measurement or layout index is
 * touched. CONTRACT §0 rule 2 is unaffected: nothing is read back.
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

import { FOLD_DURATION_MS, type FoldRowGeometry, type FoldRowMotion } from "./vlist-fold-animation";

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
 */
export function createFoldMotionController(): {
	play: (
		motions: readonly FoldRowMotion[],
		resolveNode: FoldMotionNodeResolver,
		durationMs?: number,
	) => void;
	cancel: () => void;
} {
	let active: FoldMotionHandle[] = [];
	const cancel = () => {
		for (const handle of active) handle.cancel();
		active = [];
	};
	return {
		play: (motions, resolveNode, durationMs) => {
			cancel();
			const started: FoldMotionHandle[] = [];
			for (const motion of motions) {
				const handle = playFoldMotion(resolveNode(motion.key), motion, durationMs);
				if (handle) started.push(handle);
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
