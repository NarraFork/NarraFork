/**
 * vlist-smooth-follow.ts — Smooth bottom-follow ("chase") for the exact message list.
 *
 * ## The problem
 *
 * While pinned to the bottom, every streaming growth (a new text line, a new tool
 * call row, a tool card settling its real height) used to write `scrollTop` to the
 * new bottom INSTANTLY. Relative to the viewport, every committed row above jumped
 * up by the growth delta in a single frame — jarring to read.
 *
 * ## The approach
 *
 * An rAF-driven chase eases `scrollTop` towards the LIVE bottom target
 * (exponential approach with a velocity cap). The frame a growth commits paints at
 * the old position — nothing jumps — and the view then glides to catch up, revealing
 * the new content from the bottom. The target is re-read every frame, so a moving
 * target (continuous streaming) needs no animation restarts and has no velocity
 * discontinuities.
 *
 * ## The gate (one arithmetic rule separates every scenario)
 *
 *   delta = bottomTarget - currentScrollTop
 *   chase  ⟺  0 < delta <= chaseMaxDelta(viewportHeight)  and not reduced-motion
 *
 * Streaming growth is tens-to-hundreds of px → chase. Initial load, narrator
 * switch, reload and prepend re-pin are thousands of px → snap (those mean "keep
 * the tail in view", not "new content arrived"). delta <= 0 (the document shrank
 * under the pin — a rollback) → snap. Reduced motion → snap (today's exact
 * behaviour for everyone who asked the OS for it).
 *
 * The gate is necessary but NOT sufficient on its own: fold/LOD rebuilds can also
 * produce small bottom deltas, and those transitions carry their own FLIP
 * animations whose geometry must stay fixed. Those paths either snap the chase
 * before capturing (fold toggle, LOD step) or never stamp the correction smooth
 * (see `scrollTopSmoothFollow` on the coordinator snapshot — only tail-growth
 * commits do). This module stays pure arithmetic + a thin rAF edge; the shell owns
 * those policies.
 *
 * Split: the step/gate functions are pure and unit-tested; the controller is the
 * thin DOM/rAF edge, same layering as vlist-fold-animation / vlist-motion-scheduler.
 * CONTRACT §0 rule 2 is unaffected: the chase WRITES scrollTop like any user
 * scroll and never reads back measured heights.
 */

import { prefersReducedMotion } from "./vlist-motion-scheduler";

/** Time constant of the exponential approach. Smaller = snappier glide. */
export const SMOOTH_FOLLOW_TAU_MS = 100;
/** Velocity cap so a large landing glides fast without blurring past. */
export const SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS = 4;
/**
 * Remaining distance at which the chase writes the exact target and stops.
 *
 * ## Why this is 3px and not "as small as possible"
 *
 * An exponential approach has an infinitely long tail, so the epsilon is what
 * decides when to stop caring — and stopping LATE is what the reader perceives as
 * the glide dragging on. Two effects compound at the end of every glide:
 *
 *  - Sub-pixel steps do not move the rendered position at all (device-pixel
 *    snapping), so they are pure delay. `SMOOTH_FOLLOW_MIN_STEP_PX` removes those.
 *  - What is left after the floor kicks in is a run of 1px/frame frames. Measured
 *    over a real 20px growth that was 6 frames (~100ms) of motion nobody can see,
 *    tacked onto a 130ms glide.
 *
 * 3px cuts that run to at most two frames. It is safe because the shell already
 * treats anything within `BOTTOM_DISTANCE_EPSILON` (1px) as "at the bottom" and the
 * final write is the EXACT target — the epsilon only decides when to jump the last
 * couple of pixels, and a ≤3px jump at the end of a decelerating glide is below the
 * threshold of noticing (which is precisely why creeping through it is not worth
 * 100ms).
 */
export const SMOOTH_FOLLOW_SETTLE_EPSILON_PX = 3;
/**
 * Floor on the per-frame step. THE STUTTER FIX.
 *
 * A pure exponential approach shrinks its step in proportion to the remaining
 * distance: at TAU=100ms and 60Hz each frame covers ~15% of what is left, so a 3px
 * residual advances 0.46px, then 0.39px, then 0.33px… Sub-pixel writes do not move
 * the rendered position — the compositor snaps to device pixels — so the picture
 * sits still for several frames and then lurches a whole pixel. That reads as
 * juddering right at the end of every glide, which is the most visible part of it.
 *
 * Below this floor the step is raised to it, so the tail is traversed at a constant
 * (small) speed instead of stalling. The floor cannot overshoot: the step is always
 * clamped to the remaining distance.
 *
 * 1px/frame at 60Hz is the slowest motion a display can actually show. The floor
 * alone is not enough — see the settle epsilon for why the 1px run is also cut short.
 */
export const SMOOTH_FOLLOW_MIN_STEP_PX = 1;
/** chaseMaxDelta = clamp(viewportHeight * FACTOR, MIN, MAX). */
export const SMOOTH_FOLLOW_DELTA_VIEWPORT_FACTOR = 1.5;
export const SMOOTH_FOLLOW_DELTA_MIN_PX = 480;
export const SMOOTH_FOLLOW_DELTA_MAX_PX = 2000;

/**
 * The largest growth delta that may still glide. Anything bigger snaps: it is a
 * load/switch/prepend (the reader never watched that content arrive) or a landing
 * so big that gliding would read as a scroll, not a settle.
 */
export function smoothFollowMaxDelta(viewportHeight: number): number {
	const vh = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
	return Math.min(
		Math.max(vh * SMOOTH_FOLLOW_DELTA_VIEWPORT_FACTOR, SMOOTH_FOLLOW_DELTA_MIN_PX),
		SMOOTH_FOLLOW_DELTA_MAX_PX,
	);
}

/**
 * Whether a bottom-follow write from `current` to `target` should glide rather
 * than snap. Pure; the ONLY inputs are the live DOM readings and the motion
 * preference, so every caller (correction, pin effect, re-glue) agrees.
 */
export function shouldSmoothFollow(input: {
	current: number;
	target: number;
	viewportHeight: number;
	reducedMotion: boolean;
}): boolean {
	if (input.reducedMotion) return false;
	const delta = input.target - input.current;
	if (delta <= 0) return false;
	return delta <= smoothFollowMaxDelta(input.viewportHeight);
}

export interface SmoothFollowStep {
	next: number;
	/** True when the chase is close enough to write the exact target and stop. */
	settled: boolean;
}

/**
 * One chase step: exponential approach towards `target`, with a velocity cap above
 * and a step FLOOR below.
 *
 * `next = target - (target - current) * e^(-dt/τ)`, then clamped into
 * `[minStep, maxVelocity * dt]` and finally to the remaining distance.
 *
 * Properties, all of which the tests pin:
 * - **Monotonic, never overshoots.** The exponential factor is in (0,1), the cap
 *   only shrinks the step, and the floor is itself clamped to `delta`.
 * - **dt-aware** where it matters: the exponential term and the cap both scale with
 *   `dt`, so 60Hz and 120Hz follow the same curve for the bulk of the travel. The
 *   FLOOR is per-frame by design (it exists to beat device-pixel quantisation,
 *   which is per-frame too), so the last pixel or two is frame-rate dependent —
 *   that is the point, not a defect.
 * - **Self-terminating** at the settle epsilon.
 */
export function resolveSmoothFollowStep(input: {
	current: number;
	target: number;
	dtMs: number;
	tauMs?: number;
	maxVelocityPxPerMs?: number;
	settleEpsilonPx?: number;
	minStepPx?: number;
}): SmoothFollowStep {
	const tau = input.tauMs ?? SMOOTH_FOLLOW_TAU_MS;
	const maxVelocity = input.maxVelocityPxPerMs ?? SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS;
	const epsilon = input.settleEpsilonPx ?? SMOOTH_FOLLOW_SETTLE_EPSILON_PX;
	const minStep = input.minStepPx ?? SMOOTH_FOLLOW_MIN_STEP_PX;
	const { current, target } = input;
	const delta = target - current;
	if (delta <= epsilon) return { next: target, settled: true };
	const dt = Math.max(0, input.dtMs);
	// A zero-length frame must not move: the floor below would otherwise teleport a
	// pixel for no elapsed time (and break the dt-equivalence of two half-frames).
	if (dt === 0) return { next: current, settled: false };
	let step = delta * (1 - Math.exp(-dt / tau));
	const cap = maxVelocity * dt;
	if (step > cap) step = cap;
	// The floor: below ~1px/frame the write does not change the RENDERED position
	// (device-pixel snapping), so the exponential tail shows as several still frames
	// followed by a 1px lurch. Never allowed past the remaining distance, so this
	// cannot overshoot — and when it consumes the remainder the next branch settles.
	if (step < minStep) step = Math.min(minStep, delta);
	const next = current + step;
	if (target - next <= epsilon) return { next: target, settled: true };
	return { next, settled: false };
}

/**
 * What the shell provides. `writeInstant` is the full bookkeeping write (advances
 * React scroll state); `writeChase` is the light per-frame write (DOM + refs only
 * — the scroll event it generates advances state through the normal
 * window-change gate, so chasing does not re-render the shell every frame).
 */
export interface SmoothFollowerDeps {
	readCurrent: () => number;
	readTarget: () => number;
	getViewportHeight: () => number;
	writeInstant: (value: number) => void;
	writeChase: (value: number) => void;
	isReducedMotion?: () => boolean;
	raf?: (callback: (time: number) => void) => number;
	cancelRaf?: (handle: number) => void;
	now?: () => number;
}

export interface SmoothFollower {
	/**
	 * Follow the bottom: glide when the gate passes, write instantly otherwise.
	 * Idempotent while a chase is running (the loop re-reads the live target), and
	 * snaps instantly when the gate fails mid-chase (a huge landing must not drag a
	 * long tail of animation behind it).
	 */
	ensure: () => void;
	/** Stop without writing (reader intent, unpin, unmount). */
	cancel: () => void;
	/** Stop and land exactly on the target. No-op when no chase is running. */
	snapToTarget: () => void;
	isActive: () => boolean;
}

export function createSmoothFollower(deps: SmoothFollowerDeps): SmoothFollower {
	const raf = deps.raf ?? ((callback: (time: number) => void) => requestAnimationFrame(callback));
	const cancelRaf = deps.cancelRaf ?? ((handle: number) => cancelAnimationFrame(handle));
	const now = deps.now ?? (() => performance.now());
	const isReducedMotion = deps.isReducedMotion ?? prefersReducedMotion;

	let active = false;
	let rafHandle = 0;
	let lastTime = 0;

	const stop = () => {
		if (rafHandle !== 0) cancelRaf(rafHandle);
		rafHandle = 0;
		active = false;
	};

	const tick = (time: number) => {
		rafHandle = 0;
		if (!active) return;
		const current = deps.readCurrent();
		const target = deps.readTarget();
		// The bottom moved ABOVE us (rollback shrank the document) or ran away past
		// the glide bound (a giant landing mid-chase): neither glides, land now.
		if (target <= current || target - current > smoothFollowMaxDelta(deps.getViewportHeight())) {
			stop();
			deps.writeInstant(target);
			return;
		}
		const dt = Math.max(0, time - lastTime);
		lastTime = time;
		const step = resolveSmoothFollowStep({ current, target, dtMs: dt });
		if (step.settled) {
			stop();
			// The exact landing uses the FULL write so React scroll state converges to
			// the true position even when the last frames stayed inside one window.
			deps.writeInstant(target);
			return;
		}
		deps.writeChase(step.next);
		rafHandle = raf(tick);
	};

	return {
		ensure() {
			const current = deps.readCurrent();
			const target = deps.readTarget();
			if (
				!shouldSmoothFollow({
					current,
					target,
					viewportHeight: deps.getViewportHeight(),
					reducedMotion: isReducedMotion(),
				})
			) {
				stop();
				// Gate failed: this is a snap case (load / switch / prepend / shrink /
				// reduced motion). Write exactly what the pre-chase code wrote.
				if (target !== current) deps.writeInstant(target);
				return;
			}
			if (active) return;
			active = true;
			lastTime = now();
			rafHandle = raf(tick);
		},
		cancel: stop,
		snapToTarget() {
			if (!active) return;
			stop();
			const target = deps.readTarget();
			if (target !== deps.readCurrent()) deps.writeInstant(target);
		},
		isActive: () => active,
	};
}
