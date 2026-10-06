import { describe, expect, test } from "bun:test";
import { readWithTimeout, StreamStaleError } from "../stream-timeout";

/** A stream that emits `chunks` and then stalls forever without closing. */
function stallingStream(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			// Deliberately never closes — emulates a half-open upstream connection.
		},
	});
}

describe("readWithTimeout", () => {
	test("returns buffered chunks without waiting for the timeout", async () => {
		const reader = stallingStream("a", "b").getReader();

		const first = await readWithTimeout(reader, 50);
		const second = await readWithTimeout(reader, 50);

		expect(first.done).toBe(false);
		expect(second.done).toBe(false);
	});

	/**
	 * Regression: the timer used to call `reader.cancel()` before `reject()`. Cancelling
	 * settles the pending `read()` with `{ done: true }`, which then won the Promise.race
	 * — so a stalled stream resolved as a clean end-of-stream. Callers saw a normal
	 * completion, skipped the retry path, and silently truncated the turn.
	 */
	test("throws StreamStaleError instead of reporting a clean end-of-stream", async () => {
		const reader = stallingStream("a").getReader();
		await readWithTimeout(reader, 50);

		let caught: unknown;
		let resolved: unknown;
		try {
			resolved = await readWithTimeout(reader, 50);
		} catch (err) {
			caught = err;
		}

		expect(resolved).toBeUndefined();
		expect(caught).toBeInstanceOf(StreamStaleError);
	});

	test("propagates a genuine end-of-stream as done", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});

		const result = await readWithTimeout(body.getReader(), 50);

		expect(result.done).toBe(true);
	});
});
