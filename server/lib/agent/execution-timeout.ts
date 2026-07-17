/**
 * Optional execution deadlines for long-running Agent/Bash work.
 *
 * A missing/zero timeout means no wall-clock deadline. Explicit deadlines are
 * scheduled in chunks because Bun/Node clamp a single setTimeout delay to a
 * signed 32-bit integer.
 */

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface OptionalExecutionTimeout {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly didTimeout: () => boolean;
	dispose: () => void;
}

/** Normalize a timeout where 0/undefined means "no wall-clock deadline". */
export function normalizeOptionalExecutionTimeout(timeoutMs?: number): number | undefined {
	if (timeoutMs == null || timeoutMs === 0) return undefined;
	if (!Number.isFinite(timeoutMs) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
		throw new RangeError("Execution timeout must be a finite non-negative safe integer");
	}
	return timeoutMs > 0 ? timeoutMs : undefined;
}

/** Resolve a timeout with a default while preserving 0 as an explicit unlimited value. */
export function resolveOptionalExecutionTimeout(
	timeoutMs: number | undefined,
	defaultTimeoutMs: number,
): number | undefined {
	if (timeoutMs === 0) return undefined;
	return normalizeOptionalExecutionTimeout(timeoutMs ?? defaultTimeoutMs);
}

/** Create an optional aborting deadline without imposing a policy maximum. */
export function createOptionalExecutionTimeout(
	timeoutMs: number | undefined,
	reason: string,
): OptionalExecutionTimeout | null {
	const normalized = normalizeOptionalExecutionTimeout(timeoutMs);
	if (normalized === undefined) return null;

	const controller = new AbortController();
	let remainingMs = normalized;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let timedOut = false;

	const schedule = () => {
		if (disposed || controller.signal.aborted) return;
		const delay = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
		const startedAt = Date.now();
		timer = setTimeout(() => {
			// Use elapsed wall time rather than assuming the timer fired on time.
			remainingMs -= Math.max(delay, Date.now() - startedAt);
			if (remainingMs <= 0) {
				timedOut = true;
				controller.abort(reason);
				return;
			}
			schedule();
		}, delay);
	};

	schedule();

	return {
		signal: controller.signal,
		timeoutMs: normalized,
		didTimeout: () => timedOut,
		dispose: () => {
			disposed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
