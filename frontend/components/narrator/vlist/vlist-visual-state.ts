/**
 * vlist-visual-state.ts — The single source of truth for where a morphing element
 * VISUALLY is, decoupled from where the document says it is.
 *
 * ## Why this exists
 *
 * The keyframe-based morph it replaces planned "an animation from A to B", and that model
 * has one fatal assumption: that the animation gets to finish. It does not. LOD steps are
 * throttled at 140ms (`LOD_STEP_THROTTLE_MS`) while the morph runs 250ms, so a held gesture
 * spends ~44% of its time replacing a motion that is still in flight — interruption is the
 * NORMAL case, not an edge case.
 *
 * Worse, the replacement was planned from the previous COMMITTED snapshot. Because every
 * animation ran `fill: "none"`, cancelling one snapped its node back to the committed style,
 * so the element's true visual position was neither the old snapshot nor the new one. Across
 * three quick steps the planned start was off by 300px, then 127px, then 97px — a visible
 * jump at every step, and no amount of progress-sampling could fix it because the SNAPSHOT
 * was the wrong reference, not the sample.
 *
 * So this module keeps the visual state itself. A new target never needs a start: the state
 * already knows where the element is, and simply converges toward whatever the target
 * becomes. Reversing direction mid-flight is not a special case — it is a target change.
 *
 * ## Convergence, not duration
 *
 * Each frame moves a fraction of the REMAINING distance:
 *
 *     next = current + (target − current) · (1 − e^(−dt/τ))
 *
 * This is the same exponential approach `vlist-smooth-follow.ts` already uses for scroll
 * following, deliberately: one convergence convention in this codebase, not two. The
 * difference is that this one is BIDIRECTIONAL (a morph's delta has no privileged sign,
 * where a scroll-follow only ever chases downward), so the step, the cap and the floor all
 * work on magnitude and re-apply the sign.
 *
 * There is no "animation end", which is the point. There is only "close enough for long
 * enough", after which the driver stops writing and the committed style becomes the truth
 * again.
 *
 * Pure and DOM-free: everything here is arithmetic on plain numbers so it can be unit
 * tested without a layout engine. The DOM writes live in `vlist-morph-driver.ts`.
 */

/**
 * Time constant of the approach, in ms. Smaller is snappier.
 *
 * 90ms puts ~95% of the distance behind us in 3τ ≈ 270ms, which reads close to the 250ms
 * eased motion this replaces while starting faster and settling softer. Tunable range
 * 60–140ms; below ~60 the motion reads as a snap, above ~140 a held gesture visibly lags
 * the content.
 *
 * ⚠️ This cannot be validated by tests — it is a matter of feel and has to be judged in a
 * real browser. The tests pin the SHAPE of the curve (monotonic, sign-correct, settles),
 * never how pleasant it is.
 */
export const MORPH_TAU_MS = 90;

/**
 * Distance below which a translation is considered arrived, in px.
 *
 * An exponential approach has an infinitely long tail, so something has to declare the end.
 * Half a pixel is under one device pixel at 1× and well under at 2×, so the remaining error
 * cannot be seen — and the driver writes the EXACT target on settle, so the epsilon only
 * decides WHEN to stop, never what the final value is.
 */
export const MORPH_SETTLE_EPSILON_PX = 0.5;

/**
 * Same idea for the unit-interval channels (opacity, cardness).
 *
 * 1/255 ≈ 0.004 is the smallest difference an 8-bit channel can represent, so a residue
 * below it cannot survive rasterisation.
 */
export const MORPH_SETTLE_EPSILON_UNIT = 0.004;

/**
 * Frames the state must stay within epsilon before it is declared settled.
 *
 * One frame is not enough: a target that is being updated every 140ms can momentarily
 * coincide with the current value between two steps, and settling there would stop the
 * driver in the middle of a gesture — the motion would freeze and then jump on the next
 * step. Two consecutive frames is the cheapest guard that cannot be hit by a single
 * coincidence.
 */
export const MORPH_SETTLE_FRAMES = 2;

/**
 * Largest speed a translation may travel, in px/ms.
 *
 * A level switch can move content thousands of pixels (a card stack collapsing into rows).
 * Without a cap the first frame of such a morph covers most of that distance, which is a
 * teleport with extra steps. 4px/ms ≈ 240px per 60Hz frame: fast enough to feel immediate,
 * slow enough to read as travel. Mirrors `SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS`.
 */
export const MORPH_MAX_VELOCITY_PX_PER_MS = 4;

/**
 * Smallest translation step, in px/frame, once moving.
 *
 * Below ~1px per frame a write does not change the RENDERED position (device-pixel
 * snapping), so the exponential tail degenerates into several identical frames followed by a
 * 1px lurch. Never applied past the remaining distance, so it cannot overshoot. Copied in
 * spirit from `SMOOTH_FOLLOW_MIN_STEP_PX` for the same reason.
 */
export const MORPH_MIN_STEP_PX = 0.75;

/** Hard ceiling on retained states, so a long session cannot grow this map without bound. */
export const MORPH_STATE_MAX_ENTRIES = 200;

/** One element's visual state. All values are RELATIVE to its committed position/style. */
export interface VisualState {
	/**
	 * Visual offset from the element's committed position, in DOCUMENT px.
	 *
	 * ⚠️ Document px, NOT viewport px, and that is load-bearing. An LOD switch changes the
	 * document's height drastically and `scrollTop` can be corrected in the same frame; an
	 * offset expressed in viewport space would then drift by the scroll correction and the
	 * element would land in the wrong place. An offset relative to the element's own layout
	 * box is invariant under scrolling, and it is also exactly what a `transform` write
	 * means, so no conversion is needed at the boundary.
	 */
	x: number;
	y: number;
	/** Visual opacity, 0..1. */
	opacity: number;
	/**
	 * How much this element is currently in its CARD form, 0..1.
	 *
	 * One parameter for every feature that exists in only one of the two forms — the border,
	 * the right-edge tail cluster — replacing the separate, mutually-constraining fades the
	 * keyframe implementation needed. The renderer maps it; this module only converges it.
	 */
	cardness: number;
	/**
	 * Bottom inset of a `clip-path`, in px. Absent unless the element is being REVEALED.
	 *
	 * A fold expands by un-clipping a box that is already at its final height, rather than by
	 * growing it: the exact layout has committed the final geometry, and growing the box would
	 * fight it. Optional because only the toggled row reveals — carrying it on every element
	 * would allocate a channel the other thousand rows never use.
	 */
	insetBottom?: number;
	/**
	 * Animated box, in px. Absent unless the element is one of the two documented cases that
	 * must animate LAYOUT rather than a transform:
	 *
	 *  - the decorative fold FRAME, because `scaleY` on a box whose visible substance is a 1px
	 *    border smears that border and its radius;
	 *  - a nested block that is CLOSING around a retained card, because its siblings are glued
	 *    to its bottom edge and must travel exactly the height it loses.
	 *
	 * Both are documented exemptions in `vlist-fold-motion.ts`; everything else uses
	 * `x`/`y`/`opacity` so it stays composited.
	 */
	boxTop?: number;
	boxHeight?: number;
}

/** The values a state is converging toward. Same units and meanings as {@link VisualState}. */
export type VisualTarget = VisualState;

/** A retained state plus the bookkeeping the store needs to converge and reclaim it. */
interface Entry {
	state: VisualState;
	target: VisualTarget;
	/** Consecutive frames within epsilon on every channel. */
	settledFrames: number;
	/** Frame ordinal of the last update, for LRU eviction. */
	touchedAt: number;
	/** False once the element is no longer in the admitted set (may still be settling). */
	live: boolean;
}

/** Identity → state. Keyed on `unitId`, which is LOD-invariant and DOM-independent. */
export interface VisualStateStore {
	/**
	 * Point an element at a new target, creating its state if new.
	 *
	 * A NEW element starts AT its target (offset 0, fully faded in): with nothing on screen
	 * to continue from, converging from an arbitrary start would be an animation the reader
	 * cannot interpret. Only an element that already has a state animates.
	 */
	setTarget(unitId: string, target: VisualTarget): void;
	/**
	 * Place an element AT `state` right now, then converge it toward `target`.
	 *
	 * This is how a switch starts a morph: the element has already been laid out at its new
	 * position, so it is displaced back to where it was and travels home.
	 *
	 * ⚠️ Separate from {@link setTarget} because that one deliberately never moves an existing
	 * element — it only retargets, which is what makes an interruption continuous. Seeding a
	 * displacement through `setTarget` therefore silently did nothing for any element the store
	 * already held, i.e. for every switch after the first: the target was updated, the state
	 * stayed at rest, and the element teleported with no animation at all.
	 */
	startFrom(unitId: string, state: VisualState, target: VisualTarget): void;
	/** Read a state, or null when the element has none. */
	get(unitId: string): VisualState | null;
	/** Advance every live state by `dtMs`. Returns true while any state is still moving. */
	step(dtMs: number): boolean;
	/** Mark which identities are still admitted; the rest become reclaimable once settled. */
	retain(admitted: ReadonlySet<string>): void;
	/** Drop settled, unadmitted entries and enforce the hard ceiling. Returns entries freed. */
	sweep(): number;
	/**
	 * Whether this element is still MOVING, i.e. not yet settled at its target.
	 *
	 * ⚠️ This, not `get() !== null`, is what decides whether a new switch may apply a fresh
	 * displacement. The distinction is the difference between a working morph and none at all:
	 *
	 *   - moving  → keep the current visual position and only retarget, so the motion
	 *               continues from where it is (the interruption property);
	 *   - settled → the element sits exactly at its target, so a new switch MUST seed the new
	 *               displacement or there is nothing left to animate.
	 *
	 * Using mere existence for this made every switch after the FIRST one silent: the entry
	 * was still retained, so the displacement was never applied and the element teleported.
	 * It also explains why interrupting repeatedly seemed to help — an interrupted element is
	 * still moving, so it took the correct branch by accident.
	 */
	isMoving(unitId: string): boolean;
	/** Entries currently retained (tests and diagnostics). */
	size(): number;
	/** True when no state needs another frame. */
	isIdle(): boolean;
}

/** The identity target: no offset, fully opaque, in whichever form the level commits to. */
export function restingTarget(cardness: number): VisualTarget {
	return { x: 0, y: 0, opacity: 1, cardness };
}

/**
 * One channel's convergence step, on MAGNITUDE with the sign re-applied.
 *
 * Exported for its own tests: the cap and the floor interact (a capped step must still
 * respect the floor's "never past the remainder" rule), and that is easier to pin directly
 * than through a whole store.
 */
export function convergeChannel(
	current: number,
	target: number,
	dtMs: number,
	opts: { tau?: number; epsilon?: number; maxVelocity?: number; minStep?: number } = {},
): { next: number; arrived: boolean } {
	const tau = opts.tau ?? MORPH_TAU_MS;
	const epsilon = opts.epsilon ?? MORPH_SETTLE_EPSILON_PX;
	const delta = target - current;
	const distance = Math.abs(delta);
	// Arrived: snap to the exact target so the final value is never an epsilon-sized lie.
	if (distance <= epsilon) return { next: target, arrived: true };
	// A zero-length frame must not move. Without this the floor below would teleport a
	// fraction of a pixel for no elapsed time, and two half-frames would not equal one
	// whole one.
	if (dtMs <= 0) return { next: current, arrived: false };
	const sign = delta < 0 ? -1 : 1;
	let step = distance * (1 - Math.exp(-dtMs / tau));
	const maxVelocity = opts.maxVelocity;
	if (maxVelocity !== undefined) {
		const cap = maxVelocity * dtMs;
		if (step > cap) step = cap;
	}
	const minStep = opts.minStep;
	if (minStep !== undefined && step < minStep) step = minStep;
	// Never past the target: both the floor and a large dt could otherwise overshoot, which
	// on a reversing morph would read as a bounce.
	if (step >= distance) return { next: target, arrived: true };
	return { next: current + sign * step, arrived: false };
}

/** Create an empty store. */
export function createVisualStateStore(): VisualStateStore {
	const entries = new Map<string, Entry>();
	let frame = 0;

	/**
	 * Optional channels, listed once so `withinEpsilon` and `step` cannot disagree about
	 * which of them exist — a channel converged but not settle-checked would keep the loop
	 * running forever; one settle-checked but not converged would freeze mid-animation.
	 */
	const PX_CHANNELS = ["insetBottom", "boxTop", "boxHeight"] as const;

	const withinEpsilon = (e: Entry): boolean => {
		if (Math.abs(e.target.x - e.state.x) > MORPH_SETTLE_EPSILON_PX) return false;
		if (Math.abs(e.target.y - e.state.y) > MORPH_SETTLE_EPSILON_PX) return false;
		if (Math.abs(e.target.opacity - e.state.opacity) > MORPH_SETTLE_EPSILON_UNIT) return false;
		if (Math.abs(e.target.cardness - e.state.cardness) > MORPH_SETTLE_EPSILON_UNIT) return false;
		for (const key of PX_CHANNELS) {
			const target = e.target[key];
			// An absent target means this element does not use the channel at all, so there is
			// nothing to settle — NOT that it should converge to zero.
			if (target === undefined) continue;
			const current = e.state[key] ?? target;
			if (Math.abs(target - current) > MORPH_SETTLE_EPSILON_PX) return false;
		}
		return true;
	};

	return {
		setTarget(unitId, target) {
			const existing = entries.get(unitId);
			if (existing) {
				existing.target = target;
				// A new target restarts the settle count: the element is moving again, and a
				// stale count could let it be declared settled on its first frame.
				existing.settledFrames = 0;
				existing.touchedAt = frame;
				existing.live = true;
				return;
			}
			entries.set(unitId, {
				// Starts AT the target: an element with no prior state has nothing on screen to
				// travel from (see `setTarget`'s contract).
				state: { ...target },
				target,
				settledFrames: MORPH_SETTLE_FRAMES,
				touchedAt: frame,
				live: true,
			});
		},

		startFrom(unitId, state, target) {
			const existing = entries.get(unitId);
			if (existing) {
				// Overwrite the VISUAL state, which `setTarget` intentionally never does.
				existing.state = { ...state };
				existing.target = target;
				existing.settledFrames = 0;
				existing.touchedAt = frame;
				existing.live = true;
				return;
			}
			entries.set(unitId, {
				state: { ...state },
				target,
				settledFrames: 0,
				touchedAt: frame,
				live: true,
			});
		},

		get(unitId) {
			return entries.get(unitId)?.state ?? null;
		},

		step(dtMs) {
			frame++;
			let moving = false;
			for (const entry of entries.values()) {
				if (withinEpsilon(entry)) {
					// Hold the target exactly while settling, so a settled element is pixel-identical
					// to its committed style rather than epsilon away from it.
					entry.state.x = entry.target.x;
					entry.state.y = entry.target.y;
					entry.state.opacity = entry.target.opacity;
					entry.state.cardness = entry.target.cardness;
					for (const key of PX_CHANNELS) {
						if (entry.target[key] !== undefined) entry.state[key] = entry.target[key];
					}
					if (entry.settledFrames < MORPH_SETTLE_FRAMES) {
						entry.settledFrames++;
						// Still counting down: this frame must be written, so the store is not idle.
						moving = true;
					}
					continue;
				}
				entry.settledFrames = 0;
				entry.touchedAt = frame;
				entry.state.x = convergeChannel(entry.state.x, entry.target.x, dtMs, {
					maxVelocity: MORPH_MAX_VELOCITY_PX_PER_MS,
					minStep: MORPH_MIN_STEP_PX,
				}).next;
				entry.state.y = convergeChannel(entry.state.y, entry.target.y, dtMs, {
					maxVelocity: MORPH_MAX_VELOCITY_PX_PER_MS,
					minStep: MORPH_MIN_STEP_PX,
				}).next;
				entry.state.opacity = convergeChannel(entry.state.opacity, entry.target.opacity, dtMs, {
					epsilon: MORPH_SETTLE_EPSILON_UNIT,
				}).next;
				entry.state.cardness = convergeChannel(entry.state.cardness, entry.target.cardness, dtMs, {
					epsilon: MORPH_SETTLE_EPSILON_UNIT,
				}).next;
				for (const key of PX_CHANNELS) {
					const target = entry.target[key];
					if (target === undefined) continue;
					// First frame for a channel this element only just acquired: start AT the target,
					// so a box does not fly in from the origin merely because the channel appeared.
					const current = entry.state[key] ?? target;
					entry.state[key] = convergeChannel(current, target, dtMs, {
						maxVelocity: MORPH_MAX_VELOCITY_PX_PER_MS,
						minStep: MORPH_MIN_STEP_PX,
					}).next;
				}
				moving = true;
			}
			return moving;
		},

		retain(admitted) {
			for (const [unitId, entry] of entries) entry.live = admitted.has(unitId);
		},

		sweep() {
			let freed = 0;
			for (const [unitId, entry] of entries) {
				// An UNADMITTED entry is kept until it settles: it may be mid-fade-out, and
				// dropping it would freeze that fade at whatever opacity it had reached.
				if (!entry.live && entry.settledFrames >= MORPH_SETTLE_FRAMES) {
					entries.delete(unitId);
					freed++;
				}
			}
			if (entries.size <= MORPH_STATE_MAX_ENTRIES) return freed;
			// Over the ceiling: evict least-recently-touched first. This is a guard against a
			// pathological document, not a normal path — normal churn is handled above.
			const byAge = [...entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
			for (const [unitId] of byAge) {
				if (entries.size <= MORPH_STATE_MAX_ENTRIES) break;
				entries.delete(unitId);
				freed++;
			}
			return freed;
		},

		isMoving(unitId) {
			const entry = entries.get(unitId);
			if (!entry) return false;
			// Within epsilon AND done counting = settled. A retarget resets the count, so an
			// element that has just been pointed somewhere new counts as moving even before its
			// first frame — which is what keeps a rapid second switch continuous.
			if (!withinEpsilon(entry)) return true;
			return entry.settledFrames < MORPH_SETTLE_FRAMES;
		},

		size() {
			return entries.size;
		},

		isIdle() {
			for (const entry of entries.values()) {
				if (!withinEpsilon(entry)) return false;
				if (entry.settledFrames < MORPH_SETTLE_FRAMES) return false;
			}
			return true;
		},
	};
}
