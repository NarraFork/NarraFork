/**
 * The connection each key of a custom API provider is used through: the provider's
 * config with that key's secret and network identity. Usage caches (Kimi, OpenCode Go)
 * keep one entry per subject; a provider without stored keys is its own subject.
 */
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";

export interface UsageSubject<TConfig = CustomApiProviderConfig> {
	/** The key's id (a migrated first key carries the provider's id). */
	id: string;
	providerId: string;
	config: TConfig;
}

/** Request-time identity for stream balances; kept internal and never broadcast. */
export function streamQuotaIdentity(config: {
	id: string;
	baseUrl: string;
	apiKey: string;
}): string {
	return JSON.stringify([config.id, config.baseUrl, config.apiKey]);
}

export function streamQuotaIdentityForPrefix(
	prefix: string,
	credentialId?: string,
): string | undefined {
	const custom = (settings.customApiProviders ?? []).find((provider) => provider.prefix === prefix);
	const nug =
		!custom &&
		(settings.nugProviders ?? []).find(
			(provider) => provider.prefix === prefix || provider.id === prefix,
		);
	const config = custom || nug;
	if (!config) return undefined;
	const keys = getProviderKeyStore().list(custom ? config.id : nugKeyOwner(config.id));
	const key =
		credentialId === undefined ? keys[0] : keys.find((entry) => entry.id === credentialId);
	if (key && !key.disabled) return streamQuotaIdentity(withProviderKey(config, key));
	// Plain single-key adapters preserve the historical connection id for accounting.
	const first = keys[0];
	if (
		keys.length === 1 &&
		credentialId === config.id &&
		first &&
		!first.disabled &&
		!first.network
	) {
		return streamQuotaIdentity(withProviderKey(config, first));
	}
	return keys.length === 0 ? streamQuotaIdentity(config) : undefined;
}

/** A prepared transport can outlive an edit; never publish its balance under the new identity. */
export function streamQuotaIdentityForRequest(
	prefix: string,
	info?: { credentialId?: string; validateDiagnosticCredential?: () => boolean },
): string | undefined {
	return info?.validateDiagnosticCredential?.() === false
		? undefined
		: streamQuotaIdentityForPrefix(prefix, info?.credentialId);
}

/** Match the exact request identity, not whichever key is first when the stream ends. */
export function credentialForStream<T extends { id: string; baseUrl: string; apiKey: string }>(
	config: T,
	expectedIdentity: string | undefined,
	owner = config.id,
): UsageSubject<T> | undefined {
	const keys = getProviderKeyStore().list(owner);
	for (const key of keys) {
		const selected = withProviderKey(config, key);
		if (!key.disabled && streamQuotaIdentity(selected) === expectedIdentity) {
			return { id: key.id, providerId: config.id, config: selected };
		}
	}
	return keys.length === 0 && streamQuotaIdentity(config) === expectedIdentity
		? { id: config.id, providerId: config.id, config }
		: undefined;
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
