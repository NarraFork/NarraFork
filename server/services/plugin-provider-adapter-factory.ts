/**
 * Builds the `ProviderAdapter` the Agent Loop drives for an executable-plugin
 * provider.
 *
 * The awkward part this solves is a lifecycle mismatch. `entry.createAdapter()` is
 * synchronous and is called while resolving a model, but the plugin process may not
 * be running yet, and starting it is async. Activating eagerly at registration time
 * is not an option either: registration happens for every installed plugin during a
 * catalog refresh, and spawning them all would defeat lazy activation.
 *
 * So the adapter is created immediately around a *deferred* RPC client. The first
 * `chat()`/`generate()` call activates the runtime, performs the `provider.describe`
 * handshake once, and caches the resulting client. This mirrors how
 * `PluginAgentToolBridge.ensureActivated()` defers activation to first invocation.
 */

import type { ProviderAdapter } from "@server/lib/agent/provider";
import {
	RemoteProviderAdapter,
	type RemoteProviderRpcClient,
} from "@server/lib/agent/remote-provider-adapter";
import { logger } from "@server/lib/logger";
import type { JsonValue } from "@server/lib/plugins/protocol";
import {
	type DeferredProviderClient,
	PluginProviderClientPool,
	type ProviderClientHost,
	type ProviderRuntimeResolver,
} from "./plugin-provider-client";
import type {
	ProviderAdapterFactory,
	ProviderModelDescriptor,
	ProviderRegistryEntry,
} from "./plugin-provider-registry";
import type {
	ProviderChatParams,
	ProviderDescriptor,
	ProviderGenerateParams,
	ProviderOperation,
} from "./plugin-provider-rpc";

export interface PluginProviderAdapterFactoryOptions {
	resolveRuntime?: ProviderRuntimeResolver;
	/** Share the client pool with the catalog refresher so both reuse one activation. */
	clientPool?: PluginProviderClientPool;
	/** Host identity reported during the `provider.describe` handshake. */
	host?: ProviderClientHost;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Descriptor limit defaults, kept identical to the values `plugin-provider-rpc`
 * applies when normalizing a `provider.describe` result. Matching them means a
 * manifest-derived descriptor and an RPC-derived one agree on the unset case.
 */
const DEFAULT_PROVIDER_LIMITS = {
	maxConcurrentChat: 1,
	maxConcurrentGenerate: 1,
	maxConfigBytes: 1024 * 1024,
	maxModelPageSize: 200,
} as const;

/**
 * Bridges the adapter's narrow RPC surface onto a pooled, lazily activated client.
 *
 * `RemoteProviderAdapter` only calls `chat()` and `generate()`, both of which return
 * promises, so activation hides behind them without breaking the adapter's
 * synchronous construction contract.
 */
class PooledProviderRpcClient implements RemoteProviderRpcClient {
	constructor(private readonly deferred: DeferredProviderClient) {}

	async chat(
		params: ProviderChatParams,
		options?: { signal?: AbortSignal },
	): Promise<ProviderOperation> {
		const client = await this.deferred.acquire(options?.signal);
		return client.chat(params, options);
	}

	async generate(
		params: ProviderGenerateParams,
		options?: { signal?: AbortSignal },
	): Promise<ProviderOperation> {
		const client = await this.deferred.acquire(options?.signal);
		return client.generate(params, options);
	}
}

/**
 * Create the registry adapter factory.
 *
 * Registered as the registry's `remoteProviderAdapterFactory`, so every
 * executable-plugin entry gets a working `createAdapter()` without the registry
 * knowing anything about runtimes or RPC.
 */
export function createPluginProviderAdapterFactory(
	options: PluginProviderAdapterFactoryOptions,
): ProviderAdapterFactory {
	const pool =
		options.clientPool ??
		(() => {
			if (!options.resolveRuntime) {
				throw new TypeError(
					"createPluginProviderAdapterFactory requires resolveRuntime or clientPool",
				);
			}
			return new PluginProviderClientPool(options.resolveRuntime, options.host ?? {});
		})();
	return ({ entry, config, modelCatalog }): ProviderAdapter => {
		if (entry.kind !== "executable-plugin" || !entry.pluginId) {
			throw new Error(`Provider ${entry.providerInstanceId} is not an executable plugin provider`);
		}
		const rpc = new PooledProviderRpcClient(
			pool.get({
				pluginId: entry.pluginId,
				providerTypeId: entry.providerTypeId,
				providerInstanceId: entry.providerInstanceId,
			}),
		);
		logger.debug("plugin provider adapter created", {
			pluginId: entry.pluginId,
			providerTypeId: entry.providerTypeId,
			providerPrefix: entry.providerPrefix,
			modelCount: modelCatalog.size,
		});
		return new RemoteProviderAdapter({
			rpc,
			providerTypeId: entry.providerTypeId,
			providerInstanceId: entry.providerInstanceId,
			providerPrefix: entry.providerPrefix,
			config: toJsonConfig(config),
			modelCatalog: cloneCatalog(modelCatalog),
			descriptor: descriptorFor(entry),
		});
	};
}

/**
 * Project a registry entry onto the RPC `ProviderDescriptor` shape.
 *
 * `RemoteProviderAdapter` reads exactly one field from the descriptor —
 * `capabilities.mayLeakXmlToolCalls`, which tells the Agent Loop to run XML
 * tool-call recovery for this provider. The descriptor's other fields are typed
 * as required literals by the RPC contract, so they are filled from the entry
 * (with the contract's own defaults) rather than left undefined.
 */
function descriptorFor(entry: ProviderRegistryEntry): ProviderDescriptor {
	const capabilities = entry.capabilities;
	const limits = entry.limits;
	return {
		pluginId: entry.pluginId ?? "",
		providerTypeId: entry.providerTypeId,
		localId: entry.localId,
		displayName: entry.displayName,
		...(entry.description ? { description: entry.description } : {}),
		// A boolean `configSchema` means "accept anything"; the RPC descriptor only
		// models object schemas, so normalize to an open object.
		configSchema:
			typeof entry.configSchema === "boolean"
				? { type: "object", additionalProperties: entry.configSchema }
				: (structuredClone(entry.configSchema) as Record<string, JsonValue>),
		...(entry.defaultModelId ? { defaultModelId: entry.defaultModelId } : {}),
		capabilities: {
			// These three are `true` literals in the RPC contract: a provider that
			// cannot validate config, list models or chat has nothing to offer.
			validateConfig: true,
			listModels: true,
			chat: true,
			generate: capabilities.generate,
			...(capabilities.reasoningContinuation === undefined
				? {}
				: { reasoningContinuation: capabilities.reasoningContinuation }),
			...(capabilities.inputImages === undefined ? {} : { inputImages: capabilities.inputImages }),
			...(capabilities.mayLeakXmlToolCalls === undefined
				? {}
				: { mayLeakXmlToolCalls: capabilities.mayLeakXmlToolCalls }),
		},
		limits: {
			maxConcurrentChat: limits?.maxConcurrentChat ?? DEFAULT_PROVIDER_LIMITS.maxConcurrentChat,
			maxConcurrentGenerate:
				limits?.maxConcurrentGenerate ?? DEFAULT_PROVIDER_LIMITS.maxConcurrentGenerate,
			maxConfigBytes: limits?.maxConfigBytes ?? DEFAULT_PROVIDER_LIMITS.maxConfigBytes,
			maxModelPageSize: limits?.maxModelPageSize ?? DEFAULT_PROVIDER_LIMITS.maxModelPageSize,
		},
	};
}

function cloneCatalog(
	catalog: ReadonlyMap<string, ProviderModelDescriptor>,
): Map<string, ProviderModelDescriptor> {
	return new Map([...catalog.entries()].map(([id, model]) => [id, structuredClone(model)]));
}

function toJsonConfig(config: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
	return isRecord(config) ? (structuredClone(config) as Record<string, JsonValue>) : {};
}

export type { ProviderRegistryEntry };
