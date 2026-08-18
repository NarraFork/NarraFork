/**
 * Resolve the origin a browser (or a remote machine) actually used to reach this
 * server.
 *
 * `new URL(c.req.url).origin` is the socket-level origin, which behind a reverse
 * proxy is the proxy's upstream target — typically `http://127.0.0.1:7779`. Any
 * URL built from it and then handed to a *different* machine is unreachable, so
 * every feature that emits an absolute self-URL needs the forwarded origin
 * instead.
 *
 * Forwarding headers are attacker-controlled by default, so they are honoured
 * only when the Bun socket boundary marked the immediate peer as a configured
 * trusted proxy (`server/main.ts` sets `c.env.trustedProxy`). The rightmost value
 * of a multi-hop header belongs to the closest proxy, which is the only hop we
 * have any reason to trust; taking the leftmost would accept a value the original
 * caller prepended.
 *
 * Anything unexpected falls back to the direct origin rather than guessing: a
 * wrong-but-plausible public URL fails later and further away than an obviously
 * local one.
 */
import type { Context } from "hono";

const MAX_FORWARDED_ORIGIN_HEADER_CHARS = 2_048;
const MAX_FORWARDED_ORIGIN_HOPS = 20;

/**
 * Rightmost element of a comma-separated forwarding header.
 *
 * Bounded on both length and hop count: these headers are untrusted input even
 * when the immediate peer is trusted, and an unbounded split is a cheap way to
 * make the server do pointless work.
 */
export function rightmostForwardedHeaderValue(raw: string): string | null {
	if (raw.length > MAX_FORWARDED_ORIGIN_HEADER_CHARS) return null;
	const values = raw.split(",");
	if (values.length > MAX_FORWARDED_ORIGIN_HOPS) return null;
	return values.at(-1)?.trim() || null;
}

/**
 * The externally visible origin of this server, as a URL with no path.
 *
 * Returns the direct socket origin unless the peer is a trusted proxy AND the
 * forwarded headers describe a usable http(s) origin.
 */
export function resolvePublicOrigin(c: Context): URL {
	const requestUrl = new URL(c.req.url);
	const directOrigin = new URL(requestUrl.origin);
	const env = c.env as { trustedProxy?: unknown } | undefined;
	if (env?.trustedProxy !== true) return directOrigin;

	const forwardedProtoHeader = c.req.header("X-Forwarded-Proto");
	const forwardedHostHeader = c.req.header("X-Forwarded-Host");
	let protocol = requestUrl.protocol;
	let host = requestUrl.host;

	if (forwardedProtoHeader !== undefined) {
		const forwardedProto = rightmostForwardedHeaderValue(forwardedProtoHeader)?.toLowerCase();
		if (forwardedProto !== "http" && forwardedProto !== "https") return directOrigin;
		protocol = `${forwardedProto}:`;
	}
	if (forwardedHostHeader !== undefined) {
		const forwardedHost = rightmostForwardedHeaderValue(forwardedHostHeader);
		if (!forwardedHost) return directOrigin;
		host = forwardedHost;
	}

	try {
		const publicOrigin = new URL(`${protocol}//${host}`);
		if (publicOrigin.protocol !== "http:" && publicOrigin.protocol !== "https:") {
			return directOrigin;
		}
		// A credentialed or path-bearing "origin" is not an origin. Rejecting these
		// outright keeps callers from concatenating a URL that silently points
		// somewhere else than it reads.
		if (
			publicOrigin.username ||
			publicOrigin.password ||
			publicOrigin.pathname !== "/" ||
			publicOrigin.search ||
			publicOrigin.hash
		) {
			return directOrigin;
		}
		return publicOrigin;
	} catch {
		return directOrigin;
	}
}

/** Loopback host check on a URL hostname (bracketed IPv6 accepted). */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost") return true;
	if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
		octets[0] === "127"
	);
}

/**
 * Is this hostname an IP literal (dotted-quad v4 or any v6 form) rather than a
 * name? Used to explain refusals precisely: the private-network rules above are
 * deliberately literal-only, so "why was I refused" has a different answer for
 * `http://203.0.113.10` than for `http://nas.lan`.
 */
export function isIpLiteralHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host.includes(":")) return true;
	const octets = host.split(".");
	return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part));
}

/**
 * Is this hostname a private-network literal (RFC 1918 / CGNAT / link-local /
 * IPv6 ULA), i.e. an address that cannot be routed from the public internet?
 *
 * Deliberately literal-only: a *name* that currently resolves into a private
 * range is not evidence of anything, because resolution can change and is not
 * under this server's control. Callers use this to decide whether plaintext http
 * is acceptable, and a DNS-dependent answer would make that decision
 * unverifiable.
 */
export function isPrivateNetworkHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isLoopbackHostname(host)) return true;

	const octets = host.split(".");
	if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
		const parts = octets.map(Number);
		if (parts.some((part) => part > 255)) return false;
		const [a, b] = parts as [number, number, number, number];
		if (a === 10) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		// CGNAT (100.64.0.0/10) — Tailscale and similar overlay networks live here.
		if (a === 100 && b >= 64 && b <= 127) return true;
		// Link-local (169.254.0.0/16).
		if (a === 169 && b === 254) return true;
		return false;
	}

	// IPv6: unique-local (fc00::/7) and link-local (fe80::/10).
	if (host.includes(":")) {
		if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
		if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
	}
	return false;
}
