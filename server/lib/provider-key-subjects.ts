/** Effective credentials shared by usage caches and request-time stream attribution. */
import {
	getProviderKeyStore,
	isCustomApiKeyOwner,
	nugKeyOwner,
	peekProviderKeyStore,
	withProviderKey,
} from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";
import { quotaNetworkIdentity } from "./sourcing/quota-identity";

export interface UsageSubject<TConfig = CustomApiProviderConfig> {
	/** The key's id (a migrated first key carries the provider's id). */
	id: string;
	providerId: string;
	config: TConfig;
}

/** Resolve a reported key; an unknown or ambiguous attempt never borrows the first key. */
function streamQuotaCredential<T extends { id: string; apiKey: string }>(
	config: T,
	credentialId?: string,
	owner = config.id,
): UsageSubject<T> | undefined {
	const keys = peekProviderKeyStore()?.list(owner) ?? [];
	const key = keys.find((entry) => entry.id === credentialId);
	if (key) {
		return key.disabled
			? undefined
			: { id: key.id, providerId: config.id, config: withProviderKey(config, key) };
	}
	if (credentialId !== undefined && credentialId !== config.id) return undefined;
	if (!keys.length) return { id: config.id, providerId: config.id, config };
	// A plain single-key adapter reports its connection id, without a per-key override.
	const first = keys[0];
	if (
		first &&
		!first.disabled &&
		!first.network &&
		first.apiKey === config.apiKey &&
		keys.filter((entry) => !entry.disabled && !!entry.apiKey).length === 1
	)
		return { id: first.id, providerId: config.id, config };
	return undefined;
}

/** Internal attempt identity: the exact credential and transport, never a public generation. */
export function streamQuotaIdentity(
	config: { id: string; baseUrl: string; apiKey: string; protocol?: string },
	credentialId = config.id,
): string {
	return JSON.stringify([
		config.id,
		config.baseUrl,
		config.protocol,
		credentialId,
		config.apiKey,
		quotaNetworkIdentity(config, settings.proxy),
	]);
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
	const subject = streamQuotaCredential(
		config,
		credentialId,
		custom ? config.id : nugKeyOwner(config.id),
	);
	return subject ? streamQuotaIdentity(subject.config, subject.id) : undefined;
}

/** Reject a prepared transport that outlived an edit before capturing its attempt. */
export function streamQuotaIdentityForRequest(
	prefix: string,
	info?: { credentialId?: string; validateDiagnosticCredential?: () => boolean },
): string | undefined {
	return info?.validateDiagnosticCredential?.() === false
		? undefined
		: streamQuotaIdentityForPrefix(prefix, info?.credentialId);
}

/** Validate the captured attempt, not whichever key happens to be first when it finishes. */
export function credentialForStream<T extends { id: string; baseUrl: string; apiKey: string }>(
	config: T,
	expectedIdentity: string | undefined,
	owner = config.id,
): UsageSubject<T> | undefined {
	if (!expectedIdentity) return undefined;
	for (const key of peekProviderKeyStore()?.list(owner) ?? []) {
		const selected = withProviderKey(config, key);
		if (!key.disabled && streamQuotaIdentity(selected, key.id) === expectedIdentity) {
			return { id: key.id, providerId: config.id, config: selected };
		}
	}
	const plain = streamQuotaCredential(config, config.id, owner);
	return plain && streamQuotaIdentity(plain.config) === expectedIdentity ? plain : undefined;
}

export function usageSubjects(
	belongs: (provider: CustomApiProviderConfig) => boolean,
): UsageSubject[] {
	const store = getProviderKeyStore();
	return (settings.customApiProviders ?? [])
		.filter((provider) => isCustomApiKeyOwner(provider.id) && belongs(provider))
		.flatMap((provider) => {
			const stored = store.readable ? store.list(provider.id) : [];
			if (!stored.length)
				return provider.apiKey
					? [{ id: provider.id, providerId: provider.id, config: provider }]
					: [];
			// Existing but disabled keys must never fall back to the settings projection of that key.
			return stored
				.filter((key) => !key.disabled)
				.map((key) => ({
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
