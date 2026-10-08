import type { NUGProviderState } from "./NUGProvidersSection";
import type { AddProviderType, ProviderPreset } from "./provider-presets";
import type { CustomApiProviderState, UserAgentMode } from "./types";

export interface AddProviderDraft {
	protocol: AddProviderType;
	name: string;
	baseUrl: string;
	apiKey: string;
	prefix: string;
	userAgentMode?: UserAgentMode;
}

/** ASCII colon separates the provider from the model ID and cannot appear in a prefix. */
export function sanitizeProviderPrefix(value: string): string {
	return value.replace(/:/g, "");
}

export function nugProviderFromDraft(id: string, draft: AddProviderDraft): NUGProviderState {
	return {
		id,
		name: draft.name.trim(),
		prefix: sanitizeProviderPrefix(draft.prefix).trim(),
		apiKey: draft.apiKey.trim(),
		baseUrl: draft.baseUrl.trim(),
		defaultModel: "",
	};
}

export function draftFromPreset(preset: ProviderPreset): AddProviderDraft {
	const protocol =
		(["openai-responses", "anthropic-messages", "completions-compatible"] as const).find(
			(candidate) => Object.hasOwn(preset.endpoints, candidate),
		) ?? preset.defaultProtocol;
	return {
		protocol,
		name: preset.name,
		baseUrl: preset.endpoints[protocol] ?? "",
		apiKey: "",
		prefix: "",
	};
}

/** Changing a creation preset updates connection fields without discarding user input. */
export function updateDraftConnection(
	draft: AddProviderDraft,
	preset: ProviderPreset | null,
	userAgentMode?: UserAgentMode,
): AddProviderDraft {
	const next = preset ? draftFromPreset(preset) : null;
	return {
		...draft,
		protocol: next?.protocol ?? draft.protocol,
		baseUrl: next?.baseUrl ?? "",
		userAgentMode,
	};
}

export function isValidProviderDraft(draft: AddProviderDraft): boolean {
	if (!draft.name.trim()) return false;
	try {
		const url = new URL(draft.baseUrl.trim());
		return (
			(url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
		);
	} catch {
		return false;
	}
}

export function customProviderFromDraft(
	id: string,
	draft: AddProviderDraft & { protocol: CustomApiProviderState["protocol"] },
): CustomApiProviderState {
	return {
		id,
		name: draft.name.trim(),
		prefix: sanitizeProviderPrefix(draft.prefix).trim(),
		apiKey: draft.apiKey.trim(),
		baseUrl: draft.baseUrl.trim(),
		defaultModel: "",
		protocol: draft.protocol,
		...(draft.protocol === "gemini-compatible"
			? { geminiTransport: "generate-content" as const }
			: {}),
		codexAccountId: "",
		codexWebSocket: false,
		tlsRejectUnauthorized: true,
		...(draft.userAgentMode ? { userAgentMode: draft.userAgentMode } : {}),
	};
}
