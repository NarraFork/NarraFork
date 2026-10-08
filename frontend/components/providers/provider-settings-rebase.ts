import {
	type ProvidersState,
	providersReducer,
	providersStateFromSettings,
	type SavedSnapshot,
} from "./providers-reducer";

// Settings are JSON values. Ignore object key order and absent/undefined optional
// fields so serialized snapshots do not turn unchanged records into local edits.
function equalValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => equalValue(value, right[index]))
		);
	}
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	const a = left as Record<string, unknown>;
	const b = right as Record<string, unknown>;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((key) => equalValue(a[key], b[key]));
}

function equalSet(local: Set<string>, baseline: string[]): boolean {
	const saved = new Set(baseline);
	return local.size === saved.size && [...local].every((value) => saved.has(value));
}

function rebaseRecords<T extends { id: string }>(local: T[], baseline: T[], fresh: T[]): T[] {
	const savedById = new Map(baseline.map((record) => [record.id, record]));
	const localById = new Map(local.map((record) => [record.id, record]));
	const freshIds = new Set(fresh.map((record) => record.id));
	const merged: T[] = [];
	for (const record of fresh) {
		const draft = localById.get(record.id);
		const saved = savedById.get(record.id);
		// A missing local record that existed at baseline is a pending deletion.
		if (!draft && saved) continue;
		merged.push(draft && !equalValue(draft, saved) ? draft : record);
	}
	// Preserve edited records deleted remotely, and unsaved additions, in draft order.
	for (const record of local) {
		if (!freshIds.has(record.id) && !equalValue(record, savedById.get(record.id))) {
			merged.push(record);
		}
	}
	return merged;
}

/** Rebase a settings response onto a draft without discarding edits since baseline. */
export function rebaseProviderState(
	local: ProvidersState,
	baseline: SavedSnapshot,
	freshSettings: Record<string, unknown>,
): ProvidersState {
	const fresh = providersStateFromSettings(freshSettings);
	const customApiProviders = rebaseRecords(
		local.customApiProviders,
		baseline.customApiProviders,
		fresh.customApiProviders,
	);
	const nugProviders = rebaseRecords(local.nugProviders, baseline.nugProviders, fresh.nugProviders);
	const modelContextWindows = { ...fresh.modelContextWindows };
	for (const key of new Set([
		...Object.keys(baseline.modelContextWindows),
		...Object.keys(local.modelContextWindows),
	])) {
		const hasLocal = Object.hasOwn(local.modelContextWindows, key);
		const hasSaved = Object.hasOwn(baseline.modelContextWindows, key);
		if (
			hasLocal === hasSaved &&
			local.modelContextWindows[key] === baseline.modelContextWindows[key]
		) {
			continue;
		}
		if (hasLocal) modelContextWindows[key] = local.modelContextWindows[key];
		else delete modelContextWindows[key];
	}
	const projected = providersReducer(fresh, {
		type: "SET_CUSTOM_API_PROVIDERS",
		providers: customApiProviders,
	});
	// Clone the result, including nested headers/proxies and sets: callers may
	// continue editing it without changing local, baseline or the settings cache.
	return structuredClone({
		...projected,
		customApiProviders,
		nugProviders,
		hiddenModels: equalSet(local.hiddenModels, baseline.hiddenModels)
			? fresh.hiddenModels
			: local.hiddenModels,
		disabledProviders: equalSet(local.disabledProviders, baseline.disabledProviders)
			? fresh.disabledProviders
			: local.disabledProviders,
		customModels: equalValue(local.customModels, baseline.customModels)
			? fresh.customModels
			: local.customModels,
		providerOrder: equalValue(local.providerOrder, baseline.providerOrder)
			? fresh.providerOrder
			: local.providerOrder,
		modelContextWindows,
	});
}
