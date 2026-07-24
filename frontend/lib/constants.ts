export {
	CHAPTER_ROLE_ICONS,
	CHAPTER_STATUS_COLORS,
	CONTAINER_STATUS_COLORS,
	EDGE_TYPE_COLORS,
	NARRATOR_STATUS_COLORS,
	statusRegistry,
	TOOL_CALL_STATUS_COLORS,
} from "./status-registry";

export type ModelPricingInfo = {
	billingMode?: string;
	unitName?: string;
	tokenUnit?: number;
	input?: number | string;
	output?: number | string;
	cacheCreationInput?: number | string;
	cacheReadInput?: number | string;
	credit?: number | string;
};

export type ModelOption = {
	value: string;
	label: string;
	provider?: string;
	channel?: string;
	channelType?: string;
	bareModel?: string;
	rateMultiplier?: number;
	effortLevels?: string[];
	/** NUG model pricing info (only present for NUG models that have configured
	 * prices). Used for the model-info price popup. */
	pricing?: ModelPricingInfo;
	officialInputUsd?: number;
	officialOutputUsd?: number;
	officialCacheCreationInputUsd?: number;
	officialCacheReadInputUsd?: number;
	channelMultiplier?: number;
	contextWindow?: number;
	usdRate?: number;
	/** NUG models: false when the model's upstream is temporarily unavailable
	 * (its whole credential pool is disabled). The option is shown but marked
	 * "temporarily unavailable" so the user knows selecting it will wait for
	 * recovery. Absent/true means available. */
	available?: boolean;
};

/** Sentinel value stored in DB to mean "follow the default model from settings". */
export const FOLLOW_DEFAULT_MODEL = "__default__";

/** Sentinel value stored in DB to mean "follow the summary model from settings". */
export const FOLLOW_SUMMARY_MODEL = "__summary__";

/** Human-readable label for a NUG model's channelType (request protocol). */
export function nugChannelTypeLabel(channelType?: string): string {
	switch (channelType) {
		case "codex":
			return "codex 兼容";
		case "responses":
			return "responses 兼容";
		case "openai":
			return "openai 兼容";
		case "anthropic":
			return "anthropic";
		default:
			return channelType ?? "";
	}
}

/** Prefix for model aggregation values. */
export const AGG_MODEL_PREFIX = "__agg__:";

export interface ModelAggregation {
	id: string;
	name: string;
	models: string[];
	routingMode: "priority" | "balanced";
}

/**
 * Parse an aggregation model value.
 * Returns null if the value is not an aggregation.
 */
export function parseAggModelValue(raw?: string | null): {
	aggId: string;
	pinnedModel?: string;
} | null {
	if (!raw?.startsWith(AGG_MODEL_PREFIX)) return null;
	const rest = raw.slice(AGG_MODEL_PREFIX.length);
	const firstColon = rest.indexOf(":");
	if (firstColon < 0) return { aggId: rest };
	const aggId = rest.slice(0, firstColon);
	const pinnedModel = rest.slice(firstColon + 1);
	return { aggId, pinnedModel: pinnedModel || undefined };
}

/**
 * Build an aggregation model value string.
 */
export function buildAggModelValue(aggId: string, pinnedModel?: string): string {
	if (pinnedModel) return `${AGG_MODEL_PREFIX}${aggId}:${pinnedModel}`;
	return `${AGG_MODEL_PREFIX}${aggId}`;
}

/**
 * Resolve a (possibly meta) model reference to a concrete "provider:model" value
 * for display/capability lookups (context window, reasoning effort, codex controls).
 *
 * Handles:
 *   - "follow default" sentinel  -> the configured default model value
 *   - aggregation, pinned         -> the pinned member
 *   - aggregation, auto           -> the first member (mirrors backend "priority"
 *                                     routing default; the backend resolves the
 *                                     actual member at request time)
 *
 * This intentionally does not honor the "balanced" round-robin order or
 * provider-disabled filtering — it only needs a representative concrete model
 * for client-side display. Concrete and unknown values pass through unchanged.
 */
export function resolveDisplayModel(
	model: string | null | undefined,
	options: { defaultModelValue?: string; aggregations?: ModelAggregation[] } = {},
): string {
	const { defaultModelValue, aggregations } = options;
	const raw = model?.trim();
	if (!raw || raw === FOLLOW_DEFAULT_MODEL) {
		// Avoid infinite recursion if the default is itself a sentinel.
		const fallback = defaultModelValue?.trim();
		if (!fallback || fallback === FOLLOW_DEFAULT_MODEL) return raw ?? "";
		return resolveDisplayModel(fallback, options);
	}

	const agg = parseAggModelValue(raw);
	if (!agg) return raw;

	if (agg.pinnedModel) return resolveDisplayModel(agg.pinnedModel, options);

	const members = aggregations?.find((a) => a.id === agg.aggId)?.models ?? [];
	const first = members[0];
	if (!first) return raw;
	return resolveDisplayModel(first, options);
}

/**
 * Build a "provider:model" composite value.
 * This allows the same model ID to appear under different providers.
 */
export function modelValue(provider: string, modelId: string): string {
	return `${provider}:${modelId}`;
}

/**
 * Merge multiple ModelOption arrays, deduplicating by value.
 * Earlier entries win.
 */
export function mergeModels(...sources: ModelOption[][]): ModelOption[] {
	const seen = new Set<string>();
	const result: ModelOption[] = [];
	for (const list of sources) {
		for (const m of list) {
			if (!seen.has(m.value)) {
				seen.add(m.value);
				result.push(m);
			}
		}
	}
	return result;
}

/** Group ModelOption[] by provider for Mantine Select's grouped data format. */
export function groupModelsByProvider(
	models: ModelOption[],
	providerLabels: Record<string, string> = {},
): { group: string; items: { value: string; label: string }[] }[] {
	const defaultLabels: Record<string, string> = {
		openai: "OpenAI",
		anthropic: "Anthropic",
	};
	const labels = { ...defaultLabels, ...providerLabels };
	const groups = new Map<string, { value: string; label: string }[]>();
	const seen = new Set<string>();
	for (const m of models) {
		if (seen.has(m.value)) continue;
		seen.add(m.value);
		if (!groups.has(prov)) groups.set(prov, []);
		const suffix = m.rateMultiplier != null ? ` (×${m.rateMultiplier})` : "";
		groups.get(prov)?.push({ value: m.value, label: `${m.label}${suffix}` });
	}
	return [...groups.entries()].map(([prov, items]) => ({
		group: labels[prov] ?? prov,
		items,
	}));
}
