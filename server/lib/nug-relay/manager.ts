/**
 * Registry of live NUG relay clients, keyed by NUG provider id.
 *
 * Clients are created lazily by NugProvider construction (idempotent: same
 * config reuses the running client) and torn down when a provider's egress
 * mode returns to "nug" or the provider disappears from settings.
 */
import type { NUGProviderConfig } from "../settings";
import { NugRelayClient, type NugRelayStatus } from "./relay-client";

interface ManagedRelay {
	client: NugRelayClient;
	/** Fingerprint of the config the client was built from; changes restart. */
	signature: string;
}

const managed = new Map<string, ManagedRelay>();

function relaySignature(config: NUGProviderConfig): string {
	return JSON.stringify([config.baseUrl, config.apiKey, config.egressProxyUrl ?? ""]);
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

export function getNugRelayStatus(providerId: string): NugRelayStatus | "disabled" {
	const entry = managed.get(providerId);
	return entry ? entry.client.status : "disabled";
}

/** Test hook: stop every managed relay client. */
export function stopAllNugRelayClients(): void {
	for (const entry of managed.values()) {
		entry.client.stop();
	}
	managed.clear();
}

/**
 * Sync the managed set with the configured providers: ensure clients for
 * egress-enabled providers and stop clients whose provider vanished from
 * settings. Called at startup and after every settings save; NugProvider
 * construction also ensures its own client, so this only needs to cover the
 * gaps (startup before first chat, provider removal).
 */
export function reconcileNugRelayClients(providers: NUGProviderConfig[]): void {
	const wanted = new Set<string>();
	for (const p of providers) {
		if (p.disabled) {
			continue;
		}
		ensureNugRelayClient(p);
		if (usesLocalEgress(p)) {
			wanted.add(p.id);
		}
	}
	for (const [id, entry] of managed) {
		if (!wanted.has(id)) {
			entry.client.stop();
			managed.delete(id);
		}
	}
}
