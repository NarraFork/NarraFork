import { describe, expect, test } from "bun:test";
import type { SpeechProvider, SpeechSettings } from "@shared/speech";
import {
	loadSpeechSettings,
	mergeSpeechSettingsPatch,
	redactSpeechSettings,
	validateSpeechSettings,
} from "../speech-settings";
import {
	speechAsrProfileSchema,
	speechExtraHeadersSchema,
	speechSettingsPatchSchema,
	speechTtsProfileSchema,
} from "../validators/speech";

const provider: SpeechProvider = {
	id: "voice",
	name: "Voice",
	enabled: true,
	baseUrl: "https://speech.invalid/v1",
	apiKey: "secret-api-key",
	extraHeaders: { Authorization: "secret-header", "X-Token": "secret-custom" },
	proxy: { mode: "custom", url: "http://user:password@proxy.invalid:8080?token=secret-proxy" },
	asr: { protocol: "openai-transcription", model: "asr" },
	tts: { protocol: "openai-speech", model: "tts", voice: "alloy", format: "mp3" },
};
const configuration: SpeechSettings = {
	enabled: true,
	providers: [provider],
	defaultAsrProviderId: provider.id,
	defaultTtsProviderId: provider.id,
};

describe("speech settings", () => {
	test("only absent old settings default to disabled; partials do not insert defaults", () => {
		expect(loadSpeechSettings(undefined)).toEqual({ enabled: false, providers: [] });
		expect(speechSettingsPatchSchema.parse({})).toEqual({});
		expect(mergeSpeechSettingsPatch(configuration, {})).toEqual(configuration);
		for (const value of [null, {}, { enabled: true }, { providers: [] }]) {
			expect(() => loadSpeechSettings(value)).toThrow("Invalid speech settings");
		}
	});

	test("redacts every credential, all header values and secret proxy URLs without mutation", () => {
		const snapshot = structuredClone(configuration);
		const publicSettings = redactSpeechSettings(configuration);
		const json = JSON.stringify(publicSettings);
		for (const secret of ["secret", "password", "Authorization", "X-Token", "?token", "user:"]) {
			expect(json).not.toContain(secret);
		}
		expect(publicSettings.providers[0]).toMatchObject({ hasApiKey: true, hasExtraHeaders: true });
		expect(publicSettings.providers[0]).not.toHaveProperty("apiKey");
		expect(publicSettings.providers[0]).not.toHaveProperty("extraHeaders");
		expect(publicSettings.providers[0].proxy).toEqual({ mode: "custom" });
		expect(configuration).toEqual(snapshot);
		expect(mergeSpeechSettingsPatch(configuration, publicSettings)).toEqual(configuration);
	});

	test("submitted provider arrays preserve omitted secrets by id, not index; explicit empties clear", () => {
		const { apiKey: _key, extraHeaders: _headers, ...publicProvider } = provider;
		const next = mergeSpeechSettingsPatch(configuration, {
			providers: [{ ...publicProvider, name: "Renamed" }],
		});
		expect(next.providers[0].apiKey).toBe(provider.apiKey);
		expect(next.providers[0].extraHeaders).toEqual(provider.extraHeaders);
		const cleared = mergeSpeechSettingsPatch(configuration, {
			providers: [{ ...publicProvider, apiKey: "", extraHeaders: {} }],
		});
		expect(cleared.providers[0].apiKey).toBe("");
		expect(cleared.providers[0].extraHeaders).toEqual({});
		const newProvider = mergeSpeechSettingsPatch(configuration, {
			providers: [{ ...publicProvider, id: "new" }],
			defaultAsrProviderId: "new",
			defaultTtsProviderId: "new",
		});
		expect(newProvider.providers[0].apiKey).toBeUndefined();
		expect(newProvider.providers[0].extraHeaders).toBeUndefined();
		expect(
			mergeSpeechSettingsPatch(configuration, {
				providers: [],
				defaultAsrProviderId: "",
				defaultTtsProviderId: "",
			}),
		).toEqual({ enabled: true, providers: [] });
	});

	test("rejects duplicate ids, dangling defaults and defaults without enabled matching profiles", () => {
		for (const providers of [
			[provider, provider],
			[],
			[{ ...provider, enabled: false }],
			[{ ...provider, asr: undefined }],
			[{ ...provider, tts: undefined }],
		])
			expect(() => validateSpeechSettings({ ...configuration, providers })).toThrow();
		expect(() => mergeSpeechSettingsPatch(configuration, { providers: [] })).toThrow();
		expect(
			validateSpeechSettings({ enabled: false, providers: [{ ...provider, tts: undefined }] })
				.providers,
		).toHaveLength(1);
	});

	test("base URL rejects unsafe roots and protocol/schema extensions", () => {
		for (const baseUrl of [
			"ftp://host/v1",
			"https://host/v1\u0000",
			"https://@host/v1",
			"https://user:pass@host/v1",
			"https://host/v1?key=secret",
			"https://host/v1#fragment",
			"https://host/v1?",
			"https://host/v1#",
			" https://host/v1",
			"https://ho\nst/v1",
			"https:\\host/v1",
		])
			expect(() =>
				validateSpeechSettings({ ...configuration, providers: [{ ...provider, baseUrl }] }),
			).toThrow();
		expect(() => validateSpeechSettings({ ...configuration, extraBody: {} })).toThrow();
		expect(() =>
			validateSpeechSettings({ ...configuration, providers: [{ ...provider, extraBody: {} }] }),
		).toThrow();
	});

	test("header validation denies framing overrides, duplicates and CRLF but permits authorization", () => {
		for (const name of [
			"Host",
			"CONTENT-LENGTH",
			"Connection",
			"Transfer-Encoding",
			"Content-Type",
			"Accept",
			"Upgrade",
			"Sec-Websocket-Key",
		]) {
			expect(speechExtraHeadersSchema.safeParse({ [name]: "bad" }).success).toBe(false);
		}
		expect(speechExtraHeadersSchema.safeParse({ Authorization: "Bearer safe" }).success).toBe(true);
		expect(speechExtraHeadersSchema.safeParse({ "X-Token": "a\r\nHost: evil" }).success).toBe(
			false,
		);
		expect(speechExtraHeadersSchema.safeParse({ "X-Token": "one", "x-token": "two" }).success).toBe(
			false,
		);
		expect(speechExtraHeadersSchema.safeParse({ "bad name": "value" }).success).toBe(false);
	});

	test("ASR rejects unsupported streaming/variant/ITN combinations", () => {
		const profile = { protocol: "openai-transcription", model: "asr" };
		for (const patch of [
			{ streaming: true },
			{ variant: "qwen" },
			{ enableItn: true },
			{ enableItn: false },
		]) {
			expect(speechAsrProfileSchema.safeParse({ ...profile, ...patch }).success).toBe(false);
		}
		expect(speechAsrProfileSchema.safeParse({ ...profile, streaming: false }).success).toBe(true);
		for (const variant of ["generic", "mimo"]) {
			expect(
				speechAsrProfileSchema.safeParse({
					...profile,
					protocol: "chat-completions-asr",
					variant,
					enableItn: true,
				}).success,
			).toBe(false);
		}
		expect(
			speechAsrProfileSchema.safeParse({
				...profile,
				protocol: "chat-completions-asr",
				variant: "qwen",
				enableItn: true,
			}).success,
		).toBe(true);
	});

	test("TTS format matrices and required DashScope variant are enforced", () => {
		const profile = { model: "tts", voice: "voice", streaming: true };
		for (const format of ["mp3", "wav", "pcm16", "opus", "flac", "aac"]) {
			expect(
				speechTtsProfileSchema.safeParse({ ...profile, protocol: "openai-speech", format }).success,
			).toBe(true);
			expect(
				speechTtsProfileSchema.safeParse({ ...profile, protocol: "dashscope-tts", format }).success,
			).toBe(false);
			expect(
				speechTtsProfileSchema.safeParse({
					...profile,
					protocol: "dashscope-tts",
					variant: "qwen-tts",
					format,
				}).success,
			).toBe(format === "pcm16");
			expect(
				speechTtsProfileSchema.safeParse({
					...profile,
					protocol: "dashscope-tts",
					variant: "qwen-audio-tts",
					format,
				}).success,
			).toBe(["mp3", "pcm16", "wav"].includes(format));
			expect(
				speechTtsProfileSchema.safeParse({ ...profile, protocol: "chat-completions-tts", format })
					.success,
			).toBe(format === "pcm16");
			expect(
				speechTtsProfileSchema.safeParse({
					...profile,
					streaming: false,
					protocol: "chat-completions-tts",
					format,
				}).success,
			).toBe(["wav", "pcm16"].includes(format));
		}
		expect(
			speechTtsProfileSchema.safeParse({
				...profile,
				protocol: "openai-speech",
				variant: "qwen-tts",
				format: "pcm16",
			}).success,
		).toBe(false);
	});

	test("ASR-only and TTS-only providers support independent defaults", () => {
		const value = validateSpeechSettings({
			enabled: true,
			providers: [
				{ ...provider, id: "asr", tts: undefined },
				{ ...provider, id: "tts", asr: undefined },
			],
			defaultAsrProviderId: "asr",
			defaultTtsProviderId: "tts",
		});
		expect(value.defaultAsrProviderId).toBe("asr");
		expect(value.defaultTtsProviderId).toBe("tts");
	});

	test("validation errors never include original credential values", () => {
		try {
			mergeSpeechSettingsPatch(configuration, {
				providers: [{ ...provider, apiKey: "private\r\nkey" }],
			});
			throw new Error("should reject");
		} catch (error) {
			expect(String(error)).toContain("Invalid speech settings");
			expect(String(error)).not.toContain("private");
		}
	});
});
