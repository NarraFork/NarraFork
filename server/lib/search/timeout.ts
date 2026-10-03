export const WEB_SEARCH_TIMEOUT_MS = 60_000;
export const SEARCH_SUBAGENT_CLEANUP_TIMEOUT_MS = 10_000;

/** Never start a fallback while an earlier child can still publish to the parent tool. */
export class SearchSubagentCleanupTimeoutError extends Error {
	constructor() {
		super("Search subagent cleanup timed out; channel fallback stopped");
		this.name = "SearchSubagentCleanupTimeoutError";
	}
}

export function isAbortError(err: unknown): boolean {
	return (
		(err instanceof Error && (err.name === "AbortError" || err.message === "Aborted")) ||
		(typeof DOMException !== "undefined" &&
			err instanceof DOMException &&
			err.name === "AbortError")
	);
}

function createNamedError(message: string, name: "AbortError" | "TimeoutError"): Error {
	if (typeof DOMException !== "undefined") {
		return new DOMException(message, name);
	}
	const err = new Error(message);
	err.name = name;
	return err;
}

function normalizeAbortReason(reason: unknown): Error {
	return reason instanceof Error ? reason : createNamedError("Aborted", "AbortError");
}

export async function withSearchTimeout<T>(
	ctxSignal: AbortSignal | undefined,
	fn: (signal: AbortSignal) => Promise<T>,
	timeoutMs = WEB_SEARCH_TIMEOUT_MS,
): Promise<T> {
	if (ctxSignal?.aborted) throw normalizeAbortReason(ctxSignal.reason);

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	const operation = Promise.resolve().then(() => fn(controller.signal));
	const timeoutOrAbort = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const err = createNamedError("Web search timed out", "TimeoutError");
			controller.abort(err);
			reject(err);
		}, timeoutMs);

		if (ctxSignal) {
			onAbort = () => {
				const err = normalizeAbortReason(ctxSignal.reason);
				controller.abort(err);
				reject(err);
			};
			ctxSignal.addEventListener("abort", onAbort, { once: true });
		}
	});

	try {
		return await Promise.race([operation, timeoutOrAbort]);
	} finally {
		if (timer) clearTimeout(timer);
		if (ctxSignal && onAbort) ctxSignal.removeEventListener("abort", onAbort);
	}
}

/**
 * A persisted child owns a terminal publication, unlike a stateless HTTP probe.
 * Cancel on timeout/parent abort, then await its finalization before reporting failure.
 * If finalization exceeds its bounded grace period, fail closed instead of falling back.
 */
export async function withSearchSubagentTimeout<T>(
	ctxSignal: AbortSignal | undefined,
	fn: (signal: AbortSignal) => Promise<T>,
	timeoutMs = WEB_SEARCH_TIMEOUT_MS,
	cleanupTimeoutMs = SEARCH_SUBAGENT_CLEANUP_TIMEOUT_MS,
): Promise<T> {
	if (ctxSignal?.aborted) throw normalizeAbortReason(ctxSignal.reason);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	let abortReason: Error | undefined;
	let onAbort: (() => void) | undefined;
	const interrupted = Promise.withResolvers<void>();
	const cancel = (reason: Error) => {
		if (abortReason) return;
		abortReason = reason;
		controller.abort(reason);
		interrupted.resolve();
	};
	if (ctxSignal) {
		onAbort = () => cancel(normalizeAbortReason(ctxSignal.reason));
		ctxSignal.addEventListener("abort", onAbort, { once: true });
	}
	timer = setTimeout(
		() => cancel(createNamedError("Web search timed out", "TimeoutError")),
		timeoutMs,
	);
	// Observe both outcomes immediately: cancellation may precede the child's rejection.
	const operation = Promise.resolve().then(() => {
		if (controller.signal.aborted) throw abortReason;
		return fn(controller.signal);
	});
	const settled = operation.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
	try {
		const outcome = await Promise.race([settled, interrupted.promise.then(() => null)]);
		if (abortReason) {
			await Promise.race([
				settled,
				new Promise<never>((_resolve, reject) => {
					cleanupTimer = setTimeout(
						() => reject(new SearchSubagentCleanupTimeoutError()),
						cleanupTimeoutMs,
					);
				}),
			]);
			throw abortReason;
		}
		if (!outcome) throw new Error("Search cancellation did not provide a reason");
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	} finally {
		if (timer) clearTimeout(timer);
		if (cleanupTimer) clearTimeout(cleanupTimer);
		if (ctxSignal && onAbort) ctxSignal.removeEventListener("abort", onAbort);
	}
}
