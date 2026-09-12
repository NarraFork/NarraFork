import {
	SUBAGENT_POOL_TYPES,
	type SubagentModelReasoningEfforts,
} from "@shared/subagent-model-policy";
import { ValidationError } from "../errors";
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
		nativeSearch: provider.nativeSearch,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
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
		geminiTransport: provider.geminiTransport ?? "generate-content",
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
		nativeSearch: provider.protocol === "anthropic-official" ? provider.nativeSearch : undefined,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
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
		geminiTransport: provider.geminiTransport ?? "generate-content",
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
		geminiTransport:
			provider.protocol === "gemini-compatible"
				? (provider.geminiTransport ?? "generate-content")
				: provider.geminiTransport,
		defaultReasoningEffort: provider.defaultReasoningEffort ?? undefined,
		codexAccountId: provider.codexAccountId ?? "",
		codexWebSocket: provider.codexWebSocket ?? false,
		codexWebSearch: provider.codexWebSearch ?? true,
		codexImageGeneration: provider.codexImageGeneration ?? true,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized ?? true,
	};
}

export interface ProviderPrefixChange {
	id: string;
	from: string;
	to: string;
}

export function getProviderPrefixChanges(
	previousGroups: Array<Array<{ id: string; prefix?: string }> | undefined>,
	nextGroups: Array<Array<{ id: string; prefix?: string }> | undefined>,
): ProviderPrefixChange[] {
	const previousById = new Map<string, string>();
	for (const group of previousGroups) {
		for (const provider of group ?? []) {
			if (!provider.id || !provider.prefix) continue;
			if (previousById.has(provider.id)) {
				throw new ValidationError(`Duplicate provider id "${provider.id}" in current settings.`);
			}
			previousById.set(provider.id, provider.prefix);
		}
	}

	const changes: ProviderPrefixChange[] = [];
	const seenIds = new Set<string>();
	for (const group of nextGroups) {
		for (const provider of group ?? []) {
			if (!provider.id || !provider.prefix) continue;
			if (seenIds.has(provider.id)) {
				throw new ValidationError(`Duplicate provider id "${provider.id}" in updated settings.`);
			}
			seenIds.add(provider.id);
			const previousPrefix = previousById.get(provider.id);
			if (previousPrefix && previousPrefix !== provider.prefix) {
				changes.push({ id: provider.id, from: previousPrefix, to: provider.prefix });
			}
		}
	}
	return changes;
}

export function rewriteModelReference(value: string, prefixMap: Map<string, string>): string {
	for (const [from, to] of prefixMap) {
		if (value.startsWith(`${from}:`)) return `${to}:${value.slice(from.length + 1)}`;
		if (value.startsWith("__agg__:")) {
			const marker = `:${from}:`;
			const markerIndex = value.indexOf(marker);
			if (markerIndex >= 0) {
				return `${value.slice(0, markerIndex)}:${to}:${value.slice(markerIndex + marker.length)}`;
			}
		}
	}
	return value;
}

function rewriteModelReferenceArray(values: string[], prefixMap: Map<string, string>): string[] {
	return values.map((value) => rewriteModelReference(value, prefixMap));
}

/**
 * Atomically migrate every persisted agent-level model reference when a provider's
 * user-facing prefix changes while its stable provider id remains the same.
 */
export function migrateProviderPrefixReferences(
	settings: NarraForkSettings,
	changes: ProviderPrefixChange[],
): boolean {
	const prefixMap = new Map(
		changes.filter((change) => change.from && change.to).map((change) => [change.from, change.to]),
	);
	if (prefixMap.size === 0) return false;

	const migratedContextWindows: Record<string, number> = {};
	const contextSources = new Map<string, string>();
	for (const [sourceModel, contextWindow] of Object.entries(
		settings.agent.modelContextWindows ?? {},
	)) {
		const targetModel = rewriteModelReference(sourceModel, prefixMap);
		const existing = migratedContextWindows[targetModel];
		if (existing !== undefined && existing !== contextWindow) {
			throw new ValidationError(
				`Provider prefix migration would overwrite context window "${targetModel}" ` +
					`from both "${contextSources.get(targetModel)}" and "${sourceModel}".`,
			);
		}
		if (existing === undefined) {
			migratedContextWindows[targetModel] = contextWindow;
			contextSources.set(targetModel, sourceModel);
		}
	}

	const migratedCustomModels: typeof settings.agent.customModels = [];
	const customModelSources = new Map<string, { source: string; serialized: string }>();
	for (const model of settings.agent.customModels ?? []) {
		const migrated = {
			...model,
			value: rewriteModelReference(model.value, prefixMap),
			provider: model.provider ? (prefixMap.get(model.provider) ?? model.provider) : model.provider,
		};
		const serialized = JSON.stringify(migrated);
		const existing = customModelSources.get(migrated.value);
		if (existing && existing.serialized !== serialized) {
			throw new ValidationError(
				`Provider prefix migration would create conflicting custom model "${migrated.value}" ` +
					`from both "${existing.source}" and "${model.value}".`,
			);
		}
		if (!existing) {
			customModelSources.set(migrated.value, { source: model.value, serialized });
			migratedCustomModels.push(migrated);
		}
	}

	// Compute every effort target before mutating any settings, including unrelated refs.
	let migratedReasoningEfforts: SubagentModelReasoningEfforts | undefined;
	const reasoningEfforts = settings.agent.subagentModelReasoningEfforts;
	if (
		reasoningEfforts &&
		typeof reasoningEfforts === "object" &&
		!Array.isArray(reasoningEfforts)
	) {
		migratedReasoningEfforts = { ...reasoningEfforts };
		for (const poolType of SUBAGENT_POOL_TYPES) {
			const pool = reasoningEfforts[poolType];
			if (!pool || typeof pool !== "object" || Array.isArray(pool)) continue;
			const targets = new Map<string, (typeof pool)[string]>();
			const sources = new Map<string, string>();
			for (const [sourceModel, effort] of Object.entries(pool)) {
				const targetModel = rewriteModelReference(sourceModel, prefixMap);
				if (targets.has(targetModel) && targets.get(targetModel) !== effort) {
					throw new ValidationError(
						`Provider prefix migration would overwrite subagent reasoning effort ` +
							`"${poolType}:${targetModel}" from both "${sources.get(targetModel)}" ` +
							`and "${sourceModel}".`,
					);
				}
				targets.set(targetModel, effort);
				sources.set(targetModel, sourceModel);
			}
			migratedReasoningEfforts[poolType] = Object.fromEntries(targets);
		}
	}

	const before = JSON.stringify({
		defaultModel: settings.agent.defaultModel,
		summaryModel: settings.agent.summaryModel,
		translationModel: settings.agent.translationModel,
		promptOptimizeModel: settings.agent.promptOptimizeModel,
		subagentModels: settings.agent.subagentModels,
		subagentAllowedModels: settings.agent.subagentAllowedModels,
		subagentModelReasoningEfforts: settings.agent.subagentModelReasoningEfforts,
		modelAggregations: settings.agent.modelAggregations,
		hiddenModels: settings.agent.hiddenModels,
		customModels: settings.agent.customModels,
		modelContextWindows: settings.agent.modelContextWindows,
		providerOrder: settings.agent.providerOrder,
		disabledProviders: settings.agent.disabledProviders,
		searchChannels: settings.search?.channels,
	});

	settings.agent.defaultModel = rewriteModelReference(settings.agent.defaultModel, prefixMap);
	settings.agent.summaryModel = rewriteModelReference(settings.agent.summaryModel, prefixMap);
	settings.agent.translationModel = rewriteModelReference(
		settings.agent.translationModel,
		prefixMap,
	);
	settings.agent.promptOptimizeModel = rewriteModelReference(
		settings.agent.promptOptimizeModel,
		prefixMap,
	);
	for (const key of Object.keys(settings.agent.subagentModels) as Array<
		keyof typeof settings.agent.subagentModels
	>) {
		const value = settings.agent.subagentModels[key];
		if (value) settings.agent.subagentModels[key] = rewriteModelReference(value, prefixMap);
	}
	for (const key of Object.keys(settings.agent.subagentAllowedModels) as Array<
		keyof typeof settings.agent.subagentAllowedModels
	>) {
		const values = settings.agent.subagentAllowedModels[key];
		if (values) {
			settings.agent.subagentAllowedModels[key] = rewriteModelReferenceArray(values, prefixMap);
		}
	}
	settings.agent.modelAggregations = settings.agent.modelAggregations?.map((aggregation) => ({
		...aggregation,
		models: rewriteModelReferenceArray(aggregation.models, prefixMap),
	}));
	settings.agent.hiddenModels = rewriteModelReferenceArray(
		settings.agent.hiddenModels ?? [],
		prefixMap,
	);
	if (migratedReasoningEfforts !== undefined) {
		settings.agent.subagentModelReasoningEfforts = migratedReasoningEfforts;
	}
	settings.agent.customModels = migratedCustomModels;
	settings.agent.modelContextWindows = migratedContextWindows;
	settings.agent.providerOrder = settings.agent.providerOrder?.map(
		(prefix) => prefixMap.get(prefix) ?? prefix,
	);
	settings.agent.disabledProviders = settings.agent.disabledProviders?.map(
		(prefix) => prefixMap.get(prefix) ?? prefix,
	);
	if (settings.search?.channels) {
		settings.search.channels = settings.search.channels.map((channel) => ({
			...channel,
			model: channel.model ? rewriteModelReference(channel.model, prefixMap) : channel.model,
		}));
	}

	const after = JSON.stringify({
		defaultModel: settings.agent.defaultModel,
		summaryModel: settings.agent.summaryModel,
		translationModel: settings.agent.translationModel,
		promptOptimizeModel: settings.agent.promptOptimizeModel,
		subagentModels: settings.agent.subagentModels,
		subagentAllowedModels: settings.agent.subagentAllowedModels,
		subagentModelReasoningEfforts: settings.agent.subagentModelReasoningEfforts,
		modelAggregations: settings.agent.modelAggregations,
		hiddenModels: settings.agent.hiddenModels,
		customModels: settings.agent.customModels,
		modelContextWindows: settings.agent.modelContextWindows,
		providerOrder: settings.agent.providerOrder,
		disabledProviders: settings.agent.disabledProviders,
		searchChannels: settings.search?.channels,
	});
	return before !== after;
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
