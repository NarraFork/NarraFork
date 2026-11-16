/**
 * The clock of live outline editing: every timer and every "now" of the live session engine
 * (`server/services/outline/live/`) and of the editor's live client
 * (`frontend/components/outline/editor/live-client.ts`) goes through it, so tests can run them
 * on a clock they advance themselves (no real waiting, the same order every run).
 *
 * Production uses the platform's timers (unreferenced on the server: a timer of the engine
 * never keeps a process alive). Measurements (`performance.now()` for statistics) are not
 * timers and stay real.
 */

/** An opaque timer handle. */
export type LiveTimer = { readonly __liveTimer: true } | ReturnType<typeof setTimeout>;

export interface LiveClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): LiveTimer;
	clearTimeout(timer: LiveTimer): void;
	/** Let other tasks run (a long loop yields to the event loop between steps). */
	yield(): Promise<void>;
}

const realClock: LiveClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => {
		const t = setTimeout(fn, ms);
		(t as { unref?: () => void }).unref?.();
		return t;
	},
	clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
	yield: () =>
		new Promise<void>((resolve) =>
			typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0),
		),
};

let current: LiveClock = realClock;

export function liveNow(): number {
	return current.now();
}

export function liveTimeout(fn: () => void, ms: number): LiveTimer {
	return current.setTimeout(fn, ms);
}

export function cancelLiveTimer(timer: LiveTimer | null | undefined): void {
	if (timer) current.clearTimeout(timer);
}

export function liveSleep(ms: number): Promise<void> {
	return new Promise((resolve) => current.setTimeout(resolve, ms));
}

export function liveYield(): Promise<void> {
	return current.yield();
}

/** Run the live engine and clients on `clock` (tests); null restores the real one. */
export function setLiveClockForTests(clock: LiveClock | null): void {
	current = clock ?? realClock;
}
