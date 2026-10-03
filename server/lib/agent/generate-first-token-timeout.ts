import type { GenerateOptions } from "./provider";

/** Bound only the wait for model output, never the entire generation. */
export async function generateWithFirstTokenTimeout<T>(
	generate: (options: GenerateOptions) => Promise<T>,
	firstTokenTimeoutMs: number,
	requestSignal: AbortSignal,
): Promise<T> {
	requestSignal.throwIfAborted();
	const controller = new AbortController();
	const signal = AbortSignal.any([requestSignal, controller.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clearTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const onDelta = (delta: string) => {
		if (delta.length > 0) clearTimer();
	};
	if (firstTokenTimeoutMs > 0) {
		timer = setTimeout(() => {
			controller.abort(
				new DOMException(
					`First token timeout after ${firstTokenTimeoutMs / 1000} seconds`,
					"TimeoutError",
				),
			);
		}, firstTokenTimeoutMs);
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			generate({ signal, onTextDelta: onDelta, onReasoningDelta: onDelta }),
			aborted,
		]);
	} finally {
		clearTimer();
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
