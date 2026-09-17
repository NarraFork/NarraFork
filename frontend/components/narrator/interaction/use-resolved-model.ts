import { useMemo } from "react";
import {
	type ModelAggregation,
	type ModelOption,
	resolveDisplayModel,
} from "../../../lib/constants";

export interface UseResolvedModelResult {
	resolvedModel: string;
	resolvedProvider: string;
	resolvedBareModel: string;
	resolvedModelOption: ModelOption | undefined;
}

/**
 * Resolves the narrator's effective model string and its provider/bare-model
 * parse + catalog option. Split out from {@link useModelSelection} because the
 * panel needs `resolvedModel` up front (it feeds the NUG quota, Kimi usage and
 * context-threshold queries and the WS state's initial quota), while the rest of
 * the model/reasoning derivations live down in the status bar.
 */
export function useResolvedModel(
	narratorModel: string | null | undefined,
	defaultModelValue: string | undefined,
	aggregations: ModelAggregation[] | undefined,
	allModels: ModelOption[],
): UseResolvedModelResult {
	const resolvedModel = useMemo(
		() => resolveDisplayModel(narratorModel, { defaultModelValue, aggregations }),
		[narratorModel, defaultModelValue, aggregations],
	);

	const { resolvedProvider, resolvedBareModel } = useMemo(() => {
		const idx = resolvedModel.indexOf(":");
		if (idx > 0) {
			return {
				resolvedProvider: resolvedModel.slice(0, idx),
				resolvedBareModel: resolvedModel.slice(idx + 1),
			};
		}
		return { resolvedProvider: "", resolvedBareModel: resolvedModel };
	}, [resolvedModel]);

	const resolvedModelOption = useMemo(
		() => allModels.find((m) => m.value === resolvedModel),
		[allModels, resolvedModel],
	);

	return { resolvedModel, resolvedProvider, resolvedBareModel, resolvedModelOption };
}
