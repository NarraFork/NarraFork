export const WEB_SEARCH_TIMEOUT_MS = 60_000;

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
