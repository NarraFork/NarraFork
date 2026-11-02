import { describe, expect, test } from "bun:test";
import { createNativeMediaDumpEncoder, redactNativeMediaForDump } from "../native-media";
import { createRequestBodyEncoder, stringifyRequestBody } from "../request-json";

describe("bounded request JSON", () => {
	test("matches JSON.stringify across large strings, surrogate boundaries and omitted values", async () => {
		const text = `${"x".repeat(65535)}\ud83d\ude80\ud800\n\t"\\${"y".repeat(100000)}`;
		const body = {
			input: [{ text, missing: undefined, callable: () => 1, symbol: Symbol("omitted") }],
			array: [undefined, NaN, Infinity, -Infinity, -0, null, true, false, ""],
			sparse: new Array(4),
			tools: Array.from({ length: 600 }, (_, i) => ({
				name: `tool-${i}`,
				parameters: { type: "object" },
			})),
			date: new Date("2026-10-30T00:00:00.000Z"),
			bytes: new Uint8Array([0, 127, 255]),
			signed: new Int16Array([-32768, 0, 32767]),
			floats: new Float32Array([1.5, NaN, Infinity]),
			buffer: Buffer.from([0, 127, 255]),
			view: new DataView(new ArrayBuffer(4)),
		};
		expect(await stringifyRequestBody(body)).toBe(JSON.stringify(body));
	});

	test("retry reuses large tools/history fragments while root fields can change", async () => {
		let reads = 0;
		const tools = [
			{
				get description() {
					reads++;
					return "x".repeat(100000);
				},
				name: "Read",
			},
		];
		const body: Record<string, unknown> = {
			tools,
			input: [{ text: "history" }],
			max_output_tokens: 1,
		};
		const encode = createRequestBodyEncoder();
		const first = await encode(body);
		const beforeRetry = reads;
		delete body.max_output_tokens;
		body.service_tier = "priority";
		const second = await encode(body);
		expect(reads).toBe(beforeRetry);
		expect(JSON.parse(first).tools).toEqual(JSON.parse(second).tools);
		expect(JSON.parse(second)).not.toHaveProperty("max_output_tokens");
		expect(JSON.parse(second).service_tier).toBe("priority");
	});

	test("abort is caller-local while another large caller continues", async () => {
		const controller = new AbortController();
		const reason = new Error("cancel this request");
		const a = stringifyRequestBody({ text: "a".repeat(4 * 1024 * 1024) }, controller.signal);
		const b = stringifyRequestBody({ text: "b".repeat(256 * 1024) }, new AbortController().signal);
		controller.abort(reason);
		await expect(a).rejects.toBe(reason);
		expect(JSON.parse(await b).text).toHaveLength(256 * 1024);
		await expect(stringifyRequestBody({ text: "never" }, controller.signal)).rejects.toBe(reason);
	});

	test("no-media diagnostics reuse wire text without revisiting large tool schemas", async () => {
		let dispatched = false;
		const body = {
			input: [{ type: "message", content: [{ type: "input_text", text: "hello" }] }],
			tools: [
				{
					get description() {
						if (dispatched) throw new Error("dump traversed tools again");
						return "x".repeat(100000);
					},
					parameters: { bytes: new Uint8Array([1, 2, 3]) },
				},
			],
		};
		const wire = await stringifyRequestBody(body);
		dispatched = true;
		expect(await createNativeMediaDumpEncoder()(body, wire)).toBe(wire);
	});

	test("large media diagnostics use shallow transforms, preserve wire, and reuse retry fragments", async () => {
		const bytes = "a".repeat(100000);
		let dispatched = false;
		const body: Record<string, unknown> = {
			messages: [
				{
					content: [
						{ type: "input_audio", input_audio: { data: bytes, format: "wav" } },
						{ type: "video_url", video_url: { url: `data:video/mp4;base64,${bytes}` } },
						{ type: "input_video", video_url: `data:video/mp4;base64,${bytes}` },
					],
				},
			],
			contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: bytes } }] }],
			input: [
				{ type: "user_input", content: [{ type: "video", mime_type: "video/mp4", data: bytes }] },
			],
			tools: [
				{
					get description() {
						if (dispatched) throw new Error("retry traversed tools again");
						return "x".repeat(100000);
					},
					parameters: { bytes: new Uint8Array([1, 2, 3]) },
				},
			],
			max_tokens: 10,
		};
		const expected = JSON.stringify(redactNativeMediaForDump(body));
		const encodeWire = createRequestBodyEncoder();
		const encodeDump = createNativeMediaDumpEncoder();
		const wire = await encodeWire(body);
		const dump = await encodeDump(body, wire);
		expect(dump).toBe(expected);
		expect(wire).toContain(bytes);
		expect(dump).not.toContain(bytes);
		expect(dump).toContain("native media omitted");
		dispatched = true;
		delete body.max_tokens;
		const retryWire = await encodeWire(body);
		const retryDump = await encodeDump(body, retryWire);
		const expectedRetry = JSON.parse(dump);
		delete expectedRetry.max_tokens;
		expect(JSON.parse(retryDump)).toEqual(expectedRetry);
		expect(JSON.parse(retryDump)).not.toHaveProperty("max_tokens");
		expect(JSON.parse(retryDump).messages).toEqual(JSON.parse(dump).messages);
		expect(retryWire).toContain(bytes);
	});

	test("cancelling media diagnostic encoding is caller-local and leaves wire bytes unchanged", async () => {
		const body = {
			messages: [
				{ content: [{ type: "input_audio", input_audio: { data: "secret", format: "wav" } }] },
			],
			tools: [{ description: "x".repeat(4 * 1024 * 1024) }],
		};
		const controller = new AbortController();
		const reason = new Error("cancel diagnostic encoding");
		const cancelled = createNativeMediaDumpEncoder()(body, "wire", controller.signal);
		const other = createNativeMediaDumpEncoder()(
			{ messages: body.messages, text: "x".repeat(100000) },
			"other wire",
		);
		const timer = setTimeout(() => controller.abort(reason), 0);
		try {
			await expect(cancelled).rejects.toBe(reason);
			expect(await other).not.toContain("secret");
			expect(body.messages[0].content[0].input_audio.data).toBe("secret");
			await expect(createNativeMediaDumpEncoder()(body, "wire", controller.signal)).rejects.toBe(
				reason,
			);
		} finally {
			clearTimeout(timer);
		}
	});

	test("circular values and BigInt reject rather than truncating", async () => {
		const cycle: Record<string, unknown> = { text: "x".repeat(40000) };
		cycle.self = cycle;
		await expect(stringifyRequestBody(cycle)).rejects.toThrow("circular");
		await expect(stringifyRequestBody({ value: 1n })).rejects.toThrow();
	});
});
