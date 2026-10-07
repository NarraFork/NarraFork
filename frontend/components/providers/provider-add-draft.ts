import type { NUGProviderState } from "./NUGProvidersSection";
import type { AddProviderType, ProviderPreset } from "./provider-presets";
import type { CustomApiProviderState } from "./types";

export interface AddProviderDraft {
	protocol: AddProviderType;
	name: string;
	baseUrl: string;
	apiKey: string;
	prefix: string;
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
	return {
		protocol: preset.defaultProtocol,
		name: preset.name,
		baseUrl: preset.endpoints[preset.defaultProtocol] ?? "",
		apiKey: "",
		prefix: "",
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
	};
}
