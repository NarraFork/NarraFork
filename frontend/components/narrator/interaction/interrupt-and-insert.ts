/**
 * Ordering boundary for the interrupt-and-insert composer action.
 *
 * The replacement message is accepted only after the old loop has reached its
 * settled boundary. A 409 with `settled: false` is an expected race outcome,
 * not permission to send again: the caller keeps the draft intact and lets the
 * user retry the single action later.
 */
export interface SettledInterruptResponse {
	settled?: boolean;
}

export function isSettledInterruptResponse(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"settled" in value &&
		(value as { settled?: unknown }).settled === true
	);
}

export function isInterruptNotSettledError(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const error = value as {
		status?: unknown;
		data?: { settled?: unknown };
	};
	return error.status === 409 && error.data?.settled === false;
}

/**
 * Interrupt once, then insert at most once after a settled response.
 *
 * Returning `undefined` means the old loop did not settle in time. In that case
 * `insert` is deliberately never called, which prevents duplicate replacement
 * messages when the user retries after the server has already accepted the stop.
 */
export async function interruptAndInsert<T>(
	interrupt: () => Promise<unknown>,
	insert: () => Promise<T>,
): Promise<T | undefined> {
	try {
		const response = await interrupt();
		if (!isSettledInterruptResponse(response)) return undefined;
	} catch (error) {
		if (isInterruptNotSettledError(error)) return undefined;
		throw error;
	}
	return insert();
}
