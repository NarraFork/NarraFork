/**
 * Bound a settings save that the browser may never send.
 *
 * A PATCH that is stuck in the per-host connection queue does not reject: the
 * save button spins until the tab is closed. Aborting here turns that into an
 * error the user can retry, after closing the other tabs that are holding the
 * sockets.
 */
export const SETTINGS_SAVE_TIMEOUT_MS = 30_000;

export async function runSettingsSave<T>(
	execute: (signal: AbortSignal) => Promise<T>,
	timeoutMessage: string,
	timeoutMs = SETTINGS_SAVE_TIMEOUT_MS,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Race instead of only trusting `execute` to reject. A fetch stuck in the
	// browser connection queue does reject on abort in current Chrome, but the
	// save button must still recover if a caller forgets to forward the signal.
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(timeoutMessage));
		}, timeoutMs);
	});
	const execution = execute(controller.signal).catch((error: unknown) => {
		if (controller.signal.aborted) throw new Error(timeoutMessage);
		throw error;
	});
	try {
		return await Promise.race([execution, timedOut]);
	} finally {
		clearTimeout(timer);
		// The loser of the race can reject after the winner has settled.
		execution.catch(() => {});
		timedOut.catch(() => {});
	}
}
