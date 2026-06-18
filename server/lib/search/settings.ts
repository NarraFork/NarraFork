import type {
	CustomSearchProviderConfig,
	NarraForkSettings,
	SearchChannelConfig,
	SearchChannelKind,
	SearchSettings,
} from "../settings/types";

export const SEARCH_NATIVE_CHANNEL_ID = "native";
export const SEARCH_SUBAGENT_CHANNEL_ID = "subagent";
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_SEARCH_MAX_OUTPUT_CHARS = 24_000;

export function nugSearchChannelId(providerId: string): string {
	return `nug:${providerId}`;
}

}

export function customSearchChannelId(providerId: string): string {
	return `custom:${providerId}`;
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

	catalog.push({ id: SEARCH_SUBAGENT_CHANNEL_ID, kind: "subagent", enabled: false, maxTurns: 4 });
	return catalog;
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
			protocol: "narrafork-search-v1",
			baseUrl: provider.baseUrl?.trim() ?? "",
			timeoutMs: sanitizeTimeoutMs(provider.timeoutMs),
			...(Object.keys(normalizedHeaders).length > 0 ? { headers: normalizedHeaders } : {}),
		});
	}
	return result;
}

function mergeChannels(
	settings: NarraForkSettings,
	search: SearchSettings,
	legacyNativeEnabled: boolean | undefined,
): SearchChannelConfig[] {
	const catalog = buildSearchChannelCatalog({ ...settings, search });
	const existing = new Map((search.channels ?? []).map((channel) => [channel.id, channel]));
	const merged: SearchChannelConfig[] = [];

	for (const fallback of catalog) {
		const saved = existing.get(fallback.id);
		const next = saved ? normalizeChannel(saved, fallback) : fallback;
		if (fallback.id === SEARCH_NATIVE_CHANNEL_ID && legacyNativeEnabled === false && !saved) {
			next.enabled = false;
		}
		merged.push(next);
	}

	return merged;
}

function equivalent(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
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

	return !equivalent(before, settings.search);
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
