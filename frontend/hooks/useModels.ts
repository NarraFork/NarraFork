import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../lib/api";
import {
	AGG_MODEL_PREFIX,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	groupModelsByProvider,
	type ModelAggregation,
	type ModelOption,
	mergeModels,
	modelValue,
} from "../lib/constants";
import type { ProviderCapabilityKey } from "./usePlatform";

const MODELS_SETTINGS_QUERY_GC_TIME_MS = 60_000;
const MODELS_SETTINGS_QUERY_STALE_TIME_MS = 30_000;

/**
 * The retired `tutorial:` prefix stays unselectable even if old settings or a
 * provider catalog still contain it. The server rejects it before plugin routing.
 */
export function isSelectableProviderPrefix(
	prefix: string,
	disabledProviders: ReadonlySet<string>,
): boolean {
	if (prefix === "tutorial") return false;
	return !disabledProviders.has(prefix);
}

export interface ProviderModels {
	prefix: string;
	name: string;
	models: ModelOption[];
	agentProviderType?: ProviderCapabilityKey;
	/**
	 * NUG providers only: the configured provider id, which the per-provider
	 * model-refresh endpoint is keyed by. The prefix alone is user-editable and
	 * therefore not a usable API key.
	 */
	nugProviderId?: string;
}

interface ConfiguredFallbackModel extends ModelOption {
	providerName: string;
	agentProviderType?: ProviderCapabilityKey;
	pinnedAs?: Array<"default" | "summary">;
}

export function getConfiguredFallbackModels(
	settingsData: Record<string, unknown> | undefined,
): ConfiguredFallbackModel[] {
	if (!settingsData) return [];
	// biome-ignore lint/suspicious/noExplicitAny: settings response is a dynamic API entity
	const settings = settingsData as any;
	const results: ConfiguredFallbackModel[] = [];
	const seen = new Set<string>();
	const disabledPrefixes = new Set<string>(settings.agent?.disabledProviders ?? []);
	const configuredPrefixes = new Map<
		string,
		{ name: string; type?: ProviderCapabilityKey; defaultModel?: string }
	>();
	const registerProvider = (
		provider: Record<string, unknown>,
		type: ProviderCapabilityKey,
		credentialKey: "apiKey" | "accessToken",
		requireBaseUrl = false,
	) => {
		const prefix = String(provider.prefix ?? type).trim();
		if (!prefix || provider.disabled || disabledPrefixes.has(prefix)) return;
		if (!String(provider[credentialKey] ?? "").trim()) return;
		if (requireBaseUrl && !String(provider.baseUrl ?? "").trim()) return;
		configuredPrefixes.set(prefix, {
			name: String(provider.name ?? prefix),
			type,
			defaultModel: String(provider.defaultModel ?? ""),
		});
	};
	const add = (
		prefix: string,
		model: string,
		providerName: string,
		agentProviderType?: ProviderCapabilityKey,
		modelIsFullValue = false,
		pinnedAs?: "default" | "summary",
	) => {
		const trimmedPrefix = prefix.trim();
		const trimmedModel = model.trim();
		if (!configuredPrefixes.has(trimmedPrefix) || !trimmedModel) return;
		if (
			trimmedModel === FOLLOW_DEFAULT_MODEL ||
			trimmedModel === FOLLOW_SUMMARY_MODEL ||
			trimmedModel.startsWith(AGG_MODEL_PREFIX)
		)
			return;
		const value = modelIsFullValue
			? trimmedModel
			: trimmedModel.startsWith(`${trimmedPrefix}:`)
				? trimmedModel
				: `${trimmedPrefix}:${trimmedModel}`;
		const existing = seen.has(value) ? results.find((r) => r.value === value) : undefined;
		if (existing) {
			// The same concrete model can sit in both the default and summary slots.
			// Keep one row but remember every role that pins it, so the UI can tell
			// the user which assignment to change.
			if (pinnedAs && !existing.pinnedAs?.includes(pinnedAs)) {
				existing.pinnedAs = [...(existing.pinnedAs ?? []), pinnedAs];
			}
			return;
		}
		seen.add(value);
		results.push({
			value,
			label: value.slice(value.indexOf(":") + 1),
			provider: trimmedPrefix,
			providerName: providerName || trimmedPrefix,
			agentProviderType,
			...(pinnedAs ? { pinnedAs: [pinnedAs] } : {}),
		});
	};

	for (const provider of (settings.customApiProviders ?? []) as Array<Record<string, unknown>>) {
		const protocol = String(provider.protocol ?? "");
		const type: ProviderCapabilityKey = protocol.startsWith("anthropic")
			? "anthropic"
			: protocol === "gemini-compatible"
				? "gemini"
				: "openai";
		registerProvider(provider, type, "apiKey");
	}
	for (const provider of (settings.openaiProviders ?? []) as Array<Record<string, unknown>>) {
		registerProvider(provider, "openai", "apiKey");
	}
	for (const provider of (settings.anthropicProviders ?? []) as Array<Record<string, unknown>>) {
		registerProvider(provider, "anthropic", "apiKey");
	}
	for (const provider of (settings.geminiProviders ?? []) as Array<Record<string, unknown>>) {
		registerProvider(provider, "gemini", "apiKey");
	}
	for (const provider of (settings.nugProviders ?? []) as Array<Record<string, unknown>>) {
		registerProvider(provider, "nug", "apiKey", true);
	}
	if (settings.codexAvailable && !disabledPrefixes.has("codex")) {
		configuredPrefixes.set("codex", { name: "Codex", type: "codex" });
	}

	for (const [prefix, configured] of configuredPrefixes) {
		if (configured.defaultModel) {
			add(prefix, configured.defaultModel, configured.name, configured.type);
		}
	}
	const agentDefaultModel = String(settings.agent?.defaultModel || "");
	const agentSummaryModel = String(settings.agent?.summaryModel || "");
	if (agentDefaultModel) {
		const colon = agentDefaultModel.indexOf(":");
		if (colon > 0) {
			const prefix = agentDefaultModel.slice(0, colon);
			const configured = configuredPrefixes.get(prefix);
			if (configured) {
				add(prefix, agentDefaultModel, configured.name, configured.type, true, "default");
			}
		}
	}
	if (agentSummaryModel) {
		const colon = agentSummaryModel.indexOf(":");
		if (colon > 0) {
			const prefix = agentSummaryModel.slice(0, colon);
			const configured = configuredPrefixes.get(prefix);
			if (configured) {
				add(prefix, agentSummaryModel, configured.name, configured.type, true, "summary");
			}
		}
	}
	return results;
}

/**
 * Decide whether a fallback-only model is actually delisted (catalog was
 * fetched for that provider and no longer contains it) versus merely not
 * discovered yet (empty catalog — keep quiet so bootstrap does not look like
 * an outage).
 */
export function classifyFallbackModelPresence(args: {
	value: string;
	provider: string | undefined;
	catalogValues: ReadonlySet<string>;
	catalogCountByProvider: ReadonlyMap<string, number>;
	pinnedAs?: Array<"default" | "summary">;
}): { catalogMissing: boolean; pinnedAs?: Array<"default" | "summary"> } {
	const { value, provider, catalogValues, catalogCountByProvider, pinnedAs } = args;
	if (catalogValues.has(value)) return { catalogMissing: false, pinnedAs };
	const discovered = provider ? (catalogCountByProvider.get(provider) ?? 0) : 0;
	// Empty catalog for this provider: discovery has not produced a list yet
	// (or the cache was cleared on purpose). Do not label the model "delisted".
	if (discovered === 0) return { catalogMissing: false, pinnedAs };
	return { catalogMissing: true, pinnedAs };
}

/**
 * Central hook that builds the full model list from settings.
 * Replaces duplicated model-building logic across NarratorPanel,
 * sessions/index and settings pages.
 */
export function useAllModels() {
	const qc = useQueryClient();
	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: MODELS_SETTINGS_QUERY_STALE_TIME_MS,
		gcTime: MODELS_SETTINGS_QUERY_GC_TIME_MS,
	});
	// The shared NUG availability poller refreshes model availability while a
	// narrator waits for a temporarily-unavailable model to recover. Re-fetch
	// settings (which carry the NUG model list + `available` flags) so the picker
	// reflects recovery/outage live.
	useEffect(() => {
		const onAvailabilityChanged = () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
		};
		window.addEventListener(
			"narrafork:nug-model-availability-changed",
			onAvailabilityChanged as EventListener,
		);
		return () => {
			window.removeEventListener(
				"narrafork:nug-model-availability-changed",
				onAvailabilityChanged as EventListener,
			);
		};
	}, [qc]);

	return useMemo(() => {
		const hidden = new Set<string>(settingsData?.agent?.hiddenModels ?? []);
		const providerOrder: string[] = settingsData?.agent?.providerOrder ?? [];
		const disabledProviders = new Set<string>(settingsData?.agent?.disabledProviders ?? []);
		const collectDisabledProviderPrefixes = (
			providers?: Array<{ prefix?: string; disabled?: boolean }>,
		) => {
			for (const provider of providers ?? []) {
				if (provider.disabled && provider.prefix) disabledProviders.add(provider.prefix);
			}
		};
		collectDisabledProviderPrefixes(settingsData?.customApiProviders);
		collectDisabledProviderPrefixes(settingsData?.openaiProviders);
		collectDisabledProviderPrefixes(settingsData?.anthropicProviders);
		collectDisabledProviderPrefixes(settingsData?.nugProviders);
		collectDisabledProviderPrefixes(settingsData?.geminiProviders);
		// Agent mode is supported for every provider: the capability that used to gate this
		// had no signal behind it and always resolved to supported.
		const providerAgentModeSupported = (_provider: ProviderCapabilityKey) => true;

		// --- OpenAI-compatible models (per-provider) ---
		const openaiModelsGrouped: Array<{
			providerId: string;
			providerName: string;
			models: Array<{ id: string }>;
		}> = settingsData?.openaiModelsGrouped ?? [];

		const serverProviders: Array<{ id: string; prefix?: string; name?: string }> =
			settingsData?.openaiProviders ?? [];

		const providerLabels: Record<string, string> = {
			codex: "Codex",
			gemini: "Gemini",
		};
		const fetchedOpenaiModels: ModelOption[] = [];
		const openaiByProvider: ProviderModels[] = [];

		for (const group of openaiModelsGrouped) {
			const cfg = serverProviders.find((p) => p.id === group.providerId);
			const prefix = cfg?.prefix ?? "openai";
			const name = group.providerName || cfg?.name || prefix;
			providerLabels[prefix] = name;
			const models: ModelOption[] = [];
			for (const m of group.models) {
				const opt: ModelOption = {
					value: `${prefix}:${m.id}`,
					label: m.id,
					provider: prefix,
				};
				models.push(opt);
				fetchedOpenaiModels.push(opt);
			}
			openaiByProvider.push({ prefix, name, models, agentProviderType: "openai" });
		}

		// Fallback: legacy flat openaiModels (no grouped data)
		if (fetchedOpenaiModels.length === 0 && settingsData?.openaiModels?.length) {
			const prefix = serverProviders[0]?.prefix ?? "openai";
			const name = serverProviders[0]?.name ?? "OpenAI";
			providerLabels[prefix] = name;
			const models: ModelOption[] = [];
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			for (const m of settingsData.openaiModels as any[]) {
				const opt: ModelOption = {
					value: modelValue(prefix, m.id),
					label: m.id,
					provider: prefix,
				};
				models.push(opt);
				fetchedOpenaiModels.push(opt);
			}
			openaiByProvider.push({ prefix, name, models, agentProviderType: "openai" });
		}

		// --- Anthropic models (per-provider) ---
		const anthropicModelsGrouped: Array<{
			providerId: string;
			providerName: string;
			models: Array<{ id: string }>;
		}> = settingsData?.anthropicModelsGrouped ?? [];

		const serverAnthropicProviders: Array<{ id: string; prefix?: string; name?: string }> =
			settingsData?.anthropicProviders ?? [];

		const fetchedAnthropicModels: ModelOption[] = [];
		const anthropicByProvider: ProviderModels[] = [];

		for (const group of anthropicModelsGrouped) {
			const cfg = serverAnthropicProviders.find((p) => p.id === group.providerId);
			const prefix = cfg?.prefix ?? "anthropic";
			const name = group.providerName || cfg?.name || prefix;
			providerLabels[prefix] = name;
			const models: ModelOption[] = [];
			for (const m of group.models) {
				const opt: ModelOption = {
					value: `${prefix}:${m.id}`,
					label: m.id,
					provider: prefix,
				};
				models.push(opt);
				fetchedAnthropicModels.push(opt);
			}
			anthropicByProvider.push({ prefix, name, models, agentProviderType: "anthropic" });
		}

		// --- Gemini models (per-provider, native Google API) ---
		const geminiModelsGrouped: Array<{
			providerId: string;
			providerName: string;
			models: Array<{ id: string; name?: string }>;
		}> = settingsData?.geminiModelsGrouped ?? [];

		const serverGeminiProviders: Array<{ id: string; prefix?: string; name?: string }> =
			settingsData?.geminiProviders ?? [];

		const fetchedGeminiModels: ModelOption[] = [];
		const geminiByProvider: ProviderModels[] = [];

		for (const group of geminiModelsGrouped) {
			const cfg = serverGeminiProviders.find((p) => p.id === group.providerId);
			const prefix = cfg?.prefix ?? "gemini";
			const name = group.providerName || cfg?.name || prefix;
			providerLabels[prefix] = name;
			const models: ModelOption[] = [];
			for (const m of group.models) {
				const opt: ModelOption = {
					value: `${prefix}:${m.id}`,
					label: m.name || m.id,
					provider: prefix,
				};
				models.push(opt);
				fetchedGeminiModels.push(opt);
			}
			geminiByProvider.push({ prefix, name, models, agentProviderType: "gemini" });
		}

		// --- NUG models (per-provider, channel metadata aware) ---
		const nugModelsGrouped: Array<{
			providerId: string;
			providerName: string;
			models: Array<Record<string, unknown>>;
			usdRate?: number;
		}> = settingsData?.nugModelsGrouped ?? [];

		const serverNugProviders: Array<{ id: string; prefix?: string; name?: string }> =
			settingsData?.nugProviders ?? [];

		const nugByProvider: ProviderModels[] = [];
		for (const group of nugModelsGrouped) {
			const cfg = serverNugProviders.find((p) => p.id === group.providerId);
			const prefix = cfg?.prefix ?? "nug";
			const name = group.providerName || cfg?.name || prefix;
			providerLabels[prefix] = name;
			const groupUsdRate = typeof group.usdRate === "number" ? group.usdRate : undefined;
			const models: ModelOption[] = [];
			for (const m of group.models) {
				const id = String(m.id ?? "");
				if (!id) continue;
				const rawBareModel = m.model ?? id.split(":").slice(1).join(":");
				const bareModel = String(rawBareModel || id);
				const channel = String(m.channel ?? id.split(":")[0] ?? "");
				const channelType = String(m.channelType ?? channel);
				// An empty array is meaningful and must survive: the gateway reports the
				// exact thinking tiers each model accepts, and `[]` asserts there are
				// none. Only an absent field means "unknown, infer from the model id".
				const effortLevels = Array.isArray(m.effortLevels)
					? m.effortLevels.filter((l): l is string => typeof l === "string")
					: undefined;
				const pricing =
					m.pricing != null && typeof m.pricing === "object" && !Array.isArray(m.pricing)
						? (m.pricing as ModelOption["pricing"])
						: undefined;
				const numField = (key: string): number | undefined => {
					const v = (m as Record<string, unknown>)[key];
					const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
					return Number.isFinite(n) ? n : undefined;
				};
				models.push({
					value: `${prefix}:${id}`,
					label: `${channel} · ${String(m.name ?? bareModel)}`,
					provider: prefix,
					channel,
					channelType,
					bareModel,
					...(effortLevels ? { effortLevels } : {}),
					...(pricing ? { pricing } : {}),
					...(numField("officialInputUsd") != null
						? { officialInputUsd: numField("officialInputUsd") }
						: {}),
					...(numField("officialOutputUsd") != null
						? { officialOutputUsd: numField("officialOutputUsd") }
						: {}),
					...(numField("officialCacheCreationInputUsd") != null
						? {
								officialCacheCreationInputUsd: numField("officialCacheCreationInputUsd"),
							}
						: {}),
					...(numField("officialCacheReadInputUsd") != null
						? { officialCacheReadInputUsd: numField("officialCacheReadInputUsd") }
						: {}),
					...(numField("channelMultiplier") != null
						? { channelMultiplier: numField("channelMultiplier") }
						: {}),
					...(numField("contextWindow") != null || numField("contextLength") != null
						? {
								contextWindow: numField("contextWindow") ?? numField("contextLength"),
							}
						: {}),
					...(groupUsdRate != null ? { usdRate: groupUsdRate } : {}),
					// A NUG model whose upstream is temporarily unavailable (whole
					// credential pool disabled) is kept in the list but flagged so the
					// picker can mark it "temporarily unavailable".
					...(typeof m.available === "boolean" ? { available: m.available } : {}),
				});
			}
			nugByProvider.push({
				prefix,
				name,
				models,
				agentProviderType: "nug",
				...(group.providerId ? { nugProviderId: group.providerId } : {}),
			});
		}

		// --- Custom models ---
		const modelPrefix = (model: { value: string; provider?: string }) => {
			if (model.provider) return model.provider;
			const idx = model.value.indexOf(":");
			return idx > 0 ? model.value.slice(0, idx) : "openai";
		};
		const customModels: ModelOption[] = (settingsData?.agent?.customModels ?? [])
			.map((m: { value: string; label: string; provider?: string }) => ({
				...m,
				provider: modelPrefix(m),
			}))
			.filter((m: ModelOption) => !disabledProviders.has(modelPrefix(m)));

		// --- Codex models (from backend hardcoded list) ---
		// Only include codex models when codex credentials are available
		const codexModelIds: string[] = settingsData?.codexModels ?? [];
		const codexModels: ModelOption[] = settingsData?.codexAvailable
			? codexModelIds.map((id) => ({
					value: modelValue("codex", id),
					label: id,
					provider: "codex",
					bareModel: id,
				}))
			: [];

		// --- Plugin provider models (from the host provider registry) ---
		// Values are already `prefix:modelId`. Models from a disabled plugin arrive with
		// `available: false` so the picker can show them as temporarily unusable rather
		// than hiding a provider the user just installed.
		const pluginProviderGroups: Array<{
			prefix: string;
			name: string;
			models: ModelOption[];
			pluginId?: string;
			contributionId?: string;
		}> = (settingsData?.pluginProviderModelsGrouped ?? [])
			.map(
				(group: {
					prefix?: unknown;
					name?: unknown;
					pluginId?: unknown;
					contributionId?: unknown;
					models?: Array<Record<string, unknown>>;
				}) => {
					const prefix = typeof group.prefix === "string" ? group.prefix : "";
					const name = typeof group.name === "string" && group.name ? group.name : prefix;
					const models: ModelOption[] = (group.models ?? []).flatMap((entry) => {
						const value = typeof entry.value === "string" ? entry.value : "";
						const bareModel = typeof entry.bareModel === "string" ? entry.bareModel : "";
						if (!value || !bareModel) return [];
						return [
							{
								value,
								label: typeof entry.label === "string" && entry.label ? entry.label : bareModel,
								provider: prefix,
								bareModel,
								...(typeof entry.contextWindow === "number"
									? { contextWindow: entry.contextWindow }
									: {}),
								...(Array.isArray(entry.effortLevels)
									? {
											effortLevels: entry.effortLevels.filter(
												(level): level is string => typeof level === "string",
											),
										}
									: {}),
								...(entry.available === false ? { available: false } : {}),
							},
						];
					});
					return {
						prefix,
						name,
						models,
						// Carried through so the provider settings page can address the owning
						// plugin; the prefix alone is user-overridable and not a stable key.
						...(typeof group.pluginId === "string" ? { pluginId: group.pluginId } : {}),
						...(typeof group.contributionId === "string"
							? { contributionId: group.contributionId }
							: {}),
					};
				},
			)
			.filter((group: { prefix: string }) => group.prefix.length > 0);

		// --- Merge & filter ---
		// Build per-provider model arrays, then sort by providerOrder
		const providerModelArrays: ProviderModels[] = [];
		const addGroup = (
			prefix: string,
			models: ModelOption[],
			agentProviderType?: ProviderCapabilityKey,
			nugProviderId?: string,
		) => {
			if (models.length === 0) return;
			providerModelArrays.push({
				prefix,
				name: providerLabels[prefix] ?? prefix,
				models,
				agentProviderType,
				...(nugProviderId ? { nugProviderId } : {}),
			});
		};

		for (const group of openaiByProvider)
			addGroup(group.prefix, group.models, group.agentProviderType);
		for (const group of anthropicByProvider)
			addGroup(group.prefix, group.models, group.agentProviderType);
		for (const group of geminiByProvider)
			addGroup(group.prefix, group.models, group.agentProviderType);
		for (const group of nugByProvider)
			addGroup(group.prefix, group.models, group.agentProviderType, group.nugProviderId);
		if (codexModels.length > 0) addGroup("codex", codexModels, "codex");
		// Executable-plugin providers, after every builtin so a plugin never reorders
		// the familiar provider list. Each group already carries fully-prefixed values.
		for (const group of pluginProviderGroups) {
			providerLabels[group.prefix] = group.name;
			addGroup(group.prefix, group.models);
		}
		if (customModels.length > 0) addGroup("__custom__", customModels);

		// Keep configured defaults and the current default/summary selections usable even
		// before model discovery succeeds or after a provider cache is cleared.
		// When the provider catalog is already populated but no longer lists the
		// model (delisted after a refresh), still keep the row so the pin stays
		// visible — but mark it `catalogMissing` so the UI can tell the user to
		// reassign default/summary to an available model instead of offering hide
		// or "set as default/summary" as the fix.
		const catalogValues = new Set<string>();
		const catalogCountByProvider = new Map<string, number>();
		const catalogMissingModels: ModelOption[] = [];
		for (const group of providerModelArrays) {
			catalogCountByProvider.set(
				group.prefix,
				(catalogCountByProvider.get(group.prefix) ?? 0) + group.models.length,
			);
			for (const m of group.models) catalogValues.add(m.value);
		}
		for (const fallback of getConfiguredFallbackModels(
			settingsData as Record<string, unknown> | undefined,
		)) {
			providerLabels[fallback.provider ?? ""] = fallback.providerName;
			const presence = classifyFallbackModelPresence({
				value: fallback.value,
				provider: fallback.provider,
				catalogValues,
				catalogCountByProvider,
				pinnedAs: fallback.pinnedAs,
			});
			const annotated: ModelOption = {
				...fallback,
				...(presence.catalogMissing ? { catalogMissing: true } : {}),
				...(presence.pinnedAs?.length ? { pinnedAs: presence.pinnedAs } : {}),
			};
			if (presence.catalogMissing) {
				catalogMissingModels.push(annotated);
			}
			const existing = providerModelArrays.find((group) => group.prefix === fallback.provider);
			if (existing) {
				existing.models = mergeModels(existing.models, [annotated]);
				existing.agentProviderType ??= fallback.agentProviderType;
			} else if (fallback.provider) {
				addGroup(fallback.provider, [annotated], fallback.agentProviderType);
			}
		}

		const agentModeUnsupportedProviders = new Set<ProviderCapabilityKey>();
		for (const group of providerModelArrays) {
			if (group.agentProviderType && !providerAgentModeSupported(group.agentProviderType)) {
				agentModeUnsupportedProviders.add(group.agentProviderType);
			}
		}

		// Sort by providerOrder (providers not in the list go to the end)
		if (providerOrder.length > 0) {
			const orderMap = new Map(providerOrder.map((p, i) => [p, i]));
			providerModelArrays.sort((a, b) => {
				const ai = orderMap.get(a.prefix) ?? 9999;
				const bi = orderMap.get(b.prefix) ?? 9999;
				return ai - bi;
			});
		}

		// Filter out user-disabled providers, providers unavailable for agent mode, and
		// the reserved tutorial prefix.
		const enabledModelArrays = providerModelArrays
			.filter(
				(g) =>
					isSelectableProviderPrefix(g.prefix, disabledProviders) &&
					(!g.agentProviderType || providerAgentModeSupported(g.agentProviderType)),
			)
			.map((g) => g.models);
		const allModels = mergeModels(...enabledModelArrays);
		const visibleModels = allModels.filter((m) => !hidden.has(m.value));

		// --- Model aggregations ---
		const aggregations: ModelAggregation[] = settingsData?.agent?.modelAggregations ?? [];
		const availableModelValues = new Set(allModels.map((model) => model.value));
		const aggModels: ModelOption[] = aggregations
			.filter((agg) => agg.models.some((model) => availableModelValues.has(model)))
			.map((agg) => ({
				value: `${AGG_MODEL_PREFIX}${agg.id}`,
				label: agg.name,
				provider: "__agg__",
			}));

		// --- "Follow default" / "Follow summary" options ---
		// Build a meta "follow" option that carries the resolved target model's
		// pricing/metadata so price popups work on the follow entry too.
		const buildFollowOption = (
			value: string,
			provider: string,
			targetValue: string,
		): ModelOption => {
			const target = visibleModels.find((m) => m.value === targetValue);
			return {
				value,
				// `|| targetValue` guards against an empty target label; `|| value`
				// guards against an empty targetValue so the label is never "".
				label: target?.label || targetValue || value,
				provider,
				...(target?.pricing ? { pricing: target.pricing } : {}),
				...(target?.officialInputUsd != null ? { officialInputUsd: target.officialInputUsd } : {}),
				...(target?.officialOutputUsd != null
					? { officialOutputUsd: target.officialOutputUsd }
					: {}),
				...(target?.officialCacheCreationInputUsd != null
					? { officialCacheCreationInputUsd: target.officialCacheCreationInputUsd }
					: {}),
				...(target?.officialCacheReadInputUsd != null
					? { officialCacheReadInputUsd: target.officialCacheReadInputUsd }
					: {}),
				...(target?.channelMultiplier != null
					? { channelMultiplier: target.channelMultiplier }
					: {}),
				...(target?.contextWindow != null ? { contextWindow: target.contextWindow } : {}),
				...(target?.usdRate != null ? { usdRate: target.usdRate } : {}),
			};
		};

		// May be "" before the setup wizard has run. There is deliberately no
		// hardcoded fallback: showing a concrete model here would present a
		// provider the user never configured as the current default, and the
		// resulting failure would name that phantom model instead of the real
		// cause. `buildFollowOption` already falls back to labelling the entry
		// with its own sentinel when the target is empty.
		const defaultModelValue = settingsData?.agent?.defaultModel || "";
		const followDefaultOption = buildFollowOption(
			FOLLOW_DEFAULT_MODEL,
			"__default__",
			defaultModelValue,
		);

		// Use `||` (not `??`) so a stored empty string (e.g. after the summary
		// model becomes unavailable) falls back to the default model — mirroring
		// the server-side resolveConfiguredSummaryModel behavior where an unset
		// summary model follows the default model. Never surface a hardcoded
		// model that is not actually configured: it would masquerade as a real
		// selection and mislead the user. Both may be "" pre-setup, in which case
		// `buildFollowOption` labels the entry with its sentinel value.
		const summaryModelValue = settingsData?.agent?.summaryModel || defaultModelValue;
		const followSummaryOption = buildFollowOption(
			FOLLOW_SUMMARY_MODEL,
			"__summary__",
			summaryModelValue,
		);

		// Prepend follow-default, follow-summary and aggregations to visible models for grouped select
		const visibleWithDefault = [
			followDefaultOption,
			followSummaryOption,
			...aggModels,
			...visibleModels,
		];
		const groupedModels = groupModelsByProvider(visibleWithDefault, {
			...providerLabels,
			__default__: "Default",
			__summary__: "Summary",
			__agg__: "Aggregations",
		});

		// Provider prefix → NUG provider id. Model pickers group by prefix, so this
		// is what lets a group header address the right provider (e.g. to refresh
		// just that gateway's model list) without touching every ModelOption.
		const nugProviderIdByPrefix: Record<string, string> = {};
		for (const group of nugByProvider) {
			if (group.nugProviderId) nugProviderIdByPrefix[group.prefix] = group.nugProviderId;
		}

		return {
			/** All models (including hidden) — disabled providers filtered out. */
			allModels,
			/** Models after hiddenModels filter. */
			visibleModels,
			/** Models with "follow default" and aggregations prepended, after hiddenModels filter. */
			visibleWithDefault,
			/** Grouped for Mantine Select (includes "follow default" and aggregations). */
			groupedModels,
			/** The "follow default" ModelOption. */
			followDefaultOption,
			/** The "follow summary" ModelOption. */
			followSummaryOption,
			/** The current default model value from settings. */
			defaultModelValue,
			/** The current summary model value from settings. */
			summaryModelValue,
			/** Model aggregations from settings. */
			aggregations,
			/** Codex models only. */
			codexModels,
			/** OpenAI models grouped by provider. */
			openaiByProvider,
			/** Anthropic models grouped by provider. */
			anthropicByProvider,
			/** Gemini models grouped by provider. */
			geminiByProvider,
			/** NUG models grouped by provider. */
			nugByProvider,
			/** Provider prefix → NUG provider id, for prefix-keyed model pickers. */
			nugProviderIdByPrefix,
			/** Custom models. */
			customModels,
			/** Hidden model values set. */
			hiddenModels: hidden,
			/**
			 * Models kept only because a default/summary (or provider-default)
			 * selection still points at them after they left the provider catalog.
			 * The UI should prompt reassignment of those roles.
			 */
			catalogMissingModels,
			/** Provider prefix → display name. */
			providerLabels,
			/** Raw settings data (for other fields). */
			settingsData,
			/** Per-provider model groups BEFORE disabled filtering (for overview). */
			allProviderModels: providerModelArrays,
			/**
			 * Executable-plugin providers, with their owning plugin identity. Kept separate
			 * from `allProviderModels` because the provider settings page needs to know which
			 * prefixes came from plugins in order to route the detail area.
			 */
			pluginProviderGroups,
			/** Provider capability keys that are configured but unavailable for agent mode. */
			agentModeUnsupportedProviders,
			/** Set of disabled provider prefixes (for overview). */
			disabledProviders,
		};
	}, [settingsData]);
}
