import { proxyOverrideSchema } from "@shared/proxy-settings";
import { z } from "zod";

const boundedText = z.string().trim().min(1).max(200);
const proxyShape = proxyOverrideSchema.unwrap().shape;

export const speechBaseUrlSchema = z
	.string()
	.max(2048)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				value === value.trim() &&
				!/[\s\\]/.test(value) &&
				!Array.from(value).some(
					(char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f,
				) &&
				!/^https?:\/\/[^/?#]*@/i.test(value) &&
				/^https?:\/\//i.test(value) &&
				(url.protocol === "http:" || url.protocol === "https:") &&
				!!url.hostname &&
				!url.username &&
				!url.password &&
				!value.includes("?") &&
				!value.includes("#")
			);
		} catch {
			return false;
		}
	}, "Speech baseUrl must be an HTTP(S) API root without credentials, query or fragment");

const forbiddenHeaders = new Set([
	"host",
	"content-length",
	"connection",
	"transfer-encoding",
	"content-type",
	"content-encoding",
	"accept",
	"accept-encoding",
	"upgrade",
	"keep-alive",
	"proxy-connection",
	"proxy-authorization",
	"te",
	"trailer",
]);

export const speechExtraHeadersSchema = z
	.record(
		z
			.string()
			.max(100)
			.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
		z
			.string()
			.max(4096)
			.regex(/^[\t\x20-\x7e\x80-\xff]*$/),
	)
	.superRefine((headers, ctx) => {
		const names = Object.keys(headers);
		if (names.length > 32) ctx.addIssue({ code: "custom", message: "Too many speech headers" });
		const seen = new Set<string>();
		for (const name of names) {
			const normalized = name.toLowerCase();
			if (forbiddenHeaders.has(normalized) || normalized.startsWith("sec-")) {
				ctx.addIssue({ code: "custom", message: "Speech header overrides protocol framing" });
			}
			if (seen.has(normalized)) {
				ctx.addIssue({ code: "custom", message: "Duplicate case-insensitive speech header" });
			}
			seen.add(normalized);
		}
	});

export const speechAsrProfileSchema = z
	.strictObject({
		protocol: z.enum(["openai-transcription", "chat-completions-asr"]),
		model: boundedText,
		streaming: z.boolean().optional(),
		variant: z.enum(["generic", "mimo", "qwen"]).optional(),
		enableItn: z.boolean().optional(),
	})
	.superRefine((profile, ctx) => {
		if (profile.protocol === "openai-transcription") {
			if (profile.streaming === true || profile.variant !== undefined) {
				ctx.addIssue({
					code: "custom",
					message: "Transcription does not support streaming or variants",
				});
			}
		}
		if (
			profile.enableItn !== undefined &&
			(profile.protocol !== "chat-completions-asr" || profile.variant !== "qwen")
		) {
			ctx.addIssue({ code: "custom", message: "enableItn is only supported by Qwen chat ASR" });
		}
	});

export const speechTtsProfileSchema = z
	.strictObject({
		protocol: z.enum(["openai-speech", "chat-completions-tts", "dashscope-tts"]),
		model: boundedText,
		voice: boundedText,
		format: z.enum(["mp3", "wav", "pcm16", "opus", "flac", "aac"]),
		streaming: z.boolean().optional(),
		variant: z.enum(["qwen-tts", "qwen-audio-tts"]).optional(),
	})
	.superRefine((profile, ctx) => {
		if (profile.protocol === "dashscope-tts") {
			if (!profile.variant) {
				ctx.addIssue({ code: "custom", message: "DashScope TTS requires an explicit variant" });
			} else if (
				(profile.variant === "qwen-tts" && profile.format !== "pcm16") ||
				(profile.variant === "qwen-audio-tts" && !["mp3", "pcm16", "wav"].includes(profile.format))
			) {
				ctx.addIssue({ code: "custom", message: "Unsupported DashScope TTS format for variant" });
			}
		} else if (profile.variant !== undefined) {
			ctx.addIssue({ code: "custom", message: "TTS variants are only valid for DashScope" });
		}
		if (profile.protocol === "chat-completions-tts") {
			if (!["wav", "pcm16"].includes(profile.format)) {
				ctx.addIssue({ code: "custom", message: "Chat TTS supports only WAV or PCM16" });
			}
			if (profile.format === "wav" && profile.streaming !== false) {
				ctx.addIssue({ code: "custom", message: "Chat TTS WAV requires streaming:false" });
			}
		}
	});

// The PATCH form permits an omitted custom URL so it can preserve a redacted secret URL.
const speechProxyPatchSchema = z.strictObject(proxyShape).optional();
export const speechProviderSchema = z.strictObject({
	id: boundedText,
	name: boundedText,
	enabled: z.boolean(),
	baseUrl: speechBaseUrlSchema,
	apiKey: z
		.string()
		.max(4096)
		.regex(/^[\x20-\x7e]*$/)
		.optional(),
	extraHeaders: speechExtraHeadersSchema.optional(),
	proxy: proxyOverrideSchema,
	asr: speechAsrProfileSchema.optional(),
	tts: speechTtsProfileSchema.optional(),
});

const speechProviderPatchSchema = speechProviderSchema
	.extend({
		proxy: speechProxyPatchSchema,
		hasApiKey: z.boolean().optional(),
		hasExtraHeaders: z.boolean().optional(),
	})
	.transform(({ hasApiKey: _key, hasExtraHeaders: _headers, ...provider }) => provider);

const settingsShape = {
	enabled: z.boolean(),
	providers: z.array(speechProviderSchema).max(64),
	defaultAsrProviderId: z.string().max(200).optional(),
	defaultTtsProviderId: z.string().max(200).optional(),
};

export const speechSettingsSchema = z.strictObject(settingsShape).superRefine((settings, ctx) => {
	const ids = new Set<string>();
	for (const provider of settings.providers) {
		if (ids.has(provider.id)) {
			ctx.addIssue({
				code: "custom",
				path: ["providers"],
				message: "Duplicate speech provider id",
			});
		}
		ids.add(provider.id);
	}
	for (const [field, capability] of [
		["defaultAsrProviderId", "asr"],
		["defaultTtsProviderId", "tts"],
	] as const) {
		const id = settings[field];
		if (!id) continue;
		const provider = settings.providers.find((candidate) => candidate.id === id);
		if (!provider?.enabled || !provider[capability]) {
			ctx.addIssue({
				code: "custom",
				path: [field],
				message: "Default speech provider must be enabled and have the matching profile",
			});
		}
	}
});

// No defaults here: an empty PATCH must never reset enabled/providers or credentials.
export const speechSettingsPatchSchema = z.strictObject({
	enabled: settingsShape.enabled.optional(),
	providers: z.array(speechProviderPatchSchema).max(64).optional(),
	defaultAsrProviderId: settingsShape.defaultAsrProviderId,
	defaultTtsProviderId: settingsShape.defaultTtsProviderId,
});
