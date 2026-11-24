/**
 * The connection each key of a custom API provider is used through: the provider's
 * config with that key's secret and network identity. Usage caches (Kimi, OpenCode Go)
 * keep one entry per subject; a provider without stored keys is its own subject.
 */
import { getProviderKeyStore, peekProviderKeyStore, withProviderKey } from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";
import { quotaNetworkIdentity } from "./sourcing/quota-identity";

export interface UsageSubject<TConfig = CustomApiProviderConfig> {
	/** The key's id (a migrated first key carries the provider's id). */
	id: string;
	providerId: string;
	config: TConfig;
}

/** Resolve an actual stream credential from memory; an explicit unknown id never picks first. */
export function streamQuotaCredential<T extends { id: string; apiKey: string }>(
	config: T,
	credentialId?: string,
): UsageSubject<T> | undefined {
	const keys = peekProviderKeyStore()?.listGroup(config.id) ?? [];
	let key = credentialId === undefined ? keys[0] : keys.find((key) => key.id === credentialId);
	// Direct adapters report the connection id for the one plain credential they use.
	// Stored ids may differ after imports; this alias must not admit an arbitrary pool id.
	if (!key && credentialId === config.id) {
		const usable = keys.filter((candidate) => !candidate.disabled && !!candidate.apiKey);
		if (usable.length === 1 && usable[0]?.apiKey === config.apiKey && !usable[0]?.network) {
			key = usable[0];
		}
	}
	if (key) {
		return key.disabled
			? undefined
			: { id: key.id, providerId: config.id, config: withProviderKey(config, key) };
	}
	// Legacy non-pooled providers report their connection id rather than a stored key id.
	if (keys.length || (credentialId !== undefined && credentialId !== config.id)) return undefined;
	return { id: config.id, providerId: config.id, config };
}

/** Request-attempt identity for stream balances; kept internal and never broadcast. */
export function streamQuotaIdentity(
	config: { id: string; baseUrl: string; apiKey: string },
	credentialId?: string,
): string | undefined {
	const credential = streamQuotaCredential(config, credentialId);
	if (!credential) return undefined;
	return JSON.stringify([
		config.id,
		config.baseUrl,
		credential.id,
		credential.config.apiKey,
		quotaNetworkIdentity(credential.config, settings.proxy),
	]);
}

export function streamQuotaIdentityForPrefix(
	prefix: string,
	credentialId?: string,
): string | undefined {
	const custom = (settings.customApiProviders ?? []).find((provider) => provider.prefix === prefix);
	if (custom) return streamQuotaIdentity(custom, credentialId);
	const nug = (settings.nugProviders ?? []).find(
		(provider) => provider.prefix === prefix || provider.id === prefix,
	);
	return nug ? streamQuotaIdentity(nug, credentialId) : undefined;
}

export function usageSubjects(
	belongs: (provider: CustomApiProviderConfig) => boolean,
): UsageSubject[] {
	const store = getProviderKeyStore();
	return (settings.customApiProviders ?? []).filter(belongs).flatMap((provider) => {
		const keys = store.list(provider.id).filter((key) => !key.disabled);
		if (keys.length === 0) {
			return provider.apiKey
				? [{ id: provider.id, providerId: provider.id, config: provider }]
				: [];
		}
		return keys.map((key) => ({
			id: key.id,
			providerId: provider.id,
			config: withProviderKey(provider, key),
		}));
	});
}

/** The subject a provider-level view (status bar, quota wait) reports: its first usable key. */
export function shownSubjectId(subjects: readonly UsageSubject[], providerId: string) {
	return subjects.find((subject) => subject.providerId === providerId)?.id;
}

/**
 * The credential a provider-level quota (DeepSeek balance) is kept under: the provider's
 * first stored key, which is the one settings shows, with its own network applied; the
 * provider itself without stored keys.
 */
export function firstCredential(provider: CustomApiProviderConfig): UsageSubject {
	const key = getProviderKeyStore().list(provider.id)[0];
	return key
		? { id: key.id, providerId: provider.id, config: withProviderKey(provider, key) }
		: { id: provider.id, providerId: provider.id, config: provider };
}
