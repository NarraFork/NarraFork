const URL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export type OutboundProxyMode = "system" | "direct" | "custom";

export interface OutboundProxySummary {
	mode: OutboundProxyMode;
	url: string;
	/** True when the policy actively routes through a proxy (system or custom). */
	configured: boolean;
}

export function normalizeProxyUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const normalized = URL_PROTOCOL_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		const protocol = new URL(normalized).protocol;
		return protocol === "http:" || protocol === "https:" ? normalized : undefined;
	} catch {
		return undefined;
	}
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
