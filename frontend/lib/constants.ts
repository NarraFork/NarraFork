export const CHAPTER_STATUS_COLORS: Record<string, string> = {
	active: "green",
	dormant: "yellow",
	merged: "blue",
	abandoned: "gray",
};

export const NARRATOR_STATUS_COLORS: Record<string, string> = {
	idle: "gray",
	thinking: "blue",
	waiting: "yellow",
	done: "green",
	archived: "dark",
	error: "red",
};

export const CONTAINER_STATUS_COLORS: Record<string, string> = {
	created: "gray",
	running: "green",
	paused: "yellow",
	stopped: "red",
	removed: "gray",
};

export const BUILTIN_MODELS = [
];

export type ModelOption = {
	value: string;
	label: string;
	provider?: string;
	rateMultiplier?: number;
};

/** Group ModelOption[] by provider for Mantine Select's grouped data format. */
export function groupModelsByProvider(
	models: ModelOption[],
	providerLabels: Record<string, string> = {},
): { group: string; items: { value: string; label: string }[] }[] {
	const labels = { ...defaultLabels, ...providerLabels };
	const groups = new Map<string, { value: string; label: string }[]>();
	for (const m of models) {
		if (!groups.has(prov)) groups.set(prov, []);
		const suffix = m.rateMultiplier != null ? ` (×${m.rateMultiplier})` : "";
		groups.get(prov)?.push({ value: m.value, label: `${m.label}${suffix}` });
	}
	return [...groups.entries()].map(([prov, items]) => ({
		group: labels[prov] ?? prov,
		items,
	}));
}
