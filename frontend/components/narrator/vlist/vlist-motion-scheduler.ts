/**
 * vlist-motion-scheduler.ts — The ONE owner of every decorative animation on the
 * exact canvas.
 *
 * ## Why this exists
 *
 * Four things animate this canvas, and before this module each owned its own WAAPI
 * handles, its own cancel boundary and its own duration constant:
 *
 *  - the fold FLIP (rows, via `data-nf-row-key`),
 *  - the fold's decorative tool-run frames (via `data-tool-run-frame`),
 *  - the drill-down header morph (a node INSIDE a trace row),
 *  - the LOD-switch morph (via `data-nf-unit` ?? `data-nf-row-key`).
 *
 * They are not independent events. `onToggleRow` captures a fold AND flips a trace
 * row's drill state in ONE click, so the fold and the drill morph always play in the
 * same frame — on different nodes, so they do not overwrite each other's properties,
 * but with nothing keeping their lifetimes together. A second click could cancel the
 * fold's half (the fold controller cancels everything it started) while leaving the
 * drill half running (that controller only cancels the same `rowUid`), so one visual
 * event came apart into two that ended at different times.
 *
 * The durations had already drifted: 200ms for a fold, 200ms for a drill morph (by
 * reference), 250ms for an LOD switch. That drift is legitimate for the LOD case and
 * an accident everywhere else, and with three modules there was no single place where
 * the distinction could be stated.
 *
 * So the planners stay exactly as they are — `planFoldMotion`, `diffDrillSnapshots`
 * and `diffLodSnapshots` compute different things in different coordinate spaces, and
 * they are the correct part of this system. What is unified is EXECUTION: this module
 * is the only holder of animation handles, the only decider of duration and easing,
 * and the only cancel boundary.
 *
 * ## Scopes, not "all" or "one key"
 *
 * A cancel domain is a string. `row:<key>`, `frame:<key>`, `drill:<traceKey>::<rowKey>`,
 * `lod:<unitId>`. Re-playing a scope cancels that scope's previous animation and
 * nothing else, so stacked activity (several trace rows drilled at once) survives a
 * re-toggle of one of them — the behaviour the per-row drill controller had — while a
 * fold that re-plays a row also takes down that row's frame and drill animations,
 * which no previous controller could express.
 *
 * ## One commit, one frame
 *
 * The fold play effect and the two diff effects are separate layout effects. Each
 * pushes its ops into the CURRENT frame instead of starting them; a third layout
 * effect declared after all of them flushes. Layout effects within one component run
 * in declaration order, which is the same mechanism `vlist-fold-wiring.test.ts`
 * already relies on for the scroll-correction ordering. Flushing once means every
 * `node.animate()` for one visual event is issued in a single synchronous burst, so
 * two halves of one movement cannot start a frame apart.
 *
 * ## What this module deliberately does NOT do
 *
 * It never reads the DOM (no `getBoundingClientRect`, no `getComputedStyle`): all
 * geometry arrives pre-computed from the pure planners. It writes only composited
 * properties on rows, and `top`/`height` on the decorative frames alone — the one
 * documented exception, because `scaleY` on a box whose substance is a 1px border
 * smears that border and its radius (see `FoldFrameMotion`). Every animation runs
 * with `fill: "none"`, so the committed style is the truth the instant an animation
 * ends or is cancelled and there is no cleanup that can be missed.
 */

/** The shared time base for every decorative motion on this canvas. */
export const MOTION_DURATION_MS = 200;

/**
 * The LOD switch's own duration.
 *
 * Longer on purpose, and the ONE legitimate deviation from the shared base: a level
 * switch re-themes the whole document at once, so the eye needs slightly more time to
 * follow content that changed component AND position. Kept here, next to the base, so
 * the two are read together — when this lived in `vlist-lod-morph.ts` there was no
 * place where "these differ, and why" could be stated.
 */
export const LOD_MOTION_DURATION_MS = 250;

/** Easing for every motion. Mantine `<Collapse>`'s default, so folds decelerate alike. */
export const MOTION_EASING = "ease";

/** The subset of Element this module needs; keeps it testable without a real DOM. */
export interface MotionNode {
	animate?: (
		keyframes: Keyframe[],
		options: KeyframeAnimationOptions,
	) => { cancel: () => void } | undefined;
}

/** A running animation. */
export interface MotionHandle {
	cancel: () => void;
}

/**
 * One instruction for one node, within one visual event.
 *
 * `resolve` is a thunk rather than a node because an op is created during a layout
 * effect but may be flushed after other effects have run; resolving late means a row
 * that left the mounted window in between yields null and is skipped, instead of
 * animating a detached node.
 */
export interface MotionOp {
	/** Cancel domain. Re-playing this scope cancels its previous animation only. */
	readonly scope: string;
	readonly resolve: () => MotionNode | null | undefined;
	/**
	 * The keyframes to play, or a builder that receives how far the animation THIS op
	 * replaces had got (null when this scope was idle, or when the environment cannot be
	 * sampled).
	 *
	 * A builder is what makes rapid re-clicking seamless: the outgoing motion is sampled
	 * before it is cancelled, so the incoming one can start from where the element
	 * visually is rather than from the committed geometry `fill: "none"` snaps it to. Ops
	 * that cannot be interrupted mid-visibly (a frame's box, a fade) just pass an array.
	 */
	readonly keyframes: Keyframe[] | ((previous: MotionSample | null) => Keyframe[]);
	/** Overrides the event's duration (the LOD switch uses this). */
	readonly durationMs?: number;
	/**
	 * Hold the final keyframe after the animation ends (`fill: "forwards"`), instead of
	 * letting the node snap back to its committed style.
	 *
	 * ⚠️ Off by default, and it must stay that way for almost everything: `fill: "none"` is
	 * what guarantees an interrupted motion leaves NO residue, so nothing has to be cleaned
	 * up (see the module note).
	 *
	 * The exception is a motion whose node is about to be UNMOUNTED by the same event that
	 * ends it — the collapsing drill-down's card header. Its morph and the block's resize
	 * are both 200ms, so they finish together: with `fill: "none"` the header's transform is
	 * dropped on the final frame and the header snaps back 11px to its un-morphed position
	 * for exactly one frame before React removes it. That is the visible "one frame
	 * dislocated downward" flash. Holding the end state bridges it, and costs nothing here
	 * because the node is gone immediately afterwards.
	 */
	readonly holdEndState?: boolean;
	/**
	 * Called EXACTLY ONCE when this op stops mattering, whichever way that happens:
	 * it finished, it was cancelled by a re-play of its scope, `cancel()` tore
	 * everything down, or it never started (no node, no WAAPI, a throwing resolver).
	 *
	 * This exists for the one motion that is not purely decorative: closing a
	 * drilled-in card animates a box whose CONTENT React would otherwise unmount in
	 * frame one, so the shell keeps that content mounted for the duration and needs a
	 * reliable "now you may drop it" signal. A missed call leaves a card painted
	 * forever; a double call would clear state belonging to the NEXT interaction.
	 *
	 * Runs synchronously and must not throw — the scheduler isolates it so one
	 * callback cannot abort the rest of an event.
	 */
	readonly onDone?: () => void;
}

/**
 * True when the environment asks for reduced motion, in which case callers skip
 * planning entirely and every change applies instantly at its committed geometry.
 *
 * Read at play time rather than cached: the OS setting can change mid-session, and
 * this is one `matchMedia` call per event, not per frame. Falls back to `false` where
 * `matchMedia` is unavailable so a test DOM behaves like a normal browser.
 *
 * Consolidated here from three identical copies (fold / drill / LOD), which the shell
 * imported under three aliases.
 */
export { prefersReducedMotion } from "@frontend/lib/smooth-scroll";

/**
 * Start one animation, or return null when there is no node / no WAAPI support
 * (older WebViews, the linkedom test DOM). Never throws: a motion that cannot play
 * degrades to the committed geometry, which is always correct on its own.
 */
function startAnimation(
	node: MotionNode | null | undefined,
	keyframes: Keyframe[],
	durationMs: number,
	onFinish?: () => void,
	holdEndState?: boolean,
): {
	entry: (done: () => void) => {
		handle: MotionHandle;
		done: () => void;
		sample: () => MotionSample | null;
	};
} | null {
	if (!node || typeof node.animate !== "function") return null;
	try {
		const animation = node.animate(keyframes, {
			duration: durationMs,
			easing: MOTION_EASING,
			// No fill: the committed style is the truth the moment this ends or is
			// cancelled, so an interrupted motion can never leave a stale transform or a
			// clip that hides half a card. The one exception is a node that is about to be
			// unmounted by the same event (see `MotionOp.holdEndState`).
			fill: holdEndState ? "forwards" : "none",
		});
		if (!animation) return null;
		// Natural completion. The scheduler guarantees the callback runs at most once, so
		// a `finish` that lands after a `cancel` is a no-op.
		if (onFinish) {
			const withEvents = animation as { onfinish?: (() => void) | null };
			try {
				withEvents.onfinish = () => onFinish();
			} catch {
				// An environment without the handler still gets the cancel/teardown path.
			}
		}
		return {
			entry: (done: () => void) => ({
				handle: { cancel: () => animation.cancel() },
				done,
				// Sampled by `cancelScope` before it stops this animation, so a replacement
				// can resume from the live position instead of the committed style.
				sample: () => sampleProgress(animation),
			}),
		};
	} catch {
		return null;
	}
}

/**
 * The live value of one animated property, sampled from a RUNNING animation.
 *
 * This is what makes an interruption seamless. Every animation runs `fill: "none"`, so
 * the instant one is cancelled its node reads the COMMITTED style — correct, and exactly
 * what we want for teardown, but wrong for a re-toggle mid-flight: the element would snap
 * to where the previous fold had already put it and then start the new motion from there,
 * which is the jump a reader sees when clicking twice quickly.
 *
 * So before cancelling, the scheduler asks the outgoing animation where it visually IS,
 * and hands that to the incoming plan as its starting point.
 */
export interface MotionSample {
	/** Fraction of the way through the outgoing animation, clamped to 0..1. */
	readonly progress: number;
}

/**
 * Read how far a running animation has got, as a 0..1 fraction.
 *
 * `currentTime` and `effect.getTiming()` are the only inputs, so this works for any
 * property set: the CALLER decides what to do with the fraction (interpolate a transform,
 * a height, a clip). Returns null when the environment does not expose them (the linkedom
 * test DOM, older WebViews), in which case the caller falls back to planning from the
 * committed geometry — the pre-existing behaviour.
 */
function sampleProgress(animation: unknown): MotionSample | null {
	try {
		const anim = animation as {
			currentTime?: number | { value?: number } | null;
			effect?: { getTiming?: () => { duration?: number | string } } | null;
		};
		const raw = anim.currentTime;
		const elapsed =
			typeof raw === "number" ? raw : typeof raw?.value === "number" ? raw.value : null;
		if (elapsed === null || !Number.isFinite(elapsed)) return null;
		const duration = anim.effect?.getTiming?.().duration;
		if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
		const progress = elapsed / duration;
		return { progress: progress < 0 ? 0 : progress > 1 ? 1 : progress };
	} catch {
		return null;
	}
}

/** Wrap a cleanup callback so it can only ever run once. */
function once(fn: (() => void) | undefined): () => void {
	let done = false;
	return () => {
		if (done || !fn) return;
		done = true;
		// A throwing cleanup must not abort an event or leave other scopes uncleaned.
		try {
			fn();
		} catch {
			// Ignored by contract (see MotionOp.onDone).
		}
	};
}

export interface MotionScheduler {
	/**
	 * Open (or join) the current frame's batch. Idempotent within a commit: the
	 * second caller in the same commit joins the batch the first opened.
	 */
	begin: () => void;
	/** Add ops to the open batch. No-op when nothing called `begin` — see `flush`. */
	push: (ops: readonly MotionOp[], durationMs?: number) => void;
	/**
	 * Start every op collected since `begin`, in one synchronous burst, then close
	 * the batch. Cancels each op's scope first, so one visual event replaces the
	 * previous animation on the same scope and leaves every other scope alone.
	 */
	flush: () => void;
	/** Cancel one scope's animation, if any. */
	cancelScope: (scope: string) => void;
	/** Cancel everything. Called on unmount so no animation outlives the list. */
	cancel: () => void;
	/** Test seam: how many scopes are currently animating. */
	activeScopeCount: () => number;
}

/**
 * Create the canvas's motion scheduler.
 *
 * One instance per mounted list, held in a ref (never React state — this is
 * decoration written straight to nodes, and putting it in state would invalidate
 * every row's memo and make a visual concern part of the render that produces the
 * geometry being animated).
 */
export function createMotionScheduler(): MotionScheduler {
	const active = new Map<
		string,
		{ handle: MotionHandle; done: () => void; sample: () => MotionSample | null }
	>();
	/** Ops collected for the frame currently being assembled, or null when closed. */
	let batch: { ops: MotionOp[]; durationMs: number } | null = null;

	/**
	 * Stop a scope, returning how far it had got so a replacement can resume from there.
	 *
	 * The sample is taken BEFORE the cancel, because `fill: "none"` makes the node read
	 * its committed style the instant the animation stops — after that the live position
	 * is gone.
	 */
	const cancelScope = (scope: string): MotionSample | null => {
		const entry = active.get(scope);
		if (!entry) return null;
		const sample = entry.sample();
		entry.handle.cancel();
		active.delete(scope);
		// Cancelling is one of the ways an op stops mattering, so its cleanup is due
		// here too — a card kept mounted for a transition must be released even when a
		// re-toggle interrupts it.
		entry.done();
		return sample;
	};

	return {
		begin: () => {
			// Joining an already-open batch is the normal case: several layout effects
			// contribute to one commit's event.
			if (batch) return;
			batch = { ops: [], durationMs: MOTION_DURATION_MS };
		},
		push: (ops, durationMs) => {
			if (!batch) return;
			// A per-event duration override (the LOD switch). Last writer wins, which is
			// unambiguous in practice: the fold and the LOD morph cannot plan in the same
			// commit (their admission gates are mutually exclusive), and a drill morph
			// riding along with a fold deliberately shares the fold's base.
			if (durationMs !== undefined) batch.durationMs = durationMs;
			for (const op of ops) batch.ops.push(op);
		},
		flush: () => {
			const current = batch;
			batch = null;
			if (!current || current.ops.length === 0) return;
			// Cancel every scope this event touches BEFORE starting any of it, so a
			// re-toggle cannot cancel an animation this same event just started (two ops
			// on one scope within one event would otherwise take each other down).
			// Sampled as each scope is stopped, so an op that REPLACES a running one can
			// start from the position the element visually holds instead of the committed
			// geometry. Keyed by scope; absent means that scope was idle.
			const samples = new Map<string, MotionSample | null>();
			for (const op of current.ops) {
				const sample = cancelScope(op.scope);
				// First writer wins: two ops naming one scope in a single event are one
				// movement, and only the first can have interrupted something.
				if (!samples.has(op.scope)) samples.set(op.scope, sample);
			}
			for (const op of current.ops) {
				// Exactly-once cleanup, shared by every exit path below.
				const done = once(op.onDone);
				// One op must not be able to abort the event. A resolver walks the DOM for
				// a node that may have been torn down since the plan was made, so it can
				// throw; letting that propagate would leave every op after it unplayed —
				// half the rows of one movement animating and half teleporting.
				let node: MotionNode | null | undefined;
				try {
					node = op.resolve();
				} catch {
					// Never started ⇒ nothing will finish it, so release now. Otherwise a
					// card kept mounted for this transition would stay painted forever.
					done();
					continue;
				}
				// Resolve the keyframes, handing a builder the position it is taking over from.
				let keyframes: Keyframe[];
				try {
					keyframes =
						typeof op.keyframes === "function"
							? op.keyframes(samples.get(op.scope) ?? null)
							: op.keyframes;
				} catch {
					done();
					continue;
				}
				const started = startAnimation(
					node,
					keyframes,
					op.durationMs ?? current.durationMs,
					done,
					op.holdEndState,
				);
				if (started) active.set(op.scope, started.entry(done));
				// No node or no WAAPI: the change applies instantly, so release immediately.
				else done();
			}
		},
		cancelScope,
		cancel: () => {
			const entries = [...active.values()];
			active.clear();
			batch = null;
			for (const entry of entries) {
				entry.handle.cancel();
				// Teardown is an exit path like any other: release anything the ops were
				// keeping alive, or a narrator switch mid-transition leaks it.
				entry.done();
			}
		},
		activeScopeCount: () => active.size,
	};
}

/** Scope name for a row's own fold motion. */
export function rowScope(key: string): string {
	return `row:${key}`;
}

/** Scope name for a decorative tool-run frame. */
export function frameScope(key: string): string {
	return `frame:${key}`;
}

/** Scope name for one trace row's drill-down header morph. */
export function drillScope(rowUid: string): string {
	return `drill:${rowUid}`;
}

/** Scope name for one element's LOD-switch morph. */
export function lodScope(unitId: string): string {
	return `lod:${unitId}`;
}
