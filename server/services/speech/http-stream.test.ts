import { expect, test } from "bun:test";
import { readSpeechBody, speechResponseStream } from "./http-stream";

test("upload limit is enforced while reading chunked requests", async () => {
	let cancelled = false;
	const request = new Request("https://local.invalid", {
		method: "POST",
		body: new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array(3));
				c.enqueue(new Uint8Array(3));
			},
			cancel() {
				cancelled = true;
			},
		}),
	});
	await expect(readSpeechBody(request, 5, new AbortController().signal)).rejects.toThrow("large");
	expect(cancelled).toBe(true);
});

test("content-length preflight does not read body", async () => {
	const request = new Request("https://local.invalid", {
		method: "POST",
		headers: { "content-length": "100" },
		body: "x",
	});
	await expect(readSpeechBody(request, 5, new AbortController().signal)).rejects.toThrow("large");
	expect(request.bodyUsed).toBe(false);
});

test("abort interrupts pending upload read", async () => {
	let cancelled = false;
	const request = new Request("https://local.invalid", {
		method: "POST",
		body: new ReadableStream({
			cancel() {
				cancelled = true;
			},
		}),
	});
	const controller = new AbortController();
	const pending = readSpeechBody(request, 5, controller.signal);
	controller.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled");
	expect(cancelled).toBe(true);
});

test("audio pulls are driven by consumer and cancel closes generator", async () => {
	let count = 0;
	let closed = 0;
	let cleaned = false;
	async function* source() {
		try {
			for (let i = 0; i < 10; i++) {
				count++;
				yield new Uint8Array([i]);
			}
		} finally {
			cleaned = true;
		}
	}
	const iterator = source();
	const first = await iterator.next();
	const stream = speechResponseStream(
		iterator,
		first,
		new AbortController().signal,
		() => closed++,
	);
	await Promise.resolve();
	expect(count).toBe(1);
	const reader = stream.getReader();
	expect((await reader.read()).value).toEqual(new Uint8Array([0]));
	expect(count).toBe(1);
	await reader.cancel();
	expect(cleaned).toBe(true);
	expect(closed).toBe(1);
});

test("stream abort propagates and normal end closes once", async () => {
	let closed = 0;
	async function* source() {
		yield new Uint8Array([1]);
	}
	const iterator = source();
	const first = await iterator.next();
	const controller = new AbortController();
	const stream = speechResponseStream(iterator, first, controller.signal, () => closed++);
	const reader = stream.getReader();
	await reader.read();
	expect((await reader.read()).done).toBe(true);
	controller.abort();
	expect(closed).toBe(1);
	const other = source();
	const next = await other.next();
	const abort = new AbortController();
	const active = speechResponseStream(other, next, abort.signal, () => {});
	abort.abort();
	await expect(active.getReader().read()).rejects.toThrow("interrupted");
});
