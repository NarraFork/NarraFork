import type {
	CustomSearchProviderConfig,
	NarraForkSettings,
	SearchChannelConfig,
	SearchChannelKind,
	SearchSettings,
} from "../settings/types";
import { getProtocolDefaultBaseUrl, isKnownProtocol } from "./adapters/index";
import { areExtraSearchChannelsReady, listExtraSearchChannels } from "./plugin-source";

export const SEARCH_NATIVE_CHANNEL_ID = "native";
export const SEARCH_SUBAGENT_CHANNEL_ID = "subagent";
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_SEARCH_MAX_OUTPUT_CHARS = 24_000;

export function nugSearchChannelId(providerId: string): string {
	return `nug:${providerId}`;
}

export function customSearchChannelId(providerId: string): string {
	return `custom:${providerId}`;
}

/**
 * Channel id for a plugin's search contribution.
 *
 * Both halves are needed: the contribution id is only unique within its plugin. Nothing
 * parses this back apart — the owning source resolves ids through its own registry — so the
 * colon in a plugin id is harmless here.
 */
export function pluginSearchChannelId(pluginId: string, contributionId: string): string {
	return `plugin:${pluginId}:${contributionId}`;
}

function sanitizeTimeoutMs(value: number | undefined): number | undefined {
	if (!Number.isFinite(value) || value == null) return undefined;
	return Math.min(Math.max(Math.trunc(value), 1_000), 300_000);
}

function sanitizeMaxTurns(value: number | undefined): number | undefined {
	if (!Number.isFinite(value) || value == null) return undefined;
	return Math.min(Math.max(Math.trunc(value), 1), 10);
}

function normalizeChannel(
	input: SearchChannelConfig,
	fallback: SearchChannelConfig,
): SearchChannelConfig {
	return {
		...fallback,
		...input,
		id: fallback.id,
		kind: fallback.kind,
		providerId: fallback.providerId,
		enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
		timeoutMs: sanitizeTimeoutMs(input.timeoutMs),
		maxTurns: sanitizeMaxTurns(input.maxTurns),
	};
}

function makeBaseChannel(
	id: string,
	kind: SearchChannelKind,
	enabled: boolean,
	providerId?: string,
): SearchChannelConfig {
	return { id, kind, enabled, ...(providerId ? { providerId } : {}) };
}

export function buildSearchChannelCatalog(settings: NarraForkSettings): SearchChannelConfig[] {
	const catalog: SearchChannelConfig[] = [
		makeBaseChannel(SEARCH_NATIVE_CHANNEL_ID, "native", true),
	];

	for (const provider of settings.nugProviders ?? []) {
		catalog.push(makeBaseChannel(nugSearchChannelId(provider.id), "nug-mcp", true, provider.id));
	}
	for (const provider of settings.search?.customProviders ?? []) {
		catalog.push(
			makeBaseChannel(
				customSearchChannelId(provider.id),
				"custom-api",
				!provider.disabled,
				provider.id,
			),
		);
	}
	// Plugin-contributed channels. `listExtraSearchChannels()` is a synchronous registry read
	// (see `plugin-source.ts`), which matters because this function is on a hot path. A plugin
	// that is uninstalled stops appearing here, but its saved entry is NOT dropped for that
	// reason alone — see `mergeChannels` for why absence from the catalog cannot mean removal.
	for (const channel of listExtraSearchChannels()) {
		catalog.push(makeBaseChannel(channel.id, "plugin", true));
	}

	catalog.push({ id: SEARCH_SUBAGENT_CHANNEL_ID, kind: "subagent", enabled: false, maxTurns: 4 });
	return catalog;
}

function normalizeCustomSearchProviderProtocol(
	protocol: unknown,
): CustomSearchProviderConfig["protocol"] {
	// Accept any string that the registry knows; fall back to "zhipu-web-search-v1" for legacy configs
	if (typeof protocol === "string" && isKnownProtocol(protocol)) return protocol;
	return "zhipu-web-search-v1";
}

function normalizeCustomSearchProviders(
	providers: CustomSearchProviderConfig[] | undefined,
): CustomSearchProviderConfig[] {
	const seen = new Set<string>();
	const result: CustomSearchProviderConfig[] = [];
	for (const provider of providers ?? []) {
		const id = String(provider.id || "").trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const protocol = normalizeCustomSearchProviderProtocol(provider.protocol);
		const normalizedHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(provider.headers ?? {})) {
			const header = key.trim();
			if (!header) continue;
			normalizedHeaders[header] = String(value);
		}
		result.push({
			...provider,
			id,
			name: provider.name?.trim() || id,
			protocol,
			baseUrl: provider.baseUrl?.trim() || getProtocolDefaultBaseUrl(protocol),
			timeoutMs: sanitizeTimeoutMs(provider.timeoutMs),
			...(Object.keys(normalizedHeaders).length > 0 ? { headers: normalizedHeaders } : {}),
		});
	}
	return result;
}

/**
 * Merge saved channel configs with the catalog of currently available channels.
 *
 * Channel order is user-configurable (it decides the fallback chain, and native
 * search only applies when it is first), so the saved order must win. The
 * catalog only supplies defaults for unseen channels and drops channels whose
 * provider no longer exists; new catalog entries are appended in catalog order.
 */
function mergeChannels(
	settings: NarraForkSettings,
	search: SearchSettings,
	legacyNativeEnabled: boolean | undefined,
): SearchChannelConfig[] {
	const catalog = buildSearchChannelCatalog({ ...settings, search });
	const fallbacks = new Map(catalog.map((channel) => [channel.id, channel]));
	const merged: SearchChannelConfig[] = [];
	const consumed = new Set<string>();

	for (const saved of search.channels ?? []) {
		if (consumed.has(saved.id)) continue;
		const fallback = fallbacks.get(saved.id);
		if (!fallback) {
			// A built-in channel's provider lives in this same settings document, so its absence
			// from the catalog is authoritative: the provider was removed, drop the entry.
			//
			// A plugin channel is only absent-because-removed once the plugin registry has
			// actually loaded. `settings` is built during module load, before the plugin platform
			// registers its source, so at startup every saved plugin channel is missing for a
			// reason that has nothing to do with the plugin. Dropping it there would discard the
			// user's enabled flag and fallback position and — because `normalizeSearchSettings`
			// reports a change — persist that loss to disk.
			if (saved.kind !== "plugin" || areExtraSearchChannelsReady()) continue;
			consumed.add(saved.id);
			// Keep the saved row as its own fallback: no catalog entry exists to supply defaults,
			// and its `kind` is what marks it unavailable until the real registration arrives.
			merged.push(normalizeChannel(saved, { ...saved, kind: "plugin" }));
			continue;
		}
		consumed.add(saved.id);
		merged.push(normalizeChannel(saved, fallback));
	}

	for (const fallback of catalog) {
		if (consumed.has(fallback.id)) continue;
		const next = { ...fallback };
		if (fallback.id === SEARCH_NATIVE_CHANNEL_ID && legacyNativeEnabled === false) {
			next.enabled = false;
		}
		merged.push(next);
	}

	return merged;
}

export function normalizeSearchSettings(
	settings: NarraForkSettings,
	raw?: Record<string, unknown>,
): boolean {
	const before = JSON.stringify(settings.search ?? null);
	const rawSearch = raw?.search;
	const hasRawSearch = !!rawSearch && typeof rawSearch === "object" && !Array.isArray(rawSearch);
	const rawCodex = raw?.codex;
	const legacyNativeEnabled =
		!hasRawSearch &&
		rawCodex &&
		typeof rawCodex === "object" &&
		!Array.isArray(rawCodex) &&
		"useWebSearch" in rawCodex
			? (rawCodex as { useWebSearch?: boolean }).useWebSearch
			: undefined;

	const current = settings.search ?? {
		channels: [],
		customProviders: [],
		defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
		maxOutputChars: DEFAULT_SEARCH_MAX_OUTPUT_CHARS,
	};
	const search: SearchSettings = {
		channels: current.channels ?? [],
		customProviders: normalizeCustomSearchProviders(current.customProviders),
		defaultTimeoutMs: sanitizeTimeoutMs(current.defaultTimeoutMs) ?? DEFAULT_SEARCH_TIMEOUT_MS,
		maxOutputChars:
			Number.isFinite(current.maxOutputChars) && current.maxOutputChars
				? Math.min(Math.max(Math.trunc(current.maxOutputChars), 1_000), 100_000)
				: DEFAULT_SEARCH_MAX_OUTPUT_CHARS,
	};
	search.channels = mergeChannels(settings, search, legacyNativeEnabled);
	settings.search = search;

	const native = search.channels.find((channel) => channel.id === SEARCH_NATIVE_CHANNEL_ID);
	if (settings.codex) {
		settings.codex.useWebSearch = native?.enabled ?? true;
	}

	// `before` is already serialized; compare strings so an unchanged config does
	// not report "changed" (which would trigger a settings save on every load).
	return before !== JSON.stringify(settings.search);
}

export function getNormalizedSearchChannels(settings: NarraForkSettings): SearchChannelConfig[] {
	// normalizeSearchSettings only mutates `search` and `codex.useWebSearch`, and
	// reads (without mutating) the provider lists. Avoid structuredClone of the
	// whole settings object (which carries large provider/API-key trees) — shallow
	// clone and deep-copy only the two fields that get written. This matters
	// because the native-search helpers below are called on every tool execution
	// and every provider request-body build.
	const clone: NarraForkSettings = {
		...settings,
		search: settings.search ? structuredClone(settings.search) : settings.search,
		codex: settings.codex ? { ...settings.codex } : settings.codex,
	};
	normalizeSearchSettings(clone);
	return clone.search?.channels ?? [];
}
