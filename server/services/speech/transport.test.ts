import { describe, expect, test } from "bun:test";
import { decodeAudio, type SpeechResponse, speechError, sseEvents, timed } from "./transport";

function response(parts: string[], closed: () => void = () => {}): SpeechResponse {
	return {
		headers: new Headers(),
		close: closed,
		async *bytes() {
			for (const part of parts) yield new TextEncoder().encode(part);
		},
	};
}
async function collect(source: AsyncIterable<unknown>) {
	const result = [];
	for await (const item of source) result.push(item);
	return result;
}

describe("speech transport", () => {
	test("safe error status distinguishes invalid input, timeout, abort and upstream failure", () => {
		for (const code of [
			"SPEECH_INVALID_INPUT",
			"SPEECH_UNSUPPORTED_FORMAT",
			"SPEECH_UNSUPPORTED_STREAMING",
			"SPEECH_UNSUPPORTED_INSTRUCTIONS",
		])
			expect(speechError(code).statusCode).toBe(400);
		expect(speechError("SPEECH_TIMEOUT").statusCode).toBe(504);
		expect(speechError("SPEECH_ABORTED").statusCode).toBe(499);
		expect(speechError().statusCode).toBe(502);
	});
	test("SSE handles CRLF split, multiline data, comments, and EOF tail", async () => {
		let closed = false;
		const events = await collect(
			sseEvents(
				response(
					[": hello\r", '\ndata: {\r\ndata: "text":"你"}\r', '\n\r\ndata: {"text":"tail"}'],
					() => {
						closed = true;
					},
				),
			),
		);
		expect(events).toEqual([{ text: "你" }, { text: "tail" }]);
		expect(closed).toBe(true);
	});
	test("DONE ignores subsequent events", async () => {
		expect(await collect(sseEvents(response(["data: [DONE]\n\ndata: not-json\n\n"])))).toEqual([]);
	});
	test("provider errors and malformed trailing frames are safe", async () => {
		for (const frame of [
			"event: error\ndata: secret\n\n",
			'data: {"error":"credential secret"}',
			'data: {"code":"Forbidden","message":"secret"}',
			"data: broken",
		]) {
			try {
				await collect(sseEvents(response([frame])));
				throw new Error("unexpected success");
			} catch (error) {
				expect(String(error)).not.toContain("secret");
				expect(String(error)).toContain("Speech request");
			}
		}
	});
	test("base64 is canonical and bounded, not Buffer's permissive decoder", () => {
		expect([...decodeAudio("AQI=")]).toEqual([1, 2]);
		for (const value of ["%%%", "AQI", "AR==", "AQI=\n", "AQI===", "AQ-I"])
			expect(() => decodeAudio(value)).toThrow();
	});
	test("explicit completion is required and EOF stop frame is accepted", async () => {
		await expect(
			collect(sseEvents(response(['data: {"text":"partial"}\n\n']), true)),
		).rejects.toMatchObject({ code: "SPEECH_INCOMPLETE_RESPONSE" });
		expect(
			await collect(sseEvents(response(['data: {"output":{"finish_reason":"stop"}}']), true)),
		).toEqual([{ output: { finish_reason: "stop" } }]);
		await expect(
			collect(sseEvents(response(['data: {"choices":[{"finish_reason":"length"}]}\n\n']), true)),
		).rejects.toMatchObject({ code: "SPEECH_INCOMPLETE_RESPONSE" });
	});
	test("UTF8 code points may split across fetch chunks", async () => {
		const bytes = new TextEncoder().encode('data: {"text":"你好"}\n\n');
		const source: SpeechResponse = {
			headers: new Headers(),
			close() {},
			async *bytes() {
				for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1);
			},
		};
		expect(await collect(sseEvents(source))).toEqual([{ text: "你好" }]);
	});
	test("oversized SSE frame is rejected without JSON parsing", async () => {
		await expect(
			collect(sseEvents(response([`data: ${"x".repeat(16 * 1024 * 1024)}`]))),
		).rejects.toMatchObject({ code: "SPEECH_FRAME_LIMIT" });
	});
	test("idle wait and caller cancellation are bounded", async () => {
		await expect(
			timed(new Promise(() => {}), new AbortController().signal, 5),
		).rejects.toMatchObject({ code: "SPEECH_TIMEOUT" });
		const controller = new AbortController();
		const pending = timed(new Promise(() => {}), controller.signal, 1000);
		controller.abort("private reason");
		await expect(pending).rejects.toMatchObject({ code: "SPEECH_ABORTED" });
	});
});
