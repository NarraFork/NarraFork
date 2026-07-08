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
import type { ProxyOverride } from "../settings/types";

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

/**
 * Resolve a per-location proxy override to a proxy URL (ignoring per-target
 * exemptions). When the override is absent or its mode is "default", falls back
 * to the global outbound proxy policy.
 * - "default" → global policy (getOutboundProxy)
 * - "direct"  → undefined (no proxy)
 * - "system"  → read HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars
 * - "custom"  → the override's url
 */
export function resolveOverride(override?: ProxyOverride): string | undefined {
	const mode = override?.mode ?? "default";
	switch (mode) {
		case "direct":
			return undefined;
		case "system":
			return detectSystemProxy();
		case "custom":
			return override?.url || undefined;
		default:
			return getOutboundProxy();
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
 * Apply loopback and NO_PROXY exemptions to an already-resolved proxy URL for a
 * given target. Returns undefined when the target should be reached directly.
 */
export function applyProxyExemptions(
	proxy: string | undefined,
	target: string | URL,
): string | undefined {
	if (!proxy) return undefined;

	let hostname: string;
	try {
		hostname = typeof target === "string" ? new URL(target).hostname : target.hostname;
	} catch {
		// Unparseable target — fall back to the resolved proxy.
		return proxy;
	}

	if (isLoopbackHost(hostname)) return undefined;
	if (matchesNoProxy(hostname, getNoProxyEntries())) return undefined;
	return proxy;
}

/**
 * Resolve the proxy URL for a specific target URL, applying loopback and
 * NO_PROXY exemptions. An optional per-location override takes precedence over
 * the global policy (absent/"default" → global). Returns undefined when the
 * target should be reached directly (no proxy). Use this in every per-request
 * proxy-aware fetch so local gateways are never proxied.
 */
export function resolveProxyForUrl(
	target: string | URL,
	override?: ProxyOverride,
): string | undefined {
	return applyProxyExemptions(resolveOverride(override), target);
}

/** Whether a proxy URL uses a SOCKS scheme (socks/socks4/socks4a/socks5/socks5h). */
export function isSocksProxy(proxyUrl: string): boolean {
	return /^socks(4a?|5h?)?:\/\//i.test(proxyUrl.trim());
}

/**
 * A node `http.Agent`-compatible proxy agent. Kept loose (`unknown`-ish) because
 * https-proxy-agent and socks-proxy-agent expose slightly different types but
 * both satisfy the `agent` option of ws / axios / node http(s).
 */
export interface ProxyAgentLike {
	destroy?: () => void;
}

/**
 * Create an http(s)-compatible proxy agent for the given proxy URL, choosing the
 * right implementation by scheme: SOCKS URLs use socks-proxy-agent, everything
 * else (http/https) uses https-proxy-agent. Returns undefined for a falsy URL.
 *
 * Use this for libraries that accept a node `http.Agent` (ws, axios, @slack/bolt,
 * node-fetch). For undici-based clients (discord.js REST) use
 * {@link createUndiciProxyDispatcher} instead.
 *
 * Callers that create an agent per connection MUST keep the reference and call
 * `.destroy?.()` on teardown/reconnect to avoid leaking socket pools.
 */
export async function createProxyAgent(
	proxyUrl: string | undefined,
): Promise<ProxyAgentLike | undefined> {
	if (!proxyUrl) return undefined;
	if (isSocksProxy(proxyUrl)) {
		const { SocksProxyAgent } = await import("socks-proxy-agent");
		return new SocksProxyAgent(proxyUrl) as unknown as ProxyAgentLike;
	}
	const { HttpsProxyAgent } = await import("https-proxy-agent");
	return new HttpsProxyAgent(proxyUrl) as unknown as ProxyAgentLike;
}

/** An undici dispatcher whose teardown methods may be absent under Bun's undici shim. */
export interface UndiciDispatcherLike {
	close?: () => Promise<void> | void;
	destroy?: () => Promise<void> | void;
}

/**
 * Create an undici `Dispatcher` (ProxyAgent) for the given proxy URL, for clients
 * built on undici (e.g. discord.js REST). undici's ProxyAgent only supports
 * http/https proxies — for a SOCKS URL this logs a warning and returns undefined
 * (the caller then connects directly rather than crashing). Returns undefined for
 * a falsy URL. Keep the reference and call {@link closeUndiciDispatcher} on
 * teardown to avoid leaks (Bun's undici shim may not expose close/destroy).
 */
export async function createUndiciProxyDispatcher(
	proxyUrl: string | undefined,
): Promise<UndiciDispatcherLike | undefined> {
	if (!proxyUrl) return undefined;
	if (isSocksProxy(proxyUrl)) {
		const { logger } = await import("../logger");
		logger.warn(
			"[proxy] SOCKS proxy is not supported for this channel (undici REST); connecting directly. Use an http(s) proxy to route it.",
		);
		return undefined;
	}
	const { ProxyAgent } = await import("undici");
	return new ProxyAgent(proxyUrl) as unknown as UndiciDispatcherLike;
}

/** Best-effort teardown of an undici dispatcher (close → destroy → noop). */
export async function closeUndiciDispatcher(
	dispatcher: UndiciDispatcherLike | null | undefined,
): Promise<void> {
	if (!dispatcher) return;
	try {
		if (typeof dispatcher.close === "function") await dispatcher.close();
		else if (typeof dispatcher.destroy === "function") await dispatcher.destroy();
	} catch {
		/* ignore teardown errors */
	}
}
