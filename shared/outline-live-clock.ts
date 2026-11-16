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
	/**
	 * `keepAlive`: a wait something is awaiting (a retry of a commit); on the server it keeps
	 * the process alive like any pending work. Other timers are unreferenced.
	 */
	setTimeout(fn: () => void, ms: number, keepAlive?: boolean): LiveTimer;
	clearTimeout(timer: LiveTimer): void;
	/** Let other tasks run (a long loop yields to the event loop between steps). */
	yield(): Promise<void>;
}

const realClock: LiveClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms, keepAlive) => {
		const t = setTimeout(fn, ms);
		if (!keepAlive) (t as { unref?: () => void }).unref?.();
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

/** A wait something awaits: referenced (an unreferenced one could leave its promise unsettled at exit). */
export function liveSleep(ms: number): Promise<void> {
	return new Promise((resolve) => current.setTimeout(resolve, ms, true));
}

export function liveYield(): Promise<void> {
	return current.yield();
}

/** Run the live engine and clients on `clock` (tests); null restores the real one. */
export function setLiveClockForTests(clock: LiveClock | null): void {
	current = clock ?? realClock;
}
