import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";
import {
	BUILTIN_MODELS,
	groupModelsByProvider,
	type ModelOption,
	mergeModels,
	modelValue,
} from "../lib/constants";

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
	});

	return useMemo(() => {
		const hidden = new Set<string>(settingsData?.agent?.hiddenModels ?? []);

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
			: BUILTIN_MODELS;

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

		// --- Custom models ---
		const customModels: ModelOption[] = (settingsData?.agent?.customModels ?? []).map(
			(m: { value: string; label: string; provider?: string }) => ({
				...m,
				provider: m.provider ?? "openai",
			}),
		);

		// --- Merge & filter ---
		const visibleModels = allModels.filter((m) => !hidden.has(m.value));
		const groupedModels = groupModelsByProvider(visibleModels, providerLabels);

		return {
			/** All models (including hidden). */
			allModels,
			/** Models after hiddenModels filter. */
			visibleModels,
			/** Grouped for Mantine Select. */
			groupedModels,
			/** OpenAI models grouped by provider. */
			openaiByProvider,
			/** Custom models. */
			customModels,
			/** Hidden model values set. */
			hiddenModels: hidden,
			/** Provider prefix → display name. */
			providerLabels,
			/** Raw settings data (for other fields). */
			settingsData,
		};
	}, [settingsData]);
}
