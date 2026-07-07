/**
 * Unified outbound proxy resolver.
 *
 * Cline, NUG, WebFetch, browser) resolve their proxy through this module so a
 * single global policy (`settings.proxy`) controls every outbound request.
 *
 * Note: Bun's `fetch()` does NOT read HTTP(S)_PROXY env vars by default, so the
 * "system" mode reads them manually here and passes the URL to `fetch({ proxy })`.
 */

import { settings } from "../settings";

/**
 * Detect a proxy URL from standard environment variables (case-insensitive).
 * Order: HTTPS_PROXY → HTTP_PROXY → ALL_PROXY.
 */
export function detectSystemProxy(): string | undefined {
	return (
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy ||
		process.env.ALL_PROXY ||
		process.env.all_proxy ||
		undefined
	);
}

/**
 * Resolve the global outbound proxy URL (ignoring per-target exemptions).
 * - "direct" → undefined (no proxy)
 * - "system" → read HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars
 * - "custom" → the user-specified URL
 *
 * Default behaviour (when no proxy config exists) is "system".
 */
export function getOutboundProxy(): string | undefined {
	const cfg = settings.proxy;
	const mode = cfg?.mode ?? "system";

	switch (mode) {
		case "direct":
			return undefined;
		case "custom":
			return cfg?.url || undefined;
		default:
			return detectSystemProxy();
	}
}

/** Hostnames that always bypass the proxy (loopback / this-host). */
function isLoopbackHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h === "::1" || h === "0.0.0.0") return true;
	// IPv4 loopback range 127.0.0.0/8
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	return false;
}

/** Read the NO_PROXY / no_proxy env var into a normalized entry list. */
function getNoProxyEntries(): string[] {
	const raw = process.env.NO_PROXY || process.env.no_proxy || "";
	return raw
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Whether a hostname matches a NO_PROXY entry.
 * Supports exact match, leading-dot / suffix match, and "*" wildcard-all.
 */
function matchesNoProxy(hostname: string, entries: string[]): boolean {
	if (entries.length === 0) return false;
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	for (const entry of entries) {
		if (entry === "*") return true;
		const bare = entry.replace(/^\./, "");
		if (host === bare) return true;
		if (host.endsWith(`.${bare}`)) return true;
	}
	return false;
}

/**
 * Resolve the proxy URL for a specific target URL, applying loopback and
 * NO_PROXY exemptions. Returns undefined when the target should be reached
 * directly (no proxy). Use this in every per-request proxy-aware fetch so
 * local gateways (NUG/Cline/local compatible providers) are never proxied.
 */
export function resolveProxyForUrl(target: string | URL): string | undefined {
	const proxy = getOutboundProxy();
	if (!proxy) return undefined;

	let hostname: string;
	try {
		hostname = typeof target === "string" ? new URL(target).hostname : target.hostname;
	} catch {
		// Unparseable target — fall back to the global proxy.
		return proxy;
	}

	if (isLoopbackHost(hostname)) return undefined;
	if (matchesNoProxy(hostname, getNoProxyEntries())) return undefined;
	return proxy;
}
