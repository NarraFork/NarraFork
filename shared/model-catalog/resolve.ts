/**
 * Model card resolution: which catalog entry a model value is, and what its metadata is.
 *
 * Three sources merge, later winning:
 *
 *   catalog (model, then provider variant)  <  discovered (gateway / listing)  <  user override
 *
 * The user override itself has two scopes: model-wide (by catalog model id, applied only
 * when the model value matched that entry by id or alias) and one provider entry
 * (by the full `provider:model` value). Resolution never throws on a request path:
 * conflicting values are reconciled and reported, not rejected.
 */
import { isRawPriceField, type ModelCard, modelCardView } from "./card";
import { type ModelOverride, overrideToRaw } from "./override";
import type {
	FieldSource,
	MatchedVia,
	RawCatalog,
	RawMetadata,
	RawModel,
	RawVariant,
} from "./schema/catalog";

export interface CatalogQuery {
	/** Model id as the upstream names it, without the provider prefix. */
	upstreamModelId: string;
	/** Public channel type (codex, anthropic, openai, gemini, …) for provider variants. */
	providerKey?: string;
}

export interface CatalogIdentity {
	modelId?: string;
	variantId?: string;
	matchedVia: MatchedVia;
	/** A prefix/suffix match only borrows the field groups its entry allows. */
	weak: boolean;
	entry?: RawModel | RawVariant;
}

/** Group names from the catalog's `matches.fields` vocabulary mapped onto raw keys. */
const groupKeys: Readonly<Record<string, string>> = {
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
const contextKeys = [
	"max_input_tokens",
	"context_window",
	"working_context_tokens",
	"legacy_context_window",
];
const limitKeys = [...contextKeys, "max_output_tokens"];
const longContextKey = (path: string) =>
	/_above_\d+(?:k)?_tokens/.test(path) ||
	path.startsWith("long_context_") ||
	path === "reference_pricing_long_context" ||
	path.startsWith("reference_pricing_long_context.");

/** Whether a raw key belongs to a field group a weak match may borrow. */
export function fieldAllowed(path: string, group: string): boolean {
	if (path === group || path.startsWith(`${group}.`)) return true;
	if (group === "limits") return limitKeys.includes(path);
	if (group === "limits.contextWindow") return contextKeys.includes(path);
	if (group === "referencePricing") return isRawPriceField(path) || path === "currency";
	if (group.startsWith("referencePricing.longContext")) return longContextKey(path);
	if (group === "referencePricing.currency" || group === "referencePricing.unit")
		return path === "currency";
	if ((group === "modalities" || group === "modalities.input") && path === "supports_vision")
		return true;
	if (group === "reasoning.canDisable" && path === "supports_none_reasoning_effort") return true;
	if (group === "reasoning" && path === "supports_none_reasoning_effort") return true;
	return Object.entries(groupKeys).some(
		([leaf, key]) => key === path && (leaf === group || leaf.startsWith(`${group}.`)),
	);
}

/** Only declared volatile suffixes (dates, -latest, -preview) are stripped. */
function volatileBases(id: string): string[] {
	const bases: string[] = [];
	let result = id;
	for (;;) {
		const next = result.replace(
			/(?:-(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:20)?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|latest|preview))$/,
			"",
		);
		if (next === result) return bases;
		bases.push(next);
		result = next;
	}
}

type Entry = RawModel | RawVariant;
const isVariant = (entry: Entry): entry is RawVariant => "providerKey" in entry;
interface Scope {
	exact: Map<string, Entry>;
	alias: Map<string, Entry>;
	/** Entries that opted into volatile-suffix stripping, by every exact/alias key. */
	suffix: Map<string, Entry>;
	/** Longest first. */
	prefixes: Array<[string, Entry]>;
}
function emptyScope(): Scope {
	return { exact: new Map(), alias: new Map(), suffix: new Map(), prefixes: [] };
}

/** First writer wins, so a tie the catalog validator missed resolves the same way every time. */
function put(map: Map<string, Entry>, key: string, entry: Entry) {
	if (!map.has(key)) map.set(key, entry);
}

function indexCatalog(catalog: RawCatalog) {
	const models = new Map(catalog.models.map((model) => [model.id, model]));
	const scopes = new Map<string, Scope>();
	const scopeOf = (key: string) => {
		let scope = scopes.get(key);
		if (!scope) {
			scope = emptyScope();
			scopes.set(key, scope);
		}
		return scope;
	};
	const sorted: Entry[] = [...catalog.models, ...catalog.variants].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	for (const entry of sorted) {
		const variant = isVariant(entry) ? entry : undefined;
		const scope = scopeOf(variant?.providerKey ?? "");
		const exact = [entry.id, ...(entry.matches?.ids ?? []), ...(variant?.upstreamModelIds ?? [])];
		const aliases = entry.matches?.aliases ?? [];
		for (const key of exact) put(scope.exact, key, entry);
		for (const key of aliases) put(scope.alias, key, entry);
		if (entry.matches?.volatileSuffixes)
			for (const key of [...exact, ...aliases]) put(scope.suffix, key, entry);
		for (const prefix of entry.matches?.prefixes ?? []) scope.prefixes.push([prefix, entry]);
	}
	for (const scope of scopes.values()) scope.prefixes.sort((a, b) => b[0].length - a[0].length);

	const match = (scope: Scope | undefined, id: string) => {
		if (!scope) return undefined;
		const exact = scope.exact.get(id);
		if (exact) return { entry: exact, via: "exact" as const };
		const alias = scope.alias.get(id);
		if (alias) return { entry: alias, via: "alias" as const };
		for (const base of volatileBases(id)) {
			const entry = scope.suffix.get(base);
			if (entry) return { entry, via: "suffix" as const };
		}
		const prefixed = scope.prefixes.find(([prefix]) => id.startsWith(prefix));
		return prefixed ? { entry: prefixed[1], via: "prefix" as const } : undefined;
	};

	const identifyId = (id: string, providerKey: string | undefined) =>
		(providerKey !== undefined ? match(scopes.get(providerKey), id) : undefined) ??
		match(scopes.get(""), id);

	return (query: CatalogQuery): CatalogIdentity => {
		const id = query.upstreamModelId.trim();
		// Routers often publish `vendor/model`; the catalog names the model alone.
		const found =
			identifyId(id, query.providerKey) ??
			(id.includes("/")
				? identifyId(id.slice(id.lastIndexOf("/") + 1), query.providerKey)
				: undefined);
		if (!found) return { matchedVia: "none", weak: false };
		const { entry, via } = found;
		const variant = isVariant(entry) ? entry : undefined;
		const model = variant ? models.get(variant.modelId) : entry;
		return {
			...(model ? { modelId: model.id } : {}),
			...(variant ? { variantId: variant.id } : {}),
			matchedVia: via,
			weak: via === "prefix" || via === "suffix",
			entry,
		};
	};
}

const indexes = new WeakMap<RawCatalog, ReturnType<typeof indexCatalog>>();
/** Identity lookup for one immutable catalog; the index is built once per catalog. */
export function identifyModel(catalog: RawCatalog, query: CatalogQuery): CatalogIdentity {
	let index = indexes.get(catalog);
	if (!index) {
		index = indexCatalog(catalog);
		indexes.set(catalog, index);
	}
	return index(query);
}

export interface ResolveInput {
	catalog: RawCatalog;
	query: CatalogQuery;
	/** Metadata a gateway or provider listing reported; caller-validated. */
	discovered?: RawMetadata;
	/** Model-wide user override, by catalog model id. */
	modelOverrides?: ReadonlyMap<string, ModelOverride>;
	/** This provider entry's own override, by full model value. */
	connectionOverride?: ModelOverride;
	/** The full `provider:model` value the query came from, recorded in provenance. */
	connection?: string;
	/** Revision of the user overrides, recorded on the card. */
	overridesRevision?: number;
}

export function resolveModelCard(input: ResolveInput): ModelCard {
	const { catalog } = input;
	const identity = identifyModel(catalog, input.query);
	const metadata: RawMetadata = {};
	const provenance: Record<string, FieldSource> = {};
	const clearSources = (path: string) => {
		for (const key of Object.keys(provenance))
			if (key === path || key.startsWith(`${path}.`)) delete provenance[key];
	};
	const filters = identity.weak ? identity.entry?.matches?.fields : undefined;
	const borrowable = (path: string) =>
		!identity.weak ||
		(filters
			? filters.some((filter) => fieldAllowed(path, filter))
			: identity.matchedVia !== "prefix" || !isRawPriceField(path));
	const merge = (value: RawMetadata | undefined, source: FieldSource, restrict = false) => {
		if (!value) return;
		const walk = (target: RawMetadata, data: RawMetadata, prefix: string) => {
			for (const [key, item] of Object.entries(data)) {
				const path = prefix ? `${prefix}.${key}` : key;
				if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length) {
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
				if (restrict && !borrowable(path)) continue;
				clearSources(path);
				target[key] = structuredClone(item);
				provenance[path] = { ...source };
			}
		};
		walk(metadata, value, "");
	};
	const presetSource = (entry: Entry, layer: FieldSource["layer"]): FieldSource => ({
		layer,
		id: entry.id,
		catalogVersion: catalog.catalogVersion,
		...(entry.status === "unverified" || entry.status === "legacy-unverified"
			? { legacy: true }
			: {}),
	});
	const model = identity.modelId
		? catalog.models.find((entry) => entry.id === identity.modelId)
		: undefined;
	const variant = identity.variantId
		? catalog.variants.find((entry) => entry.id === identity.variantId)
		: undefined;
	if (model) merge(model.metadata, presetSource(model, "preset-model"), true);
	if (variant) merge(variant.metadata, presetSource(variant, "preset-variant"), true);
	merge(input.discovered, { layer: "discovered" });
	// A model-wide decision is about that model; a weak match is only a look-alike.
	const wide = identity.modelId && !identity.weak && input.modelOverrides?.get(identity.modelId);
	if (wide)
		merge(overrideToRaw(wide), { layer: "local-model", id: identity.modelId, explicit: true });
	if (input.connectionOverride)
		merge(overrideToRaw(input.connectionOverride), {
			layer: "local-connection",
			...(input.connection ? { id: input.connection } : {}),
			explicit: true,
		});
	// A default level the effective level list no longer offers cannot be sent; drop it.
	if (
		typeof metadata.default_reasoning_effort === "string" &&
		Array.isArray(metadata.reasoning_effort_levels) &&
		!metadata.reasoning_effort_levels.includes(metadata.default_reasoning_effort)
	) {
		delete metadata.default_reasoning_effort;
		delete provenance.default_reasoning_effort;
	}
	const card = {
		schemaVersion: 2,
		catalogVersion: catalog.catalogVersion,
		localRevision: input.overridesRevision ?? 0,
		...(identity.modelId ? { modelId: identity.modelId } : {}),
		...(identity.variantId ? { variantId: identity.variantId } : {}),
		matchedVia: identity.matchedVia,
		metadata,
		provenance,
	} as ModelCard;
	// The display view is derived on first read: runtime reads never look at it.
	let view: ModelCard["view"] | undefined;
	Object.defineProperty(card, "view", {
		enumerable: true,
		configurable: true,
		get: () => {
			view ??= modelCardView(card.metadata);
			return view;
		},
	});
	return card;
}
