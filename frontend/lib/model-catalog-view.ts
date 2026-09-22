import {
	type ModelCatalogSnapshot,
	type ModelDefinition,
	type ModelVariant,
	type ResolvedModelMetadata,
	resolveModelMetadata,
} from "@shared/model-catalog";

/** Inspect a specific layer, not an unrelated concrete connection's effective card.
 * Hidden records remain inspectable; this does not alter actual availability. */
export function resolveCatalogEntry(
	snapshot: ModelCatalogSnapshot,
	entry: ModelDefinition | ModelVariant,
): ResolvedModelMetadata {
	const variant = "modelId" in entry;
	return resolveModelMetadata({
		catalog: snapshot.catalog,
		local: { ...snapshot.local, hiddenModelIds: [], hiddenVariantIds: [], bindings: [] },
		query: {
			upstreamModelId: entry.id,
			...(variant
				? { modelId: entry.modelId, variantId: entry.id, providerKey: entry.providerKey }
				: { modelId: entry.id }),
		},
	});
}
