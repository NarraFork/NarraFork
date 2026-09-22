/** Legacy DTO projection of the single bundled public catalog.
 * Source: NarraFork/narrafork-model-catalog. Runtime consumers use model-catalog.
 * Kept for old card clients and migration tests, not an independently maintained table.
 */

import type { ModelCard } from "@shared/model-card";
import catalog from "@shared/model-catalog/dist/catalog.json";
import type { CatalogDocument } from "@shared/model-catalog/schema/catalog";
import type { ReasoningEffort } from "@shared/reasoning-effort";

const wireLevels = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
export const BUILTIN_MODEL_CARDS: readonly ModelCard[] = (catalog as CatalogDocument).models
	// The compatibility API keeps its original seed membership. The new catalog
	// independently includes the NUG union without claiming those models callable.
	.filter((model) =>
		model.sources?.some((source) =>
			source.label.startsWith("NarraFork server/lib/model-cards/builtin.ts"),
		),
	)
	.map((model) => {
		const metadata = model.metadata;
		const card: ModelCard = {
			modelKey: model.id,
			displayName: model.name,
			family: model.family,
			notes: model.notes,
			builtin: true,
			aliases: model.matches?.aliases,
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
