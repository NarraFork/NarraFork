/**
 * rAF-driven exponential scroll follower for the split view's scroll sync.
 *
 * The scroll-sync effect computes a fresh target on every source scroll event;
 * writing it directly snaps the follower side in discrete jumps and kills the
 * user's native scroll momentum. Instead the target is approached
 * exponentially each frame — smooth at display refresh rate, still fast
 * enough (τ ≈ 90 ms) to feel locked to the other pane.
 */

/** Time constant: each τ of elapsed time closes ~63% of the remaining distance. */
export const SCROLL_FOLLOW_TAU_MS = 90;
/** At or below this remaining distance the follower snaps to the target and stops. */
export const SCROLL_FOLLOW_SNAP_PX = 0.5;
/** Cap one frame's step so a backgrounded tab doesn't teleport on return. */
const MAX_FRAME_DT_MS = 64;

/** One easing step; returns `target` exactly once close enough (settles the loop). */
export function scrollFollowStep(current: number, target: number, dtMs: number): number {
	if (dtMs <= 0) return current;
	const remaining = target - current;
	if (Math.abs(remaining) <= SCROLL_FOLLOW_SNAP_PX) return target;
	const next = current + remaining * (1 - Math.exp(-dtMs / SCROLL_FOLLOW_TAU_MS));
	return Math.abs(target - next) <= SCROLL_FOLLOW_SNAP_PX ? target : next;
}

export interface ScrollFollower {
	/** Aim at a new target; the follower eases toward it from wherever it is. */
	setTarget(target: number): void;
	/** True while a target is still being approached. */
	readonly active: boolean;
	/** Stop immediately (the user took over the scroller). */
	cancel(): void;
	dispose(): void;
}

/**
 * `get`/`set` read and write the scroller position; raf/cancelRaf are
 * injectable for tests. The loop runs only while a target is unsettled.
 */
export function createScrollFollower(
	get: () => number,
	set: (value: number) => void,
	raf: (callback: (time: number) => void) => number = (callback) => requestAnimationFrame(callback),
	cancelRaf: (id: number) => void = (id) => cancelAnimationFrame(id),
): ScrollFollower {
	let target: number | null = null;
	let frame: number | null = null;
	let lastTime: number | null = null;

	const tick = (time: number) => {
		frame = null;
		if (target == null) return;
		const dt = lastTime == null ? 1000 / 60 : Math.min(MAX_FRAME_DT_MS, time - lastTime);
		lastTime = time;
		const next = scrollFollowStep(get(), target, dt);
		set(next);
		if (next === target) {
			target = null;
			lastTime = null;
			return;
		}
		frame = raf(tick);
	};

	const stop = () => {
		target = null;
		lastTime = null;
		if (frame != null) {
			cancelRaf(frame);
			frame = null;
		}
	};

	return {
		setTarget(value: number) {
			target = value;
			if (frame == null) {
				lastTime = null;
				frame = raf(tick);
			}
		},
		get active() {
			return target != null;
		},
		cancel: stop,
		dispose: stop,
	};
}
