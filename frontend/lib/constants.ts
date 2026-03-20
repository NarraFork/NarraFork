export {
	CHAPTER_ROLE_ICONS,
	CHAPTER_STATUS_COLORS,
	CONTAINER_STATUS_COLORS,
	EDGE_TYPE_COLORS,
	NARRATOR_STATUS_COLORS,
	statusRegistry,
	TOOL_CALL_STATUS_COLORS,
} from "./status-registry";

export type ModelOption = {
	value: string;
	label: string;
	provider?: string;
	rateMultiplier?: number;
};

/** Sentinel value stored in DB to mean "follow the default model from settings". */
export const FOLLOW_DEFAULT_MODEL = "__default__";

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
