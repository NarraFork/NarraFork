import { describe, expect, test } from "bun:test";
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

	test("circular values and BigInt reject rather than truncating", async () => {
		const cycle: Record<string, unknown> = { text: "x".repeat(40000) };
		cycle.self = cycle;
		await expect(stringifyRequestBody(cycle)).rejects.toThrow("circular");
		await expect(stringifyRequestBody({ value: 1n })).rejects.toThrow();
	});
});
