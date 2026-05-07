const PROXY_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function normalizeProxyUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (PROXY_PROTOCOL_RE.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}
