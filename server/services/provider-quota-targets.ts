import { selectProviderKey } from "@server/lib/agent/pooled-provider";
import {
	getProviderKeyStore,
	isCustomApiKeyOwner,
	type ProviderKey,
	withProviderKey,
} from "@server/lib/provider-keys";
import { type CustomApiProviderConfig, settings } from "@server/lib/settings";
import { getHttpUserAgent } from "@server/lib/user-agent";
import { type CustomApiQuotaTarget, customApiQuotaTargetId } from "@shared/provider-quota";
import {
	projectQuotaSettings,
	quotaSettingsGeneration,
} from "./provider-quota-settings-projection";
import { hasSiteQuotaConfig, resolveSiteQuotaConfig, siteQuotaRoot } from "./provider-quota-sites";

export interface CustomApiQuotaConnection {
	target: CustomApiQuotaTarget;
	/** Host-private subject key; one underlying entry even when a provider view aliases it. */
	cacheId?: string;
	/** Private, never put on the wire, in logs or on disk. */
	identity: string;
	config: CustomApiProviderConfig;
	valid: boolean;
}
type QuotaKeyStore = Pick<ReturnType<typeof getProviderKeyStore>, "readable" | "list" | "get">;
export interface CustomApiQuotaTargetDirectoryOptions {
	providers: () => readonly CustomApiProviderConfig[];
	globalProxy: () => unknown;
	userAgent?: () => string;
	settingsGeneration?: (providerId: string) => string;
	keyStore?: () => QuotaKeyStore;
	selectKey?: (providerId: string) => ProviderKey | undefined;
}
function normalizedBaseUrl(baseUrl: string): string | null {
	if (!baseUrl || baseUrl.length > 2048 || /[\s\\?#]/u.test(baseUrl)) return null;
	try {
		const url = new URL(baseUrl);
		return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

/** Only saved Custom API connections and their own keys. No platform, NUG or plugin vault. */
export class CustomApiQuotaTargetDirectory {
	private readonly entries = new Map<string, CustomApiQuotaConnection>();
	private readonly aliases = new Map<string, string>();
	private readonly listeners = new Set<(ids: readonly string[]) => void>();
	constructor(private readonly options: CustomApiQuotaTargetDirectoryOptions) {}
	private store(): QuotaKeyStore {
		return this.options.keyStore?.() ?? getProviderKeyStore();
	}
	private provider(id: string): CustomApiProviderConfig | undefined {
		return this.options.providers().find((config) => config.id === id && !config.disabled);
	}
	private storedKeys(config: CustomApiProviderConfig): ProviderKey[] {
		if (!isCustomApiKeyOwner(config.id)) return [];
		const store = this.store();
		return store.readable ? [...store.list(config.id)] : [];
	}
	private selectedKey(
		config: CustomApiProviderConfig,
		keys: readonly ProviderKey[],
	): ProviderKey | undefined {
		if (!keys.length) return undefined;
		const selected = this.options.selectKey
			? this.options.selectKey(config.id)
			: this.options.keyStore
				? keys.find((key) => !key.disabled)
				: selectProviderKey(config.id);
		return (
			selected &&
			keys.find((key) => key.id === selected.id && key.providerId === config.id && !key.disabled)
		);
	}
	private identity(config: CustomApiProviderConfig, keyId?: string): string {
		return JSON.stringify([
			"custom-api",
			config.id,
			keyId,
			config.baseUrl,
			config.apiKey,
			config.protocol,
			config.proxy,
			config.tlsRejectUnauthorized,
			config.userAgentMode,
			config.customUserAgent,
			Object.entries(config.extraHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
			config.quotaSiteUrl,
			config.quotaAccessToken,
			config.quotaUserId,
			this.options.globalProxy(),
			this.options.userAgent?.() ?? getHttpUserAgent(),
			this.options.settingsGeneration?.(config.id),
		]);
	}
	private reconcile(
		cacheId: string,
		config: CustomApiProviderConfig,
		keyId?: string,
		unavailable = false,
	): boolean {
		const identity = this.identity(config, keyId);
		const old = this.entries.get(cacheId);
		if (old?.identity === identity) {
			old.target.prefix = config.prefix;
			return false;
		}
		const baseUrl = normalizedBaseUrl(config.baseUrl);
		const site = hasSiteQuotaConfig(config);
		let valid = baseUrl !== null && Boolean(config.apiKey?.trim());
		if (site) {
			try {
				resolveSiteQuotaConfig(config);
				valid = true;
			} catch {
				valid = false;
			}
		}
		this.entries.set(cacheId, {
			cacheId,
			target: {
				kind: "custom-api",
				id: customApiQuotaTargetId(config.id, keyId),
				providerId: config.id,
				...(keyId ? { keyId } : {}),
				generation: crypto.randomUUID(),
				baseUrl: baseUrl ?? "invalid",
				prefix: config.prefix,
				protocol: config.protocol,
				...(site ? { siteQuota: { root: siteQuotaRoot(config) } } : {}),
			},
			identity,
			config: structuredClone(config),
			valid: valid && !unavailable && isCustomApiKeyOwner(config.id),
		});
		return true;
	}
	private primary(
		config: CustomApiProviderConfig,
		keys: readonly ProviderKey[],
	): { cacheId: string; config: CustomApiProviderConfig; keyId?: string; unavailable?: boolean } {
		const chosen = this.selectedKey(config, keys);
		// Site-account credit authenticates independently from the inference pool's availability.
		if (hasSiteQuotaConfig(config))
			return { cacheId: config.id, config: chosen ? withProviderKey(config, chosen) : config };
		if (keys.length && !chosen)
			return {
				cacheId: `unavailable/${config.id}`,
				config: { ...config, apiKey: "" },
				unavailable: true,
			};
		if (!chosen) return { cacheId: config.id, config };
		return {
			cacheId: `key/${chosen.id}`,
			keyId: chosen.id,
			config: withProviderKey(config, chosen),
		};
	}
	private notify(ids: readonly string[]): void {
		if (ids.length) for (const listener of this.listeners) listener(ids);
	}
	sync(): void {
		const seen = new Set<string>();
		const providers = new Set<string>();
		const changed = new Set<string>();
		for (const config of this.options.providers()) {
			if (config.disabled || !config.id || providers.has(config.id)) continue;
			providers.add(config.id);
			const keys = this.storedKeys(config);
			// Site credit has one account subject; individual key allowance is a different question.
			if (!hasSiteQuotaConfig(config))
				for (const key of keys) {
					if (key.disabled || key.providerId !== config.id) continue;
					const cacheId = `key/${key.id}`;
					seen.add(cacheId);
					if (this.reconcile(cacheId, withProviderKey(config, key), key.id)) changed.add(config.id);
				}
			const primary = this.primary(config, keys);
			seen.add(primary.cacheId);
			if (this.reconcile(primary.cacheId, primary.config, primary.keyId, primary.unavailable))
				changed.add(config.id);
			if (this.aliases.get(config.id) !== primary.cacheId) changed.add(config.id);
			this.aliases.set(config.id, primary.cacheId);
		}
		for (const [cacheId, connection] of this.entries) {
			if (seen.has(cacheId)) continue;
			this.entries.delete(cacheId);
			changed.add(connection.target.providerId);
		}
		for (const id of this.aliases.keys()) if (!providers.has(id)) this.aliases.delete(id);
		this.notify([...changed]);
	}
	get(providerId: string): CustomApiQuotaConnection | undefined {
		const config = this.provider(providerId);
		if (!config) return undefined;
		const primary = this.primary(config, this.storedKeys(config));
		const changed =
			this.reconcile(primary.cacheId, primary.config, primary.keyId, primary.unavailable) ||
			this.aliases.get(providerId) !== primary.cacheId;
		this.aliases.set(providerId, primary.cacheId);
		if (changed) this.notify([providerId]);
		return this.entries.get(primary.cacheId);
	}
	getKey(keyId: string): CustomApiQuotaConnection | undefined {
		if (!isCustomApiKeyOwner(keyId)) return undefined;
		const store = this.store();
		const key = store.readable ? store.get(keyId) : undefined;
		if (key && !isCustomApiKeyOwner(key.providerId)) return undefined;
		if (key) {
			const config = this.provider(key.providerId);
			if (!config || key.disabled || hasSiteQuotaConfig(config)) return undefined;
			const cacheId = `key/${key.id}`;
			if (this.reconcile(cacheId, withProviderKey(config, key), key.id))
				this.notify([key.providerId]);
			return this.entries.get(cacheId);
		}
		const legacy = this.provider(keyId);
		return legacy && !this.storedKeys(legacy).length && !hasSiteQuotaConfig(legacy)
			? this.get(keyId)
			: undefined;
	}
	getTarget(target: CustomApiQuotaTarget): CustomApiQuotaConnection | undefined {
		const connection = target.keyId ? this.getKey(target.keyId) : this.get(target.providerId);
		return connection?.target.providerId === target.providerId && connection.target.id === target.id
			? connection
			: undefined;
	}
	/** No selection or mutation: key-pool probes must not recurse into key selection. */
	isKeyIdentityCurrent(keyId: string, connection: CustomApiQuotaConnection): boolean {
		const config = this.provider(connection.target.providerId);
		if (!config || hasSiteQuotaConfig(config)) return false;
		if (!connection.target.keyId)
			return (
				config.id === keyId &&
				!this.storedKeys(config).length &&
				this.identity(config) === connection.identity
			);
		const store = this.store();
		const key = store.readable ? store.get(keyId) : undefined;
		return (
			!!key &&
			!key.disabled &&
			key.providerId === config.id &&
			this.identity(withProviderKey(config, key), key.id) === connection.identity
		);
	}
	/** Already reconciled by list(); no second selection while publishing a page. */
	primaryEntries(): readonly { providerId: string; cacheId: string }[] {
		return [...this.aliases].map(([providerId, cacheId]) => ({ providerId, cacheId }));
	}
	list(): readonly CustomApiQuotaConnection[] {
		this.sync();
		return [...this.entries.values()];
	}
	onChanged(listener: (ids: readonly string[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
export const customApiQuotaTargets = new CustomApiQuotaTargetDirectory({
	providers: () => (settings.customApiProviders ?? []).map(projectQuotaSettings),
	settingsGeneration: quotaSettingsGeneration,
	globalProxy: () => settings.proxy,
});
