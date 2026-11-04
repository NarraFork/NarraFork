import { describe, expect, test } from "bun:test";
import type { SpeechSettings } from "@shared/speech";
import { type SpeechAdapter, SpeechService } from "./service";

const config = (): SpeechSettings => ({
	enabled: true,
	defaultAsrProviderId: "test",
	defaultTtsProviderId: "test",
	providers: [
		{
			id: "test",
			name: "Test",
			enabled: true,
			baseUrl: "https://speech.invalid/v1",
			apiKey: "secret",
			asr: { protocol: "chat-completions-asr", model: "asr", streaming: true },
			tts: { protocol: "openai-speech", model: "tts", voice: "test", format: "mp3" },
		},
	],
});
const adapter: SpeechAdapter = {
	getCapabilities: (p) => ({
		id: p.id,
		name: p.name,
		asr: { textStreaming: true, realtimeInput: false },
	}),
	async *transcribe() {
		yield { type: "delta", text: "hello" };
		yield { type: "done", text: "hello" };
	},
	async synthesize() {
		return {
			metadata: { mimeType: "audio/mpeg", format: "mp3" },
			audio: (async function* () {
				yield new Uint8Array([1]);
			})(),
		};
	},
};
const audio = { audio: new Uint8Array([1]), mimeType: "audio/wav" };

describe("speech operation lifecycle", () => {
	test("reusing an operation cannot release its active concurrency reservation", async () => {
		const service = new SpeechService(config, adapter);
		const op = service.begin("a", "tts");
		const output = await op.synthesize({ text: "hello" });
		await expect(op.synthesize({ text: "again" })).rejects.toThrow("reusable");
		expect(() => service.begin("a", "asr")).toThrow("busy");
		await Array.fromAsync(output.audio);
		service.begin("a", "asr").close();
	});
	test("disabled and missing providers never reach adapter", () => {
		const value = config();
		value.enabled = false;
		const service = new SpeechService(() => value, adapter);
		expect(service.getCapabilities().providers).toEqual([]);
		expect(() => service.begin("a", "asr")).toThrow("disabled");
		value.enabled = true;
		expect(() => service.begin("a", "asr", "missing")).toThrow("selected");
	});
	test("reserves before upload, caps global/per-user operations, releases idempotently", () => {
		const service = new SpeechService(config, adapter);
		const a = service.begin("a", "asr");
		expect(() => service.begin("a", "tts")).toThrow("busy");
		const b = service.begin("b", "tts");
		expect(() => service.begin("c", "asr")).toThrow("busy");
		a.close();
		a.close();
		const c = service.begin("c", "asr");
		c.close();
		b.close();
	});
	test("pins credentials, returns final text and releases without aborting normal completion", async () => {
		const value = config();
		let key: string | undefined;
		const service = new SpeechService(() => value, {
			...adapter,
			async *transcribe(p) {
				key = p.apiKey;
				yield { type: "done", text: "ok" };
			},
		});
		const op = service.begin("a", "asr");
		value.providers[0].apiKey = "new";
		expect(await Array.fromAsync(op.transcribe(audio))).toEqual([{ type: "done", text: "ok" }]);
		expect(key).toBe("secret");
		expect(op.signal.aborted).toBe(false);
		service.begin("a", "asr").close();
	});
	test("cancel reaches upstream and releases even when audio is never consumed", async () => {
		const service = new SpeechService(config, adapter);
		const controller = new AbortController();
		const op = service.begin("a", "tts", undefined, controller.signal);
		await op.synthesize({ text: "hello" });
		controller.abort();
		expect(op.signal.aborted).toBe(true);
		service.begin("a", "tts").close();
	});
	test("total deadline releases abandoned operation", async () => {
		const service = new SpeechService(config, adapter, { timeoutMs: 5 });
		const op = service.begin("a", "asr");
		await new Promise<void>((resolve) =>
			op.signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		expect(op.signal.aborted).toBe(true);
		expect(op.signal.reason.code).toBe("SPEECH_TIMEOUT");
		service.begin("a", "asr").close();
	});
	test("empty input and incomplete upstream release admission", async () => {
		const service = new SpeechService(config, adapter);
		await expect(
			Array.fromAsync(service.begin("a", "asr").transcribe({ ...audio, audio: new Uint8Array() })),
		).rejects.toThrow("empty");
		const broken = new SpeechService(config, {
			...adapter,
			async *transcribe() {
				yield { type: "delta", text: "partial" };
			},
		});
		await expect(Array.fromAsync(broken.begin("a", "asr").transcribe(audio))).rejects.toThrow(
			"complete",
		);
		broken.begin("a", "asr").close();
		service.begin("a", "tts").close();
	});
	test("audio is lazy and generator cancellation closes upstream", async () => {
		let count = 0;
		let cleaned = false;
		const service = new SpeechService(config, {
			...adapter,
			async synthesize() {
				return {
					metadata: { mimeType: "audio/mpeg", format: "mp3" },
					audio: (async function* () {
						try {
							for (let i = 0; i < 10; i++) {
								count++;
								yield new Uint8Array([i]);
							}
						} finally {
							cleaned = true;
						}
					})(),
				};
			},
		});
		const op = service.begin("a", "tts");
		const output = await op.synthesize({ text: "hello" });
		expect(count).toBe(0);
		for await (const _ of output.audio) break;
		expect(count).toBe(1);
		expect(cleaned).toBe(true);
		service.begin("a", "tts").close();
	});
});
