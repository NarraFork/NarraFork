/** Fail promptly on timeout/cancellation even if an external adapter ignores AbortSignal.
 * The underlying operation stays observed; callers hold its queue slot until it settles.
 * A timeout does not prove a native operation stopped or permit replay. */
export function runWindowsIoBounded<T>(
	signal: AbortSignal,
	operation: () => Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const aborted = () => {
			signal.removeEventListener("abort", aborted);
			reject(signal.reason);
		};
		signal.addEventListener("abort", aborted, { once: true });
		Promise.resolve()
			.then(operation)
			.then(resolve, reject)
			.finally(() => {
				signal.removeEventListener("abort", aborted);
			});
	});
}
