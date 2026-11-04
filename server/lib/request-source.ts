import { getProviderKeyStore } from "./provider-keys";
import { settings } from "./settings";

/** Singleton built-in sources: the prefix is the only identity they have. */
const SINGLETON_SOURCES: Readonly<Record<string, string>> = {
	tokendance: "TokenDance",
	CommandCode: "Command Code",
};

function apiConnections() {
	return [
		...(settings.openaiProviders ?? []),
		...(settings.anthropicProviders ?? []),
		...(settings.nugProviders ?? []),
		...(settings.geminiProviders ?? []),
	];
}

/**
 * The source a request is attributed to when the adapter did not name a credential.
 * Pooled providers (Codex accounts, plugins) always report their own credential; an API
 * connection holds exactly one key, so its stable connection id is the source and
 * survives prefix renames. Unknown prefixes stay unattributed rather than guessed.
 */
export function defaultRequestSourceId(provider: string | null | undefined): string | null {
	if (!provider) return null;
	if (provider in SINGLETON_SOURCES) return provider;
	return apiConnections().find((connection) => connection.prefix === provider)?.id ?? null;
}

/**
 * Display name of a non-Codex source id, including disabled connections. A provider's
 * extra keys read "Provider · label"; its first key carries the provider's own id.
 */
export function requestSourceName(sourceId: string): string | undefined {
	const named = (id: string) => apiConnections().find((connection) => connection.id === id)?.name;
	const singleton = SINGLETON_SOURCES[sourceId] ?? named(sourceId);
	if (singleton) return singleton;
	const key = getProviderKeyStore().get(sourceId);
	if (!key) return undefined;
	const provider = named(key.providerId) ?? key.providerId;
	return `${provider} · ${key.label ?? `…${key.apiKey.slice(-4)}`}`;
}
