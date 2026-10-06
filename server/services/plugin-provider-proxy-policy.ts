/**
 * How a plugin provider's outbound proxy is decided.
 *
 * A pure function, separate from `plugin-platform-services.ts`, because the interesting part is
 * a policy decision rather than wiring: getting it wrong silently routes upstream traffic
 * somewhere the user did not choose, and that is worth testing without constructing a registry,
 * a client pool and a state store first.
 *
 * `mode: "direct"` resolves to no proxy URL, but must still send an empty `outbound` so the
 * plugin clears its previous proxy. No override and no global proxy means no hints to send.
 *
 * Proxy URLs come from the host's user-configured provider/global/system proxy policy, not
 * plugin-supplied upstream request targets. Honor that choice, including LAN and loopback
 * proxies, without a second opt-in. This is not an outbound-network sandbox or an SSRF
 * validator for untrusted request destinations; only URL syntax and proxy schemes are checked.
 *
 * Private-target gate
 * -------------------
 * A separate concern from proxy URL validity: when the resolved proxy *target* itself is a
 * private/reserved address (loopback, RFC 1918, link-local, IPv6 unique-local), forwarding it
 * to the plugin lets the plugin route every upstream API call through an address on the LAN.
 * That is a meaningful capability escalation — the plugin could reach internal services the
 * host never intended to expose. `applyPrivateProxyGate` enforces `network.egress.allowlist`
 * for such targets; `isPrivateProxyTarget` is the syntactic check (no DNS lookup).
 */

import type { ProxyOverride } from "@server/lib/settings/types";

/** The capability required to forward a private-network proxy to a plugin provider. */
export const PRIVATE_PROXY_CAPABILITY = "network.egress.allowlist";

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
}

/**
 * Decide what to tell a plugin about proxying.
 *
 * Returns `undefined` only when the host genuinely has no policy to communicate; an explicit
 * override always produces a value.
 *
 * @throws {ProxyTargetValidationError} for malformed URLs or unsupported proxy schemes.
 */
export function decideProviderProxy(
	input: ProviderProxyPolicyInput,
): ProviderProxyDecision | undefined {
	if (input.override) {
		const proxyUrl = input.resolveOverride(input.override);
		if (proxyUrl) {
			validateProxyUrl(proxyUrl);
		}
		// An absent `proxyUrl` inside a present `outbound` means "clear the previous proxy".
		return { outbound: { ...(proxyUrl ? { proxyUrl } : {}) } };
	}
	if (!input.globalProxyUrl) return undefined;
	validateProxyUrl(input.globalProxyUrl);
	return { outbound: { proxyUrl: input.globalProxyUrl } };
}

const ALLOWED_PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks5h:"]);

export class ProxyTargetValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProxyTargetValidationError";
	}
}

// ---------------------------------------------------------------------------
// Private-target gate
// ---------------------------------------------------------------------------

/**
 * Whether the host portion of `proxyUrl` is a private/reserved address.
 *
 * Checks are purely syntactic (no DNS resolution): a hostname that *looks* public may
 * still resolve to a private IP, but that is a DNS-level concern outside this policy
 * layer. The gate is a defence-in-depth safeguard for the common case — users pasting
 * LAN addresses — not a full SSRF firewall.
 *
 * Recognised private ranges:
 *   - Loopback: 127.0.0.0/8, ::1, localhost / *.localhost
 *   - Link-local: 169.254.0.0/16, fe80::/10
 *   - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - IPv6 unique-local: fc00::/7 (fc**::/8 + fd**::/8)
 *   - Unspecified / reserved: 0.0.0.0/8, 0::0, multicast/Class D/E (≥ 224.0.0.0)
 *
 * Returns `false` for unparseable URLs (those fail `validateProxyUrl` before this is
 * called).
 */
export function isPrivateProxyTarget(proxyUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(proxyUrl);
	} catch {
		return false; // validateProxyUrl will surface the parse error separately.
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return isPrivateHostname(hostname);
}

/** Syntactic private-address check for an already-lowercased, bracket-stripped hostname. */
function isPrivateHostname(hostname: string): boolean {
	// Named loopback
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	// IPv6
	if (hostname.includes(":")) {
		return (
			hostname === "::" ||
			hostname === "::1" ||
			hostname.startsWith("fe80:") || // link-local fe80::/10
			hostname.startsWith("fc") || // unique-local fc00::/7
			hostname.startsWith("fd")
		);
	}
	// IPv4-mapped IPv6 (::ffff:1.2.3.4)
	const ipv4Candidate = hostname.startsWith("::ffff:")
		? hostname.slice("::ffff:".length)
		: hostname;
	return isPrivateIpv4(ipv4Candidate);
}

function isPrivateIpv4(ip: string): boolean {
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
	const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.some((p) => !Number.isInteger(p) || p > 255)) return true; // Malformed — treat as private.
	const [a, b] = parts as [number, number, number, number];
	if (a === 0 || a >= 224) return true; // 0.0.0.0/8, multicast / reserved
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	return false;
}

/**
 * Outcome of `applyPrivateProxyGate`.
 *
 * `"allow"` — hints may be forwarded to the plugin unchanged.
 * `"suppress"` — the proxy URL targets a private address and the plugin lacks
 *                `network.egress.allowlist`; the caller must not send the hints and
 *                should surface a pending-authorisation signal to the user.
 */
export type PrivateProxyGateOutcome = "allow" | "suppress";

export interface PrivateProxyGateInput {
	/**
	 * The resolved proxy URL (after `decideProviderProxy`). When absent or empty the
	 * gate is vacuously satisfied — there is nothing private to gate.
	 */
	proxyUrl?: string;
	/** Capability strings already granted to this plugin installation. */
	grantedCapabilities: readonly string[];
}

/**
 * Decide whether a private-network proxy URL may be forwarded to the plugin.
 *
 * Public targets are unconditionally allowed regardless of capabilities (no regression for
 * existing behaviour). Private targets require `network.egress.allowlist`.
 *
 * This is intentionally a pure synchronous function: `resolveProviderHostHints` runs on
 * the hot request path and cannot await a permission-broker round-trip. The caller is
 * responsible for firing off the async `addPendingRequest` side-effect on `"suppress"`.
 */
export function applyPrivateProxyGate(input: PrivateProxyGateInput): PrivateProxyGateOutcome {
	if (!input.proxyUrl) return "allow";
	if (!isPrivateProxyTarget(input.proxyUrl)) return "allow";
	if (input.grantedCapabilities.includes(PRIVATE_PROXY_CAPABILITY)) return "allow";
	return "suppress";
}

/** Validate the user-selected proxy without imposing a public-address requirement. */
function validateProxyUrl(url: string): void {
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
}
