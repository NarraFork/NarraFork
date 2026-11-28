import { describe, expect, test } from "bun:test";
import { StreamSizeLimitError } from "../../stream-timeout";
import { readSseFrames, type SseFrame } from "../sse-frames";

const encoder = new TextEncoder();
const MAX_EVENT_BYTES = 32 * 1024 * 1024;

function streamOf(text: string, chunkBytes = Infinity): ReadableStream<Uint8Array> {
	const bytes = encoder.encode(text);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset === bytes.length) {
				controller.close();
				return;
			}
			const end = Math.min(offset + chunkBytes, bytes.length);
			controller.enqueue(bytes.subarray(offset, end));
			offset = end;
		},
	});
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
	const frames = [];
	for await (const frame of readSseFrames(body)) frames.push(frame);
	return frames;
}

function trackedStream(text: string, close = false, cancelError?: Error) {
	let cancellations = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			if (close) controller.close();
		},
		cancel() {
			cancellations++;
			if (cancelError) throw cancelError;
		},
	});
	return { body, cancellations: () => cancellations };
}

describe("bounded shared SSE frames", () => {
	test.each([
		"\n",
		"\r\n",
		"\r",
	])("frames multiline JSON with %j across UTF-8 byte chunks", async (eol) => {
		const lines = [
			"\uFEFF: heartbeat",
			"event: custom",
			'data:{"text":',
			'data: "中文𠀀",',
			'data: "values": [',
			"data: {}",
			"data: ]}",
			"",
			"event: unused",
			": heartbeat",
			"",
			"data:done at EOF",
		];
		const frames = await collect(streamOf(lines.join(eol), 1));
		expect(frames).toHaveLength(2);
		expect(frames[0].event).toBe("custom");
		expect(JSON.parse(frames[0].data)).toEqual({ text: "中文𠀀", values: [{}] });
		expect(frames[1]).toEqual({ event: "", data: "done at EOF" });
	});

	test("preserves data whitespace, empty fields and embedded BOM", async () => {
		const frames = await collect(
			streamOf("event: first\nevent: last\ndata:  leading \ndata\ndata:\ndata:\uFEFF\n\n"),
		);
		expect(frames).toEqual([{ event: "last", data: " leading \n\n\n\uFEFF" }]);
		expect(await collect(streamOf("event: ignored\nid: 7\nretry: 2\n\n"))).toEqual([]);
	});

	test("does not emit until a standard frame is delimited", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				controller.enqueue(encoder.encode('data: {"first":1}\n'));
			},
		});
		const frames = readSseFrames(body);
		let emitted = false;
		const next = frames.next().then((value) => {
			emitted = true;
			return value;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(emitted).toBe(false);
		controller.enqueue(encoder.encode("\n"));
		expect((await next).value).toEqual({ event: "", data: '{"first":1}' });
		await frames.return(undefined);
		expect(body.locked).toBe(false);
	});

	test("supports missing-blank-line JSON relays without merging event names", async () => {
		const text =
			'event: first\ndata:{"first":1}\nevent: second\ndata: {"second":2}\n' +
			'data:{"third":3}\ndata:[DONE]';
		expect(await collect(streamOf(text, 3))).toEqual([
			{ event: "first", data: '{"first":1}' },
			{ event: "second", data: '{"second":2}' },
			{ event: "", data: '{"third":3}' },
			{ event: "", data: "[DONE]" },
		]);
	});

	test("does not split a complete JSON value followed by whitespace data", async () => {
		expect(await collect(streamOf('data: {"ok":true}\ndata:  \n\n'))).toEqual([
			{ event: "", data: '{"ok":true}\n ' },
		]);
	});

	test("EOF flush keeps a trailing event name and error payload", async () => {
		expect(await collect(streamOf('event: error\rdata:{"message":\rdata:"failure"}', 2))).toEqual([
			{ event: "error", data: '{"message":\n"failure"}' },
		]);
	});

	test("early return cancels and releases the owned reader", async () => {
		const tracked = trackedStream('data: {"ok":true}\n\n');
		for await (const _frame of readSseFrames(tracked.body)) break;
		expect(tracked.cancellations()).toBe(1);
		expect(tracked.body.locked).toBe(false);
	});

	test("consumer errors survive cancellation errors and release the lock", async () => {
		const tracked = trackedStream("data: ready\n\n", false, new Error("cancel failure"));
		const failure = new Error("consumer failure");
		const consume = async () => {
			for await (const _frame of readSseFrames(tracked.body)) throw failure;
		};
		await expect(consume()).rejects.toBe(failure);
		expect(tracked.cancellations()).toBe(1);
		expect(tracked.body.locked).toBe(false);
	});

	test.each([
		"return",
		"throw",
	])("%s releases the reader even if cancellation never settles", async (exit) => {
		let cancellations = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: ready\n\n"));
			},
			cancel() {
				cancellations++;
				return new Promise<void>(() => {});
			},
		});
		const frames = readSseFrames(body);
		await frames.next();
		if (exit === "return") {
			await expect(frames.return(undefined)).resolves.toEqual({ done: true, value: undefined });
		} else {
			const failure = new Error("consumer failure");
			await expect(frames.throw(failure)).rejects.toBe(failure);
		}
		expect(cancellations).toBe(1);
		expect(body.locked).toBe(false);
	});

	test("generator throw cancels, while normal EOF does not", async () => {
		const tracked = trackedStream("data: ready\n\n");
		const frames = readSseFrames(tracked.body);
		await frames.next();
		const failure = new Error("abort");
		await expect(frames.throw(failure)).rejects.toBe(failure);
		expect(tracked.cancellations()).toBe(1);
		expect(tracked.body.locked).toBe(false);
		const normal = trackedStream("data: last", true);
		expect(await collect(normal.body)).toEqual([{ event: "", data: "last" }]);
		expect(normal.cancellations()).toBe(0);
		expect(normal.body.locked).toBe(false);
	});

	test("transport cancellation rejects the read and releases the lock", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		});
		const frames = readSseFrames(body);
		const next = frames.next();
		const failure = new DOMException("cancelled", "AbortError");
		controller.error(failure);
		await expect(next).rejects.toBe(failure);
		expect(body.locked).toBe(false);
	});

	test.each([
		"data: ",
		":",
		"unknown:",
	])("caps an unterminated %s line and cancels", async (prefix) => {
		const tracked = trackedStream(prefix + "x".repeat(MAX_EVENT_BYTES));
		await expect(collect(tracked.body)).rejects.toBeInstanceOf(StreamSizeLimitError);
		expect(tracked.cancellations()).toBe(1);
		expect(tracked.body.locked).toBe(false);
	});

	test("caps accumulated multiline data, even when every line is short enough", async () => {
		const tracked = trackedStream(`data: ${"x".repeat(1024 * 1024)}\n`.repeat(33));
		await expect(collect(tracked.body)).rejects.toThrow("SSE event exceeded hard limit");
		expect(tracked.cancellations()).toBe(1);
	});

	test("caps no-data frames composed only of comments", async () => {
		const tracked = trackedStream(`: ${"x".repeat(1024 * 1024)}\n`.repeat(33));
		await expect(collect(tracked.body)).rejects.toThrow("SSE event exceeded hard limit");
		expect(tracked.body.locked).toBe(false);
	});

	test("enforces bytes, not JS characters", async () => {
		const tracked = trackedStream(`data:${"界".repeat(Math.floor(MAX_EVENT_BYTES / 3))}`);
		await expect(collect(tracked.body)).rejects.toBeInstanceOf(StreamSizeLimitError);
	});

	test("does not cap an entire legal long stream or monopolize a huge chunk", async () => {
		const value = "x".repeat(1024 * 1024);
		const text = `data:${value}\n\n`.repeat(34);
		let turnYielded = false;
		const timer = setTimeout(() => {
			turnYielded = true;
		}, 0);
		try {
			const frames = await collect(streamOf(text));
			expect(frames).toHaveLength(34);
			expect(frames[0].data.length).toBe(value.length);
			expect(turnYielded).toBe(true);
		} finally {
			clearTimeout(timer);
		}
	});

	test("bounds events independently on the nonstandard no-blank-line path", async () => {
		const data = JSON.stringify({ text: "x".repeat(17 * 1024 * 1024) });
		const frames = await collect(streamOf(`data:${data}\ndata:${data}\n`, 64 * 1024));
		expect(frames).toHaveLength(2);
		expect(frames[0].data.length).toBe(data.length);
		expect(frames[1].data.length).toBe(data.length);
	});
});
