/**
 * The `auto:` models and their sources, for the model picker (GET /api/model-catalog/auto).
 *
 * Sources are listed in the order `auto:` routing would try them now, with the facts that
 * ordering used, so the picker can say why the first one is chosen.
 */
import type { AutoModelInfo } from "@shared/auto-model";
import { autoModelValue } from "@shared/auto-model";
import { autoSourceFacts } from "../agent/auto-route-signals";
import {
	listAutoModelIds,
	orderedAutoModelCandidates,
	parseModelId,
	referencePricePerMillion,
} from "../settings";

/** Bounds the response; the picker lists at most this many logical models. */
const MAX_AUTO_MODELS = 500;

export function listAutoModels(nameOf: (modelId: string) => string | undefined): AutoModelInfo[] {
	const now = Date.now();
	return listAutoModelIds()
		.slice(0, MAX_AUTO_MODELS)
		.map((modelId) => ({
			value: autoModelValue(modelId),
			modelId,
			name: nameOf(modelId) ?? modelId,
			sources: orderedAutoModelCandidates(modelId).map((value) => {
				const provider = parseModelId(value).provider as string;
				const referencePrice = referencePricePerMillion(value);
				return {
					value,
					provider,
					...autoSourceFacts(provider, now, value),
					...(referencePrice !== undefined ? { referencePrice } : {}),
				};
			}),
		}))
		.filter((model) => model.sources.length > 0)
		.sort((a, b) => a.name.localeCompare(b.name));
}
