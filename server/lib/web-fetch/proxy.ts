// WebFetch proxy resolution — delegates to the unified outbound proxy resolver.

import { getOutboundProxy, resolveProxyForUrl } from "../net/proxy";

/**
 * Resolve the proxy URL for WebFetch based on the global outbound proxy policy.
 * Kept as a thin wrapper for backward compatibility with existing callers.
 */
export function getWebFetchProxy(): string | undefined {
	return getOutboundProxy();
}

/** Resolve the proxy for a specific target URL (applies loopback/NO_PROXY exemptions). */
export function getWebFetchProxyForUrl(target: string | URL): string | undefined {
	return resolveProxyForUrl(target);
}
