// WebFetch proxy resolution — honours the WebFetch/browser proxy override
// (absent/"default" → global outbound proxy policy).

import { resolveOverride, resolveProxyForUrl } from "../net/proxy";
import { settings } from "../settings";

/** The WebFetch/browser proxy override (undefined = follow global policy). */
function webFetchProxyOverride() {
	return settings.agent.webFetchPolicy?.proxy;
}

/**
 * Resolve the proxy URL for WebFetch/browser, honouring the WebFetch proxy
 * override. Used by the browser pool where a single fixed proxy is applied.
 */
export function getWebFetchProxy(): string | undefined {
	return resolveOverride(webFetchProxyOverride());
}

/** Resolve the proxy for a specific target URL (applies loopback/NO_PROXY exemptions). */
export function getWebFetchProxyForUrl(target: string | URL): string | undefined {
	return resolveProxyForUrl(target, webFetchProxyOverride());
}
