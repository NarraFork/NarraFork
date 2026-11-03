/**
 * A user's correction of one model's metadata.
 *
 * Only the fields a runtime decision reads can be overridden, and they are typed here
 * instead of exposed as raw catalog keys: the editor never needs to know that a context
 * window can be spelled four ways or that prices are stored per token. Each override is
 * validated on its own when saved; nothing about it is re-checked on a request.
 */
import { decimalValue } from "./card";
import type { Modality } from "./profile";
import type { RawMetadata } from "./schema/catalog";

export const MODALITIES: readonly Modality[] = ["text", "image", "audio", "video"];

/** Prefix-preserving tool loading modes, in no particular order. */
export const TOOL_LOADING_MODES = [
	"anthropic_tool_addition",
	"anthropic_deferred_tail",
	"openai_additional_tools",
	"kimi_system_tools",
	"custom_injection",
] as const;
export type ToolLoadingMode = (typeof TOOL_LOADING_MODES)[number];

/** Reasoning effort levels a provider adapter knows how to send. */
export const REASONING_LEVELS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
const isLevel = (value: unknown): value is ReasoningLevel =>
	typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);

export const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

export interface ModelOverride {
	/** History budget in tokens. */
	contextWindow?: number;
	maxOutputTokens?: number;
	inputModalities?: Modality[];
	nativeSearch?: boolean;
	reasoningLevels?: ReasoningLevel[];
	defaultReasoningLevel?: ReasoningLevel;
	canDisableReasoning?: boolean;
	/** Priority order; `[]` turns prefix-preserving tool loading off. */
	toolLoadingModes?: ToolLoadingMode[];
	/** USD per million tokens, as exact decimal strings. */
	prices?: Partial<Record<PriceField, string>>;
}
export type OverrideField = keyof ModelOverride;

/** Raw catalog key each price field is stored under (USD per token). */
export const PRICE_KEYS: Readonly<Record<PriceField, string>> = {
	input: "input_cost_per_token",
	output: "output_cost_per_token",
	cacheRead: "cache_read_input_token_cost",
	cacheWrite: "cache_creation_input_token_cost",
};

/** A rejected field, phrased for the person who typed it. */
export class OverrideValidationError extends Error {
	constructor(
		readonly field: string,
		message: string,
	) {
		super(message);
	}
}

const MAX_TOKENS = 100_000_000;

function tokens(field: OverrideField, value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_TOKENS)
		throw new OverrideValidationError(field, `${field} must be a whole number of tokens`);
	return value;
}
function list<T extends string>(
	field: OverrideField,
	value: unknown,
	accept: (item: string) => item is T,
): T[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && accept(item)))
		throw new OverrideValidationError(field, `${field} contains an unsupported value`);
	return [...new Set(value as T[])];
}
function bool(field: OverrideField, value: unknown): boolean {
	if (typeof value !== "boolean")
		throw new OverrideValidationError(field, `${field} must be on or off`);
	return value;
}

/**
 * Parse an override from untrusted input. Unknown keys and `undefined`/`null` values are
 * dropped (null means "inherit"); anything else malformed is rejected with its field.
 */
export function normalizeOverride(input: unknown): ModelOverride {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new OverrideValidationError("", "Expected an object of model fields");
	const source = input as Record<string, unknown>;
	const out: ModelOverride = {};
	const has = (key: OverrideField) => source[key] !== undefined && source[key] !== null;
	if (has("contextWindow")) out.contextWindow = tokens("contextWindow", source.contextWindow);
	if (has("maxOutputTokens"))
		out.maxOutputTokens = tokens("maxOutputTokens", source.maxOutputTokens);
	if (has("inputModalities")) {
		out.inputModalities = list("inputModalities", source.inputModalities, (m): m is Modality =>
			(MODALITIES as readonly string[]).includes(m),
		);
		if (!out.inputModalities.includes("text"))
			throw new OverrideValidationError("inputModalities", "Input modalities must include text");
	}
	if (has("nativeSearch")) out.nativeSearch = bool("nativeSearch", source.nativeSearch);
	if (has("reasoningLevels"))
		out.reasoningLevels = list("reasoningLevels", source.reasoningLevels, isLevel);
	if (has("defaultReasoningLevel")) {
		const level = source.defaultReasoningLevel;
		if (!isLevel(level))
			throw new OverrideValidationError("defaultReasoningLevel", "Unsupported reasoning level");
		if (out.reasoningLevels && !out.reasoningLevels.includes(level))
			throw new OverrideValidationError(
				"defaultReasoningLevel",
				`Default reasoning level "${level}" is not one of the listed levels`,
			);
		out.defaultReasoningLevel = level;
	}
	if (has("canDisableReasoning"))
		out.canDisableReasoning = bool("canDisableReasoning", source.canDisableReasoning);
	if (has("toolLoadingModes"))
		out.toolLoadingModes = list(
			"toolLoadingModes",
			source.toolLoadingModes,
			(m): m is ToolLoadingMode => (TOOL_LOADING_MODES as readonly string[]).includes(m),
		);
	if (has("prices")) {
		const prices = source.prices;
		if (!prices || typeof prices !== "object" || Array.isArray(prices))
			throw new OverrideValidationError("prices", "Expected prices per million tokens");
		const parsed: ModelOverride["prices"] = {};
		for (const field of PRICE_FIELDS) {
			const value = (prices as Record<string, unknown>)[field];
			if (value === undefined || value === null || value === "") continue;
			try {
				parsed[field] = decimalValue(value);
			} catch {
				throw new OverrideValidationError(
					`prices.${field}`,
					"Price must be a non-negative number of USD per million tokens",
				);
			}
		}
		if (Object.keys(parsed).length) out.prices = parsed;
	}
	return out;
}

export function isEmptyOverride(override: ModelOverride | undefined): boolean {
	return !override || Object.keys(override).length === 0;
}

/** The raw catalog keys an override stands for; merged as the highest layers. */
export function overrideToRaw(override: ModelOverride): RawMetadata {
	const raw: RawMetadata = {};
	// The working window is the most specific window key, so it wins within its layer.
	if (override.contextWindow !== undefined) raw.working_context_tokens = override.contextWindow;
	if (override.maxOutputTokens !== undefined) raw.max_output_tokens = override.maxOutputTokens;
	if (override.inputModalities) raw.supported_modalities = [...override.inputModalities];
	if (override.nativeSearch !== undefined) raw.supports_web_search = override.nativeSearch;
	if (override.reasoningLevels) {
		raw.reasoning_effort_levels = [...override.reasoningLevels];
		// Listing levels is a claim that the model reasons; an empty list says nothing more.
		if (override.reasoningLevels.length) {
			raw.reasoning_mode = "levels";
			raw.supports_reasoning = true;
		}
	}
	if (override.defaultReasoningLevel !== undefined)
		raw.default_reasoning_effort = override.defaultReasoningLevel;
	if (override.canDisableReasoning !== undefined)
		raw.can_disable_reasoning = override.canDisableReasoning;
	if (override.toolLoadingModes) raw.tool_loading_modes = [...override.toolLoadingModes];
	for (const field of PRICE_FIELDS) {
		const value = override.prices?.[field];
		if (value !== undefined) raw[PRICE_KEYS[field]] = decimalValue(value, -6);
	}
	return raw;
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Best-effort import of an older raw override (settings.json local layer). Keys outside
 * the override's fields are dropped; values that would not validate are skipped.
 */
export function rawToOverride(raw: RawMetadata): ModelOverride {
	const draft: Record<string, unknown> = {
		contextWindow:
			positive(raw.working_context_tokens) ??
			positive(raw.legacy_context_window) ??
			positive(raw.max_input_tokens) ??
			positive(raw.context_window),
		maxOutputTokens: positive(raw.max_output_tokens),
		inputModalities: Array.isArray(raw.supported_modalities)
			? raw.supported_modalities
			: raw.supports_vision === true
				? ["text", "image"]
				: undefined,
		nativeSearch: raw.supports_web_search,
		reasoningLevels: raw.reasoning_effort_levels,
		defaultReasoningLevel: raw.default_reasoning_effort,
		canDisableReasoning: raw.can_disable_reasoning ?? raw.supports_none_reasoning_effort,
		toolLoadingModes: raw.tool_loading_modes,
	};
	const prices: Record<string, string> = {};
	for (const field of PRICE_FIELDS) {
		const value = raw[PRICE_KEYS[field]];
		if (typeof value === "number" || typeof value === "string")
			try {
				prices[field] = decimalValue(value, 6);
			} catch {
				/* not a price */
			}
	}
	if (Object.keys(prices).length) draft.prices = prices;
	const result: ModelOverride = {};
	for (const [key, value] of Object.entries(draft)) {
		try {
			Object.assign(result, normalizeOverride({ [key]: value }));
		} catch {
			/* skip a field that would not validate on its own */
		}
	}
	if (result.defaultReasoningLevel && result.reasoningLevels)
		if (!result.reasoningLevels.includes(result.defaultReasoningLevel))
			delete result.defaultReasoningLevel;
	return result;
}
