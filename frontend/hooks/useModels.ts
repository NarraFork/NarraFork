import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";
import {
	AGG_MODEL_PREFIX,
	FOLLOW_DEFAULT_MODEL,
	groupModelsByProvider,
	type ModelAggregation,
	type ModelOption,
	mergeModels,
	modelValue,
} from "../lib/constants";

const MODELS_SETTINGS_QUERY_GC_TIME_MS = 60_000;

export interface ProviderModels {
	prefix: string;
	name: string;
	models: ModelOption[];
}

/**
 * Central hook that builds the full model list from settings.
 * Replaces duplicated model-building logic across NarratorPanel,
 */
export function useAllModels() {
	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		gcTime: MODELS_SETTINGS_QUERY_GC_TIME_MS,
	});

	return useMemo(() => {
		const hidden = new Set<string>(settingsData?.agent?.hiddenModels ?? []);
		const providerOrder: string[] = settingsData?.agent?.providerOrder ?? [];
		const disabledProviders = new Set<string>(settingsData?.agent?.disabledProviders ?? []);

					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					.map((m: any) => {
						const id = String(m.model_id ?? m.modelId ?? "");
						return {
							label: String(
								m.model_short_name ?? m.modelShortName ?? m.model_name ?? m.modelName ?? id,
							),
							rateMultiplier: m.rate_multiplier ?? m.rateMultiplier,
						};
					})
			: [];

		// --- OpenAI-compatible models (per-provider) ---
		const openaiModelsGrouped: Array<{
			providerId: string;
			providerName: string;
			models: Array<{ id: string }>;
		}> = settingsData?.openaiModelsGrouped ?? [];

		const serverProviders: Array<{ id: string; prefix?: string; name?: string }> =
			settingsData?.openaiProviders ?? [];

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
			openaiByProvider.push({ prefix, name, models });
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
			openaiByProvider.push({ prefix, name, models });
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
			anthropicByProvider.push({ prefix, name, models });
		}

			providerId: string;
			providerName: string;
			models: Array<Record<string, unknown>>;



			const name = group.providerName || cfg?.name || prefix;
			providerLabels[prefix] = name;
			const models: ModelOption[] = [];
			for (const m of group.models) {
				const id = String(m.model_id ?? m.modelId ?? "");
				if (!id) continue;
				const rawRate = m.rate_multiplier ?? m.rateMultiplier;
				const opt: ModelOption = {
					value: `${prefix}:${id}`,
					label: String(
						m.model_short_name ?? m.modelShortName ?? m.model_name ?? m.modelName ?? id,
					),
					provider: prefix,
					rateMultiplier: typeof rawRate === "number" ? rawRate : undefined,
				};
				models.push(opt);
			}
		}

		// --- Cline models (per-provider, OpenRouter-based) ---
		const clineModelsGrouped: Array<{
			providerId: string;
			providerName: string;
			models: Array<{ id: string; name?: string }>;
		}> = settingsData?.clineModelsGrouped ?? [];

		const serverClineProviders: Array<{ id: string; prefix?: string; name?: string }> =
			settingsData?.clineProviders ?? [];

		const fetchedClineModels: ModelOption[] = [];
		const clineByProvider: ProviderModels[] = [];

		for (const group of clineModelsGrouped) {
			const cfg = serverClineProviders.find((p) => p.id === group.providerId);
			const prefix = cfg?.prefix ?? "cline";
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
				fetchedClineModels.push(opt);
			}
			clineByProvider.push({ prefix, name, models });
		}

		// --- Custom models ---
		const customModels: ModelOption[] = (settingsData?.agent?.customModels ?? []).map(
			(m: { value: string; label: string; provider?: string }) => ({
				...m,
				provider: m.provider ?? "openai",
			}),
		);

		// --- Codex models (from backend hardcoded list) ---
		// Only include codex models when codex credentials are available
		const codexModelIds: string[] = settingsData?.codexModels ?? [];
		const codexModels: ModelOption[] = settingsData?.codexAvailable
			? codexModelIds.map((id) => ({
					value: modelValue("codex", id),
					label: id,
					provider: "codex",
				}))
			: [];

		// --- Merge & filter ---
		// Build per-provider model arrays, then sort by providerOrder
		const providerModelArrays: { prefix: string; models: ModelOption[] }[] = [];
		const addGroup = (prefix: string, models: ModelOption[]) => {
			if (models.length === 0) return;
			providerModelArrays.push({ prefix, models });
		};

		for (const group of openaiByProvider) addGroup(group.prefix, group.models);
		for (const group of anthropicByProvider) addGroup(group.prefix, group.models);
		for (const group of clineByProvider) addGroup(group.prefix, group.models);
		if (codexModels.length > 0) addGroup("codex", codexModels);
		if (customModels.length > 0) addGroup("__custom__", customModels);

		// Sort by providerOrder (providers not in the list go to the end)
		if (providerOrder.length > 0) {
			const orderMap = new Map(providerOrder.map((p, i) => [p, i]));
			providerModelArrays.sort((a, b) => {
				const ai = orderMap.get(a.prefix) ?? 9999;
				const bi = orderMap.get(b.prefix) ?? 9999;
				return ai - bi;
			});
		}

		// Filter out disabled providers and merge
		const enabledModelArrays = providerModelArrays
			.filter((g) => !disabledProviders.has(g.prefix))
			.map((g) => g.models);
		const allModels = mergeModels(...enabledModelArrays);
		const visibleModels = allModels.filter((m) => !hidden.has(m.value));

		// --- Model aggregations ---
		const aggregations: ModelAggregation[] = settingsData?.agent?.modelAggregations ?? [];
		const aggModels: ModelOption[] = aggregations.map((agg) => ({
			value: `${AGG_MODEL_PREFIX}${agg.id}`,
			label: agg.name,
			provider: "__agg__",
		}));

		// --- "Follow default" option ---
		const defaultModelOption = visibleModels.find((m) => m.value === defaultModelValue);
		const defaultModelLabel = defaultModelOption?.label ?? defaultModelValue;
		const followDefaultOption: ModelOption = {
			value: FOLLOW_DEFAULT_MODEL,
			label: defaultModelLabel,
			provider: "__default__",
		};

		// Prepend follow-default and aggregations to visible models for grouped select
		const visibleWithDefault = [followDefaultOption, ...aggModels, ...visibleModels];
		const groupedModels = groupModelsByProvider(visibleWithDefault, {
			...providerLabels,
			__default__: "Default",
			__agg__: "Aggregations",
		});

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
			/** The current default model value from settings. */
			defaultModelValue,
			/** Model aggregations from settings. */
			aggregations,
			/** Codex models only. */
			codexModels,
			/** OpenAI models grouped by provider. */
			openaiByProvider,
			/** Anthropic models grouped by provider. */
			anthropicByProvider,
			/** Cline models grouped by provider. */
			clineByProvider,
			/** Custom models. */
			customModels,
			/** Hidden model values set. */
			hiddenModels: hidden,
			/** Provider prefix → display name. */
			providerLabels,
			/** Raw settings data (for other fields). */
			settingsData,
			/** Per-provider model groups BEFORE disabled filtering (for overview). */
			allProviderModels: providerModelArrays,
			/** Set of disabled provider prefixes (for overview). */
			disabledProviders,
		};
	}, [settingsData]);
}
