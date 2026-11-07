/**
 * Typed reads over a resolved raw card. This is the only place that interprets raw keys
 * for runtime decisions (context window, output cap, modalities, reasoning, reference
 * prices). It is derived on demand: never stored, never patched, never converted back.
 */
import { decimalValue, multiplyDecimal } from "./card";
import type { FieldSource, MetadataLayer, RawMetadata } from "./schema/catalog";

export type Modality = "text" | "image" | "audio" | "video";
const MODALITIES: readonly string[] = ["text", "image", "audio", "video"];
export type ReasoningMode = "levels" | "fixed" | "budget" | "unknown";
const REASONING_MODES: readonly string[] = ["levels", "fixed", "budget", "unknown"];

/** Decimal strings per million tokens. Missing = not declared; null = declared unknown. */
export interface ReferencePrices {
	input?: string | null;
	output?: string | null;
	cacheRead?: string | null;
	cacheWrite?: string | null;
}
export interface ReferencePricing extends ReferencePrices {
	currency?: "USD";
	unit?: "perMillionTokens";
	longContext?: ReferencePrices & {
		thresholdTokens?: number | null;
		basis?: "promptTokens";
		mode?: "full" | "marginal" | null;
	};
}
export interface ModelReasoning {
	supported?: boolean | null;
	mode?: ReasoningMode | null;
	levels?: string[] | null;
	canDisable?: boolean | null;
	defaultLevel?: string | null;
}
export interface ModelProfile {
	/** History/prompt budget. undefined = not declared; null = declared unknown. */
	contextWindow?: number | null;
	/** Where the context window came from: its raw key and layer. */
	contextWindowSource?: { key: string } & FieldSource;
	maxOutputTokens?: number | null;
	inputModalities?: Modality[] | null;
	outputModalities?: Modality[] | null;
	nativeSearch?: boolean | null;
	/** Declared tool loading modes in priority order. undefined/null = use name defaults. */
	toolLoadingModes?: string[] | null;
	reasoning: ModelReasoning;
	referencePricing?: ReferencePricing;
	/** True when any reference price comes from a local (user) layer. */
	pricingOverridden: boolean;
}

/** Higher wins. A deeper local layer is a more specific decision than any catalog fact. */
const LAYER_RANK: Record<MetadataLayer, number> = {
	default: 0,
	"preset-model": 1,
	"preset-variant": 2,
	discovered: 3,
	"local-model": 4,
	"local-connection": 5,
};
/**
 * Window keys in tie-break order within one layer. `working_context_tokens` is this
 * instance's history budget and the most specific statement a layer can make. An input
 * cap bounds the prompt directly; a combined total also has to hold the output, so it
 * is the least specific prompt window.
 */
const WINDOW_KEYS = [
	"working_context_tokens",
	"max_input_tokens",
	"legacy_context_window",
	"context_window",
] as const;

const PRICE_KEYS = {
	input: "input_cost_per_token",
	output: "output_cost_per_token",
	cacheRead: "cache_read_input_token_cost",
	cacheWrite: "cache_creation_input_token_cost",
} as const;

function tokens(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function strings(value: unknown): string[] | null | undefined {
	if (value === null) return null;
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? [...value]
		: undefined;
}
function bool(value: unknown): boolean | null | undefined {
	return value === null || typeof value === "boolean" ? value : undefined;
}
function perMillion(value: unknown, multiplier: unknown = 1): string | null {
	return value === null ? null : decimalValue(multiplyDecimal(value, multiplier), 6);
}
function modalities(value: unknown): Modality[] | null | undefined {
	const list = strings(value);
	return list ? (list.filter((item) => MODALITIES.includes(item)) as Modality[]) : list;
}

function contextWindow(
	raw: RawMetadata,
	provenance: Record<string, FieldSource>,
): Pick<ModelProfile, "contextWindow" | "contextWindowSource"> {
	let best: { key: string; source: FieldSource; rank: number; order: number } | undefined;
	WINDOW_KEYS.forEach((key, order) => {
		if (!Object.hasOwn(raw, key)) return;
		const source = provenance[key] ?? { layer: "default" as const };
		const rank = LAYER_RANK[source.layer] ?? 0;
		if (!best || rank > best.rank || (rank === best.rank && order < best.order))
			best = { key, source, rank, order };
	});
	if (!best) return {};
	const chosen = best as { key: string; source: FieldSource };
	const value = tokens(raw[chosen.key]);
	// An input cap below the output cap is not a prompt window; it says nothing usable.
	if (
		chosen.key === "max_input_tokens" &&
		typeof value === "number" &&
		typeof raw.max_output_tokens === "number" &&
		raw.max_output_tokens > value
	)
		return {};
	if (value === undefined) return {};
	return { contextWindow: value, contextWindowSource: { key: chosen.key, ...chosen.source } };
}

function longContext(raw: RawMetadata): ReferencePricing["longContext"] | undefined {
	if (Object.hasOwn(raw, "reference_pricing_long_context")) {
		const value = raw.reference_pricing_long_context;
		return value && typeof value === "object" && !Array.isArray(value)
			? (structuredClone(value) as ReferencePricing["longContext"])
			: undefined;
	}
	const mode = raw.long_context_pricing_basis === "marginal" ? "marginal" : "full";
	// A declared-unknown threshold is still a tier: it must block base prices, not vanish.
	if (raw.long_context_input_token_threshold === null)
		return { thresholdTokens: null, basis: "promptTokens", mode };
	const thresholds = Object.keys(raw).flatMap((key) => {
		const match =
			/^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)(k)?_tokens$/.exec(
				key,
			);
		return match ? [Number(match[1]) * (match[2] ? 1000 : 1)] : [];
	});
	const threshold =
		typeof raw.long_context_input_token_threshold === "number"
			? raw.long_context_input_token_threshold
			: thresholds.length
				? Math.min(...thresholds)
				: undefined;
	if (threshold === undefined || threshold <= 0) return undefined;
	const tier: NonNullable<ReferencePricing["longContext"]> = {
		thresholdTokens: threshold,
		basis: "promptTokens",
		mode,
	};
	// Source rows spell a tier in thousands when they can (`_above_200k_tokens`).
	const suffixes = [
		...(threshold % 1000 === 0 ? [`_above_${threshold / 1000}k_tokens`] : []),
		`_above_${threshold}_tokens`,
	];
	const above = (key: string) =>
		suffixes.map((suffix) => key + suffix).find((k) => Object.hasOwn(raw, k));
	const positive = (value: unknown) =>
		(typeof value === "number" || typeof value === "string") && Number(value) > 0
			? value
			: undefined;
	let inputMultiplier: unknown = positive(raw.long_context_input_cost_multiplier) ?? 1;
	const baseInput = positive(raw.input_cost_per_token);
	const aboveInputKey = above(PRICE_KEYS.input);
	const aboveInput = aboveInputKey === undefined ? undefined : raw[aboveInputKey];
	// Without a declared multiplier, cache tiers scale like the explicit input tier.
	const aboveInputRate = positive(aboveInput);
	if (inputMultiplier === 1 && baseInput !== undefined && aboveInputRate !== undefined)
		inputMultiplier = Number(aboveInputRate) / Number(baseInput);
	const outputMultiplier = positive(raw.long_context_output_cost_multiplier) ?? 1;
	for (const [field, key] of Object.entries(PRICE_KEYS) as Array<[keyof ReferencePrices, string]>) {
		const explicit = above(key);
		if (explicit !== undefined) tier[field] = perMillion(raw[explicit]);
		else if (Object.hasOwn(raw, key))
			tier[field] = perMillion(raw[key], field === "output" ? outputMultiplier : inputMultiplier);
	}
	return tier;
}

function referencePricing(raw: RawMetadata): ReferencePricing | undefined {
	let pricing: ReferencePricing | undefined;
	for (const [field, key] of Object.entries(PRICE_KEYS) as Array<[keyof ReferencePrices, string]>)
		if (Object.hasOwn(raw, key)) {
			pricing ??= {};
			pricing[field] = perMillion(raw[key]);
		}
	if (pricing) Object.assign(pricing, { currency: "USD", unit: "perMillionTokens" });
	const tier = longContext(raw);
	if (tier) {
		pricing ??= {};
		pricing.longContext = tier;
	}
	return pricing;
}

export function modelProfile(card: {
	metadata: RawMetadata;
	provenance?: Record<string, FieldSource>;
}): ModelProfile {
	const raw = card.metadata;
	const provenance = card.provenance ?? {};
	const has = (key: string) => Object.hasOwn(raw, key);
	const profile: ModelProfile = {
		...contextWindow(raw, provenance),
		reasoning: {},
		pricingOverridden: Object.entries(provenance).some(
			([key, source]) =>
				source.layer.startsWith("local-") &&
				(Object.values(PRICE_KEYS).some((price) => key.startsWith(price)) ||
					key.startsWith("long_context_") ||
					key.startsWith("reference_pricing_long_context")),
		),
	};
	if (has("max_output_tokens")) {
		profile.maxOutputTokens = tokens(raw.max_output_tokens);
		// A declared total holds the output too, whichever layer declared each of them.
		for (const key of ["context_window", "legacy_context_window"]) {
			const total = tokens(raw[key]);
			if (typeof total === "number" && typeof profile.maxOutputTokens === "number")
				profile.maxOutputTokens = Math.min(profile.maxOutputTokens, total);
		}
	}
	if (has("supported_modalities")) profile.inputModalities = modalities(raw.supported_modalities);
	else if (raw.supports_vision === true) profile.inputModalities = ["text", "image"];
	if (has("supported_output_modalities"))
		profile.outputModalities = modalities(raw.supported_output_modalities);
	if (has("supports_web_search")) profile.nativeSearch = bool(raw.supports_web_search);
	if (has("tool_loading_modes")) profile.toolLoadingModes = strings(raw.tool_loading_modes);
	const reasoning = profile.reasoning;
	if (has("supports_reasoning")) reasoning.supported = bool(raw.supports_reasoning);
	if (has("reasoning_mode"))
		reasoning.mode =
			raw.reasoning_mode === null
				? null
				: REASONING_MODES.includes(String(raw.reasoning_mode))
					? (raw.reasoning_mode as ReasoningMode)
					: undefined;
	if (has("reasoning_effort_levels")) reasoning.levels = strings(raw.reasoning_effort_levels);
	if (has("default_reasoning_effort"))
		reasoning.defaultLevel =
			raw.default_reasoning_effort === null || typeof raw.default_reasoning_effort === "string"
				? raw.default_reasoning_effort
				: undefined;
	if (has("supports_none_reasoning_effort"))
		reasoning.canDisable = bool(raw.supports_none_reasoning_effort);
	if (has("can_disable_reasoning")) reasoning.canDisable = bool(raw.can_disable_reasoning);
	for (const key of Object.keys(reasoning) as Array<keyof ModelReasoning>)
		if (reasoning[key] === undefined) delete reasoning[key];
	const pricing = referencePricing(raw);
	if (pricing) profile.referencePricing = pricing;
	return profile;
}
