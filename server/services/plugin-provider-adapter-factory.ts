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
	ProviderHostHints,
	ProviderOperation,
} from "./plugin-provider-rpc";

export interface PluginProviderAdapterFactoryOptions {
	resolveRuntime?: ProviderRuntimeResolver;
	/** Share the client pool with the catalog refresher so both reuse one activation. */
	clientPool?: PluginProviderClientPool;
	/** Host identity reported during the `provider.describe` handshake. */
	host?: ProviderClientHost;
	/**
	 * Merge stored credentials into the config sent with each request.
	 *
	 * Resolved per request rather than captured here, because the factory runs once per
	 * model resolution while a credential can be rotated or revoked at any time. Without
	 * it the adapter sends only the plain config the registry holds, which is the
	 * pre-credential behaviour.
	 */
	resolveConfig?: (providerInstanceId: string) => Promise<Record<string, JsonValue>>;
	/**
	 * Resolve host-provided hints (proxy URL and optional cooperative upstream-concurrency hint)
	 * for each request.
	 *
	 * Called per-request so that settings changes take effect immediately. Returns
	 * undefined when there is nothing to communicate; an empty object is never sent.
	 * Provider-specific queuing/throttling remains plugin-owned; this resolver never turns
	 * descriptor `maxConcurrent*` declarations into host admission checks.
	 *
	 * Receives the provider instance the call belongs to, so a per-provider policy can be
	 * applied. Without it the host could only offer one global proxy for every plugin
	 * provider at once — the built-in providers each have their own `settings.<provider>.proxy`
	 * override, and a plugin provider had no equivalent.
	 *
	 * SECURITY: The returned `outbound.proxyUrl` may contain credentials. The caller
	 * (PooledProviderRpcClient) injects it into RPC params which cross a process boundary
	 * but are NOT logged, NOT sent to diagnostics, NOT echoed to WebSocket/SSE.
	 */
	resolveHostHints?: (context: ProviderHostHintsContext) => ProviderHostHints | undefined;
}

/** Which provider a hints lookup is for. */
export interface ProviderHostHintsContext {
	pluginId: string;
	providerInstanceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Provider-declared descriptor defaults, kept identical to the values `plugin-provider-rpc`
 * applies when normalizing a `provider.describe` result. The maxConcurrent* defaults describe
 * plugin-side provider policy for the unset case; they are not host admission limits.
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
 *
 * This class also injects `hostHints` (proxy URL and optional cooperative upstream-concurrency
 * hint) into every outgoing request. The hints are resolved per-call so host policy changes take
 * effect immediately; provider-specific concurrency remains plugin-owned.
 */
class PooledProviderRpcClient implements RemoteProviderRpcClient {
	constructor(
		private readonly deferred: DeferredProviderClient,
		private readonly resolveHostHints?: (
			context: ProviderHostHintsContext,
		) => ProviderHostHints | undefined,
		/** Identity passed to the hints resolver so it can apply a per-provider policy. */
		private readonly hintsContext?: ProviderHostHintsContext,
	) {}

	async chat(
		params: ProviderChatParams,
		options?: { signal?: AbortSignal },
	): Promise<ProviderOperation> {
		const client = await this.deferred.acquire(options?.signal);
		return client.chat(this.injectHints(params), options);
	}

	async generate(
		params: ProviderGenerateParams,
		options?: { signal?: AbortSignal },
	): Promise<ProviderOperation> {
		const client = await this.deferred.acquire(options?.signal);
		return client.generate(this.injectHints(params), options);
	}

	/**
	 * Inject host hints into params. The hints field is only added when the resolver
	 * returns a non-empty object, preserving backward compatibility with plugins that
	 * do not expect it.
	 */
	private injectHints<T extends { hostHints?: ProviderHostHints }>(params: T): T {
		if (!this.resolveHostHints || !this.hintsContext) return params;
		const hints = this.resolveHostHints(this.hintsContext);
		if (!hints) return params;
		// Attach when a field is present, including an empty outbound object that explicitly
		// clears a previously cached proxy inside the plugin.
		if (!("outbound" in hints) && !("concurrency" in hints)) return params;
		return { ...params, hostHints: hints };
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
			options.resolveHostHints,
			{ pluginId: entry.pluginId, providerInstanceId: entry.providerInstanceId },
		);
		logger.debug("plugin provider adapter created", {
			pluginId: entry.pluginId,
			providerTypeId: entry.providerTypeId,
			providerPrefix: entry.providerPrefix,
			modelCount: modelCatalog.size,
		});
		const resolveConfig = options.resolveConfig;
		return new RemoteProviderAdapter({
			rpc,
			providerTypeId: entry.providerTypeId,
			providerInstanceId: entry.providerInstanceId,
			providerPrefix: entry.providerPrefix,
			config: toJsonConfig(config),
			...(resolveConfig ? { resolveConfig: () => resolveConfig(entry.providerInstanceId) } : {}),
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
