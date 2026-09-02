/**
 * vlist-morph-driver.ts — The ONE timing owner: a single rAF loop that converges every
 * morphing element's visual state and writes it to the DOM.
 *
 * ## Why there is exactly one loop
 *
 * `vlist-motion-scheduler.ts` records the lesson this file must not un-learn: the fold and
 * the morph once held separate controllers, and "re-toggling cancelled the fold's half
 * wholesale while the other half ran to a different finish time, so one visual event came
 * apart". A single `flush()` per commit is what fixed it.
 *
 * This driver preserves that property by construction rather than by discipline: there is
 * no per-element animation to get out of sync, because there is no per-element timeline at
 * all. Every element is advanced by the SAME `dt` in the SAME frame from the SAME store, so
 * two elements physically cannot finish at different times or be cancelled independently.
 *
 * That is also why fold has to move onto this driver rather than staying on WAAPI: two
 * backends means two timing owners, which is the original bug with extra steps.
 *
 * ## What it writes
 *
 * Composited properties only, plus one deliberate exception:
 *
 *   - `transform: translate(x, y)` — the visual offset, in document px (see `VisualState`).
 *   - `opacity` — when it differs from 1.
 *   - `borderColor` — interpolated toward transparent by `cardness`. NOT composited, and
 *     the exception is argued in `resolveCardness`: the alternative (opacity on the
 *     border-carrying element) fades the card's CONTENT too, which is the "blur in"
 *     artifact the line's own motion exists to avoid.
 *
 * `left` is never written at all: it feeds the measured-height model, and a write there can
 * loop back into layout.
 *
 * `top`/`height` are written only for the two LAYOUT-ANIMATING cases that cannot be expressed
 * as a transform (the fold frame and a closing nested block, via `VisualState.boxTop` /
 * `boxHeight`). Those are the renderer's own channels here — every row is absolutely
 * positioned with a React-owned inline `top` — so the driver tracks which elements it
 * introduced a value on (`layoutPainted`) and clears only those. See `writeOne` and
 * `clearOne` for why an unconditional clear destroyed the committed layout instead of
 * restoring it.
 *
 * ## Settling returns control to the committed style
 *
 * When a state settles the driver writes the resting values ONCE and then clears its inline
 * styles, so the element goes back to being described by its own CSS. Nothing is left
 * applied — the same guarantee `fill: "none"` gave the keyframe implementation, without
 * needing the animation to be cancelled to get it.
 */

import { prefersReducedMotion } from "./vlist-motion-scheduler";
import type { VisualState, VisualStateStore } from "./vlist-visual-state";

/** Longest frame the driver will integrate, in ms. */
export const MORPH_MAX_FRAME_MS = 64;

/**
 * The subset of an element the driver touches. Structural typing so tests can pass a plain
 * object and the linkedom DOM works unchanged.
 */
export interface MorphNode {
	style: {
		transform: string;
		opacity: string;
		borderColor: string;
		willChange: string;
		/** Fold reveal: un-clips a box already at its final height. */
		clipPath: string;
		/** The two documented layout-animating cases — see `VisualState.boxTop`. */
		top: string;
		height: string;
	};
}

/** How the driver finds the nodes for one identity at write time. */
export interface MorphTargets {
	/** The element that carries the offset and opacity. */
	readonly root: MorphNode | null | undefined;
	/** The card surface whose border fades with `cardness`. Absent for a row form. */
	readonly surface?: MorphNode | null | undefined;
	/** The right-edge tail cluster, faded by `cardness` (it cannot travel — see the plan). */
	readonly tail?: MorphNode | null | undefined;
}

export interface MorphDriver {
	/**
	 * Ensure the loop is running. Idempotent: calling it every commit is the intended
	 * usage, and it never starts a second loop.
	 */
	kick(): void;
	/** Stop the loop and clear every inline style the driver applied. */
	stop(): void;
	/** True while the loop holds a scheduled frame. */
	isRunning(): boolean;
	/** Advance and write one frame manually. Returns whether another frame is needed. */
	tick(dtMs: number): boolean;
}

export interface MorphDriverDeps {
	readonly store: VisualStateStore;
	/** Resolve the DOM nodes for an identity, or null when it is not currently mounted. */
	readonly resolve: (unitId: string) => MorphTargets | null;
	/** Identities the driver should write this frame. */
	readonly identities: () => Iterable<string>;
	/** Injected for tests; defaults to `requestAnimationFrame`. */
	readonly raf?: (cb: (now: number) => void) => number;
	readonly cancelRaf?: (handle: number) => void;
	readonly now?: () => number;
	/** Injected for tests; defaults to the shared media-query check. */
	readonly isReducedMotion?: () => boolean;
}

/**
 * Map `cardness` to a border colour.
 *
 * Only ONE end is named, and it is always `transparent`. The opaque end is left to the
 * element's own computed style, because the card's border is a theme variable by default
 * and a STATUS OVERRIDE on some cards — naming a colour here would repaint those in the
 * wrong hue for the duration, i.e. a fade that also changes colour.
 *
 * `cardness >= 1` therefore clears the inline value rather than setting one.
 */
export function resolveBorderColor(cardness: number): string {
	if (cardness >= 1) return "";
	if (cardness <= 0) return "transparent";
	// Mixed against `var(--nf-card-border)`, which the RENDER layer publishes on the card
	// surface, so the committed colour stays owned by the renderer and the driver never has
	// to know what it is. That matters because the border is a theme variable by default and
	// a status override on some cards.
	//
	// ⚠️ NOT `currentColor`: that is the element's TEXT colour, which on a card is nothing
	// like its border colour — mixing against it would fade the border through the wrong hue.
	// The fallback keeps a card whose variable is missing looking correct rather than
	// invisible.
	const pct = Math.round(cardness * 100);
	return `color-mix(in srgb, var(--nf-card-border, var(--mantine-color-default-border)) ${pct}%, transparent)`;
}

/** Format the offset as a transform, or "" when the element is at rest. */
export function resolveTransform(state: VisualState): string {
	if (state.x === 0 && state.y === 0) return "";
	return `translate(${state.x}px, ${state.y}px)`;
}

/** Create the driver. It does not schedule anything until `kick()`. */
export function createMorphDriver(deps: MorphDriverDeps): MorphDriver {
	const raf =
		deps.raf ??
		((cb: (now: number) => void) =>
			typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : 0);
	const cancel =
		deps.cancelRaf ??
		((handle: number) => {
			if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
		});
	const now =
		deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
	const isReducedMotion = deps.isReducedMotion ?? prefersReducedMotion;

	let handle = 0;
	let lastAt = 0;
	/** Identities with inline styles applied, so `stop()` can clear exactly those. */
	const painted = new Set<string>();
	/**
	 * Identities the driver wrote inline `top`/`height` on.
	 *
	 * Tracked separately from {@link painted} because those two channels are the only ones
	 * the RENDERER also owns: a row is absolutely positioned with an inline `top`, so an
	 * unconditional clear wipes the committed layout instead of restoring it. Only the two
	 * documented layout-animating cases (the fold frame, a closing nested block) ever put
	 * the driver's own value there, and only those may be cleared.
	 */
	const layoutPainted = new Set<string>();

	const writeOne = (unitId: string, state: VisualState): void => {
		const targets = deps.resolve(unitId);
		if (!targets?.root) return;
		const transform = resolveTransform(state);
		targets.root.style.transform = transform;
		targets.root.style.opacity = state.opacity >= 1 ? "" : String(state.opacity);
		// `will-change` only while actually moving: leaving it on permanently keeps a
		// composited layer alive for every row in the document.
		targets.root.style.willChange = transform ? "transform" : "";
		if (targets.surface) targets.surface.style.borderColor = resolveBorderColor(state.cardness);
		if (targets.tail)
			targets.tail.style.opacity = state.cardness >= 1 ? "" : String(state.cardness);
		// Fold's channels, written only when the element actually uses them: an element with no
		// `insetBottom` must not get `clip-path: inset(0 0 0 0)`, which would create a clipping
		// context (and a composited layer) for every row in the document.
		if (state.insetBottom !== undefined) {
			targets.root.style.clipPath =
				state.insetBottom <= 0 ? "" : `inset(0px 0px ${state.insetBottom}px 0px)`;
		}
		// Recorded as the driver's own, so `clearOne` knows this inline value replaced the
		// renderer's and may be blanked. An element that never enters these branches keeps the
		// committed `top`/`height` untouched.
		if (state.boxTop !== undefined || state.boxHeight !== undefined) {
			if (state.boxTop !== undefined) targets.root.style.top = `${state.boxTop}px`;
			if (state.boxHeight !== undefined) targets.root.style.height = `${state.boxHeight}px`;
			layoutPainted.add(unitId);
		} else if (layoutPainted.has(unitId)) {
			// The channels went away while this element stayed admitted (a layout-animating fold
			// finished and the same node is now only being translated). `painted` may drop it in
			// the same frame — a fully-resting element paints nothing — and then `clearOne` would
			// never run for it, leaving the element frozen at its animated box for the rest of the
			// session. Release the two channels the moment they stop being driven.
			targets.root.style.top = "";
			targets.root.style.height = "";
			layoutPainted.delete(unitId);
		}
		if (
			transform ||
			state.opacity < 1 ||
			state.cardness < 1 ||
			state.insetBottom !== undefined ||
			state.boxTop !== undefined ||
			state.boxHeight !== undefined
		) {
			painted.add(unitId);
		} else painted.delete(unitId);
	};

	const clearOne = (unitId: string): void => {
		const targets = deps.resolve(unitId);
		if (targets?.root) {
			targets.root.style.transform = "";
			targets.root.style.opacity = "";
			targets.root.style.willChange = "";
			targets.root.style.clipPath = "";
			// ⚠️ `top` / `height` are cleared ONLY for an element the driver actually wrote them
			// on (see `layoutPainted`).
			//
			// In this shell every row is `position: absolute` with a React-owned inline `top`
			// and `height` — that inline value IS the committed layout, not a fallback for it.
			// Blanking it unconditionally therefore did not "hand control back to the committed
			// style", it DESTROYED the committed style: the row lost its `top`, fell back to
			// `auto`, and the whole group collapsed into a stack at the container's origin while
			// bodies pushed out of view disappeared.
			//
			// It only bit AFTER a morph finished (that is the one moment `clearOne` runs on a
			// settled element), which is exactly the reported shape: the transition itself looked
			// right and everything broke the instant it completed.
			//
			// The original concern behind clearing them — a stale inline box freezing the element
			// at its animated size — is real, so the channels are still cleared, just only where
			// they were introduced by the driver.
			if (layoutPainted.has(unitId)) {
				targets.root.style.top = "";
				targets.root.style.height = "";
				layoutPainted.delete(unitId);
			}
		}
		if (targets?.surface) targets.surface.style.borderColor = "";
		if (targets?.tail) targets.tail.style.opacity = "";
	};

	/** Write every admitted identity's CURRENT state without advancing time. */
	const paintCurrent = (): void => {
		for (const unitId of deps.identities()) {
			const state = deps.store.get(unitId);
			if (state) writeOne(unitId, state);
		}
	};

	const driver: MorphDriver = {
		kick() {
			// Reduced motion: no loop at all. States are still set, so the committed geometry is
			// what the reader sees — which is the correct degradation, not a broken one.
			if (isReducedMotion()) {
				driver.stop();
				return;
			}
			// ⚠️ WRITE THE CURRENT STATE SYNCHRONOUSLY, BEFORE SCHEDULING ANYTHING.
			//
			// `kick()` is called from a layout effect, so the DOM is committed but not yet
			// painted. Only scheduling a frame means the first WRITE happens on the NEXT frame —
			// and the browser paints the frame in between with no transform applied at all. The
			// element therefore appears at its FINAL position for one frame, then jumps back to
			// its start and converges from there. That reads as a flash rather than a
			// transition, and it is invisible to the test suite because every value involved is
			// eventually correct.
			//
			// It also explains why interrupting repeatedly appeared to "fix" it: by then the
			// loop was already running and the states already existed, so most elements were
			// being written every frame and only the newly-seeded ones flashed.
			//
			// Writing here costs one extra pass over the admitted set and closes the gap
			// entirely: the seeded offset is applied in the same commit that produced it.
			paintCurrent();
			if (handle) return;
			lastAt = now();
			const frame = (): void => {
				handle = 0;
				const at = now();
				// Clamped: a backgrounded tab can hand back a multi-second dt, and integrating it
				// would teleport every element. Clamping trades exactness for continuity, which is
				// the right way round for an animation nobody watched.
				const dt = Math.min(MORPH_MAX_FRAME_MS, Math.max(0, at - lastAt));
				lastAt = at;
				if (driver.tick(dt)) handle = raf(frame);
			};
			handle = raf(frame);
		},

		stop() {
			if (handle) cancel(handle);
			handle = 0;
			for (const unitId of painted) clearOne(unitId);
			painted.clear();
		},

		isRunning() {
			return handle !== 0;
		},

		tick(dtMs) {
			const moving = deps.store.step(dtMs);
			for (const unitId of deps.identities()) {
				const state = deps.store.get(unitId);
				if (state) writeOne(unitId, state);
			}
			if (!moving) {
				// Settled: hand control back to the committed style. Everything the driver wrote is
				// removed, so nothing is left applied and no cleanup can be missed later.
				for (const unitId of painted) clearOne(unitId);
				painted.clear();
				deps.store.sweep();
			}
			return moving;
		},
	};
	return driver;
}
