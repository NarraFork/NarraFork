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
import type { JsonRpcNotification } from "@server/lib/plugins/protocol";
import { PluginProviderRpcClient, PluginRuntimeProviderTransport } from "./plugin-provider-rpc";

/** The runtime surface the provider transport needs. */
export interface ProviderRuntimeLike {
	request<T = unknown>(
		method: string,
		params?: unknown,
		options?: {
			signal?: AbortSignal;
			timeoutMs?: number;
			priority?: "control" | "unary" | "stream";
		},
	): Promise<T>;
	notify(method: string, params?: unknown): Promise<void>;
	quarantine(reason: string): void;
	onNotification?(
		handler: (notification: JsonRpcNotification, bodyBytes?: number) => void,
	): () => void;
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

type ProviderNotificationHandler = (notification: JsonRpcNotification, bodyBytes?: number) => void;
type ProviderClientLookup = () => PluginProviderRpcClient | undefined;

interface ProviderNotificationSubscription {
	lookupClient: ProviderClientLookup;
	handler: ProviderNotificationHandler;
}

/**
 * One notification subscription per shared runtime, with operation-aware fan-out.
 *
 * A runtime can back several provider clients. Valid events are routed only to the client that
 * owns (or recently closed) their operation. Events without a routable operation are sent to one
 * current client so malformed and unknown events still reach `handleNotification` exactly once,
 * rather than being silently discarded or counted as foreign late events by every client.
 */
class SharedProviderNotificationDispatcher {
	private readonly subscriptions = new Set<ProviderNotificationSubscription>();
	private lastSubscription?: ProviderNotificationSubscription;
	private readonly unsubscribeRuntime: () => void;

	constructor(private readonly runtime: ProviderRuntimeLike) {
		this.unsubscribeRuntime =
			runtime.onNotification?.((notification, bodyBytes) => {
				this.dispatch(notification, bodyBytes);
			}) ?? (() => undefined);
	}

	subscribe(lookupClient: ProviderClientLookup, handler: ProviderNotificationHandler): () => void {
		const subscription = { lookupClient, handler };
		this.subscriptions.add(subscription);
		this.lastSubscription = subscription;
		return () => {
			if (!this.subscriptions.delete(subscription)) return;
			if (this.lastSubscription === subscription) {
				this.lastSubscription = [...this.subscriptions].at(-1);
			}
			if (this.subscriptions.size === 0) {
				this.unsubscribeRuntime();
				dispatchers.delete(this.runtime as object);
			}
		};
	}

	private dispatch(notification: JsonRpcNotification, bodyBytes?: number): void {
		if (notification.method !== "provider.event") return;
		const operationId = providerEventOperationId(notification);
		if (operationId) {
			const owners = [...this.subscriptions].filter((subscription) =>
				subscription.lookupClient()?.acceptsOperationNotification(operationId),
			);
			if (owners.length > 0) {
				for (const owner of owners) owner.handler(notification, bodyBytes);
				return;
			}
		}
		// There is no safe operation-based owner for malformed/unknown events. Use one active
		// subscription as the runtime-level protocol sink instead of broadcasting it to every client.
		this.lastSubscription?.handler(notification, bodyBytes);
	}
}

const dispatchers = new WeakMap<object, SharedProviderNotificationDispatcher>();

function sharedProviderNotificationDispatcher(
	runtime: ProviderRuntimeLike,
): SharedProviderNotificationDispatcher {
	const key = runtime as object;
	const existing = dispatchers.get(key);
	if (existing) return existing;
	const created = new SharedProviderNotificationDispatcher(runtime);
	dispatchers.set(key, created);
	return created;
}

function providerEventOperationId(notification: JsonRpcNotification): string | undefined {
	const params = notification.params;
	if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
	const operationId = (params as Record<string, unknown>).operationId;
	return typeof operationId === "string" && operationId.length > 0 ? operationId : undefined;
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
	private releaseClient?: () => void;
	private generation = 0;

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
		if (!this.pending) {
			const pending = this.createClient(++this.generation).finally(() => {
				if (this.pending === pending) this.pending = undefined;
			});
			this.pending = pending;
		}
		return this.pending;
	}

	/** Release the cached or activating client so the next acquire re-activates. */
	reset(): void {
		this.generation += 1;
		this.client = undefined;
		this.pending = undefined;
		const release = this.releaseClient;
		this.releaseClient = undefined;
		release?.();
	}

	private async createClient(generation: number): Promise<PluginProviderRpcClient> {
		const runtime = await this.resolveRuntime(this.pluginId, {
			reason: `onProvider:${this.providerTypeId}`,
		});
		if (generation !== this.generation) {
			throw new Error("Provider client activation was reset");
		}
		const subscribeClose = runtime.onClose?.bind(runtime);
		let client: PluginProviderRpcClient | undefined;
		const dispatcher = runtime.onNotification
			? sharedProviderNotificationDispatcher(runtime)
			: undefined;
		const subscribeNotifications = dispatcher
			? (handler: ProviderNotificationHandler) => dispatcher.subscribe(() => client, handler)
			: undefined;
		const transport = new PluginRuntimeProviderTransport(runtime, {
			...(subscribeNotifications ? { subscribeNotifications } : {}),
			...(subscribeClose ? { subscribeClose } : {}),
		});
		const createdClient = new PluginProviderRpcClient({
			transport,
			expectedPluginId: this.pluginId,
			host: { name: this.host.name ?? "narrafork", version: this.host.version ?? "unknown" },
		});
		client = createdClient;
		let runtimeClosed = false;
		let released = false;
		let unsubscribeRuntimeClose: (() => void) | undefined;
		const release = () => {
			if (released) return;
			released = true;
			unsubscribeRuntimeClose?.();
			// dispose detaches subscriptions synchronously, including notifications retained
			// by PluginRuntime across restarts of the same runtime object.
			void createdClient.dispose().catch((error: unknown) => {
				logger.warn("plugin provider client disposal failed", { pluginId: this.pluginId, error });
			});
		};

		// Track the client before describe settles: reset/close must also release a pending
		// activation. A stale close or handshake must never clear its replacement.
		this.releaseClient = release;
		try {
			unsubscribeRuntimeClose = runtime.onClose?.(() => {
				runtimeClosed = true;
				release();
				if (generation === this.generation) this.reset();
			});
			// `provider.describe` negotiates and caches the protocol required by all calls.
			await createdClient.describe({});
			if (runtimeClosed) throw new Error("Provider runtime closed during activation");
			if (generation !== this.generation) {
				throw new Error("Provider client activation was reset");
			}
			this.client = createdClient;
			logger.debug("plugin provider client activated", {
				pluginId: this.pluginId,
				providerTypeId: this.providerTypeId,
			});
			return createdClient;
		} catch (error) {
			release();
			if (this.releaseClient === release) this.releaseClient = undefined;
			throw error;
		}
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
