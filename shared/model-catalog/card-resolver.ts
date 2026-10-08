import {
	decimalValue,
	isRawPriceField,
	type JSONValue,
	type ModelCard,
	modelCardView,
	type RawCatalog,
	type RawMetadata,
	type RawModel,
	type RawVariant,
	validateRawMetadata,
} from "./card";
import { normalizeRawLocalState } from "./card-local";
import type {
	FieldSource,
	LocalCatalogState,
	ModelBinding,
	ModelOverride,
	ModelQuery,
} from "./schema/catalog";
import { createModelMetadataResolver } from "./src/index";

export interface RawLocalState {
	revision: number;
	/** Read-only migration provenance, keyed by target:id; edits clear only their own paths. */
	legacyFields?: Record<string, string[]>;
	models?: RawModel[];
	variants?: RawVariant[];
	bindings?: Array<Omit<ModelBinding, "overrides" | "rawMetadata"> & { overrides?: RawMetadata }>;
	overrides?: Array<Omit<ModelOverride, "metadata" | "rawMetadata"> & { metadata: RawMetadata }>;
	hiddenModelIds?: string[];
	hiddenVariantIds?: string[];
}
export const legacyPaths: Readonly<Record<string, string>> = {
	"limits.maxOutputTokens": "max_output_tokens",
	"modalities.input": "supported_modalities",
	"modalities.output": "supported_output_modalities",
	"nativeSearch.supported": "supports_web_search",
	"reasoning.supported": "supports_reasoning",
	"reasoning.mode": "reasoning_mode",
	"reasoning.levels": "reasoning_effort_levels",
	"reasoning.canDisable": "can_disable_reasoning",
	"reasoning.defaultLevel": "default_reasoning_effort",
	"referencePricing.input": "input_cost_per_token",
	"referencePricing.output": "output_cost_per_token",
	"referencePricing.cacheRead": "cache_read_input_token_cost",
	"referencePricing.cacheWrite": "cache_creation_input_token_cost",
};
export function legacyMetadataToRaw(metadata: object, local = false): RawMetadata {
	const source = metadata as Record<string, unknown>;
	const groups = new Set(["limits", "modalities", "nativeSearch", "reasoning", "referencePricing"]);
	const raw: RawMetadata = Object.fromEntries(
		Object.entries(source).filter(([key]) => !groups.has(key)),
	) as RawMetadata;
	for (const [path, key] of Object.entries(legacyPaths)) {
		const [group, field] = path.split(".");
		const values = source[group!] as Record<string, unknown> | undefined;
		if (!values || !Object.hasOwn(values, field!)) continue;
		const value = values[field!];
		raw[key] =
			path.startsWith("referencePricing.") && value !== null
				? decimalValue(value, -6)
				: (structuredClone(value) as JSONValue);
	}
	const limits = source.limits as Record<string, JSONValue> | undefined;
	if (limits && Object.hasOwn(limits, "contextWindow"))
		raw[local ? "working_context_tokens" : "legacy_context_window"] = limits.contextWindow!;
	const prices = source.referencePricing as Record<string, JSONValue> | undefined;
	if (prices?.currency !== undefined) raw.currency = prices.currency;
	if (prices?.longContext !== undefined)
		raw.reference_pricing_long_context = structuredClone(prices.longContext);
	return validateRawMetadata(raw);
}
export function legacyLocalToRaw(local: LocalCatalogState): RawLocalState {
	return normalizeRawLocalState({
		...structuredClone(local),
		models: local.models?.map(({ metadata, rawMetadata, ...entry }) => ({
			...structuredClone(entry),
			metadata:
				rawMetadata === undefined
					? legacyMetadataToRaw(metadata, true)
					: validateRawMetadata(rawMetadata),
		})),
		variants: local.variants?.map(({ metadata, rawMetadata, ...entry }) => ({
			...structuredClone(entry),
			metadata:
				rawMetadata === undefined
					? legacyMetadataToRaw(metadata, true)
					: validateRawMetadata(rawMetadata),
		})),
		bindings: local.bindings?.map(({ overrides, rawMetadata, ...entry }) => ({
			...structuredClone(entry),
			...(rawMetadata !== undefined
				? { overrides: validateRawMetadata(rawMetadata) }
				: overrides === undefined
					? {}
					: { overrides: legacyMetadataToRaw(overrides, true) }),
		})),
		overrides: local.overrides?.map(({ metadata, rawMetadata, ...entry }) => ({
			...structuredClone(entry),
			metadata:
				rawMetadata === undefined
					? legacyMetadataToRaw(metadata, true)
					: validateRawMetadata(rawMetadata),
		})),
	});
}
function identityEntry(entry: RawModel) {
	const { fields: _fields, ...matches } = entry.matches ?? {};
	return {
		...entry,
		metadata: {},
		matches,
		status: entry.status === "unverified" ? ("legacy-unverified" as const) : entry.status,
		sources: entry.sources?.map(({ fields: _, ...source }) => source),
	};
}
function fieldAllowed(path: string, filter: string): boolean {
	if (path === filter || path.startsWith(`${filter}.`)) return true;
	if (filter === "limits.contextWindow")
		return [
			"max_input_tokens",
			"context_window",
			"working_context_tokens",
			"legacy_context_window",
		].includes(path);
	if (filter === "referencePricing") return isRawPriceField(path);
	if (filter === "limits")
		return [
			"max_input_tokens",
			"max_output_tokens",
			"context_window",
			"working_context_tokens",
			"legacy_context_window",
		].includes(path);
	if (filter === "referencePricing.longContext")
		return (
			/_above_\d+(?:k)?_tokens/.test(path) ||
			path.startsWith("long_context_") ||
			path === "reference_pricing_long_context"
		);
	return legacyPaths[filter] === path;
}

/** Matching stays in the existing resolver; only metadata layering and view generation are v2. */
export function createModelCardResolver(
	catalogInput: RawCatalog,
	localInput: RawLocalState = { revision: 0 },
) {
	const catalog = structuredClone(catalogInput),
		local = structuredClone(localInput);
	for (const entry of [
		...catalog.models,
		...catalog.variants,
		...(local.models ?? []),
		...(local.variants ?? []),
	])
		entry.metadata = validateRawMetadata(entry.metadata);
	for (const entry of local.overrides ?? []) entry.metadata = validateRawMetadata(entry.metadata);
	for (const entry of local.bindings ?? [])
		if (entry.overrides !== undefined) entry.overrides = validateRawMetadata(entry.overrides);
	const skeleton = {
		schemaVersion: 1 as const,
		catalogVersion: catalog.catalogVersion,
		publishedAt: catalog.publishedAt,
		models: catalog.models.map(identityEntry),
		variants: catalog.variants.map((entry) => ({
			...identityEntry(entry),
			modelId: entry.modelId,
			providerKey: entry.providerKey,
			upstreamModelIds: entry.upstreamModelIds,
		})),
	};
	const { legacyFields: _legacyFields, ...localIdentity } = local;
	const identityLocal: LocalCatalogState = {
		...localIdentity,
		models: local.models?.map(identityEntry),
		variants: local.variants?.map((entry) => ({
			...identityEntry(entry),
			modelId: entry.modelId,
			providerKey: entry.providerKey,
			upstreamModelIds: entry.upstreamModelIds,
		})),
		bindings: local.bindings?.map((entry) => ({ ...entry, overrides: {} })),
		overrides: local.overrides?.map((entry) => ({ ...entry, metadata: {} })),
	};
	const identify = createModelMetadataResolver(skeleton, identityLocal);
	const identifyUnbound = (local.bindings ?? []).some(
		(binding) => !binding.modelId && !binding.variantId,
	)
		? createModelMetadataResolver(skeleton, { ...identityLocal, bindings: [] })
		: identify;
	const baseModels = new Map(catalog.models.map((entry) => [entry.id, entry]));
	const baseVariants = new Map(catalog.variants.map((entry) => [entry.id, entry]));
	const localModels = new Map((local.models ?? []).map((entry) => [entry.id, entry]));
	const localVariants = new Map((local.variants ?? []).map((entry) => [entry.id, entry]));
	return (query: ModelQuery, discovered?: RawMetadata, defaults?: RawMetadata): ModelCard => {
		const identity = identify(query);
		const binding = local.bindings?.find((entry) => entry.id === identity.bindingId);
		let via = identity.matchedVia;
		if (binding && !binding.modelId && !binding.variantId && !query.modelId && !query.variantId)
			via = identifyUnbound(query).matchedVia;
		const matched = identity.variantId
			? (localVariants.get(identity.variantId) ?? baseVariants.get(identity.variantId))
			: identity.modelId
				? (localModels.get(identity.modelId) ?? baseModels.get(identity.modelId))
				: undefined;
		const weak = via === "prefix" || via === "suffix";
		const metadata: RawMetadata = {},
			provenance: Record<string, FieldSource> = {};
		const clearSources = (path: string) => {
			for (const key of Object.keys(provenance))
				if (key === path || key.startsWith(`${path}.`)) delete provenance[key];
		};
		const merge = (value: RawMetadata | undefined, source: FieldSource, restrict = false) => {
			if (value === undefined) return;
			const raw = validateRawMetadata(value);
			const walk = (target: RawMetadata, data: RawMetadata, prefix: string) => {
				for (const [key, item] of Object.entries(data)) {
					const path = prefix ? `${prefix}.${key}` : key;
					if (
						item !== null &&
						typeof item === "object" &&
						!Array.isArray(item) &&
						Object.keys(item).length
					) {
						const before = target[key];
						const child =
							before && typeof before === "object" && !Array.isArray(before) ? before : {};
						walk(child, item, path);
						if (Object.keys(child).length) {
							delete provenance[path];
							target[key] = child;
						}
						continue;
					}
					if (restrict && weak) {
						const filters = matched?.matches?.fields;
						if (filters && !filters.some((filter) => fieldAllowed(path, filter))) continue;
						if (
							via === "prefix" &&
							isRawPriceField(path) &&
							!filters?.some((filter) => fieldAllowed(path, filter))
						)
							continue;
					}
					// Empty objects merge; explicit null and arrays replace, including empty arrays.
					if (
						item &&
						typeof item === "object" &&
						!Array.isArray(item) &&
						Object.hasOwn(target, key)
					)
						continue;
					clearSources(path);
					target[key] = structuredClone(item);
					provenance[path] = { ...source };
					if (local.legacyFields !== undefined && source.layer.startsWith("local-")) {
						delete provenance[path]!.legacy;
						if (local.legacyFields[`${source.layer.slice(6)}:${source.id}`]?.includes(path))
							provenance[path]!.legacy = true;
					}
				}
			};
			walk(metadata, raw, "");
		};
		const entrySource = (entry: RawModel, layer: FieldSource["layer"]): FieldSource => ({
			layer,
			id: entry.id,
			catalogVersion: catalog.catalogVersion,
			...(entry.status === "unverified" || entry.status === "legacy-unverified"
				? { legacy: true }
				: {}),
		});
		merge(defaults, { layer: "default" });
		const model = identity.modelId && baseModels.get(identity.modelId),
			variant = identity.variantId && baseVariants.get(identity.variantId);
		if (model) merge(model.metadata, entrySource(model, "preset-model"), true);
		if (variant) merge(variant.metadata, entrySource(variant, "preset-variant"), true);
		merge(discovered, { layer: "discovered" });
		const applyOverride = (target: "model" | "variant" | "binding", id: string) => {
			const entry = local.overrides?.find(
				(override) => override.target === target && override.targetId === id,
			);
			if (entry)
				merge(
					entry.metadata,
					{
						layer: `local-${target}`,
						id,
						explicit: true,
						...(entry.source === "legacy-local" ? { legacy: true } : {}),
					},
					target !== "binding",
				);
		};
		if (identity.modelId) {
			const entry = localModels.get(identity.modelId);
			if (entry)
				merge(entry.metadata, { layer: "local-model", id: entry.id, explicit: true }, true);
			applyOverride("model", identity.modelId);
		}
		if (identity.variantId) {
			const entry = localVariants.get(identity.variantId);
			if (entry)
				merge(entry.metadata, { layer: "local-variant", id: entry.id, explicit: true }, true);
			applyOverride("variant", identity.variantId);
		}
		if (binding) {
			merge(binding.overrides, { layer: "local-binding", id: binding.id, explicit: true });
			applyOverride("binding", binding.id);
		}
		return {
			schemaVersion: 2,
			catalogVersion: catalog.catalogVersion,
			localRevision: local.revision,
			...(identity.modelId ? { modelId: identity.modelId } : {}),
			...(identity.variantId ? { variantId: identity.variantId } : {}),
			...(binding ? { bindingId: binding.id } : {}),
			matchedVia: identity.matchedVia,
			metadata: validateRawMetadata(metadata),
			provenance,
			view: modelCardView(metadata),
		};
	};
}
