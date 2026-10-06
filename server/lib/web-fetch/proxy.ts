// WebFetch proxy resolution — honours the WebFetch proxy override
// (absent/"default" → global outbound proxy policy).

import { resolveOverride, resolveProxyForUrl } from "../net/proxy";
import { settings } from "../settings";

/** The WebFetch proxy override (undefined = follow global policy). */
function webFetchProxyOverride() {
	return settings.agent.webFetchPolicy?.proxy;
}

/**
 * Resolve the proxy URL for WebFetch, honouring the WebFetch proxy
 * override. Used for isolated WebFetch browser-rendering contexts.
 */
export function getWebFetchProxy(): string | undefined {
	return resolveOverride(webFetchProxyOverride());
}

/** Browser sessions resolve independently from WebFetch. */
export function getBrowserProxy(): string | undefined {
	return resolveOverride(settings.agent.browserProxy);
}

/** Resolve the proxy for a specific target URL (applies loopback/NO_PROXY exemptions). */
export function getWebFetchProxyForUrl(target: string | URL): string | undefined {
	return resolveProxyForUrl(target, webFetchProxyOverride());
}
