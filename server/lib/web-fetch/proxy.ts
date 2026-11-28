// WebFetch proxy resolution — honours the WebFetch proxy override
// (absent/"default" → global outbound proxy policy).

import { resolveOverride, resolveProxyForUrl } from "../net/proxy";
import { settings } from "../settings";

/** The WebFetch proxy override (undefined = follow global policy). */
function webFetchProxyOverride() {
	return settings.agent.webFetchPolicy?.proxy;
}

/** Browser sessions resolve independently from WebFetch (no per-navigation target). */
export function getBrowserProxy(): string | undefined {
	return resolveOverride(settings.agent.browserProxy);
}

/**
 * Resolve the WebFetch proxy for one target URL.
 *
 * WebFetch opens a fresh isolated browser context per navigation, so the target is
 * always known here — which is what lets `settings.proxy.noProxyRules` (wildcard
 * and regex alike) decide that context's proxy, not just Chromium's host-based
 * bypass list. The override is honoured first (absent/"default" → global policy).
 */
export function getWebFetchProxyForUrl(target: string | URL): string | undefined {
	return resolveProxyForUrl(target, webFetchProxyOverride());
}
