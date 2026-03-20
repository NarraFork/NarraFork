import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";
import {
	FOLLOW_DEFAULT_MODEL,
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
		const allModels = mergeModels(
			fetchedOpenaiModels,
			fetchedAnthropicModels,
			fetchedClineModels,
			codexModels,
			customModels,
		);
		const visibleModels = allModels.filter((m) => !hidden.has(m.value));

		// --- "Follow default" option ---
		const defaultModelOption = visibleModels.find((m) => m.value === defaultModelValue);
		const defaultModelLabel = defaultModelOption?.label ?? defaultModelValue;
		const followDefaultOption: ModelOption = {
			value: FOLLOW_DEFAULT_MODEL,
			label: defaultModelLabel,
			provider: "__default__",
		};

		// Prepend follow-default to visible models for grouped select
		const visibleWithDefault = [followDefaultOption, ...visibleModels];
		const groupedModels = groupModelsByProvider(visibleWithDefault, {
			...providerLabels,
			__default__: "Default",
		});

		return {
			/** All models (including hidden). */
			allModels,
			/** Models after hiddenModels filter. */
			visibleModels,
			/** Models with "follow default" prepended, after hiddenModels filter. */
			visibleWithDefault,
			/** Grouped for Mantine Select (includes "follow default"). */
			groupedModels,
			/** The "follow default" ModelOption. */
			followDefaultOption,
			/** The current default model value from settings. */
			defaultModelValue,
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
		};
	}, [settingsData]);
}
