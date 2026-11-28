import type {
	ProviderConnectionSelection,
	ProviderPreset,
	SourcingCatalog,
} from "@shared/sourcing/presets";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { sourcingApi } from "../../lib/api/sourcing";
import type { UserAgentMode } from "./types";

export const SOURCING_CATALOG_QUERY_KEY = ["sourcing", "templates"] as const;

/** The add-provider presets; never stale, since they are constants of the running build. */
export function useProviderPresets(): UseQueryResult<readonly ProviderPreset[]> {
	return useQuery({
		queryKey: SOURCING_CATALOG_QUERY_KEY,
		queryFn: sourcingApi.templates,
		staleTime: Number.POSITIVE_INFINITY,
		select: (catalog: SourcingCatalog) => catalog.presets,
	});
}

export function getProviderPresetName(
	provider: ProviderPreset,
	translate: (key: string) => string,
): string {
	return provider.nameKey ? translate(provider.nameKey) : provider.name;
}

/** Whether a preset is offered in the given UI language (see `ProviderPreset.languages`). */
export function isProviderPresetAvailable(provider: ProviderPreset, language: string): boolean {
	if (!provider.languages) return true;
	const primary = language.toLowerCase().split("-")[0] ?? "";
	return provider.languages.includes(primary);
}

export function popularProviderPresets(presets: readonly ProviderPreset[]): ProviderPreset[] {
	return presets
		.filter((preset) => preset.popular)
		.sort((a, b) => (a.popular ?? 0) - (b.popular ?? 0));
}

/** Match all terms against raw/localized names, id, aliases, protocols and API URLs. */
export function searchProviderPresets(
	presets: readonly ProviderPreset[],
	query: string,
	translate?: (key: string) => string,
): ProviderPreset[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return presets.filter((provider) => {
		const haystack = [
			provider.id,
			provider.name,
			...(translate ? [getProviderPresetName(provider, translate)] : []),
			...(provider.aliases ?? []),
			...Object.keys(provider.endpoints),
			...Object.values(provider.endpoints),
		]
			.join(" ")
			.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}

/** Pay-as-you-go in the UI language's region, unless the preset names its region. */
export function initialConnectionSelection(
	preset: ProviderPreset,
	language: string,
): ProviderConnectionSelection {
	return {
		region:
			preset.defaultRegion ?? (language.toLowerCase().startsWith("zh") ? "china" : "international"),
		billing: "payg",
	};
}

/** Variants of the selected region and billing (several when a cluster must be chosen). */
function matchingConnections(preset: ProviderPreset, selection: ProviderConnectionSelection) {
	return (preset.connections ?? []).filter(
		(connection) =>
			connection.region === selection.region && connection.billing === selection.billing,
	);
}

/** Clusters to choose from for this selection; empty when none is needed. */
export function connectionClusters(preset: ProviderPreset, selection: ProviderConnectionSelection) {
	return matchingConnections(preset, selection).flatMap((connection) =>
		connection.cluster ? [connection.cluster] : [],
	);
}

/** The preset as the selected variant creates it; null until a required cluster is chosen. */
export function resolveProviderConnection(
	preset: ProviderPreset,
	selection: ProviderConnectionSelection,
): { preset: ProviderPreset; userAgentMode?: UserAgentMode } | null {
	if (!preset.connections) return { preset };
	const connection = matchingConnections(preset, selection).find(
		(candidate) => !candidate.cluster || candidate.cluster === selection.cluster,
	);
	if (!connection) return null;
	const { endpoints, defaultProtocol, creationProtocol, userAgentMode } = connection;
	return {
		preset: {
			...preset,
			endpoints,
			defaultProtocol,
			...(creationProtocol ? { creationProtocol } : {}),
		},
		...(userAgentMode ? { userAgentMode } : {}),
	};
}
