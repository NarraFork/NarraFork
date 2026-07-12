import type {
	AnthropicProviderConfig,
	CustomApiProtocol,
	CustomApiProviderConfig,
	GeminiProviderConfig,
	NarraForkSettings,
	OpenAIProviderConfig,
} from "./types";

export function customApiProtocolFromOpenAI(
	providerOrApiMode?: OpenAIProviderConfig | OpenAIProviderConfig["apiMode"],
	legacyResponsesApi?: boolean,
): CustomApiProtocol {
	const apiMode =
		typeof providerOrApiMode === "object" ? providerOrApiMode.apiMode : providerOrApiMode;
	const responsesApi =
		typeof providerOrApiMode === "object" ? providerOrApiMode.responsesApi : legacyResponsesApi;

	switch (apiMode) {
		case "codex":
			return "codex-native";
		case "completions":
			return "completions-compatible";
		case "responses":
			return "responses-compatible";
		default:
			return responsesApi === false ? "completions-compatible" : "responses-compatible";
	}
}

export function customApiProtocolFromAnthropic(officialApi?: boolean): CustomApiProtocol {
	return officialApi ? "anthropic-official" : "anthropic-compatible";
}

export function isOpenAICustomApiProtocol(protocol: CustomApiProtocol): boolean {
	return (
		protocol === "codex-native" ||
		protocol === "responses-compatible" ||
		protocol === "completions-compatible"
	);
}

export function isAnthropicCustomApiProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "anthropic-official" || protocol === "anthropic-compatible";
}

export function isGeminiCustomApiProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "gemini-compatible";
}

export function customApiProtocolToOpenAIApiMode(
	protocol: CustomApiProtocol,
): OpenAIProviderConfig["apiMode"] | undefined {
	switch (protocol) {
		case "codex-native":
			return "codex";
		case "responses-compatible":
			return "responses";
		case "completions-compatible":
			return "completions";
		default:
			return undefined;
	}
}

export function openAIProviderToCustomApi(provider: OpenAIProviderConfig): CustomApiProviderConfig {
	return {
		id: provider.id,
		name: provider.name,
		disabled: provider.disabled,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		defaultContextWindow: provider.defaultContextWindow,
		protocol: customApiProtocolFromOpenAI(provider),
		proxy: provider.proxy,
		codexAccountId: provider.codexAccountId,
		codexWebSocket: provider.codexWebSocket,
		codexWebSearch: provider.codexWebSearch,
		codexImageGeneration: provider.codexImageGeneration,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		emulateCodexHeaders: provider.emulateCodexHeaders,
	};
}

export function anthropicProviderToCustomApi(
	provider: AnthropicProviderConfig,
): CustomApiProviderConfig {
	return {
		id: provider.id,
		name: provider.name,
		disabled: provider.disabled,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		defaultContextWindow: provider.defaultContextWindow,
		protocol: customApiProtocolFromAnthropic(provider.officialApi),
		defaultReasoningEffort: provider.defaultReasoningEffort,
		proxy: provider.proxy,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		emulateCodexHeaders: provider.emulateCodexHeaders,
	};
}

export function geminiProviderToCustomApi(provider: GeminiProviderConfig): CustomApiProviderConfig {
	return {
		id: provider.id,
		name: provider.name,
		disabled: provider.disabled,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		defaultContextWindow: provider.defaultContextWindow,
		protocol: "gemini-compatible",
		defaultReasoningEffort: provider.defaultReasoningEffort,
		proxy: provider.proxy,
	};
}

export function deriveCustomApiProvidersFromLegacy(
	openaiProviders: OpenAIProviderConfig[] | undefined,
	anthropicProviders: AnthropicProviderConfig[] | undefined,
	geminiProviders?: GeminiProviderConfig[] | undefined,
): CustomApiProviderConfig[] {
	const byId = new Map<string, CustomApiProviderConfig>();
	for (const provider of openaiProviders ?? []) {
		byId.set(provider.id, openAIProviderToCustomApi(provider));
	}
	for (const provider of anthropicProviders ?? []) {
		const existing = byId.get(provider.id);
		if (existing) {
			byId.set(provider.id, {
				...existing,
				...anthropicProviderToCustomApi(provider),
				codexAccountId: existing.codexAccountId,
				codexWebSocket: existing.codexWebSocket,
				codexWebSearch: existing.codexWebSearch,
				codexImageGeneration: existing.codexImageGeneration,
			});
			continue;
		}
		byId.set(provider.id, anthropicProviderToCustomApi(provider));
	}
	for (const provider of geminiProviders ?? []) {
		if (byId.has(provider.id)) continue;
		byId.set(provider.id, geminiProviderToCustomApi(provider));
	}
	return [...byId.values()];
}

export function customApiProviderToOpenAI(
	provider: CustomApiProviderConfig,
): OpenAIProviderConfig | undefined {
	const apiMode = customApiProtocolToOpenAIApiMode(provider.protocol);
	if (!apiMode) return undefined;
	return {
		id: provider.id,
		name: provider.name,
		disabled: provider.disabled,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		defaultContextWindow: provider.defaultContextWindow,
		apiMode,
		proxy: provider.proxy,
		codexAccountId: provider.codexAccountId,
		codexWebSocket: provider.codexWebSocket,
		codexWebSearch: provider.codexWebSearch,
		codexImageGeneration: provider.codexImageGeneration,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		emulateCodexHeaders: provider.emulateCodexHeaders,
	};
}

export function customApiProviderToAnthropic(
	provider: CustomApiProviderConfig,
): AnthropicProviderConfig | undefined {
	if (!isAnthropicCustomApiProtocol(provider.protocol)) return undefined;
	return {
		id: provider.id,
		name: provider.name,
		disabled: provider.disabled,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		defaultContextWindow: provider.defaultContextWindow,
		defaultReasoningEffort: provider.defaultReasoningEffort ?? undefined,
		proxy: provider.proxy,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized,
		officialApi: provider.protocol === "anthropic-official",
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		emulateCodexHeaders: provider.emulateCodexHeaders,
	};
}

export function customApiProvidersToOpenAI(
	providers: CustomApiProviderConfig[] | undefined,
): OpenAIProviderConfig[] {
	return (providers ?? []).flatMap((provider) => {
		const converted = customApiProviderToOpenAI(provider);
		return converted ? [converted] : [];
	});
}

export function customApiProviderToGemini(
	provider: CustomApiProviderConfig,
): GeminiProviderConfig | undefined {
	if (!isGeminiCustomApiProtocol(provider.protocol)) return undefined;
	return {
		id: provider.id,
		name: provider.name,
		disabled: provider.disabled,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		defaultContextWindow: provider.defaultContextWindow,
		defaultReasoningEffort: provider.defaultReasoningEffort ?? undefined,
		proxy: provider.proxy,
	};
}

export function customApiProvidersToAnthropic(
	providers: CustomApiProviderConfig[] | undefined,
): AnthropicProviderConfig[] {
	return (providers ?? []).flatMap((provider) => {
		const converted = customApiProviderToAnthropic(provider);
		return converted ? [converted] : [];
	});
}

export function customApiProvidersToGemini(
	providers: CustomApiProviderConfig[] | undefined,
): GeminiProviderConfig[] {
	return (providers ?? []).flatMap((provider) => {
		const converted = customApiProviderToGemini(provider);
		return converted ? [converted] : [];
	});
}

export function normalizeCustomApiProvider(
	provider: CustomApiProviderConfig,
): CustomApiProviderConfig {
	return {
		...provider,
		protocol: provider.protocol ?? "responses-compatible",
		defaultReasoningEffort: provider.defaultReasoningEffort ?? undefined,
		codexAccountId: provider.codexAccountId ?? "",
		codexWebSocket: provider.codexWebSocket ?? false,
		codexWebSearch: provider.codexWebSearch ?? true,
		codexImageGeneration: provider.codexImageGeneration ?? true,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized ?? true,
	};
}

export function normalizeCustomApiProviderSettings(settings: NarraForkSettings): boolean {
	const before = JSON.stringify({
		customApiProviders: settings.customApiProviders,
		openaiProviders: settings.openaiProviders,
		anthropicProviders: settings.anthropicProviders,
		geminiProviders: settings.geminiProviders,
	});

	settings.customApiProviders = (
		Array.isArray(settings.customApiProviders)
			? settings.customApiProviders
			: deriveCustomApiProvidersFromLegacy(
					settings.openaiProviders,
					settings.anthropicProviders,
					settings.geminiProviders,
				)
	).map(normalizeCustomApiProvider);
	settings.openaiProviders = customApiProvidersToOpenAI(settings.customApiProviders);
	settings.anthropicProviders = customApiProvidersToAnthropic(settings.customApiProviders);
	settings.geminiProviders = customApiProvidersToGemini(settings.customApiProviders);

	const after = JSON.stringify({
		customApiProviders: settings.customApiProviders,
		openaiProviders: settings.openaiProviders,
		anthropicProviders: settings.anthropicProviders,
		geminiProviders: settings.geminiProviders,
	});
	return before !== after;
}
