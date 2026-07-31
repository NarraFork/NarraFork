/**
 * Pulls a plugin provider's model catalog over RPC into the provider registry.
 *
 * Registration only knows what the manifest declares, which is a `defaultModelId`
 * at most. The real catalog comes from `provider.listModels`, so until this runs a
 * provider is registered but has no models and the registry reports its catalog as
 * stale.
 *
 * Refresh is deliberately pull-based and bounded:
 *
 * - it is never run on a timer, because that would start plugin processes in the
 *   background just to poll them (see the "no background activation" constraint in
 *   B-4); callers trigger it after activation or from an explicit user action;
 * - pagination is followed to a hard page cap so a misbehaving plugin cannot stream
 *   an unbounded catalog into memory;
 * - a failure marks the catalog stale rather than clearing it, so a previously good
 *   catalog keeps serving while the provider is unreachable.
 */

import { logger } from "@server/lib/logger";
import type { JsonValue } from "@server/lib/plugins/protocol";
import type { PluginProviderClientPool } from "./plugin-provider-client";
import type {
	PluginProviderRegistry,
	ProviderModelDescriptor,
	ProviderRegistryEntry,
} from "./plugin-provider-registry";
import type { ProviderModelDescriptor as RpcModelDescriptor } from "./plugin-provider-rpc";

/**
 * Hard ceiling on pages followed in one refresh. With the protocol's 200-model page
 * limit this allows 2000 models, far beyond any real catalog, while still
 * terminating if a plugin returns a cursor that never advances.
 */
const MAX_CATALOG_PAGES = 10;

export interface ProviderCatalogRefreshResult {
	providerInstanceId: string;
	providerPrefix: string;
	modelCount: number;
	catalogVersion?: string;
	stale: boolean;
	/** Set when the refresh failed; the previous catalog is left in place. */
	error?: string;
	/** True when the provider does not support model discovery at all. */
	skipped?: boolean;
}

export interface PluginProviderCatalogRefresherOptions {
	registry: PluginProviderRegistry;
	clientPool: PluginProviderClientPool;
	maxPages?: number;
}

/**
 * The RPC and registry model descriptors are structurally identical but declared
 * independently, so convert explicitly rather than casting. Doing it field by field
 * also drops anything a plugin adds beyond the contract.
 */
function toRegistryModel(model: RpcModelDescriptor): ProviderModelDescriptor {
	return {
		id: model.id,
		displayName: model.displayName,
		...(model.description === undefined ? {} : { description: model.description }),
		...(model.aliases === undefined ? {} : { aliases: [...model.aliases] }),
		...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
		...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
		...(model.deprecated === undefined ? {} : { deprecated: model.deprecated }),
		...(model.deprecationMessage === undefined
			? {}
			: { deprecationMessage: model.deprecationMessage }),
		capabilities: {
			chat: model.capabilities.chat,
			generate: model.capabilities.generate,
			streaming: model.capabilities.streaming,
			tools: model.capabilities.tools,
			...(model.capabilities.parallelToolCalls === undefined
				? {}
				: { parallelToolCalls: model.capabilities.parallelToolCalls }),
			...(model.capabilities.inputImages === undefined
				? {}
				: { inputImages: model.capabilities.inputImages }),
			...(model.capabilities.reasoning === undefined
				? {}
				: { reasoning: model.capabilities.reasoning }),
			...(model.capabilities.reasoningEfforts === undefined
				? {}
				: { reasoningEfforts: [...model.capabilities.reasoningEfforts] }),
			sessionMode: model.capabilities.sessionMode,
		},
		...(model.metadata === undefined
			? {}
			: { metadata: structuredClone(model.metadata) as Record<string, JsonValue> }),
	};
}

export class PluginProviderCatalogRefresher {
	private readonly registry: PluginProviderRegistry;
	private readonly clientPool: PluginProviderClientPool;
	private readonly maxPages: number;
	private readonly inFlight = new Map<string, Promise<ProviderCatalogRefreshResult>>();

	constructor(options: PluginProviderCatalogRefresherOptions) {
		this.registry = options.registry;
		this.clientPool = options.clientPool;
		this.maxPages = Math.max(1, options.maxPages ?? MAX_CATALOG_PAGES);
	}

	/**
	 * Refresh one provider's catalog.
	 *
	 * Concurrent calls for the same provider share a single RPC round, so several
	 * narrators resolving an unpopulated provider do not each trigger a listModels.
	 */
	async refresh(
		reference: string,
		options: { signal?: AbortSignal; force?: boolean } = {},
	): Promise<ProviderCatalogRefreshResult> {
		const entry = this.registry.get(reference);
		if (!entry) {
			throw new Error(`Provider is not registered: ${reference}`);
		}
		const existing = this.inFlight.get(entry.providerInstanceId);
		if (existing) return existing;
		const flight = this.refreshLocked(entry, options).finally(() => {
			this.inFlight.delete(entry.providerInstanceId);
		});
		this.inFlight.set(entry.providerInstanceId, flight);
		return flight;
	}

	/**
	 * Refresh every executable-plugin provider whose catalog is stale.
	 *
	 * Used after a contribution refresh: freshly registered providers start with an
	 * empty, stale catalog. Providers already carrying a good catalog are skipped so
	 * this does not activate plugins needlessly.
	 */
	async refreshStale(
		options: { signal?: AbortSignal } = {},
	): Promise<ProviderCatalogRefreshResult[]> {
		const targets = this.registry
			.list()
			.filter(
				(entry) =>
					entry.kind === "executable-plugin" &&
					entry.status === "available" &&
					entry.catalogStale &&
					entry.capabilities.listModels,
			);
		const results: ProviderCatalogRefreshResult[] = [];
		// Sequential on purpose: refreshing in parallel would start several plugin
		// processes at once, and this runs on the main thread.
		for (const entry of targets) {
			if (options.signal?.aborted) break;
			results.push(await this.refresh(entry.providerInstanceId, options));
		}
		return results;
	}

	private async refreshLocked(
		entry: ProviderRegistryEntry,
		options: { signal?: AbortSignal; force?: boolean },
	): Promise<ProviderCatalogRefreshResult> {
		if (!entry.capabilities.listModels) {
			// A provider may legitimately ship a fixed manifest catalog only.
			return {
				providerInstanceId: entry.providerInstanceId,
				providerPrefix: entry.providerPrefix,
				modelCount: entry.modelCount,
				catalogVersion: entry.catalogVersion,
				stale: entry.catalogStale,
				skipped: true,
			};
		}
		if (!entry.pluginId) {
			throw new Error(`Provider ${entry.providerInstanceId} has no owning plugin`);
		}

		try {
			const client = await this.clientPool
				.get({
					pluginId: entry.pluginId,
					providerTypeId: entry.providerTypeId,
					providerInstanceId: entry.providerInstanceId,
				})
				.acquire(options.signal);

			// Keyed by model id so a plugin that repeats a model across pages cannot make
			// the whole refresh fail: `updateModelCatalog` rejects duplicate ids, which
			// would otherwise wipe a previously good catalog. First occurrence wins.
			const models = new Map<string, ProviderModelDescriptor>();
			const seenCursors = new Set<string>();
			let cursor: string | undefined;
			let catalogVersion: string | undefined;
			let stale = false;
			let pagesFetched = 0;

			for (let page = 0; page < this.maxPages; page += 1) {
				const catalog = await client.listModels(
					{
						providerTypeId: entry.providerTypeId,
						providerInstanceId: entry.providerInstanceId,
						// The plugin may need credentials from config to enumerate models.
						config: this.registry.getConfig(entry.providerInstanceId),
						...(cursor ? { cursor } : {}),
						...(options.force ? { refresh: true } : {}),
					},
					options.signal,
				);
				pagesFetched += 1;
				for (const model of catalog.models) {
					if (!models.has(model.id)) models.set(model.id, toRegistryModel(model));
				}
				catalogVersion = catalog.catalogVersion ?? catalogVersion;
				stale = catalog.stale === true;
				const next = catalog.nextCursor;
				// Stop on a missing or repeated cursor: a plugin that keeps returning the
				// same cursor would otherwise loop until the page cap.
				if (!next || seenCursors.has(next)) break;
				seenCursors.add(next);
				cursor = next;
			}
			const collected = [...models.values()];

			this.registry.updateModelCatalog(entry.providerInstanceId, collected, {
				...(catalogVersion ? { catalogVersion } : {}),
				stale,
			});
			logger.debug("plugin provider catalog refreshed", {
				providerInstanceId: entry.providerInstanceId,
				providerPrefix: entry.providerPrefix,
				modelCount: collected.length,
				pages: pagesFetched,
			});
			return {
				providerInstanceId: entry.providerInstanceId,
				providerPrefix: entry.providerPrefix,
				modelCount: collected.length,
				...(catalogVersion ? { catalogVersion } : {}),
				stale,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Keep whatever catalog was already cached; only flag it as stale so the UI
			// can show that discovery failed without losing a working model list.
			this.registry.markCatalogStale(entry.providerInstanceId, message);
			logger.warn("plugin provider catalog refresh failed", {
				providerInstanceId: entry.providerInstanceId,
				error: message,
			});
			return {
				providerInstanceId: entry.providerInstanceId,
				providerPrefix: entry.providerPrefix,
				modelCount: entry.modelCount,
				catalogVersion: entry.catalogVersion,
				stale: true,
				error: message,
			};
		}
	}
}
