import { isHttpEndpointUrl, type ProviderEndpointPolicy } from "@shared/provider-endpoints";
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
	/** Mirror endpoints for custom API protocols; blank rows are ignored. */
	baseUrls?: string[];
	endpointPolicy?: ProviderEndpointPolicy;
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
	if (preset.category === "platform-login" || !preset.defaultProtocol)
		throw new Error("Platform providers require login");
	// A preset that names its creation protocol wins over the generic preference:
	// some providers only unlock a feature on that one route.
	const creation =
		preset.creationProtocol && Object.hasOwn(preset.endpoints, preset.creationProtocol)
			? preset.creationProtocol
			: undefined;
	const protocol =
		creation ??
		(["openai-responses", "anthropic-messages", "completions-compatible"] as const).find(
			(candidate) => Object.hasOwn(preset.endpoints, candidate),
		) ??
		preset.defaultProtocol;
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
	// Mirrors and their policy belong to the endpoint being replaced (another region,
	// plan or vendor); keeping them would send this provider's key to that host.
	const { baseUrls: _baseUrls, endpointPolicy: _endpointPolicy, ...kept } = draft;
	return {
		...kept,
		protocol: next?.protocol ?? draft.protocol,
		baseUrl: next?.baseUrl ?? "",
		userAgentMode,
	};
}

/** Non-blank mirror rows, trimmed. */
export function draftMirrorUrls(draft: Pick<AddProviderDraft, "baseUrls">): string[] {
	return (draft.baseUrls ?? []).map((url) => url.trim()).filter((url) => url.length > 0);
}

export function isValidProviderDraft(draft: AddProviderDraft): boolean {
	if (!draft.name.trim()) return false;
	// NUG hides the mirror fields and never uses them.
	if (draft.protocol !== "nug" && !draftMirrorUrls(draft).every(isHttpEndpointUrl)) return false;
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
		...(draftMirrorUrls(draft).length > 0 ? { baseUrls: draftMirrorUrls(draft) } : {}),
		...(draft.endpointPolicy ? { endpointPolicy: draft.endpointPolicy } : {}),
	};
}
