/**
 * Map vertical wheel deltas to horizontal scrolling for the terminal tab strip.
 *
 * Browsers only scroll an `overflow-x: auto` container horizontally when the
 * user holds Shift (or swipes sideways on a trackpad). The tab strip hides its
 * scrollbar, so without this helper the only way to pan overflowing tabs with a
 * plain mouse wheel is Shift+wheel.
 *
 * Wheel input accumulates an intended offset ("target") which a smooth chase
 * (shared with the message list via `lib/smooth-scroll`) glides toward, so
 * rapid notches chain into one animation instead of jumping.
 */

import { createSmoothFollower, type SmoothFollowerDeps } from "../../lib/smooth-scroll";

/** Minimal geometry the scroll logic needs — kept structural for unit tests. */
export interface ScrollableX {
	scrollWidth: number;
	clientWidth: number;
	scrollLeft: number;
}

export interface WheelLike {
	deltaX: number;
	deltaY: number;
	/** 0 = DOM_DELTA_PIXEL, 1 = DOM_DELTA_LINE, 2 = DOM_DELTA_PAGE */
	deltaMode: number;
	ctrlKey: boolean;
	metaKey: boolean;
	preventDefault(): void;
}

/** Pixel height assumed for a line-mode wheel notch (Firefox default). */
const LINE_HEIGHT_PX = 40;

/** Max scrollable offset of a horizontal strip. */
export function maxScrollLeft(el: ScrollableX): number {
	return Math.max(0, el.scrollWidth - el.clientWidth);
}

/** Effective horizontal pixel delta of one wheel event. */
export function normalizeTabStripWheelDelta(event: WheelLike, clientWidth: number): number {
	let dy = event.deltaY;
	if (event.deltaMode === 1) dy *= LINE_HEIGHT_PX;
	else if (event.deltaMode === 2) dy *= clientWidth;
	return event.deltaX + dy;
}

export interface TabStripWheelDecision {
	/** Next intended offset after this event. */
	target: number;
	/** Whether the event must be consumed (preventDefault); false = let it bubble. */
	consume: boolean;
}

/**
 * Decide the next intended offset for one wheel event. Pure — the caller owns
 * the animation and the DOM.
 *
 * `consume: false` means leave the default action alone:
 * - ctrl/meta held (browser zoom gesture, e.g. trackpad pinch)
 * - the container cannot scroll horizontally at all
 * - the effective delta is zero
 * - already at the edge in that direction and nothing is still gliding (so a
 *   vertical wheel can keep scrolling the ancestor panel instead of getting
 *   stuck at the end of the strip)
 */
export function resolveTabStripWheelTarget(input: {
	target: number;
	maxScroll: number;
	delta: number;
	ctrlKey: boolean;
	metaKey: boolean;
	/** A previous chase has not landed yet. */
	animating: boolean;
}): TabStripWheelDecision {
	const { target, maxScroll, delta, ctrlKey, metaKey, animating } = input;
	if (ctrlKey || metaKey) return { target, consume: false };
	if (maxScroll <= 0) return { target, consume: false };
	if (delta === 0) return { target, consume: false };
	const next = Math.min(maxScroll, Math.max(0, target + delta));
	if (next !== target) return { target: next, consume: true };
	// At the edge: keep swallowing while the strip is still catching up to the
	// previous input (no mid-slide page scroll), bubble once it has landed.
	return { target, consume: animating };
}

export interface TabStripWheelScroller {
	/** Handle one wheel event; returns whether it was consumed. */
	handleWheel: (event: WheelLike) => boolean;
	/** Stop any in-flight chase. */
	destroy: () => void;
}

type FollowerHooks = Pick<SmoothFollowerDeps, "raf" | "cancelRaf" | "now" | "isReducedMotion">;

/**
 * Stateful wheel → horizontal scroll controller with smooth chasing.
 * The element only needs `scrollWidth`/`clientWidth`/`scrollLeft`, so tests can
 * drive it with a plain clamping stub.
 */
export function createTabStripWheelScroller(
	el: ScrollableX,
	options: FollowerHooks = {},
): TabStripWheelScroller {
	let target = el.scrollLeft;
	const clampTarget = () => {
		const max = maxScrollLeft(el);
		target = Math.min(max, Math.max(0, target));
		return target;
	};
	const follower = createSmoothFollower({
		readCurrent: () => el.scrollLeft,
		readTarget: () => clampTarget(),
		getViewportHeight: () => el.clientWidth,
		writeInstant: (value) => {
			el.scrollLeft = value;
			target = value;
		},
		writeChase: (value) => {
			el.scrollLeft = value;
		},
		// Wheel input accumulates a moving target; the shared distance gate would
		// snap mid-burst once the notch queue grows. Glide unless reduced motion.
		canAnimate: ({ reducedMotion, current, target: goal }) => !reducedMotion && goal !== current,
		isReducedMotion: options.isReducedMotion,
		raf: options.raf,
		cancelRaf: options.cancelRaf,
		now: options.now,
	});
	return {
		handleWheel(event) {
			// Resync intent to reality when no chase is in flight (external scrolls,
			// the strip shrinking because a tab closed, …).
			if (!follower.isActive()) target = el.scrollLeft;
			const decision = resolveTabStripWheelTarget({
				target,
				maxScroll: maxScrollLeft(el),
				delta: normalizeTabStripWheelDelta(event, el.clientWidth),
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				animating: follower.isActive(),
			});
			if (!decision.consume) return false;
			target = decision.target;
			follower.ensure();
			event.preventDefault();
			return true;
		},
		destroy() {
			follower.cancel();
		},
	};
}

/** Attach the non-passive wheel handler; returns a detach function. */
export function attachTabStripWheel(el: HTMLElement): () => void {
	const scroller = createTabStripWheelScroller(el);
	const handler = (e: WheelEvent) => {
		scroller.handleWheel(e);
	};
	// Must be non-passive so preventDefault can cancel the default wheel scroll.
	el.addEventListener("wheel", handler, { passive: false });
	return () => {
		el.removeEventListener("wheel", handler);
		scroller.destroy();
	};
}
