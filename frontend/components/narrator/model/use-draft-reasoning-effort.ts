import type { ReasoningEffort } from "@shared/reasoning-effort";
import { useRuntimeModel } from "../../../hooks/useModelCatalog";
import { useModelRuntimeSettings } from "../../../hooks/useModels";
import {
	displayReasoningEffort,
	runtimeReasoningEffortSupport,
} from "../interaction/use-model-selection";

export interface DraftReasoningEffort {
	supported: boolean;
	options: readonly ReasoningEffort[];
	defaultEffort: string;
}

/** The draft asks only about its current selection, never the entire model directory. */
export function useDraftReasoningEffort(model: string): DraftReasoningEffort {
	const { settingsData } = useModelRuntimeSettings();
	const { data: summary } = useRuntimeModel({
		model,
		revision: settingsData?.revision == null ? undefined : String(settingsData.revision),
		enabled: !!settingsData,
	});
	const support = summary ? runtimeReasoningEffortSupport(summary) : undefined;
	const options = (support?.reasoningEffortOptions ?? []) as readonly ReasoningEffort[];
	return {
		supported: support?.supportsReasoningEffort ?? false,
		options,
		defaultEffort: displayReasoningEffort(
			settingsData?.agent.defaultReasoningEffort || "max",
			options,
		),
	};
}
