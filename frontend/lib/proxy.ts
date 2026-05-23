const PROXY_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export type WebFetchProxyMode = "direct" | "system" | "custom";

export interface WebFetchProxySummary {
	mode: WebFetchProxyMode;
	url: string;
	configured: boolean;
}

export function normalizeProxyUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (PROXY_PROTOCOL_RE.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}

export function summarizeWebFetchProxyPolicy(policy: unknown): WebFetchProxySummary {
	const proxyPolicy = isRecord(policy) ? policy.proxy : undefined;
	if (isRecord(proxyPolicy)) {
		const mode = normalizeWebFetchProxyMode(proxyPolicy.mode);
		const url = typeof proxyPolicy.url === "string" ? proxyPolicy.url : "";
		return { mode, url, configured: mode !== "direct" };
	}
	if (typeof proxyPolicy === "string") {
		const mode = normalizeWebFetchProxyMode(proxyPolicy);
		const legacyURL =
			typeof (policy as { proxyUrl?: unknown }).proxyUrl === "string"
				? (policy as { proxyUrl: string }).proxyUrl
				: "";
		return { mode, url: legacyURL, configured: mode !== "direct" };
	}
	return { mode: "direct", url: "", configured: false };
}

function normalizeWebFetchProxyMode(value: unknown): WebFetchProxyMode {
	return value === "system" || value === "custom" || value === "direct" ? value : "direct";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
