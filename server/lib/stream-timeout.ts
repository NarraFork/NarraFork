/**
 * Stream stale-read timeout utility.
 *
 * Wraps a ReadableStreamDefaultReader so that each `read()` call is guarded
 * by a configurable inactivity timeout. If no data arrives within the window
 * the reader is cancelled and a `StreamStaleError` is thrown, which bubbles
 * up through the async-generator chain and ultimately triggers the existing
 * retry / error-handling logic in the agent loop.
 */

/** Default timeout: 5 minutes of silence before we consider the stream dead. */
const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000;

export class StreamStaleError extends Error {
	constructor(timeoutMs: number) {
		super(`Stream stale: no data received for ${Math.round(timeoutMs / 1000)}s`);
		this.name = "StreamStaleError";
	}
}

/** Error thrown when a streamed response exceeds a caller-defined hard byte cap. */
export class StreamSizeLimitError extends Error {
	readonly maxBytes: number;
	readonly receivedBytes: number;

	constructor(label: string, maxBytes: number, receivedBytes: number) {
		super(`${label} exceeded hard limit (${receivedBytes} > ${maxBytes} bytes)`);
		this.name = "StreamSizeLimitError";
		this.maxBytes = maxBytes;
		this.receivedBytes = receivedBytes;
	}
}

/** Incremental byte budget for streams, SSE events, text, or tool arguments. */
export class StreamByteBudget {
	private receivedBytes = 0;

	constructor(
		readonly maxBytes: number,
		readonly label: string,
	) {}

	add(bytes: number): number {
		this.receivedBytes += bytes;
		if (this.maxBytes >= 0 && this.receivedBytes > this.maxBytes) {
			throw new StreamSizeLimitError(this.label, this.maxBytes, this.receivedBytes);
		}
		return this.receivedBytes;
	}

	get total(): number {
		return this.receivedBytes;
	}
}

/**
 * Read from a stream reader with a per-read inactivity timeout.
 * Each successful read resets the timer. If the timer fires before
 * `reader.read()` resolves, the reader is cancelled and a
 * `StreamStaleError` is thrown.
 */
export async function readWithTimeout<T>(
	reader: ReadableStreamDefaultReader<T>,
	timeoutMs = DEFAULT_STALE_TIMEOUT_MS,
): Promise<ReadableStreamDefaultReadValueResult<T> | ReadableStreamDefaultReadDoneResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reader.cancel("Stream stale timeout").catch(() => {});
			reject(new StreamStaleError(timeoutMs));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([reader.read(), timeout]);
		return result;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
