import { afterEach, describe, expect, test } from "bun:test";
import { setOutboundFetchOverrideForTest } from "@server/lib/net/outbound-fetch";
import type { SpeechProvider } from "@shared/speech";
import { getCapabilities, synthesize, transcribe } from "./adapters";

const signal = () => new AbortController().signal;
const provider: SpeechProvider = {
	id: "speech",
	name: "Speech",
	enabled: true,
	baseUrl: "https://speech.invalid/v1",
	apiKey: "private-key",
	proxy: { mode: "direct" },
};
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of items) result.push(item);
	return result;
}
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
afterEach(() => setOutboundFetchOverrideForTest(null));

describe("speech adapters", () => {
	test("multipart transcription uses JSON and never follows redirects", async () => {
		setOutboundFetchOverrideForTest(async (url, init) => {
			expect(String(url)).toBe("https://speech.invalid/v1/audio/transcriptions");
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
			const form = init?.body as FormData;
			expect(form.get("response_format")).toBe("json");
			expect(form.get("language")).toBe("zh");
			expect(form.get("file")).toBeInstanceOf(File);
			return Response.json({ text: "你好" });
		});
		expect(
			await collect(
				transcribe(
					{ ...provider, asr: { protocol: "openai-transcription", model: "whisper" } },
					{ audio: new Uint8Array([1]), mimeType: "audio/wav", language: "zh" },
					signal(),
				),
			),
		).toEqual([{ type: "done", text: "你好" }]);
	});
	test("chat ASR sends Data URL and explicit Qwen ITN, emits final text", async () => {
		setOutboundFetchOverrideForTest(async (_, init) => {
			const body = JSON.parse(String(init?.body));
			expect(body.asr_options).toEqual({ enable_itn: false });
			expect(body.messages[0].content[0].input_audio.data).toBe("data:audio/wav;base64,AQ==");
			return new Response(
				sse({ choices: [{ delta: { content: "你" } }] }) +
					sse({ choices: [{ delta: { content: "好" } }] }) +
					"data: [DONE]\n\n",
			);
		});
		expect(
			await collect(
				transcribe(
					{
						...provider,
						asr: {
							protocol: "chat-completions-asr",
							model: "qwen",
							variant: "qwen",
							enableItn: false,
							streaming: true,
						},
					},
					{ audio: new Uint8Array([1]), mimeType: "audio/wav", stream: true },
					signal(),
				),
			),
		).toEqual([
			{ type: "delta", text: "你" },
			{ type: "delta", text: "好" },
			{ type: "done", text: "你好" },
		]);
	});
	test("MiMo rejects unsupported and encoded-over-limit audio before fetch", async () => {
		let calls = 0;
		setOutboundFetchOverrideForTest(async () => {
			calls++;
			return new Response();
		});
		const config: SpeechProvider = {
			...provider,
			asr: { protocol: "chat-completions-asr", model: "mimo", variant: "mimo" },
		};
		for (const input of [
			{ audio: new Uint8Array([1]), mimeType: "audio/ogg" },
			{ audio: new Uint8Array(8 * 1024 * 1024), mimeType: "audio/wav" },
		])
			await expect(collect(transcribe(config, input, signal()))).rejects.toMatchObject({
				code: "SPEECH_INVALID_INPUT",
			});
		expect(calls).toBe(0);
	});
	test("openai speech streams binary with real PCM metadata", async () => {
		setOutboundFetchOverrideForTest(async (url, init) => {
			expect(String(url)).toEndWith("/audio/speech");
			expect(JSON.parse(String(init?.body)).response_format).toBe("pcm");
			return new Response(new Uint8Array([1, 2]));
		});
		const output = await synthesize(
			{
				...provider,
				tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "pcm16" },
			},
			{ text: "test" },
			signal(),
		);
		expect(output.metadata).toEqual({
			format: "pcm16",
			mimeType: "audio/pcm",
			sampleRate: 24000,
			channels: 1,
		});
		expect((await collect(output.audio)).flatMap((x) => [...x])).toEqual([1, 2]);
	});
	test("DashScope variants have distinct endpoints and fields; final URL is ignored", async () => {
		for (const variant of ["qwen-tts", "qwen-audio-tts"] as const) {
			setOutboundFetchOverrideForTest(async (url, init) => {
				expect(String(url)).toEndWith(
					variant === "qwen-tts"
						? "/services/aigc/multimodal-generation/generation"
						: "/services/audio/tts/SpeechSynthesizer",
				);
				expect(new Headers(init?.headers).get("X-DashScope-SSE")).toBe("enable");
				expect(JSON.parse(String(init?.body)).input).toEqual(
					variant === "qwen-tts"
						? { text: "test", voice: "Cherry" }
						: {
								text: "test",
								voice: "Cherry",
								format: "pcm",
								sample_rate: 24000,
								instruction: "calm",
							},
				);
				return new Response(
					sse({ output: { audio: { data: "AQI=" } } }) +
						sse({
							output: {
								finish_reason: "stop",
								audio: { url: "https://private.invalid/?key=secret" },
							},
						}),
				);
			});
			const output = await synthesize(
				{
					...provider,
					tts: {
						protocol: "dashscope-tts",
						model: "qwen",
						voice: "Cherry",
						format: "pcm16",
						variant,
					},
				},
				{ text: "test", ...(variant === "qwen-audio-tts" ? { instructions: "calm" } : {}) },
				signal(),
			);
			expect((await collect(output.audio)).flatMap((x) => [...x])).toEqual([1, 2]);
		}
	});
	test("URL-only output fails without downloading", async () => {
		let calls = 0;
		setOutboundFetchOverrideForTest(async () => {
			calls++;
			return new Response(
				sse({
					output: { finish_reason: "stop", audio: { url: "https://private.invalid/secret" } },
				}),
			);
		});
		const output = await synthesize(
			{
				...provider,
				tts: {
					protocol: "dashscope-tts",
					model: "qwen",
					voice: "Cherry",
					format: "pcm16",
					variant: "qwen-tts",
				},
			},
			{ text: "test" },
			signal(),
		);
		await expect(collect(output.audio)).rejects.toMatchObject({ code: "SPEECH_NO_AUDIO" });
		expect(calls).toBe(1);
	});
	test("MiMo targets assistant text and separates user instructions", async () => {
		setOutboundFetchOverrideForTest(async (_, init) => {
			expect(JSON.parse(String(init?.body)).messages).toEqual([
				{ role: "user", content: "calm" },
				{ role: "assistant", content: "test" },
			]);
			return new Response(
				sse({ choices: [{ delta: { audio: { data: "AQI=" } }, finish_reason: "stop" }] }),
			);
		});
		const config: SpeechProvider = {
			...provider,
			tts: {
				protocol: "chat-completions-tts",
				model: "mimo",
				voice: "default",
				format: "pcm16",
				streaming: true,
			},
		};
		expect(getCapabilities(config).tts?.formats).toEqual(["pcm16"]);
		expect(
			(
				await collect(
					(
						await synthesize(config, { text: "test", instructions: "calm" }, signal())
					).audio,
				)
			).length,
		).toBe(1);
		await expect(
			synthesize(config, { text: "test", format: "wav" }, signal()),
		).rejects.toMatchObject({ code: "SPEECH_UNSUPPORTED_FORMAT" });
	});
	test("consumer break cancels upstream reader, abort cancels even unconsumed output", async () => {
		let cancelled = 0;
		setOutboundFetchOverrideForTest(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2]));
						},
						cancel() {
							cancelled++;
						},
					}),
				),
		);
		const config: SpeechProvider = {
			...provider,
			tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "pcm16" },
		};
		for await (const _ of (await synthesize(config, { text: "test" }, signal())).audio) break;
		expect(cancelled).toBe(1);
		const controller = new AbortController();
		await synthesize(config, { text: "test" }, controller.signal);
		controller.abort();
		expect(cancelled).toBe(2);
	});
	test("real HTTP POST does not follow redirects or retry paid requests", async () => {
		setOutboundFetchOverrideForTest(null);
		let calls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				calls++;
				expect(request.method).toBe("POST");
				return calls === 1
					? new Response(null, { status: 307, headers: { Location: "/private" } })
					: new Response("private", { status: 503 });
			},
		});
		try {
			const config: SpeechProvider = {
				...provider,
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "mp3" },
			};
			await expect(synthesize(config, { text: "test" }, signal())).rejects.toMatchObject({
				code: "SPEECH_UPSTREAM_ERROR",
			});
			expect(calls).toBe(1);
			await expect(synthesize(config, { text: "test" }, signal())).rejects.toMatchObject({
				code: "SPEECH_UPSTREAM_ERROR",
			});
			expect(calls).toBe(2);
		} finally {
			await server.stop(true);
		}
	});
	test("binary output cap is enforced before oversized bytes are yielded", async () => {
		setOutboundFetchOverrideForTest(async () => new Response(new Uint8Array(32 * 1024 * 1024 + 1)));
		const output = await synthesize(
			{
				...provider,
				tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "pcm16" },
			},
			{ text: "test" },
			signal(),
		);
		await expect(collect(output.audio)).rejects.toMatchObject({ code: "SPEECH_OUTPUT_LIMIT" });
	});
	test("HTTP 200 JSON error is not relabelled as audio", async () => {
		setOutboundFetchOverrideForTest(async () => Response.json({ error: "private" }));
		await expect(
			synthesize(
				{
					...provider,
					tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "mp3" },
				},
				{ text: "test" },
				signal(),
			),
		).rejects.toMatchObject({ code: "SPEECH_INVALID_AUDIO" });
	});
	test("aborting an active stalled read rejects and cleans up", async () => {
		let cancelled = false;
		setOutboundFetchOverrideForTest(
			async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		);
		const controller = new AbortController();
		const output = await synthesize(
			{
				...provider,
				tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "pcm16" },
			},
			{ text: "test" },
			controller.signal,
		);
		const pending = collect(output.audio);
		controller.abort("private reason");
		await expect(pending).rejects.toMatchObject({ code: "SPEECH_ABORTED" });
		expect(cancelled).toBe(true);
	});
	test("format capabilities never advertise unsupported containers or WAV-as-PCM", () => {
		const config: SpeechProvider = {
			...provider,
			tts: {
				protocol: "dashscope-tts",
				model: "qwen",
				voice: "Cherry",
				format: "pcm16",
				variant: "qwen-audio-tts",
			},
		};
		expect(getCapabilities(config).tts?.formats).toEqual(["wav", "pcm16", "mp3"]);
		if (config.tts) config.tts.variant = "qwen-tts";
		expect(getCapabilities(config).tts?.formats).toEqual(["pcm16"]);
	});
	test("SSE audio iterator applies backpressure and cancels on return", async () => {
		let produced = 0;
		let cancelled = false;
		setOutboundFetchOverrideForTest(
			async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							produced++;
							controller.enqueue(
								new TextEncoder().encode(sse({ output: { audio: { data: "AQI=" } } })),
							);
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		);
		const output = await synthesize(
			{
				...provider,
				tts: {
					protocol: "dashscope-tts",
					model: "qwen",
					voice: "Cherry",
					format: "pcm16",
					variant: "qwen-tts",
				},
			},
			{ text: "test" },
			signal(),
		);
		for await (const chunk of output.audio) {
			expect([...chunk]).toEqual([1, 2]);
			expect(produced).toBeLessThanOrEqual(3);
			break;
		}
		expect(cancelled).toBe(true);
	});
	test("chat ASR explicit snapshots replace rather than append", async () => {
		setOutboundFetchOverrideForTest(
			async () =>
				new Response(
					sse({ choices: [{ message: { content: "你" } }] }) +
						sse({ choices: [{ message: { content: "你好" }, finish_reason: "stop" }] }),
				),
		);
		const config: SpeechProvider = {
			...provider,
			asr: { protocol: "chat-completions-asr", model: "asr", streaming: true },
		};
		expect(
			await collect(
				transcribe(
					config,
					{ audio: new Uint8Array([1]), mimeType: "audio/wav", stream: true },
					signal(),
				),
			),
		).toEqual([
			{ type: "replace", text: "你" },
			{ type: "replace", text: "你好" },
			{ type: "done", text: "你好" },
		]);
	});
	test("nonstream chat ASR and TTS reject explicit truncated or filtered output", async () => {
		for (const finish_reason of ["length", "content_filter"]) {
			setOutboundFetchOverrideForTest(async () =>
				Response.json({
					choices: [{ finish_reason, message: { content: "partial", audio: { data: "AQI=" } } }],
				}),
			);
			await expect(
				collect(
					transcribe(
						{ ...provider, asr: { protocol: "chat-completions-asr", model: "asr" } },
						{ audio: new Uint8Array([1]), mimeType: "audio/wav" },
						signal(),
					),
				),
			).rejects.toMatchObject({ code: "SPEECH_INCOMPLETE_RESPONSE" });
			const output = await synthesize(
				{
					...provider,
					tts: {
						protocol: "chat-completions-tts",
						model: "tts",
						voice: "default",
						format: "pcm16",
					},
				},
				{ text: "test" },
				signal(),
			);
			await expect(collect(output.audio)).rejects.toMatchObject({
				code: "SPEECH_INCOMPLETE_RESPONSE",
			});
		}
	});
	test("encoded audio magic is validated across chunks even without reliable Content-Type", async () => {
		const config: SpeechProvider = {
			...provider,
			tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "mp3" },
		};
		for (const contentType of [undefined, "application/octet-stream"]) {
			for (const text of ['{"error":"denied"}', "<html>private</html>"]) {
				setOutboundFetchOverrideForTest(
					async () =>
						new Response(
							new ReadableStream({
								start(controller) {
									for (const byte of new TextEncoder().encode(text))
										controller.enqueue(new Uint8Array([byte]));
									controller.close();
								},
							}),
							{ headers: contentType ? { "Content-Type": contentType } : {} },
						),
				);
				await expect(
					collect((await synthesize(config, { text: "test" }, signal())).audio),
				).rejects.toMatchObject({ code: "SPEECH_INVALID_AUDIO" });
			}
		}
		for (const [format, fixture] of [
			["mp3", new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])],
			["wav", new TextEncoder().encode("RIFF0000WAVEfmt ")],
			["flac", new TextEncoder().encode("fLaC0000")],
			["opus", new TextEncoder().encode("OggS0000")],
			["aac", new Uint8Array([0xff, 0xf1, 0x50, 0x80])],
		] as const) {
			setOutboundFetchOverrideForTest(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								for (const byte of fixture) controller.enqueue(new Uint8Array([byte]));
								controller.close();
							},
						}),
					),
			);
			expect(
				(
					await collect((await synthesize(config, { text: "test", format }, signal())).audio)
				).flatMap((bytes) => [...bytes]),
			).toEqual([...fixture]);
		}
	});
	test("headerless PCM patterns are not mistaken for text errors", async () => {
		const fixture = new TextEncoder().encode('{"error":"denied"}');
		setOutboundFetchOverrideForTest(async () => new Response(fixture));
		expect(
			(
				await collect(
					(
						await synthesize(
							{
								...provider,
								tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "pcm16" },
							},
							{ text: "test" },
							signal(),
						)
					).audio,
				)
			).flatMap((bytes) => [...bytes]),
		).toEqual([...fixture]);
	});
	test("HTTP failures never expose upstream body", async () => {
		setOutboundFetchOverrideForTest(
			async () => new Response("private-key and input", { status: 401 }),
		);
		await expect(
			synthesize(
				{
					...provider,
					tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "mp3" },
				},
				{ text: "test" },
				signal(),
			),
		).rejects.toMatchObject({ message: "Speech request could not be completed." });
	});
});
