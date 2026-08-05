/**
 * Exposes plugin search contributions to the host's search layer.
 *
 * The counterpart of `plugin-provider-model-source.ts`, and for the same reason: the search
 * router must be able to enumerate plugin channels without `lib/search` depending on the
 * plugin platform. `lib/search/plugin-source.ts` owns the registry interface; this file
 * supplies one implementation backed by `PluginSearchRegistry`.
 *
 * `listChannels()` is a synchronous registry walk. That is a hard requirement, not a
 * preference — see the header of `plugin-search-registry.ts`.
 */

import type { ExtraSearchChannelSource } from "@server/lib/search/plugin-source";
import type { SearchChannelResult, SearchRequest } from "@server/lib/search/types";
import type { PluginSearchRegistry } from "./plugin-search-registry";

export function pluginSearchChannelSource(
	registry: Pick<PluginSearchRegistry, "list" | "isUsable" | "labelFor" | "execute">,
): ExtraSearchChannelSource {
	return {
		listChannels: () =>
			registry.list().map((entry) => ({
				id: entry.channelId,
				label: registry.labelFor(entry),
				available: registry.isUsable(entry),
				...(entry.limits?.timeoutMs != null ? { timeoutMs: entry.limits.timeoutMs } : {}),
			})),
		execute: (
			channelId: string,
			request: SearchRequest,
			signal: AbortSignal,
		): Promise<SearchChannelResult> => registry.execute(channelId, request, signal),
	};
}
