import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";
import { groupModelsByProvider, type ModelOption, mergeModels, modelValue } from "../lib/constants";

// Hardcoded Codex models (no API to fetch them)
const BUILTIN_CODEX_MODELS = [
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
];

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

		// --- Custom models ---
		const customModels: ModelOption[] = (settingsData?.agent?.customModels ?? []).map(
			(m: { value: string; label: string; provider?: string }) => ({
				...m,
				provider: m.provider ?? "openai",
			}),
		);

		// --- Codex models (hardcoded) ---
		const codexModels: ModelOption[] = BUILTIN_CODEX_MODELS.map((id) => ({
			value: modelValue("codex", id),
			label: id,
			provider: "codex",
		}));

		// --- Merge & filter ---
		const allModels = mergeModels(
			fetchedOpenaiModels,
			fetchedAnthropicModels,
			codexModels,
			customModels,
		);
		const visibleModels = allModels.filter((m) => !hidden.has(m.value));
		const groupedModels = groupModelsByProvider(visibleModels, providerLabels);

		return {
			/** All models (including hidden). */
			allModels,
			/** Models after hiddenModels filter. */
			visibleModels,
			/** Grouped for Mantine Select. */
			groupedModels,
			/** Codex models only. */
			codexModels,
			/** OpenAI models grouped by provider. */
			openaiByProvider,
			/** Anthropic models grouped by provider. */
			anthropicByProvider,
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
