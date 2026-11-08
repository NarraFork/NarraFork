import { AppError } from "@server/lib/errors";
import { SPEECH_LIMITS } from "@shared/speech";

/** Bounded even without Content-Length. Cancellation interrupts an outstanding read. */
export async function readSpeechBody(
	request: Request,
	limit: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const length = request.headers.get("content-length");
	if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
		throw new AppError("Speech request body is too large.", 413, "SPEECH_INPUT_LIMIT");
	}
	if (signal.aborted) throw signal.reason;
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let timedOut = false;
			const expiry = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new AppError("Speech upload timed out.", 408, "SPEECH_TIMEOUT"));
					void reader.cancel().catch(() => {});
				}, SPEECH_LIMITS.idleTimeoutMs);
			});
			const next = await Promise.race([reader.read(), expiry]).finally(() => clearTimeout(timer));
			if (signal.aborted) throw signal.reason;
			if (timedOut) throw new AppError("Speech upload timed out.", 408, "SPEECH_TIMEOUT");
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit)
				throw new AppError("Speech request body is too large.", 413, "SPEECH_INPUT_LIMIT");
			chunks.push(next.value);
		}
		const body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return body;
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** One read per downstream pull. Never drains or accumulates the upstream audio. */
export function speechResponseStream(
	iterator: AsyncIterator<Uint8Array>,
	first: IteratorResult<Uint8Array>,
	signal: AbortSignal,
	close: () => void,
): ReadableStream<Uint8Array> {
	let initial: IteratorResult<Uint8Array> | undefined = first;
	let ended = false;
	let abort: () => void;
	const cleanup = () => {
		ended = true;
		signal.removeEventListener("abort", abort);
		close();
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				abort = () => {
					if (ended) return;
					cleanup();
					controller.error(new AppError("Speech stream interrupted.", 502, "SPEECH_INTERRUPTED"));
					void iterator.return?.().catch(() => {});
				};
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			},
			async pull(controller) {
				try {
					const next = initial ?? (await iterator.next());
					initial = undefined;
					if (ended) return;
					if (next.done) {
						cleanup();
						controller.close();
					} else controller.enqueue(next.value);
				} catch {
					if (!ended) {
						cleanup();
						controller.error(new AppError("Speech stream interrupted.", 502, "SPEECH_INTERRUPTED"));
					}
					void iterator.return?.().catch(() => {});
				}
			},
			async cancel() {
				cleanup();
				await iterator.return?.();
			},
		},
		{ highWaterMark: 0 },
	);
}
