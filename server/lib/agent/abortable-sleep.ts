/**
 * Abort-aware sleep used by every retry/backoff path in the agent loop.
 *
 * A module of its own so tests can observe the delays a retry path actually waits. The loop
 * announces a `delayMs` in its `retrying` event AND sleeps; the two are computed from a
 * counter that moves between attempts, so "announced 30ms, slept 60ms" is a real failure
 * mode with no error to report. Asserting on wall-clock elapsed time cannot catch it (a
 * longer sleep still satisfies "at least the sum"), whereas stubbing this and recording its
 * arguments compares the two directly.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		// `{ once: true }` only self-removes when the event FIRES. The overwhelmingly common
		// outcome is the timer winning, and the listener then stays on the signal — whose
		// lifetime is the whole session, while a retry path may sleep unboundedly often
		// (`maxTransientRetries: -1`). Each survivor pins its closure and the dead timer
		// handle, so the signal accumulates listeners for the session's duration: 20k sleeps
		// on one signal held ~13 MB that never came back. Removing on BOTH exits is the only
		// way out, since a promise cannot be un-resolved later.
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
