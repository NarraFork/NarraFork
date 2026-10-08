/** Legacy DTO projection of the single bundled public catalog.
 * Source: NarraFork/narrafork-model-catalog. Runtime consumers use model-catalog.
 * Kept for old card clients and migration tests, not an independently maintained table.
 */

import type { ModelCard } from "@shared/model-card";
import catalog from "@shared/model-catalog/dist/catalog.json";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { decodeCatalog } from "../model-catalog/source";

const wireLevels = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const models = decodeCatalog(catalog).models;
const exactKeys = new Set(models.map((model) => model.id.trim().toLowerCase()));
// Metadata lookup only, not an enumeration of callable provider models.
export const BUILTIN_MODEL_CARDS: readonly ModelCard[] = models.map((model) => {
	const metadata = model.metadata;
	const card: ModelCard = {
		modelKey: model.id,
		displayName: model.name,
		family: model.family,
		notes: model.notes,
		builtin: true,
		// Exact definitions retain their own historical metadata; aliases cannot shadow them.
		aliases: model.matches?.aliases?.filter((alias) => !exactKeys.has(alias.trim().toLowerCase())),
		matchPrefixes: model.matches?.prefixes,
		contextWindow: metadata.limits?.contextWindow ?? undefined,
		maxCompletionTokens: metadata.limits?.maxOutputTokens ?? undefined,
	};
	if (metadata.reasoning?.levels?.length)
		card.effortLevels = metadata.reasoning.levels.filter((level): level is ReasoningEffort =>
			wireLevels.has(level),
		);
	if (metadata.referencePricing) {
		card.officialPricing = {};
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = metadata.referencePricing[field];
			if (value != null) card.officialPricing[field] = Number(value);
		}
	}
	return card;
});
