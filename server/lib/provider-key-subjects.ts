/**
 * The connection each key of a custom API provider is used through: the provider's
 * config with that key's secret and network identity. Usage caches (Kimi, OpenCode Go)
 * keep one entry per subject; a provider without stored keys is its own subject.
 */
import { getProviderKeyStore, isCustomApiKeyOwner, withProviderKey } from "./provider-keys";
import { type CustomApiProviderConfig, settings } from "./settings";

export interface UsageSubject {
	/** The key's id (a migrated first key carries the provider's id). */
	id: string;
	providerId: string;
	config: CustomApiProviderConfig;
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
