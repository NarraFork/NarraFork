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
	LegacyCustomApiProtocol,
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

	if (apiMode === "completions") return "completions-compatible";
	// codex / responses fold into the unified Responses protocol; an explicit
	// apiMode always wins over the legacy responsesApi boolean.
	if (apiMode) return "openai-responses";
	return responsesApi === false ? "completions-compatible" : "openai-responses";
}

export function customApiProtocolFromAnthropic(_officialApi?: boolean): CustomApiProtocol {
	return "anthropic-messages";
}

/**
 * Migrate a persisted/legacy protocol value to the current enum.
 *
 * The removed split-protocol values fold into their unified successor:
 *   codex-native / responses-compatible     → openai-responses
 *   anthropic-official / anthropic-compatible → anthropic-messages
 * Values that are already current pass through with `migratedFrom` undefined.
 */
export function migrateLegacyCustomApiProtocol(
	protocol: CustomApiProtocol | LegacyCustomApiProtocol,
): { protocol: CustomApiProtocol; migratedFrom?: LegacyCustomApiProtocol } {
	switch (protocol) {
		case "codex-native":
		case "responses-compatible":
			return { protocol: "openai-responses", migratedFrom: protocol };
		case "anthropic-official":
		case "anthropic-compatible":
			return { protocol: "anthropic-messages", migratedFrom: protocol };
		default:
			return { protocol };
	}
}

export function isOpenAICustomApiProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "openai-responses" || protocol === "completions-compatible";
}

export function isAnthropicCustomApiProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "anthropic-messages";
}

export function isGeminiCustomApiProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "gemini-compatible";
}

/**
 * Default User-Agent mode when an operator has not chosen one for this protocol.
 *
 * Relay defaults follow the protocol the traffic speaks: OpenAI Responses speaks
 * the Codex client contract and presents as Codex; Anthropic Messages speaks the
 * Claude Code dialect and presents as Claude Code. Other protocols present as
 * NarraFork.
 */
export function defaultUserAgentModeForProtocol(
	protocol: CustomApiProtocol,
): NonNullable<CustomApiProviderConfig["userAgentMode"]> {
	switch (protocol) {
		case "openai-responses":
			return "codex";
		case "anthropic-messages":
			return "claude-code";
		default:
			return "narrafork";
	}
}

export function customApiProtocolToOpenAIApiMode(
	protocol: CustomApiProtocol,
): OpenAIProviderConfig["apiMode"] | undefined {
	switch (protocol) {
		case "openai-responses":
			return "codex";
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
		// Legacy plain-Responses entries never sent Codex native tools: the
		// adapter only reads these flags in codex apiMode, and older clients
		// materialized `true` onto every entry regardless of mode — an explicit
		// `true` here is a ghost value, not a user choice. Force them off; the
		// NarraFork UA pin stays conditional because the UA selector was visible
		// for every protocol.
		codexWebSearch: legacyPlainResponses(provider) ? false : provider.codexWebSearch,
		codexImageGeneration: legacyPlainResponses(provider) ? false : provider.codexImageGeneration,
		userAgentMode:
			provider.userAgentMode ?? (legacyPlainResponses(provider) ? "narrafork" : undefined),
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
	};
}

/** Legacy OpenAI entries that spoke the plain Responses dialect (no Codex contract). */
function legacyPlainResponses(provider: OpenAIProviderConfig): boolean {
	if (provider.apiMode) return provider.apiMode === "responses";
	return provider.responsesApi !== false;
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
		// Legacy non-official entries never joined native-search routing (the old
		// conversion dropped nativeSearch for them), so any stored value is
		// inert; force search off when folding into anthropic-messages.
		nativeSearch: provider.officialApi ? provider.nativeSearch : false,
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
		// The unified Anthropic Messages protocol always speaks the Claude Code
		// dialect; server-side search stays opt-out via nativeSearch.
		officialApi: true,
		nativeSearch: provider.nativeSearch,
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
	provider: Omit<CustomApiProviderConfig, "protocol"> & {
		protocol?: CustomApiProtocol | LegacyCustomApiProtocol;
	},
): CustomApiProviderConfig {
	const rawProtocol = provider.protocol ?? "openai-responses";
	const { protocol, migratedFrom } = migrateLegacyCustomApiProtocol(rawProtocol);

	// Removed compatible protocols fold into the unified full-dialect protocol.
	// Feature toggles the old dialect never sent stay OFF after migration so the
	// traffic shape changes only where no toggle exists (wire dialect itself).
	//
	// The tool pins are unconditional: previous versions materialized
	// codexWebSearch/codexImageGeneration=true onto every entry at load time and
	// the toggles were never rendered for these protocols, so an explicit `true`
	// is a ghost value, not a user choice — and on the old wire it had no effect.
	// Users re-enable the tools explicitly on the unified protocol.
	const migratedDefaults: Partial<CustomApiProviderConfig> = {};
	if (migratedFrom === "responses-compatible") {
		migratedDefaults.codexWebSearch = false;
		migratedDefaults.codexImageGeneration = false;
		// The old wire identity for this protocol was the plain NarraFork UA;
		// pin it so upgrading does not silently re-fingerprint existing traffic.
		// An explicitly chosen UA (the selector was visible for all protocols)
		// still wins below.
		if (provider.userAgentMode === undefined) migratedDefaults.userAgentMode = "narrafork";
	}
	if (migratedFrom === "anthropic-compatible") {
		// nativeSearch was dropped by the old conversion for compatible entries,
		// so any stored value never took effect; keep search off after migration.
		migratedDefaults.nativeSearch = false;
	}

	return {
		...provider,
		protocol,
		geminiTransport:
			protocol === "gemini-compatible"
				? (provider.geminiTransport ?? "generate-content")
				: provider.geminiTransport,
		defaultReasoningEffort: provider.defaultReasoningEffort ?? undefined,
		codexAccountId: provider.codexAccountId ?? "",
		codexWebSocket: provider.codexWebSocket ?? false,
		// Migration pins win over stored values (ghost materializations — see
		// above); for unmigrated protocols the stored explicit choice wins.
		codexWebSearch: migratedDefaults.codexWebSearch ?? provider.codexWebSearch ?? true,
		codexImageGeneration:
			migratedDefaults.codexImageGeneration ?? provider.codexImageGeneration ?? true,
		nativeSearch: migratedDefaults.nativeSearch ?? provider.nativeSearch,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized ?? true,
		// Materialize the protocol default so UI display, storage, and the wire
		// all agree when the operator never touched the fingerprint control.
		userAgentMode:
			provider.userAgentMode ??
			migratedDefaults.userAgentMode ??
			defaultUserAgentModeForProtocol(protocol),
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
