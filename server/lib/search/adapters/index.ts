/**
 * Search adapter registry — purely data-driven dispatch.
 * Adding a new protocol = one new file exporting `adapter: SearchProtocolAdapter` + one entry here.
 * Zero switch/case anywhere.
 */
import type { CustomSearchProviderConfig } from "../../settings/types";
import type { SearchChannelResult } from "../types";
import { adapter as bochaAdapter } from "./bocha";
import { adapter as customHttpAdapter } from "./custom-http";
import type { AdapterContext, SearchProtocolAdapter, SearchProtocolMeta } from "./shared";
import { adapter as tavilyAdapter } from "./tavily";
import { adapter as unifuncsAdapter } from "./unifuncs";
import { adapter as zhipuAdapter } from "./zhipu";

// ─── All registered adapters (single source of truth) ─────────────────────────

const ALL_ADAPTERS: SearchProtocolAdapter[] = [
	zhipuAdapter,
	tavilyAdapter,
	bochaAdapter,
	unifuncsAdapter,
	customHttpAdapter,
];

/** Map from protocol ID → adapter, built once at import time. */
const ADAPTER_MAP = new Map<string, SearchProtocolAdapter>(ALL_ADAPTERS.map((a) => [a.meta.id, a]));

// ─── Public API ───────────────────────────────────────────────────────────────

/** All supported protocol metadata, ordered for UI display. */
export const PROTOCOL_REGISTRY: SearchProtocolMeta[] = ALL_ADAPTERS.map((a) => a.meta);

/** Get default base URL for a protocol. Falls back to empty string for unknown protocols. */
export function getProtocolDefaultBaseUrl(protocol: string): string {
	return ADAPTER_MAP.get(protocol)?.meta.defaultBaseUrl ?? "";
}

/** Check whether a protocol ID is known to the registry. */
export function isKnownProtocol(protocol: string): boolean {
	return ADAPTER_MAP.has(protocol);
}

/** Check whether a custom search provider has enough config to be usable. */
export function isCustomSearchProviderUsable(
	provider: CustomSearchProviderConfig | undefined,
): boolean {
	if (!provider || provider.disabled) return false;
	const adapter = ADAPTER_MAP.get(provider.protocol);
	if (adapter) return adapter.isUsable(provider);
	// Unknown protocol: best-effort — require at least a base URL
	return !!provider.baseUrl;
}

/** Execute a search through the appropriate protocol adapter. */
export async function executeCustomSearchProvider(
	ctx: AdapterContext,
): Promise<SearchChannelResult> {
	const adapter = ADAPTER_MAP.get(ctx.provider.protocol);
	if (!adapter) {
		throw new Error(`Unknown search protocol: ${ctx.provider.protocol}`);
	}
	return adapter.execute(ctx);
}

export type { AdapterContext, SearchProtocolAdapter, SearchProtocolMeta } from "./shared";
export { renderSearchResults } from "./shared";
