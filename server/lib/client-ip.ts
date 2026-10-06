import { BlockList, isIP } from "node:net";
import type { Context } from "hono";

const MAX_FORWARDED_HEADER_CHARS = 2_048;
const MAX_FORWARDED_HOPS = 20;

interface TrustedProxyCache {
	key: string;
	list: BlockList;
}

let trustedProxyCache: TrustedProxyCache | null = null;

function stripOptionalPort(raw: string): string {
	const value = raw.trim();
	if (value.startsWith("[")) {
		const end = value.indexOf("]");
		if (end > 0) return value.slice(1, end);
	}
	if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
		return value.slice(0, value.lastIndexOf(":"));
	}
	return value;
}

function mappedIpv4FromCanonicalIpv6(value: string): string | null {
	const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
	if (!match) return null;
	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Normalize an IP for stable limiter keys and trusted-proxy checks. */
export function normalizeIp(raw: string | null | undefined): string | null {
	if (!raw) return null;
	let value = stripOptionalPort(raw).trim();
	if (!value) return null;

	const zoneIndex = value.indexOf("%");
	if (zoneIndex >= 0) value = value.slice(0, zoneIndex);

	const dottedMapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
	if (dottedMapped && isIP(dottedMapped[1]) === 4) {
		return dottedMapped[1]
			.split(".")
			.map((part) => String(Number(part)))
			.join(".");
	}

	const version = isIP(value);
	if (version === 4) {
		return value
			.split(".")
			.map((part) => String(Number(part)))
			.join(".");
	}
	if (version !== 6) return null;

	try {
		const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
		return mappedIpv4FromCanonicalIpv6(canonical) ?? canonical;
	} catch {
		return null;
	}
}

interface TrustedProxySubnet {
	address: string;
	prefix: number;
	version: 4 | 6;
}

function parseTrustedProxySubnet(rawEntry: string): TrustedProxySubnet | null {
	const entry = rawEntry.trim();
	if (!entry) return null;
	const slash = entry.lastIndexOf("/");
	const rawAddress = slash >= 0 ? entry.slice(0, slash) : entry;
	const address = normalizeIp(rawAddress);
	if (!address) return null;
	const version = isIP(address);
	if (version !== 4 && version !== 6) return null;
	const maxPrefix = version === 4 ? 32 : 128;
	const prefix = slash >= 0 ? Number(entry.slice(slash + 1)) : maxPrefix;
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
	return { address, prefix, version };
}

export function isValidTrustedProxyCidr(value: string): boolean {
	return parseTrustedProxySubnet(value) !== null;
}

function compileTrustedProxies(cidrs: readonly string[]): BlockList {
	const key = JSON.stringify(cidrs);
	if (trustedProxyCache?.key === key) return trustedProxyCache.list;

	const list = new BlockList();
	for (const rawEntry of cidrs) {
		const subnet = parseTrustedProxySubnet(rawEntry);
		if (!subnet) continue;
		list.addSubnet(subnet.address, subnet.prefix, subnet.version === 4 ? "ipv4" : "ipv6");
	}
	trustedProxyCache = { key, list };
	return list;
}

function isTrustedProxy(ip: string, trusted: BlockList): boolean {
	const version = isIP(ip);
	return version !== 0 && trusted.check(ip, version === 4 ? "ipv4" : "ipv6");
}

/** Check whether a socket peer may supply trusted reverse-proxy headers. */
export function isTrustedProxyAddress(
	peerIp: string | null | undefined,
	trustedProxyCidrs: readonly string[],
): boolean {
	const normalized = normalizeIp(peerIp);
	return (
		normalized !== null && isTrustedProxy(normalized, compileTrustedProxies(trustedProxyCidrs))
	);
}

export interface ResolveClientIpInput {
	peerIp: string | null | undefined;
	xForwardedFor?: string | null;
	xRealIp?: string | null;
	trustedProxyCidrs: readonly string[];
}

/**
 * Resolve the security-relevant client IP from the socket peer and a trusted
 * reverse-proxy chain. Forwarding headers are ignored unless the immediate
 * socket peer is explicitly trusted. Invalid or excessive chains fail closed
 * to the socket peer.
 */
export function resolveClientIp(input: ResolveClientIpInput): string {
	const peerIp = normalizeIp(input.peerIp);
	if (!peerIp) return "unknown";

	const trusted = compileTrustedProxies(input.trustedProxyCidrs);
	if (!isTrustedProxy(peerIp, trusted)) return peerIp;

	const forwarded = input.xForwardedFor?.trim();
	let chain: string[] = [];
	if (forwarded) {
		if (forwarded.length > MAX_FORWARDED_HEADER_CHARS) return peerIp;
		const rawHops = forwarded.split(",");
		if (rawHops.length > MAX_FORWARDED_HOPS) return peerIp;
		for (const rawHop of rawHops) {
			const hop = normalizeIp(rawHop);
			if (!hop) return peerIp;
			chain.push(hop);
		}
	} else if (input.xRealIp) {
		if (input.xRealIp.length > 128) return peerIp;
		const realIp = normalizeIp(input.xRealIp);
		if (!realIp) return peerIp;
		chain = [realIp];
	}

	if (chain.length === 0) return peerIp;
	chain.push(peerIp);
	for (let i = chain.length - 1; i >= 0; i--) {
		if (!isTrustedProxy(chain[i], trusted)) return chain[i];
	}
	return chain[0];
}

/** Read the already-resolved client IP injected by the Bun HTTP boundary. */
export function getClientIp(c: Context): string {
	const env = c.env as { clientIp?: unknown } | undefined;
	return typeof env?.clientIp === "string" ? (normalizeIp(env.clientIp) ?? "unknown") : "unknown";
}
