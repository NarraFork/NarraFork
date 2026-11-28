import { isIP } from "node:net";
import type { NoProxyRule } from "@shared/proxy-settings";
import { ValidationError } from "../errors";

// Replace Chromium's platform-dependent implicit rules with the project's loopback list.
// Chromium's IPv4 CIDR matcher also includes the corresponding IPv4-mapped IPv6 literals.
const LOOPBACK_ENTRIES = [
	"<-loopback>",
	"localhost",
	"*.localhost",
	"127.0.0.0/8",
	"[::1]",
	"0.0.0.0",
];
const BARE_HOST = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/;

function canonicalHost(host: string): string | undefined {
	const literal = isIP(host) === 6 ? `[${host}]` : host;
	if (literal === host && !BARE_HOST.test(host)) return undefined;
	try {
		// Do not normalize the rule to a different host: the project compares the
		// original rule against the canonical hostname from URL.
		return new URL(`http://${literal}`).hostname === literal ? literal : undefined;
	} catch {
		return undefined;
	}
}

function hostEntries(pattern: string): string[] | undefined {
	const host = canonicalHost(pattern.replace(/^\./, ""));
	if (!host) return undefined;
	// URL IPv6 literals are bracketed in Chromium and never have dotted subdomains.
	return host.startsWith("[") ? [host] : [host, `*.${host}`];
}

function settingsEntries(pattern: string): string[] | undefined {
	const colon = pattern.lastIndexOf(":");
	if (colon < 0) return hostEntries(pattern);

	// Settings, unlike ambient NO_PROXY, match an explicit port on exactly one
	// host. URL.port omits default ports, whereas Chromium uses effective ports.
	const port = pattern.slice(colon + 1);
	if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || port === "80" || port === "443") {
		return undefined;
	}
	const host = canonicalHost(pattern.slice(0, colon));
	return host ? [`${host}:${port}`] : undefined;
}

/** Compile only policy we can enforce on redirects, subresources and later navigations. */
export function managedManualProxyBypassList(
	ambient: string,
	rules: readonly NoProxyRule[],
): string[] {
	const entries = new Set(LOOPBACK_ENTRIES);
	const ambientEntries = ambient.split(",").map((entry) => entry.trim().toLowerCase());
	// A global bypass covers every request regardless of the remaining rules.
	if (
		ambientEntries.includes("*") ||
		rules.some(
			(rule) => rule.enabled !== false && rule.match === "wildcard" && rule.pattern.trim() === "*",
		)
	)
		return [...entries, "*"];

	for (const [index, entry] of ambientEntries.entries()) {
		if (!entry) continue;
		const translated = hostEntries(entry);
		if (!translated) {
			throw new ValidationError(
				`Manual browser cannot apply NO_PROXY entry #${index + 1} per request; use a bare hostname or IP address.`,
			);
		}
		for (const value of translated) entries.add(value);
	}
	for (const [index, rule] of rules.entries()) {
		const pattern = rule.pattern.trim().toLowerCase();
		if (rule.enabled === false || !pattern) continue;
		// Project glob and regex rules can match the full URL, even if the pattern
		// looks like a hostname glob. Passing one to Chromium would change its meaning.
		const translated = rule.match === "wildcard" ? settingsEntries(pattern) : undefined;
		if (!translated) {
			throw new ValidationError(
				`Manual browser cannot apply proxy bypass rule #${index + 1} per request; use a bare hostname or an exact host with a non-default port.`,
			);
		}
		for (const value of translated) entries.add(value);
	}
	return [...entries];
}
