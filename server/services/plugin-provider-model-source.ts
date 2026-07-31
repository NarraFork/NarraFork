/**
 * Exposes plugin provider models to the host's model surfaces.
 *
 * The host has two independent model paths and both were blind to plugins:
 *
 * - `getVisibleModels()` in `settings/provider.ts`, used by the Agent (task /
 *   fork-narrator model pools, allowed-model validation, broken-model migration);
 * - the settings API response, which the frontend model picker groups per provider.
 *
 * Rather than add an eighth hardcoded `registerXxxModelLister`, this registers one
 * included, once it moves out — appears through the same path.
 *
 * Reads are synchronous and in-memory: the registry already holds the catalog that
 * `plugin-provider-catalog-refresh` pulled, so no RPC or plugin activation happens
 * here. That matters because these functions run on request paths.
 */

import type { PluginProviderRegistry, ProviderRegistryEntry } from "./plugin-provider-registry";

/** A provider group as consumed by the frontend model picker. */
export interface PluginProviderModelGroup {
	prefix: string;
	name: string;
	models: Array<{
		value: string;
		label: string;
		provider: string;
		bareModel: string;
		contextWindow?: number;
		effortLevels?: string[];
		/** False when the owning plugin is disabled or its runtime is unavailable. */
		available: boolean;
	}>;
	/** True when the catalog has never been refreshed or the last refresh failed. */
	catalogStale: boolean;
	pluginId?: string;
}

function isPluginProvider(entry: ProviderRegistryEntry): boolean {
	return entry.kind === "executable-plugin";
}

/**
 * Model values (`prefix:modelId`) for every available plugin provider.
 *
 * Unavailable providers are excluded: a model the Agent cannot actually route to
 * should not enter a model pool. Aliases are deliberately omitted — they resolve at
 * routing time and listing them would show the same model several times.
 */
export function listPluginProviderModelValues(registry: PluginProviderRegistry): string[] {
	const values: string[] = [];
	for (const entry of registry.list()) {
		if (!isPluginProvider(entry) || entry.status !== "available") continue;
		for (const model of entry.getModels()) {
			values.push(`${entry.providerPrefix}:${model.id}`);
		}
	}
	return values;
}

/**
 * Whether a bare model id belongs to some available plugin provider.
 *
 * Used by prefix-less model resolution. Plugin models are normally written with an
 * explicit prefix, so this is a fallback for values that lost theirs.
 */
export function findPluginProviderForModel(
	registry: PluginProviderRegistry,
	bareModel: string,
): string | undefined {
	for (const entry of registry.list()) {
		if (!isPluginProvider(entry) || entry.status !== "available") continue;
		if (entry.getModel(bareModel)) return entry.providerPrefix;
	}
	return undefined;
}

/**
 * Per-provider groups for the settings API / model picker.
 *
 * Unlike {@link listPluginProviderModelValues} this keeps unavailable providers, so
 * the UI can show a registered-but-disabled provider instead of silently dropping
 * it. Each model carries `available` for that distinction.
 */
export function listPluginProviderModelGroups(
	registry: PluginProviderRegistry,
): PluginProviderModelGroup[] {
	const groups: PluginProviderModelGroup[] = [];
	for (const entry of registry.list()) {
		if (!isPluginProvider(entry)) continue;
		const available = entry.status === "available";
		const models = entry.getModels().map((model) => ({
			value: `${entry.providerPrefix}:${model.id}`,
			label: model.displayName || model.id,
			provider: entry.providerPrefix,
			bareModel: model.id,
			...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
			...(model.capabilities.reasoningEfforts?.length
				? { effortLevels: [...model.capabilities.reasoningEfforts] }
				: {}),
			available,
		}));
		// A provider with no models yet is still worth surfacing: the UI can show it as
		// pending discovery rather than looking like it failed to install.
		groups.push({
			prefix: entry.providerPrefix,
			name: entry.displayName || entry.providerPrefix,
			models,
			catalogStale: entry.catalogStale,
			...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
		});
	}
	return groups;
}
