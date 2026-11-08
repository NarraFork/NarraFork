/**
 * What the models page and provider page show for a provider entry: each overridable
 * field's effective value, where it came from, and the overrides that can change it.
 * Lives apart from the catalog module because the context window also depends on
 * provider settings, which import the catalog.
 */
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { PRICE_FIELDS, PRICE_KEYS, type ReasoningLevel } from "@shared/model-catalog/override";
import type {
	EffectiveFields,
	FieldOrigin,
	ModelDescription,
	ModelDescriptionsResponse,
} from "@shared/model-catalog/schema/api";
import type { FieldSource } from "@shared/model-catalog/schema/catalog";
import { parseModelId } from "@shared/model-id";
import { resolveModelContextWindow } from "../settings";
import {
	catalogModelName,
	getEffectiveModelProfile,
	getModelOverride,
	getModelOverridesRevision,
} from "./index";

export const MAX_DESCRIBED_MODELS = 1000;
const CHUNK = 50;

function origin(source: FieldSource | undefined): FieldOrigin {
	switch (source?.layer) {
		case "preset-model":
		case "preset-variant":
			return "catalog";
		case "discovered":
			return "upstream";
		case "local-model":
			return "model";
		case "local-connection":
			return "connection";
		default:
			return "default";
	}
}

const WINDOW_ORIGIN: Record<string, FieldOrigin> = {
	user: "connection",
	card: "model",
	catalog: "upstream",
	provider: "provider",
	builtin: "catalog",
	fallback: "default",
};

export function describeModel(model: string): ModelDescription {
	const value = model.trim();
	const profile = getEffectiveModelProfile(value);
	const { card } = profile;
	const source = (...keys: string[]) =>
		origin(keys.map((key) => card.provenance[key]).find((entry) => entry !== undefined));
	const effective: EffectiveFields = {};
	const { provider, model: bare } = parseModelId(value);
	const window = resolveModelContextWindow(bare, provider ?? "");
	effective.contextWindow = {
		value: window.contextWindow,
		origin: WINDOW_ORIGIN[window.source] ?? "default",
	};
	if (typeof profile.maxOutputTokens === "number")
		effective.maxOutputTokens = {
			value: profile.maxOutputTokens,
			origin: source("max_output_tokens"),
		};
	if (profile.inputModalities)
		effective.inputModalities = {
			value: profile.inputModalities,
			origin: source("supported_modalities", "supports_vision"),
		};
	if (typeof profile.nativeSearch === "boolean")
		effective.nativeSearch = { value: profile.nativeSearch, origin: source("supports_web_search") };
	const reasoning = profile.reasoning;
	if (reasoning.levels)
		effective.reasoningLevels = {
			value: reasoning.levels as ReasoningLevel[],
			origin: source("reasoning_effort_levels"),
		};
	if (reasoning.defaultLevel)
		effective.defaultReasoningLevel = {
			value: reasoning.defaultLevel as ReasoningLevel,
			origin: source("default_reasoning_effort"),
		};
	if (typeof reasoning.canDisable === "boolean")
		effective.canDisableReasoning = {
			value: reasoning.canDisable,
			origin: source("can_disable_reasoning", "supports_none_reasoning_effort"),
		};
	if (profile.toolLoadingModes)
		effective.toolLoadingModes = {
			value: profile.toolLoadingModes as NonNullable<EffectiveFields["toolLoadingModes"]>["value"],
			origin: source("tool_loading_modes"),
		};
	const prices: Record<string, string> = {};
	let priceOrigin: FieldOrigin = "default";
	for (const field of PRICE_FIELDS) {
		const price = profile.referencePricing?.[field];
		if (typeof price !== "string") continue;
		prices[field] = price;
		const fieldOrigin = source(PRICE_KEYS[field]);
		// The most specific origin among the four prices labels the group.
		if (["connection", "model"].includes(fieldOrigin) || priceOrigin === "default")
			priceOrigin = fieldOrigin;
	}
	if (Object.keys(prices).length) effective.prices = { value: prices, origin: priceOrigin };

	const strong = card.matchedVia === "exact" || card.matchedVia === "alias";
	const modelOverride =
		card.modelId && strong ? getModelOverride("model", card.modelId) : undefined;
	const connectionOverride = getModelOverride("connection", value);
	return {
		model: value,
		...(card.modelId ? { catalogModelId: card.modelId } : {}),
		...(card.modelId && catalogModelName(card.modelId)
			? { catalogName: catalogModelName(card.modelId) }
			: {}),
		matchedVia: card.matchedVia,
		modelWideEditable: !!card.modelId && strong,
		effective,
		...(modelOverride ? { modelOverride } : {}),
		...(connectionOverride ? { connectionOverride } : {}),
	};
}

/** Describe many entries, yielding to the event loop between small batches. */
export async function describeModels(models: string[]): Promise<ModelDescriptionsResponse> {
	const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))].slice(
		0,
		MAX_DESCRIBED_MODELS,
	);
	const described: ModelDescription[] = [];
	for (let index = 0; index < unique.length; index += CHUNK) {
		if (index) await yieldToEventLoop();
		for (const model of unique.slice(index, index + CHUNK)) described.push(describeModel(model));
	}
	return { revision: getModelOverridesRevision(), models: described };
}
