/**
 * settings.json ↔ provider-keys.json.
 *
 * On disk, custom API providers carry no `apiKey`; their keys live in the provider key
 * store. In memory each provider's `apiKey` is its first key, so every reader of a single
 * key keeps working and every writer of that field edits the first key. If the key file
 * cannot be read, nothing moves and settings.json keeps its keys as before.
 */
import { getProviderKeyStore } from "../provider-keys";
import { normalizeCustomApiProviderSettings } from "./custom-api-providers";
import type { NarraForkSettings } from "./types";

/** In memory only: each provider's `apiKey` becomes its first stored key. */
export function hydrateProviderKeys(settings: NarraForkSettings): void {
	const store = getProviderKeyStore();
	if (!store.readable) return;
	for (const provider of settings.customApiProviders ?? []) {
		provider.apiKey = store.firstKey(provider.id) ?? "";
	}
	normalizeCustomApiProviderSettings(settings);
}

/**
 * Loading: keys still written in settings.json move into the store. Returns true when
 * settings.json held keys, so the caller rewrites it without them.
 */
export function absorbProviderKeys(settings: NarraForkSettings): boolean {
	const store = getProviderKeyStore();
	const providers = settings.customApiProviders ?? [];
	const hadKeys = providers.some((provider) => !!provider.apiKey?.trim());
	store.syncFirstKeys(providers, { clearOnEmpty: false });
	hydrateProviderKeys(settings);
	return hadKeys && store.readable;
}

/** Saving: the first keys settings now hold are written to the store. */
export function syncProviderKeys(settings: NarraForkSettings): void {
	getProviderKeyStore().syncFirstKeys(settings.customApiProviders ?? [], { clearOnEmpty: true });
}

/** The object written to settings.json: provider entries with their keys blanked. */
export function withoutProviderKeys(settings: NarraForkSettings): NarraForkSettings {
	if (!getProviderKeyStore().readable) return settings;
	const blank = <T extends { apiKey: string }>(list: T[] | undefined) =>
		list?.map((entry) => ({ ...entry, apiKey: "" }));
	return {
		...settings,
		customApiProviders: blank(settings.customApiProviders),
		openaiProviders: blank(settings.openaiProviders),
		anthropicProviders: blank(settings.anthropicProviders),
		geminiProviders: blank(settings.geminiProviders),
	};
}
