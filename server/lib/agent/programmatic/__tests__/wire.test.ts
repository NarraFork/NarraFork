import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { PROGRAMMATIC_LIMITS } from "../protocol";
import { BoundedStderr, NdjsonFrames, NdjsonWriter, WireBudget } from "../wire";

async function collect(frames: NdjsonFrames) {
	const result: string[] = [];
	for await (const frame of frames) result.push(frame);
	return result;
}

describe("bounded NDJSON", () => {
	test("split UTF8 survives byte boundaries", async () => {
		const frames = new NdjsonFrames(new WireBudget(), () => {});
		for (const byte of Buffer.from('{"text":"你好"}\n{}\n')) frames.push(Uint8Array.of(byte));
		frames.finish();
		expect(await collect(frames)).toEqual(['{"text":"你好"}', "{}"]);
	});
	test("fatal UTF8, blank, invalid JSON and truncated frames reject", async () => {
		for (const data of [
			Buffer.from([0xff, 10]),
			Buffer.from("\n"),
			Buffer.from("no\n"),
			Buffer.from("{}"),
		]) {
			const frames = new NdjsonFrames(new WireBudget(), () => {});
			frames.push(data);
			frames.finish();
			await expect(collect(frames)).rejects.toThrow();
		}
	});
	test("EOF cannot suppress subsequent cancellation or preserve queued success", async () => {
		let failures = 0;
		const frames = new NdjsonFrames(new WireBudget(), () => {
			failures++;
		});
		frames.push(Buffer.from('{"ok":true}\n'));
		frames.finish();
		frames.fail(new Error("cancelled"));
		frames.fail(new Error("later"));
		await expect(collect(frames)).rejects.toThrow("cancelled");
		expect(failures).toBe(1);
	});
	test("oversized single frames, total bytes, and idle queue are bounded", async () => {
		const oversized = new NdjsonFrames(new WireBudget(), () => {});
		oversized.push(Buffer.alloc(PROGRAMMATIC_LIMITS.wireFrameBytes + 1, 32));
		await expect(collect(oversized)).rejects.toThrow("too large");
		const total = new NdjsonFrames(new WireBudget(5), () => {});
		total.push(Buffer.from("{}\n{}\n"));
		await expect(collect(total)).rejects.toThrow("transfer budget");
		const idle = new NdjsonFrames(new WireBudget(), () => {});
		idle.push(Buffer.from("{}\n".repeat(1025)));
		await expect(collect(idle)).rejects.toThrow("pending frame limit");
	});
	test("writer serializes under backpressure and refuses after closing", async () => {
		const written: string[] = [];
		let release: (() => void) | undefined;
		const stream = new Writable({
			highWaterMark: 1,
			write(chunk, _encoding, callback) {
				written.push(String(chunk));
				release = () => callback();
			},
		});
		const writer = new NdjsonWriter(stream, new WireBudget(), () => {});
		const first = writer.send('{"a":1}');
		const second = writer.send('{"b":2}');
		await Promise.resolve();
		expect(written).toEqual(['{"a":1}\n']);
		release?.();
		await first;
		await Promise.resolve();
		expect(written).toEqual(['{"a":1}\n', '{"b":2}\n']);
		release?.();
		await second;
		writer.close();
		await expect(writer.send("{}")).rejects.toThrow("closed");
	});
	test("cancel rejects a blocked write; newline injection writes nothing", async () => {
		const blocked = new NdjsonWriter(new Writable({ write() {} }), new WireBudget(), () => {});
		const pending = blocked.send("{}");
		await Promise.resolve();
		blocked.close();
		await expect(pending).rejects.toThrow("closed");
		let writes = 0;
		const writer = new NdjsonWriter(
			new Writable({
				write(_c, _e, callback) {
					writes++;
					callback();
				},
			}),
			new WireBudget(),
			() => {},
		);
		await expect(writer.send("{}\n{}")).rejects.toThrow("literal newlines");
		expect(writes).toBe(0);
	});
	test("stderr drains but retains only head and tail", () => {
		let stopped = 0;
		const stderr = new BoundedStderr(() => {
			stopped++;
		}, 40000);
		stderr.push(Buffer.alloc(20000, 65));
		stderr.push(Buffer.alloc(100000, 66));
		stderr.push(Buffer.alloc(100000, 67));
		expect(stderr.text().length).toBeLessThan(33000);
		expect(stderr.text().startsWith("A".repeat(100))).toBe(true);
		expect(stderr.text().endsWith("C".repeat(100))).toBe(true);
		expect(stopped).toBe(1);
	});
});
