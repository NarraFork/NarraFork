import { AppError } from "../lib/errors";

export const BUFFER_EDIT_REQUEST_TIMEOUT_MS = 120_000;

/** Abort the actual input stream, not just a Promise racing its still-live writer. */
export async function withBufferEditRequestDeadline<T>(
	request: Request,
	work: (request: Request) => Promise<T>,
	timeoutMs = BUFFER_EDIT_REQUEST_TIMEOUT_MS,
	operationSignal?: AbortSignal,
): Promise<T> {
	const sourceSignal = operationSignal
		? AbortSignal.any([request.signal, operationSignal])
		: request.signal;
	const abort = new AbortController();
	const reader = request.body?.getReader();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	const stop = (reason: unknown) => {
		if (!abort.signal.aborted) abort.abort(reason);
		if (!closed) {
			closed = true;
			controller?.error(reason);
		}
		void reader?.cancel(reason).catch(() => {});
	};
	const disconnected = () => stop(sourceSignal.reason);
	const timer = setTimeout(
		() => stop(new AppError("Buffer edit request timed out", 408, "BUFFER_EDIT_TIMEOUT")),
		timeoutMs,
	);
	sourceSignal.addEventListener("abort", disconnected, { once: true });
	const body = reader
		? new ReadableStream<Uint8Array>({
				start(value) {
					controller = value;
				},
				async pull(value) {
					try {
						const chunk = await reader.read();
						if (closed) return;
						if (chunk.done) {
							closed = true;
							value.close();
						} else value.enqueue(chunk.value);
					} catch (error) {
						if (!closed) {
							closed = true;
							value.error(error);
						}
					}
				},
				cancel: (reason) => reader.cancel(reason),
			})
		: null;
	if (sourceSignal.aborted) disconnected();
	const bounded = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body,
		signal: abort.signal,
	});
	try {
		// Always wait for work to unwind before its caller removes the mutation pin.
		// No timeout race can let a late attachment write escape this scope.
		const result = await work(bounded);
		abort.signal.throwIfAborted();
		return result;
	} finally {
		clearTimeout(timer);
		sourceSignal.removeEventListener("abort", disconnected);
		void reader?.cancel().catch(() => {});
	}
}

/** Tiny lease bodies are read once, before the shared (large attachment) body limiter. */
export async function readBufferEditLeaseBody(request: Request): Promise<Request> {
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		if (reader)
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 1024)
					throw new AppError(
						"Buffer edit lease request exceeds the 1 KiB limit",
						413,
						"BUFFER_EDIT_TOO_LARGE",
					);
				chunks.push(chunk.value);
			}
	} finally {
		void reader?.cancel().catch(() => {});
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const headers = new Headers(request.headers);
	headers.set("content-length", String(bytes));
	return new Request(request.url, {
		method: request.method,
		headers,
		body,
		signal: request.signal,
	});
}
