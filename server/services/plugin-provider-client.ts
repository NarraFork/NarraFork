/**
 * Shared acquisition of an activated provider RPC client.
 *
 * Two callers need the same thing — an activated plugin runtime with the
 * `provider.describe` handshake already done:
 *
 * - the adapter factory, on the first `chat()`/`generate()`;
 * - the model-catalog refresher, when pulling `provider.listModels`.
 *
 * Keeping acquisition here means both share one activation and one handshake per
 * plugin instead of racing each other into two.
 */

import { logger } from "@server/lib/logger";
import { PluginProviderRpcClient, PluginRuntimeProviderTransport } from "./plugin-provider-rpc";

/** The runtime surface the provider transport needs. */
export interface ProviderRuntimeLike {
	request<T = unknown>(
		method: string,
		params?: unknown,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<T>;
	notify(method: string, params?: unknown): Promise<void>;
	quarantine(reason: string): void;
	onNotification?(handler: (notification: never, bodyBytes?: number) => void): () => void;
	onClose?(handler: (error?: Error) => void): () => void;
}

/**
 * Resolves an active runtime for a plugin, starting it if necessary.
 *
 * Implementations must be idempotent and safe to call concurrently: several
 * narrators can resolve the same provider at once.
 */
export type ProviderRuntimeResolver = (
	pluginId: string,
	options: { reason: string },
) => Promise<ProviderRuntimeLike>;

export interface ProviderClientHost {
	name?: string;
	version?: string;
}

/**
 * Lazily builds and caches the provider RPC client for one plugin.
 *
 * The cache is keyed per instance of this class, so callers that must share an
 * activation should share the provider (see `PluginProviderClientPool`).
 */
export class DeferredProviderClient {
	private client?: PluginProviderRpcClient;
	private pending?: Promise<PluginProviderRpcClient>;

	constructor(
		private readonly pluginId: string,
		private readonly providerTypeId: string,
		private readonly resolveRuntime: ProviderRuntimeResolver,
		private readonly host: ProviderClientHost = {},
	) {}

	/** The already-activated client, if any. Never triggers activation. */
	peek(): PluginProviderRpcClient | undefined {
		return this.client;
	}

	async acquire(signal?: AbortSignal): Promise<PluginProviderRpcClient> {
		if (signal?.aborted) throw new DOMException("Provider request was aborted", "AbortError");
		if (this.client) return this.client;
		// Collapse concurrent first use into one activation + handshake. Cleared on
		// settle so a failed activation can be retried (the plugin may have been
		// mid-start), rather than latching the error forever.
		this.pending ??= this.createClient().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	/** Forget the cached client so the next acquire re-activates. */
	reset(): void {
		this.client = undefined;
		this.pending = undefined;
	}

	private async createClient(): Promise<PluginProviderRpcClient> {
		const runtime = await this.resolveRuntime(this.pluginId, {
			reason: `onProvider:${this.providerTypeId}`,
		});
		const subscribeNotifications = runtime.onNotification?.bind(runtime);
		const subscribeClose = runtime.onClose?.bind(runtime);
		const transport = new PluginRuntimeProviderTransport(runtime, {
			...(subscribeNotifications ? { subscribeNotifications } : {}),
			...(subscribeClose ? { subscribeClose } : {}),
		});
		const client = new PluginProviderRpcClient({
			transport,
			expectedPluginId: this.pluginId,
			host: { name: this.host.name ?? "narrafork", version: this.host.version ?? "unknown" },
		});
		// `provider.describe` negotiates the provider protocol version and caches the
		// descriptor the RPC client needs; chat/generate/listModels all reject without it.
		await client.describe({});
		this.client = client;
		logger.debug("plugin provider client activated", {
			pluginId: this.pluginId,
			providerTypeId: this.providerTypeId,
		});
		return client;
	}
}

/**
 * One `DeferredProviderClient` per provider instance.
 *
 * Providers are keyed by `providerInstanceId` because that is what carries the
 * package generation: after an upgrade the instance id changes, so the pool
 * naturally stops reusing a client bound to the previous generation's runtime.
 */
export class PluginProviderClientPool {
	private readonly clients = new Map<string, DeferredProviderClient>();

	constructor(
		private readonly resolveRuntime: ProviderRuntimeResolver,
		private readonly host: ProviderClientHost = {},
	) {}

	get(input: {
		pluginId: string;
		providerTypeId: string;
		providerInstanceId: string;
	}): DeferredProviderClient {
		const existing = this.clients.get(input.providerInstanceId);
		if (existing) return existing;
		const created = new DeferredProviderClient(
			input.pluginId,
			input.providerTypeId,
			this.resolveRuntime,
			this.host,
		);
		this.clients.set(input.providerInstanceId, created);
		return created;
	}

	/** Drop cached clients for a plugin, e.g. after it is disabled or upgraded. */
	evictPlugin(pluginId: string): number {
		let removed = 0;
		for (const [instanceId, client] of [...this.clients.entries()]) {
			if (!instanceId.startsWith(`${pluginId}/`)) continue;
			client.reset();
			this.clients.delete(instanceId);
			removed += 1;
		}
		return removed;
	}

	clear(): void {
		for (const client of this.clients.values()) client.reset();
		this.clients.clear();
	}
}
