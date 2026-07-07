const PROXY_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

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
	if (PROXY_PROTOCOL_RE.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}

function normalizeOutboundProxyMode(value: unknown): OutboundProxyMode {
	return value === "system" || value === "custom" || value === "direct" ? value : "system";
}

/** Summarize the global outbound proxy policy (`settings.proxy`). */
export function summarizeOutboundProxyPolicy(policy: unknown): OutboundProxySummary {
	if (isRecord(policy)) {
		const mode = normalizeOutboundProxyMode(policy.mode);
		const url = typeof policy.url === "string" ? policy.url : "";
		return { mode, url, configured: mode !== "direct" };
	}
	return { mode: "system", url: "", configured: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
