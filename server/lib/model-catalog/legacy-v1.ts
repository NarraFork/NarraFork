/**
 * Read-only importers for metadata written by older NarraFork versions.
 *
 * Every function here converts one way, into the raw (v2) representation, at the
 * boundary where old data is read: settings.json written before the raw catalog,
 * catalog snapshots cached by an older binary, and gateway responses that only carry
 * the old envelope. Nothing in the runtime holds, validates, patches or writes these
 * shapes; a guard test keeps this module's imports confined to those boundaries.
 */
import {
	decimalValue,
	type JSONValue,
	type RawMetadata,
	validateRawMetadata,
} from "@shared/model-catalog/card";
import type {
	MatchRules,
	MetadataSource,
	RawCatalog,
	RawModel,
} from "@shared/model-catalog/schema/catalog";
import { validateRawCatalog } from "@shared/model-catalog/src/validation";

/** The old grouped metadata shape (`limits.contextWindow`, `referencePricing.input`, ...). */
export type LegacyMetadata = Record<string, unknown>;
interface LegacyEntry {
	id: string;
	name?: string;
	vendor?: string;
	family?: string;
	notes?: string;
	matches?: MatchRules;
	metadata: LegacyMetadata;
	rawMetadata?: Record<string, unknown>;
	status?: RawModel["status"];
	sources?: MetadataSource[];
}
interface LegacyVariant extends LegacyEntry {
	modelId: string;
	providerKey: string;
	upstreamModelIds: string[];
}
export interface LegacyLocalState {
	revision: number;
	legacyFields?: Record<string, string[]>;
	models?: LegacyEntry[];
	variants?: LegacyVariant[];
	bindings?: Array<{
		id: string;
		providerId?: string;
		channelId?: string;
		upstreamModelId: string;
		modelId?: string;
		variantId?: string;
		overrides?: LegacyMetadata;
		rawMetadata?: Record<string, unknown>;
	}>;
	overrides?: Array<{
		target: "model" | "variant" | "binding";
		targetId: string;
		metadata: LegacyMetadata;
		rawMetadata?: Record<string, unknown>;
		source?: "user" | "legacy-local";
	}>;
	hiddenModelIds?: string[];
	hiddenVariantIds?: string[];
}
interface LegacyCatalog {
	schemaVersion: 1;
	catalogVersion: string;
	publishedAt: string;
	models: LegacyEntry[];
	variants: LegacyVariant[];
}
/** An old gateway's resolved-metadata envelope (`schemaVersion: 1`). */
export interface LegacyResolvedEnvelope {
	schemaVersion: 1;
	metadata: LegacyMetadata;
	[key: string]: unknown;
}
/** A model card as stored in `agent.modelCards` before the catalog existed. */
export interface LegacyModelCard {
	modelKey: string;
	displayName?: string;
	family?: string;
	notes?: string;
	builtin?: boolean;
	aliases?: string[];
	matchPrefixes?: string[];
	contextWindow?: number;
	maxCompletionTokens?: number;
	effortLevels?: string[];
	officialPricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	deleted?: boolean;
}

const groupedKeys: Readonly<Record<string, string>> = {
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

/**
 * Old grouped metadata as raw keys. A local window was this instance's history budget
 * (`working_context_tokens`); any other window is the old untyped number, kept as
 * `legacy_context_window` rather than guessed to be an input cap or a total.
 */
export function legacyMetadataToRaw(metadata: object, local = false): RawMetadata {
	const source = metadata as Record<string, unknown>;
	const groups = new Set(["limits", "modalities", "nativeSearch", "reasoning", "referencePricing"]);
	const raw: RawMetadata = Object.fromEntries(
		Object.entries(source).filter(([key]) => !groups.has(key)),
	) as RawMetadata;
	for (const [path, key] of Object.entries(groupedKeys)) {
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

/** Prefer the complete original an older binary kept beside its projection. */
function entryMetadata(entry: { metadata?: object; rawMetadata?: object }, local: boolean) {
	return entry.rawMetadata !== undefined
		? validateRawMetadata(entry.rawMetadata)
		: legacyMetadataToRaw(entry.metadata ?? {}, local);
}
function status(value: string | undefined): RawModel["status"] {
	return value as RawModel["status"];
}

/** The raw local layer settings.json held before overrides moved to their own file. */
export interface RawLocalLayer {
	overrides?: Array<{ target: string; targetId: string; metadata: RawMetadata }>;
	connections?: Record<string, RawMetadata>;
	bindings?: Array<{
		id: string;
		providerId?: string;
		upstreamModelId: string;
		overrides?: RawMetadata;
	}>;
	models?: unknown[];
	variants?: unknown[];
}

export function legacyLocalToRaw(local: LegacyLocalState): RawLocalLayer {
	return {
		connections: structuredClone(
			(local as { connections?: Record<string, RawMetadata> }).connections,
		),
		models: local.models?.map(({ metadata, rawMetadata, ...entry }) => ({
			...structuredClone(entry),
			status: status(entry.status),
			metadata: entryMetadata({ metadata, rawMetadata }, true),
		})),
		variants: local.variants?.map(({ metadata, rawMetadata, ...entry }) => ({
			...structuredClone(entry),
			status: status(entry.status),
			metadata: entryMetadata({ metadata, rawMetadata }, true),
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
			metadata: entryMetadata({ metadata, rawMetadata }, true),
		})),
	} as RawLocalLayer;
}

/** Catalog snapshots cached by an older binary. Without kept originals, values convert as-is. */
export function legacyCatalogToRaw(value: unknown): RawCatalog {
	const catalog = value as LegacyCatalog;
	if (!catalog || catalog.schemaVersion !== 1 || typeof catalog.catalogVersion !== "string")
		throw new Error("Invalid legacy catalog snapshot");
	const sourceVersion = catalog.catalogVersion.startsWith("v2:")
		? catalog.catalogVersion.slice(3)
		: catalog.catalogVersion;
	const entry = ({ metadata, rawMetadata, ...rest }: LegacyEntry) => ({
		...rest,
		metadata: entryMetadata({ metadata, rawMetadata }, false),
	});
	return validateRawCatalog({
		schemaVersion: 2,
		catalogVersion: `v2:${sourceVersion}`,
		sourceVersion,
		publishedAt: catalog.publishedAt,
		models: (catalog.models ?? []).map(entry),
		variants: (catalog.variants ?? []).map((variant) => ({
			...entry(variant),
			modelId: variant.modelId,
			providerKey: variant.providerKey,
			upstreamModelIds: variant.upstreamModelIds,
		})),
	});
}

/** The metadata a pre-catalog model card asserted, as raw local keys. */
export function legacyCardMetadata(card: LegacyModelCard): RawMetadata {
	const raw: RawMetadata = {};
	if (card.contextWindow && card.contextWindow > 0) raw.working_context_tokens = card.contextWindow;
	if (card.maxCompletionTokens && card.maxCompletionTokens > 0)
		raw.max_output_tokens = card.maxCompletionTokens;
	if (card.effortLevels?.length) {
		raw.supports_reasoning = true;
		raw.reasoning_mode = "levels";
		raw.reasoning_effort_levels = card.effortLevels.filter((level) => level !== "none");
	}
	if (card.officialPricing) {
		const keys = {
			input: "input_cost_per_token",
			output: "output_cost_per_token",
			cacheRead: "cache_read_input_token_cost",
			cacheWrite: "cache_creation_input_token_cost",
		} as const;
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = card.officialPricing[field];
			// A card's zero meant unset, unlike an explicit decimal zero in the raw contract.
			if (value != null && value > 0) raw[keys[field]] = decimalValue(String(value), -6);
		}
	}
	return validateRawMetadata(raw);
}

/** How builds before provider-model overrides stored a provider-page window: a binding. */
export const WINDOW_BINDING_PREFIX = "legacy-window:";
