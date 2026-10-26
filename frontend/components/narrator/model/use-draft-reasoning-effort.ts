import { clampReasoningEffort, type ReasoningEffort } from "@shared/reasoning-effort";
import { useMemo } from "react";
import { useActualResolvedModelCard } from "../../../hooks/useModelCatalog";
import { useAllModels } from "../../../hooks/useModels";
import {
	type ModelSelectionSettings,
	resolveCodexCapableProviders,
	resolveReasoningEffortSupport,
} from "../interaction/use-model-selection";
import { useResolvedModel } from "../interaction/use-resolved-model";

export interface DraftReasoningEffort {
	/** Whether the selected model accepts a thinking tier at all. */
	supported: boolean;
	/** Tiers the model accepts, ascending. */
	options: readonly ReasoningEffort[];
	/**
	 * The tier a new session actually gets when the composer sends no explicit
	 * override: the instance default, clamped onto this model's tiers. Showing the
	 * clamped value keeps the picker honest — the raw default may be a tier the
	 * selected model rejects.
	 */
	defaultEffort: ReasoningEffort;
}

const FALLBACK_DEFAULT_EFFORT: ReasoningEffort = "max";

/**
 * The reasoning-effort menu for a model that has no session behind it yet.
 *
 * The dashboard composer creates its narrator on send, so there is no
 * `narrator.reasoningEffort` to read and no mutation target to write. What it
 * still needs is exactly what the session status bar shows: whether a menu is
 * offered for the currently selected model, which tiers that model accepts, and
 * which one will be used if the user says nothing. All three come from
 * {@link resolveReasoningEffortSupport}, the same computation the status bar uses,
 * so a model can never offer one ladder before creation and another after.
 */
export function useDraftReasoningEffort(model: string): DraftReasoningEffort {
	const { visibleWithDefault, defaultModelValue, aggregations, settingsData } = useAllModels();
	const { resolvedModel, resolvedBareModel, resolvedModelOption } = useResolvedModel(
		model,
		defaultModelValue,
		aggregations,
		visibleWithDefault,
	);
	const { data: modelCard } = useActualResolvedModelCard(resolvedModel || undefined);
	const settings = settingsData as ModelSelectionSettings | undefined;

	return useMemo(() => {
		const support = resolveReasoningEffortSupport({
			resolvedModel,
			resolvedBareModel,
			resolvedModelOption,
			settingsData: settings,
			modelCard,
			codexCapableProviders: resolveCodexCapableProviders(settings),
		});
		const desired =
			(settings?.agent?.defaultReasoningEffort as ReasoningEffort | undefined) ||
			FALLBACK_DEFAULT_EFFORT;
		return {
			supported: support.supportsReasoningEffort,
			options: support.reasoningEffortOptions,
			defaultEffort: clampReasoningEffort(desired, support.reasoningEffortOptions),
		};
	}, [modelCard, resolvedBareModel, resolvedModel, resolvedModelOption, settings]);
}
