/**
 * Registry of live NUG relay clients, keyed by NUG provider id.
 *
 * Startup and committed settings/key changes reconcile each connection's effective
 * credential. NugProvider construction uses that same idempotent reconciliation;
 * Auto eligibility only reads the live channel registry.
 */
import { logger } from "../logger";
import {
	getProviderKeyStore,
	nugKeyOwner,
	peekProviderKeyStore,
	withProviderKey,
} from "../provider-keys";
import { type NUGProviderConfig, settings, subscribeSettingsChanges } from "../settings";
import { NugRelayClient, type NugRelayStatus } from "./relay-client";

interface ManagedRelay {
	client: NugRelayClient;
	/** Fingerprint of the config the client was built from; changes restart. */
	signature: string;
}

const managed = new Map<string, ManagedRelay>();
let stopOwner: (() => void) | undefined;

function relaySignature(config: NUGProviderConfig): string {
	return JSON.stringify([
		config.baseUrl,
		config.apiKey,
		config.egressMode,
		config.egressProxyUrl ?? "",
	]);
}

export function usesLocalEgress(config: NUGProviderConfig): boolean {
	return config.egressMode === "local-direct" || config.egressMode === "local-proxy";
}

/**
 * Ensure a relay client exists for this provider when its egress mode needs
 * one. Idempotent; restarts the client if the connection-defining config
 * (baseUrl/apiKey/egress proxy) changed, stops it when the mode reverted.
 */
export function ensureNugRelayClient(config: NUGProviderConfig): void {
	const existing = managed.get(config.id);
	if (!usesLocalEgress(config)) {
		if (existing) {
			existing.client.stop();
			managed.delete(config.id);
		}
		return;
	}
	const signature = relaySignature(config);
	if (existing && existing.signature === signature) {
		return;
	}
	existing?.client.stop();
	const client = new NugRelayClient({
		providerId: config.id,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		egressProxyUrl: config.egressMode === "local-proxy" ? config.egressProxyUrl : undefined,
	});
	managed.set(config.id, { client, signature });
	client.start();
}

/** Current relay channel id for header injection; null when not online. */
export function getNugRelayChannelId(providerId: string): string | null {
	const entry = managed.get(providerId);
	if (!entry || entry.client.status !== "online") {
		return null;
	}
	return entry.client.currentChannelId;
}

/** Only the credential and endpoint that own the live channel may send through it. */
export function getNugRelayChannelIdForCredential(config: NUGProviderConfig): string | null {
	const entry = managed.get(config.id);
	return entry?.signature === relaySignature(config) ? getNugRelayChannelId(config.id) : null;
}

export function getNugRelayStatus(providerId: string): NugRelayStatus | "disabled" {
	const entry = managed.get(providerId);
	return entry ? entry.client.status : "disabled";
}

/** Startup owns reconciliation; Auto only reads the resulting in-memory channel registry. */
export function startNugRelayOwner(): void {
	if (stopOwner) return;
	const store = getProviderKeyStore();
	let stopped = false;
	let queued = false;
	const changed = () => {
		if (stopped || queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (stopped) return;
			try {
				reconcileNugRelayClients(settings.nugProviders ?? []);
			} catch (error) {
				logger.warn("NUG relay reconciliation failed", { error: String(error) });
			}
		});
	};
	const stopSettings = subscribeSettingsChanges(changed);
	const stopKeys = store.onChange(changed);
	stopOwner = () => {
		stopped = true;
		stopSettings();
		stopKeys();
	};
	// Key projection writes can precede the settings endpoint commit in the same turn.
	// Reconcile the final pair once, not a new key against an intermediate old endpoint.
	changed();
}

/** Stop relay ownership, including subscriptions and any queued reconciliation, then sockets. */
export function stopAllNugRelayClients(): void {
	stopOwner?.();
	stopOwner = undefined;
	for (const entry of managed.values()) {
		entry.client.stop();
	}
	managed.clear();
}

/** Reconcile one connection against enabled live keys, not its potentially disabled projection. */
export function reconcileNugRelayProvider(config: NUGProviderConfig): boolean {
	const stored = peekProviderKeyStore()?.list(nugKeyOwner(config.id)) ?? [];
	const key = stored.find((candidate) => !candidate.disabled && !!candidate.apiKey.trim());
	const effective = key ? withProviderKey(config, key) : stored.length ? undefined : config;
	if (!config.disabled && usesLocalEgress(config) && effective?.apiKey.trim()) {
		ensureNugRelayClient(effective);
		return true;
	}
	managed.get(config.id)?.client.stop();
	managed.delete(config.id);
	return false;
}

/** Sync the managed set with committed settings and the credential owner's current view. */
export function reconcileNugRelayClients(providers: NUGProviderConfig[]): void {
	const wanted = new Set<string>();
	for (const provider of providers) {
		if (reconcileNugRelayProvider(provider)) wanted.add(provider.id);
	}
	for (const [id, entry] of managed) {
		if (!wanted.has(id)) {
			entry.client.stop();
			managed.delete(id);
		}
	}
}
