import {
	type NoProxyRule,
	normalizeProxyUrl,
	validateNoProxyPattern,
} from "@shared/proxy-settings";

export {
	MAX_NO_PROXY_RULES,
	type NoProxyRule,
	normalizeProxyUrl,
	validateNoProxyPattern,
} from "@shared/proxy-settings";

export type OutboundProxyMode = "system" | "direct" | "custom";

export interface OutboundProxySummary {
	mode: OutboundProxyMode;
	url: string;
	/** True when the policy actively routes through a proxy (system or custom). */
	configured: boolean;
}

function normalizeOutboundProxyMode(value: unknown): OutboundProxyMode {
	return value === "system" || value === "custom" || value === "direct" ? value : "direct";
}

/** Summarize the global outbound proxy policy (`settings.proxy`). */
export function summarizeOutboundProxyPolicy(policy: unknown): OutboundProxySummary {
	if (isRecord(policy)) {
		const mode = normalizeOutboundProxyMode(policy.mode);
		const url = typeof policy.url === "string" ? policy.url : "";
		return { mode, url, configured: mode !== "direct" };
	}
	return { mode: "direct", url: "", configured: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Per-location proxy override mode (adds "default" = inherit global). */
export type ProxyOverrideMode = "default" | "direct" | "system" | "custom";

export interface ProxyOverride {
	mode: ProxyOverrideMode;
	url?: string;
}

/** Update and helper downloads share one override; never patch source/identity fields. */
export function buildUpdateProxyPatch(next?: ProxyOverride) {
	return { update: { proxy: next ?? { mode: "default" as const } } };
}

// ---------------------------------------------------------------------------
// no_proxy rules
// ---------------------------------------------------------------------------

/**
 * Read the stored no_proxy rule list into editor shape.
 * Unknown/blank entries are dropped rather than shown as broken rows.
 */
export function summarizeNoProxyRules(policy: unknown): NoProxyRule[] {
	if (!isRecord(policy) || !Array.isArray(policy.noProxyRules)) return [];
	const rules: NoProxyRule[] = [];
	for (const entry of policy.noProxyRules) {
		if (!isRecord(entry)) continue;
		const pattern = typeof entry.pattern === "string" ? entry.pattern.trim() : "";
		if (!pattern) continue;
		rules.push({
			...(typeof entry.id === "string" && entry.id ? { id: entry.id } : {}),
			match: entry.match === "regex" ? "regex" : "wildcard",
			pattern,
			enabled: entry.enabled !== false,
		});
	}
	return rules;
}

/**
 * Build a complete `settings.proxy` patch.
 *
 * The server replaces the whole object (so switching mode drops a stale custom
 * URL), which also means the shared no_proxy list must always travel with it —
 * omitting it would be read as "keep the stored list", and that is only true
 * for API clients that deliberately leave it out.
 */
export function buildOutboundProxyPatch(input: {
	mode: OutboundProxyMode;
	url?: string;
	noProxyRules?: NoProxyRule[];
}) {
	const proxy: { mode: OutboundProxyMode; url?: string; noProxyRules: NoProxyRule[] } = {
		mode: input.mode,
		noProxyRules: input.noProxyRules ?? [],
	};
	if (input.mode === "custom") {
		const normalized = normalizeProxyUrl(input.url);
		if (normalized) proxy.url = normalized;
	}
	return { proxy };
}

/**
 * Validate the editor's rule rows, returning `{ index, message }` for the first
 * problem. Blank rows are ignored: an empty new row is "not filled in yet".
 */
export function findNoProxyRuleError(
	rules: readonly NoProxyRule[],
): { index: number; message: string } | undefined {
	for (const [index, rule] of rules.entries()) {
		const pattern = rule.pattern.trim();
		if (!pattern) continue;
		const message = validateNoProxyPattern(rule.match, pattern);
		if (message) return { index, message };
	}
	return undefined;
}

/** Minimal settings patch; explicit default survives JSON and clears old overrides. */
export function buildWebToolProxyPatch(tool: "webFetch" | "browser", next?: ProxyOverride) {
	const proxy = next ?? { mode: "default" as const };
	return {
		agent: tool === "webFetch" ? { webFetchPolicy: { proxy } } : { browserProxy: proxy },
	};
}

export function normalizeProxyOverrideMode(value: unknown): ProxyOverrideMode {
	return value === "direct" || value === "system" || value === "custom" || value === "default"
		? value
		: "default";
}

/**
 * Build a proxy override payload from UI state.
 * - `undefined`: inherit the global policy (`default` mode)
 * - `null`: custom mode is selected but the URL is not ready to persist
 * - `ProxyOverride`: a complete configuration safe to send to the backend
 */
export function buildProxyOverride(
	mode: ProxyOverrideMode,
	url: string | undefined,
): ProxyOverride | undefined | null {
	if (mode === "default") return undefined;
	if (mode === "custom") {
		const normalizedUrl = normalizeProxyUrl(url);
		return normalizedUrl ? { mode: "custom", url: normalizedUrl } : null;
	}
	return { mode };
}

/** Outcome of committing a typed custom proxy URL. */
export type ProxyUrlCommit =
	| { action: "save"; override: ProxyOverride; normalizedUrl: string }
	| { action: "keep-draft" }
	| { action: "noop"; normalizedUrl: string };

/**
 * Decide what a "commit the typed custom proxy URL" gesture (blur / Enter)
 * should do. Kept separate from the component so the debounce-free
 * commit-on-blur behavior is testable without a DOM.
 *
 * - `keep-draft`: nothing valid to persist yet; leave the user's text alone.
 * - `noop`: identical to what is already stored; skip the network round-trip so
 *   no settings refetch can yank focus out of the field.
 * - `save`: persist the normalized override.
 */
export function commitProxyUrlDraft(
	draftUrl: string,
	persisted: ProxyOverride | undefined,
): ProxyUrlCommit {
	const next = buildProxyOverride("custom", draftUrl);
	if (!next?.url) return { action: "keep-draft" };
	const unchanged =
		normalizeProxyOverrideMode(persisted?.mode) === "custom" && persisted?.url === next.url;
	return unchanged
		? { action: "noop", normalizedUrl: next.url }
		: { action: "save", override: next, normalizedUrl: next.url };
}
