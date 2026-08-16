/**
 * How a plugin provider's outbound proxy is decided.
 *
 * A pure function, separate from `plugin-platform-services.ts`, because the interesting part is
 * a policy decision rather than wiring: getting it wrong silently routes upstream traffic
 * somewhere the user did not choose, and that is worth testing without constructing a registry,
 * a client pool and a state store first.
 *
 * ## The case that motivates the shape
 *
 * `mode: "direct"` resolves to *no* proxy URL. A resolver that returns `undefined` whenever it
 * has no URL would therefore report "nothing to say" for an explicit opt-out — and because the
 * plugin keeps the last proxy it was told about (see `applyHostHints` in the reference plugin),
 * that silently restores the global proxy the user just turned off.
 *
 * So the two cases are distinct:
 *
 * - **an override exists** → always speak, even if the answer is "no proxy". The returned
 *   `outbound` may be empty, which the plugin reads as "clear it".
 * - **no override** → fall back to the global policy, and stay silent when there is no global
 *   proxy either, so a host with no proxy configuration sends nothing on the wire.
 *
 * ## SSRF mitigation
 *
 * The resolved proxy URL is checked against private/reserved address ranges before being
 * handed to the plugin. A local-process plugin inherits the host's network stack, so
 * directing its traffic to 127.0.0.1, 169.254.x (cloud metadata), or RFC-1918 ranges
 * creates an SSRF surface. By default these are rejected; admins who intentionally use a
 * LAN proxy can set `plugins.allowPrivateProxyTarget = true` in settings.
 */

import type { ProxyOverride } from "@server/lib/settings/types";

export interface ProviderProxyDecision {
	/** Hints to send, or `undefined` to send none. */
	outbound?: { proxyUrl?: string };
}

export interface ProviderProxyPolicyInput {
	/** The provider's stored override, if any. */
	override?: ProxyOverride;
	/** Resolve an override to a URL. Injected so this stays pure. */
	resolveOverride: (override: ProxyOverride) => string | undefined;
	/** The host-wide proxy, used when there is no override. */
	globalProxyUrl?: string;
	/**
	 * Whether private/reserved IP addresses are allowed as proxy targets.
	 * Defaults to false (reject). Injected from `settings.plugins.allowPrivateProxyTarget`.
	 *
	 * Private deployments on internal networks may legitimately route through LAN proxies,
	 * so this is an explicit opt-in rather than a hard-coded rejection.
	 */
	allowPrivateProxyTarget?: boolean;
}

/**
 * Decide what to tell a plugin about proxying.
 *
 * Returns `undefined` only when the host genuinely has no policy to communicate; an explicit
 * override always produces a value.
 *
 * @throws {ProxyTargetValidationError} when the resolved URL targets a private/reserved
 *   address and `allowPrivateProxyTarget` is false.
 */
export function decideProviderProxy(
	input: ProviderProxyPolicyInput,
): ProviderProxyDecision | undefined {
	if (input.override) {
		const proxyUrl = input.resolveOverride(input.override);
		if (proxyUrl) {
			validateProxyUrl(proxyUrl, input.allowPrivateProxyTarget ?? false);
		}
		// Speak even with no URL: an absent `proxyUrl` inside a present `outbound` is how the
		// host says "no proxy", which the plugin must apply rather than ignore.
		return { outbound: { ...(proxyUrl ? { proxyUrl } : {}) } };
	}
	if (!input.globalProxyUrl) return undefined;
	validateProxyUrl(input.globalProxyUrl, input.allowPrivateProxyTarget ?? false);
	return { outbound: { proxyUrl: input.globalProxyUrl } };
}

// ─── SSRF validation ────────────────────────────────────────────────────────

/**
 * Allowed URL schemes for proxy targets. `http:` / `https:` are obvious;
 * `socks5:` and `socks5h:` are used by curl-style proxy stacks and are accepted
 * in the existing `resolveGlobalProxyUrl` codepath.
 */
const ALLOWED_PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks5h:"]);

export class ProxyTargetValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProxyTargetValidationError";
	}
}

/**
 * Validate a proxy URL: scheme whitelist + private-address rejection.
 *
 * The check is intentionally strict by default: a proxy URL whose hostname resolves to a
 * private or reserved address creates an SSRF vector for a plugin process running on the
 * host network. DNS rebinding is out of scope here (we only check the literal hostname);
 * actual DNS-level protection requires netns isolation.
 */
function validateProxyUrl(url: string, allowPrivate: boolean): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ProxyTargetValidationError(
			`Invalid proxy URL: cannot parse "${url}". ` +
				"Proxy URLs must be valid http://, https://, socks5://, or socks5h:// URLs.",
		);
	}

	if (!ALLOWED_PROXY_SCHEMES.has(parsed.protocol)) {
		throw new ProxyTargetValidationError(
			`Unsupported proxy scheme "${parsed.protocol}" in "${url}". ` +
				`Allowed: ${[...ALLOWED_PROXY_SCHEMES].join(", ")}.`,
		);
	}

	if (!allowPrivate && isPrivateOrReservedHost(parsed.hostname)) {
		throw new ProxyTargetValidationError(
			`Proxy URL "${url}" targets a private or reserved address. ` +
				"This is blocked to prevent SSRF. If you intentionally use a LAN proxy, " +
				'set plugins.allowPrivateProxyTarget = true in settings (Settings → Plugins → "Allow private proxy target").',
		);
	}
}

/**
 * Check whether a hostname is a private, loopback, link-local, or metadata address.
 *
 * Handles:
 * - IPv4 literals: 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.0.0.0
 * - IPv6 literals (bracket-stripped): ::1, fe80::, fc/fd (ULA), ::ffff:<private-v4>
 * - Hostnames: "localhost" and variants
 *
 * Does NOT do DNS resolution — only literal patterns. DNS-based SSRF requires network
 * namespace isolation (see docs/plugin-system/07-security-and-sandbox.md).
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[/, "").replace(/]$/, "");

	// Localhost aliases
	if (host === "localhost" || host.endsWith(".localhost")) return true;

	// IPv6
	if (host.includes(":")) {
		return isPrivateIPv6(host);
	}

	// IPv4 literal
	const parts = host.split(".");
	if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
		return isPrivateIPv4(parts.map(Number));
	}

	return false;
}

function isPrivateIPv4(octets: number[]): boolean {
	const [a, b] = octets;
	// 0.0.0.0/8 — "this" network
	if (a === 0) return true;
	// 10.0.0.0/8
	if (a === 10) return true;
	// 127.0.0.0/8 — loopback
	if (a === 127) return true;
	// 169.254.0.0/16 — link-local / cloud metadata (AWS 169.254.169.254)
	if (a === 169 && b === 254) return true;
	// 172.16.0.0/12
	if (a === 172 && b >= 16 && b <= 31) return true;
	// 192.168.0.0/16
	if (a === 192 && b === 168) return true;
	return false;
}

function isPrivateIPv6(addr: string): boolean {
	// Normalize :: expansion is not needed for the patterns we check — the raw forms
	// appearing in URLs are sufficient for the most common attacks.
	// ::1 — loopback
	if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
	// fe80::/10 — link-local
	if (addr.startsWith("fe80:") || addr.startsWith("fe80")) return true;
	// fc00::/7 — unique local (ULA)
	if (addr.startsWith("fc") || addr.startsWith("fd")) return true;
	// ::ffff:x.x.x.x — IPv4-mapped; check the embedded v4
	const v4Mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
	if (v4Mapped) {
		return isPrivateIPv4(v4Mapped.slice(1).map(Number));
	}
	return false;
}
