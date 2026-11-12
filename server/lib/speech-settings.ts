import type { SpeechProvider, SpeechSettings } from "@shared/speech";
import { ValidationError } from "./errors";
import { speechSettingsPatchSchema, speechSettingsSchema } from "./validators/speech";

export type PublicSpeechProvider = Omit<SpeechProvider, "apiKey" | "extraHeaders"> & {
	hasApiKey: boolean;
	hasExtraHeaders: boolean;
};
export type PublicSpeechSettings = Omit<SpeechSettings, "providers"> & {
	providers: PublicSpeechProvider[];
};

/** No Zod input/error serialization: rejected credentials must not appear in API errors or logs. */
export function validateSpeechSettings(value: unknown): SpeechSettings {
	const result = speechSettingsSchema.safeParse(value);
	if (!result.success) throw new ValidationError("Invalid speech settings");
	return result.data;
}

/** Only absence, not null or malformed speech configuration, receives legacy defaults. */
export function loadSpeechSettings(value: unknown): SpeechSettings {
	return validateSpeechSettings(value === undefined ? { enabled: false, providers: [] } : value);
}

/** Provider arrays replace by submitted list; only omitted secrets are preserved by stable id. */
export function mergeSpeechSettingsPatch(
	current: SpeechSettings | undefined,
	value: unknown,
): SpeechSettings {
	const result = speechSettingsPatchSchema.safeParse(value);
	if (!result.success) throw new ValidationError("Invalid speech settings patch");
	const patch = result.data;
	const previous = loadSpeechSettings(current);
	const next = { ...previous, ...patch };
	if (patch.providers !== undefined) {
		next.providers = patch.providers.map((provider) => {
			const existing = previous.providers.find((candidate) => candidate.id === provider.id);
			return {
				...provider,
				apiKey: provider.apiKey === undefined ? existing?.apiKey : provider.apiKey,
				extraHeaders:
					provider.extraHeaders === undefined ? existing?.extraHeaders : provider.extraHeaders,
				proxy:
					provider.proxy?.mode === "custom" && provider.proxy.url === undefined
						? {
								...provider.proxy,
								url: existing?.proxy?.mode === "custom" ? existing.proxy.url : undefined,
							}
						: provider.proxy,
			};
		});
	}
	if (next.defaultAsrProviderId === "") delete next.defaultAsrProviderId;
	if (next.defaultTtsProviderId === "") delete next.defaultTtsProviderId;
	return validateSpeechSettings(next);
}

/** Return an allowlisted DTO, never masked prefixes/suffixes or header values. Safe for every role. */
export function redactSpeechSettings(value: SpeechSettings | undefined): PublicSpeechSettings {
	const settings = loadSpeechSettings(value);
	return {
		enabled: settings.enabled,
		defaultAsrProviderId: settings.defaultAsrProviderId,
		defaultTtsProviderId: settings.defaultTtsProviderId,
		providers: settings.providers.map((provider) => {
			let proxy = provider.proxy ? { ...provider.proxy } : undefined;
			if (proxy?.url) {
				try {
					const url = new URL(proxy.url);
					// Omit secret-bearing URLs rather than returning a lossy editable placeholder.
					if (url.username || url.password || proxy.url.includes("?") || proxy.url.includes("#")) {
						proxy = { mode: proxy.mode };
					}
				} catch {
					proxy = { mode: proxy.mode };
				}
			}
			return {
				id: provider.id,
				name: provider.name,
				enabled: provider.enabled,
				baseUrl: provider.baseUrl,
				asr: provider.asr ? { ...provider.asr } : undefined,
				tts: provider.tts ? { ...provider.tts } : undefined,
				proxy,
				hasApiKey: !!provider.apiKey,
				hasExtraHeaders: Object.keys(provider.extraHeaders ?? {}).length > 0,
			};
		}),
	};
}
