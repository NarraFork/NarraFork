/**
 * Per-key coalescing scheduler for the event-driven project archive sync.
 *
 * WHY NOT A PLAIN TRAILING DEBOUNCE
 * ---------------------------------
 * The predecessor reset a 500ms timer on every narrator event. A working narrator pauses for
 * 500ms constantly (between tool calls, between turns), so the sync fired every few seconds for
 * as long as the narrator worked — and nothing stopped a second run from starting while the
 * first was still reading. The archive is a best-effort backup; syncing it seconds later costs
 * nothing, running it back-to-back costs the whole server its event loop.
 *
 * So, per key:
 *   - Events COALESCE: while a run is scheduled, further events do not move it.
 *   - At most ONE run is in flight. Events arriving during a run mark the key dirty, and exactly
 *     one follow-up run is scheduled when it finishes — no event is lost, none is run twice.
 *   - Consecutive run STARTS are at least `minIntervalMs` apart; the first run after a quiet
 *     period still waits only `debounceMs`.
 */

export interface NarratorSyncSchedulerOptions {
	/** Delay before a run when the key has not run recently. */
	readonly debounceMs: number;
	/** Minimum time between the starts of two runs for the same key. */
	readonly minIntervalMs: number;
	/** The work itself. Rejections are reported through `onError`, never rethrown. */
	readonly run: (key: string) => Promise<void>;
	readonly onError?: (key: string, error: unknown) => void;
	/** Injectable clock for tests. */
	readonly now?: () => number;
	/** Idle entries are swept once the map grows past this size. */
	readonly maxIdleEntries?: number;
}

interface KeyState {
	timer: ReturnType<typeof setTimeout> | null;
	running: boolean;
	dirty: boolean;
	lastStartedAt: number;
}

export interface NarratorSyncScheduler {
	/** Note that `key` changed; a run will follow. */
	schedule(key: string): void;
	/** Cancel every pending timer (in-flight runs finish on their own). */
	dispose(): void;
	/** For tests and diagnostics. */
	readonly size: number;
}

export function createNarratorSyncScheduler(
	options: NarratorSyncSchedulerOptions,
): NarratorSyncScheduler {
	const now = options.now ?? Date.now;
	const maxIdleEntries = options.maxIdleEntries ?? 1_000;
	const states = new Map<string, KeyState>();
	let disposed = false;

	function sweepIdle(): void {
		if (states.size <= maxIdleEntries) return;
		const cutoff = now() - options.minIntervalMs;
		for (const [key, state] of states) {
			if (!state.timer && !state.running && state.lastStartedAt <= cutoff) states.delete(key);
		}
	}

	function arm(key: string, state: KeyState): void {
		const sinceLast = now() - state.lastStartedAt;
		const delay = Math.max(options.debounceMs, options.minIntervalMs - sinceLast);
		state.timer = setTimeout(() => {
			state.timer = null;
			void fire(key, state);
		}, delay);
	}

	async function fire(key: string, state: KeyState): Promise<void> {
		state.running = true;
		state.dirty = false;
		state.lastStartedAt = now();
		try {
			await options.run(key);
		} catch (error) {
			options.onError?.(key, error);
		} finally {
			state.running = false;
			if (state.dirty && !state.timer && !disposed) arm(key, state);
		}
	}

	return {
		schedule(key) {
			if (disposed) return;
			let state = states.get(key);
			if (!state) {
				sweepIdle();
				state = { timer: null, running: false, dirty: false, lastStartedAt: -Infinity };
				states.set(key, state);
			}
			if (state.running) {
				state.dirty = true;
				return;
			}
			if (state.timer) return;
			arm(key, state);
		},
		dispose() {
			disposed = true;
			for (const state of states.values()) {
				if (state.timer) clearTimeout(state.timer);
				state.timer = null;
			}
			states.clear();
		},
		get size() {
			return states.size;
		},
	};
}
