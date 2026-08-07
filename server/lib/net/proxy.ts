/**
 * Unified outbound proxy resolver.
 *
 * Cline, NUG, WebFetch, browser) resolve their proxy through this module so a
 * single global policy (`settings.proxy`) controls every outbound request.
 *
 * Bun's global `fetch()` also reads HTTP(S)_PROXY automatically, and the
 * per-request `proxy` option cannot opt out of it (`proxy: ""` / `undefined` /
 * omitted are all still proxied on Bun 1.3.14). The ambient variables are
 * therefore snapshotted and blanked at startup by `proxy-env.ts`, which leaves
 * the explicit `proxy` value that `outbound-fetch.ts` passes as the only thing
 * deciding whether a request is proxied. "system" mode reads the snapshot.
 */

import { settings } from "../settings";
import type { ProxyOverride } from "../settings/types";
import { createOutboundProxyDispatcher, OutboundProxyConfigurationError } from "./outbound-fetch";
import { ambientNoProxy, ambientSystemProxy } from "./proxy-env";

/**
 * Detect the proxy URL the process was started with (case-insensitive).
 * Order: HTTPS_PROXY → HTTP_PROXY → ALL_PROXY.
 *
 * Reads the startup snapshot from `proxy-env.ts` rather than the live
 * environment, because the ambient variables are deliberately blanked at startup
 * so Bun's fetch cannot proxy a request behind this module's back.
 */
export function detectSystemProxy(): string | undefined {
	return ambientSystemProxy();
}

/**
 * Resolve the global outbound proxy URL (ignoring per-target exemptions).
 * - "direct" → undefined (no proxy)
 * - "system" → read HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars
 * - "custom" → the user-specified URL
 *
 * Default behaviour (when no proxy config exists) is "direct".
 */
export function getOutboundProxy(): string | undefined {
	const cfg = settings.proxy;
	const mode = cfg?.mode ?? "direct";

	switch (mode) {
		case "system":
			return detectSystemProxy();
		case "custom":
			return cfg?.url || undefined;
		default:
			return undefined;
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

/**
 * Read the startup NO_PROXY / no_proxy value into a normalized entry list.
 * Uses the snapshot for the same reason as `detectSystemProxy`.
 */
function getNoProxyEntries(): string[] {
	const raw = ambientNoProxy();
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

/** A node `http.Agent`-compatible proxy agent with best-effort teardown. */
export interface ProxyAgentLike {
	destroy?: () => void;
}

function normalizeHttpProxyUrl(proxyUrl: string): string {
	const trimmed = proxyUrl.trim();
	const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new OutboundProxyConfigurationError({ code: "INVALID_OUTBOUND_PROXY_URL" });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new OutboundProxyConfigurationError({
			code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
			protocol: parsed.protocol.replace(/:$/, "").toLowerCase(),
			supportedProtocols: ["http", "https"],
		});
	}
	return parsed.toString();
}

/**
 * Create an HTTP(S) proxy agent for libraries that accept a node `http.Agent`
 * (ws, axios, @slack/bolt, node-fetch). Returns undefined for a falsy URL.
 * Callers MUST destroy per-connection agents during teardown/reconnect.
 */
export async function createProxyAgent(
	proxyUrl: string | undefined,
): Promise<ProxyAgentLike | undefined> {
	if (!proxyUrl) return undefined;
	const { HttpsProxyAgent } = await import("https-proxy-agent");
	return new HttpsProxyAgent(normalizeHttpProxyUrl(proxyUrl)) as unknown as ProxyAgentLike;
}

/** A real undici dispatcher with best-effort teardown methods. */
export interface UndiciDispatcherLike {
	close?: () => Promise<void> | void;
	destroy?: () => Promise<void> | void;
}

/**
 * Create a caller-owned real undici dispatcher for HTTP(S) proxies.
 * Unsupported protocols fail closed instead of silently falling back to direct.
 */
export async function createUndiciProxyDispatcher(
	proxyUrl: string | undefined,
): Promise<UndiciDispatcherLike | undefined> {
	if (!proxyUrl) return undefined;
	return createOutboundProxyDispatcher(proxyUrl) as UndiciDispatcherLike;
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
