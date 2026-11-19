/**
 * no_proxy rule engine.
 *
 * Decides whether a specific target URL must bypass the outbound proxy, based on
 * the user-configured `settings.proxy.noProxyRules` list. It runs inside
 * `net/proxy.ts#applyProxyExemptions`, which is the single place every proxied
 * channel (AI providers, Codex, NUG, WebFetch, browser, IM gateways, hooks,
 * updates, speech, balance probes) turns a target into a proxy decision — so a
 * rule is applied *before* the request becomes a proxied connection, and adding
 * a channel later does not need to re-implement matching.
 *
 * A rule only ever EXEMPTS a target; it can never force one through the proxy.
 *
 * ## Priority
 *
 * 1. Loopback / this-host targets bypass the proxy unconditionally (handled in
 *    `net/proxy.ts`, before any rule). A rule cannot re-enable proxying for them.
 * 2. `regex` rules are evaluated before `wildcard` rules: a hand-written regular
 *    expression is the more explicit, more precise statement of intent, so it wins
 *    regardless of where it sits in the list.
 * 3. Within one kind, list order decides — the first matching rule wins and the
 *    remaining rules are not consulted.
 * 4. Disabled rules (`enabled: false`) are skipped. Invalid regex rules are
 *    skipped too: a broken pattern must never silently stop traffic from being
 *    proxied, and the settings writer rejects them anyway.
 *
 * ## Syntax
 *
 * A pattern is tested against three representations of the target, in order,
 * and the first representation that matches decides the reported `target`:
 * the full URL (`https://api.example.com:8443/v1/x`), the lowercase hostname
 * (`api.example.com`), and host:port (`api.example.com:8443`) when an explicit
 * port is present.
 *
 * - `wildcard` — glob: `*` matches any run of characters, `?` matches one
 *   character, everything else is literal, anchored to the whole candidate and
 *   case-insensitive. Examples:
 *   - `*.internal.example.com` — every subdomain (host candidate).
 *   - `*://*.corp.example.com/*` — same, constrained to any scheme and path.
 *   - `https://api.example.com/*` — one host and scheme only.
 *   - `*example.com*` — any candidate containing `example.com`.
 *
 * - `regex` — a JavaScript regular expression source, compiled as-is (no
 *   implicit flags, so wrap alternations in a group: `^(a|b)\.example\.com$`).
 *   Examples:
 *   - `^api\d+\.example\.com$` — `api1`, `api42`, not `api-x`.
 *   - `^https://(api|files)\.example\.com/` — scheme and host together.
 *   - `:(8080|8443)$` — any candidate ending in those ports.
 *
 * - Bare host entry — a pattern with no `*`, `?`, `/` or `://` is classical
 *   `NO_PROXY` syntax: it matches the hostname exactly, or any dotted subdomain
 *   of it, and a leading dot is ignored. Examples:
 *   - `example.com` — `example.com` and `api.example.com`.
 *   - `.corp.example.com` — the same suffix rule, spelled the `NO_PROXY` way.
 *   - `example.com:8443` — that host on that exact port.
 *
 * Pure by design: no settings import, so the semantics are testable directly and
 * callers can pass an explicit rule list.
 */

import type { NoProxyMatchKind, NoProxyRule } from "@shared/proxy-settings";

/** Which representation of the target a rule matched. */
export type NoProxyMatchTarget = "url" | "host" | "host:port";

export interface NoProxyRuleMatch {
	rule: NoProxyRule;
	kind: NoProxyMatchKind;
	pattern: string;
	target: NoProxyMatchTarget;
}

/** Bounded compiled-pattern caches: settings are read on every outbound request. */
const COMPILED_CACHE_LIMIT = 512;
const wildcardCache = new Map<string, RegExp | null>();
const regexCache = new Map<string, RegExp | null>();

function cachedCompile(
	cache: Map<string, RegExp | null>,
	key: string,
	build: () => RegExp | null,
): RegExp | null {
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const compiled = build();
	if (cache.size >= COMPILED_CACHE_LIMIT) cache.clear();
	cache.set(key, compiled);
	return compiled;
}

/** Escape one literal character for use inside a regular expression. */
function escapeRegExpChar(ch: string): string {
	return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate a glob pattern into an anchored, case-insensitive regular
 * expression: `*` → `.*`, `?` → `.`, everything else literal.
 */
export function wildcardToRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${[...pattern].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : escapeRegExpChar(ch))).join("")}$`,
		"i",
	);
}

/**
 * A pattern with no wildcard, path or scheme is a classical `NO_PROXY` host
 * entry rather than a glob.
 */
export function isBareHostPattern(pattern: string): boolean {
	return !/[*?/]/.test(pattern) && !pattern.includes("://");
}

/** Case-insensitive host for matching: brackets stripped from IPv6 literals. */
function hostOf(url: URL): string {
	return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

interface MatchCandidate {
	target: NoProxyMatchTarget;
	text: string;
}

/**
 * The representations a pattern is tested against, in priority order. The URL
 * form covers scheme/path/query patterns; host forms cover the `NO_PROXY` habit
 * of naming a machine.
 */
function candidatesFor(url: URL): MatchCandidate[] {
	const host = hostOf(url);
	const candidates: MatchCandidate[] = [
		{ target: "url", text: url.href },
		{ target: "host", text: host },
	];
	if (url.port) candidates.push({ target: "host:port", text: `${host}:${url.port}` });
	return candidates;
}

/** `NO_PROXY` host semantics: exact host, or any dotted subdomain of it. */
function matchesBareHost(
	pattern: string,
	candidates: MatchCandidate[],
): NoProxyMatchTarget | undefined {
	const lower = pattern.toLowerCase();
	if (lower.includes(":")) {
		// `host:port` — an explicit port must match exactly, never as a suffix.
		const bare = lower.replace(/^\[|\]$/g, "");
		const hit = candidates.find((c) => c.target === "host:port" && c.text === bare);
		return hit ? hit.target : undefined;
	}
	const bare = lower.replace(/^\./, "");
	const host = candidates.find((c) => c.target === "host");
	if (!host) return undefined;
	return host.text === bare || host.text.endsWith(`.${bare}`) ? "host" : undefined;
}

function matchWildcardRule(
	rule: NoProxyRule,
	candidates: MatchCandidate[],
): NoProxyRuleMatch | undefined {
	const pattern = rule.pattern.trim();
	if (isBareHostPattern(pattern)) {
		const target = matchesBareHost(pattern, candidates);
		return target ? { rule, kind: "wildcard", pattern, target } : undefined;
	}
	const compiled = cachedCompile(wildcardCache, pattern, () => {
		try {
			return wildcardToRegExp(pattern);
		} catch {
			return null;
		}
	});
	if (!compiled) return undefined;
	for (const candidate of candidates) {
		if (compiled.test(candidate.text))
			return { rule, kind: "wildcard", pattern, target: candidate.target };
	}
	return undefined;
}

function matchRegExpRule(
	rule: NoProxyRule,
	candidates: MatchCandidate[],
): NoProxyRuleMatch | undefined {
	const pattern = rule.pattern.trim();
	const compiled = cachedCompile(regexCache, pattern, () => {
		try {
			return new RegExp(pattern);
		} catch {
			// A broken pattern must not exempt anything; settings validation rejects it.
			return null;
		}
	});
	if (!compiled) return undefined;
	for (const candidate of candidates) {
		// `lastIndex` only matters for /g patterns, which we never create, but a
		// shared cached RegExp stays safe because test() is stateless without /g.
		if (compiled.test(candidate.text))
			return { rule, kind: "regex", pattern, target: candidate.target };
	}
	return undefined;
}

function isRuleEnabled(rule: NoProxyRule): boolean {
	return rule.enabled !== false && typeof rule.pattern === "string" && rule.pattern.trim() !== "";
}

/**
 * Find the rule that exempts `target`, following the documented priority:
 * regex rules first, then wildcard rules, list order within each kind.
 */
export function matchNoProxyRules(
	target: string | URL,
	rules: readonly NoProxyRule[] | undefined,
): NoProxyRuleMatch | undefined {
	if (!rules || rules.length === 0) return undefined;

	let url: URL;
	try {
		url = typeof target === "string" ? new URL(target) : target;
	} catch {
		// Unparseable target: no rule can be decided, so keep the proxy decision.
		return undefined;
	}

	const regexRules: NoProxyRule[] = [];
	const wildcardRules: NoProxyRule[] = [];
	for (const rule of rules) {
		if (!isRuleEnabled(rule)) continue;
		if (rule.match === "regex") regexRules.push(rule);
		else if (rule.match === "wildcard") wildcardRules.push(rule);
	}
	if (regexRules.length === 0 && wildcardRules.length === 0) return undefined;

	const candidates = candidatesFor(url);
	for (const rule of regexRules) {
		const match = matchRegExpRule(rule, candidates);
		if (match) return match;
	}
	for (const rule of wildcardRules) {
		const match = matchWildcardRule(rule, candidates);
		if (match) return match;
	}
	return undefined;
}

/** Whether any enabled rule exempts `target` from the proxy. */
export function isNoProxyTarget(
	target: string | URL,
	rules: readonly NoProxyRule[] | undefined,
): boolean {
	return matchNoProxyRules(target, rules) !== undefined;
}

/** Test-only: drop compiled patterns so a test can observe compilation behaviour. */
export function resetNoProxyRuleCacheForTest(): void {
	wildcardCache.clear();
	regexCache.clear();
}
