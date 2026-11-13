import { expect, test } from "bun:test";
import { readBoundedBlob } from "./bounded-blob";

test("bounded resource reader preserves bytes and MIME", async () => {
	const blob = await readBoundedBlob(
		new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
		3,
	);
	expect(blob.type).toBe("image/png");
	expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});
test("oversize advertised content is cancelled before any chunk is read", async () => {
	let cancelled = false;
	const stream = new ReadableStream({
		cancel() {
			cancelled = true;
		},
	});
	await expect(
		readBoundedBlob(new Response(stream, { headers: { "content-length": "9" } }), 8),
	).rejects.toThrow("RESOURCE_TOO_LARGE");
	expect(cancelled).toBe(true);
});
test("stream without content length is cancelled exactly at the byte budget", async () => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(5));
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(readBoundedBlob(new Response(stream), 8)).rejects.toThrow("RESOURCE_TOO_LARGE");
	expect(cancelled).toBe(true);
});
test("abort releases a stalled resource reader", async () => {
	const controller = new AbortController();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const reading = readBoundedBlob(new Response(stream), 8, controller.signal);
	controller.abort();
	await expect(reading).rejects.toThrow();
	expect(cancelled).toBe(true);
});
