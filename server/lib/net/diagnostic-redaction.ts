const REDACTED = "********";
const MAX_DIAGNOSTIC_TEXT_CHARS = 4000;
const SAFE_QUERY_PARAMS = new Set(["api-version", "version"]);
const SAFE_HEADER_NAMES = new Set([
	"accept",
	"accept-encoding",
	"content-encoding",
	"content-length",
	"content-type",
	"retry-after",
	"request-id",
	"server",
	"user-agent",
	"via",
	"x-amzn-requestid",
	"x-request-id",
	"cf-ray",
]);

function isSafeHeaderName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return (
		SAFE_HEADER_NAMES.has(normalized) ||
		/^(?:x-)?rate-?limit(?:-|$)/.test(normalized) ||
		/^ratelimit(?:-|$)/.test(normalized)
	);
}

function truncate(value: string): string {
	if (value.length <= MAX_DIAGNOSTIC_TEXT_CHARS) return value;
	return `${value.slice(0, MAX_DIAGNOSTIC_TEXT_CHARS)}…`;
}

export function redactSecretPatterns(value: string): string {
	return value
		.replace(
			/\b((?:authorization|proxy-authorization)\s*[:=]\s*)((?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)/gi,
			`$1${REDACTED}`,
		)
		.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
		.replace(
			/((?:x-api-key|api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|signature)\s*[:=]\s*)([^\s,;]+)/gi,
			`$1${REDACTED}`,
		)
		.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, REDACTED);
}

/** Remove URL credentials/hash and mask every query value except a small diagnostic allowlist. */
export function redactDiagnosticUrl(value: string | URL): string {
	const raw = value instanceof URL ? value.toString() : value;
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (!SAFE_QUERY_PARAMS.has(key.toLowerCase())) url.searchParams.set(key, REDACTED);
		}
		return url.toString();
	} catch {
		return truncate(redactSecretPatterns(raw));
	}
}

/** Best-effort redaction for errors/log strings that may contain URLs or credential fragments. */
export function redactDiagnosticText(value: string): string {
	const withoutUnsafeVerboseHint = value.replace(
		/\.\s*For more information, pass `verbose: true` in the second argument to fetch\(\)/gi,
		".",
	);
	const masked = redactSecretPatterns(withoutUnsafeVerboseHint).replace(
		/\b(?:https?|socks(?:4a?|5h?)):\/\/[^\s<>"']+/gi,
		(url) => redactDiagnosticUrl(url),
	);
	return truncate(masked);
}

/** Preserve header names, but reveal values only for the diagnostic-safe allowlist. */
export function redactDiagnosticHeader(name: string, value: string): string {
	if (!isSafeHeaderName(name)) return REDACTED;
	return redactSecretPatterns(value);
}

export function redactDiagnosticHeaders(headers: HeadersInit | undefined): string[] {
	if (!headers) return [];
	try {
		return [...new Headers(headers).entries()].map(
			([name, value]) => `${name}: ${redactDiagnosticHeader(name, value)}`,
		);
	} catch {
		return [`headers: ${REDACTED}`];
	}
}

export function selectSafeDiagnosticHeaders(headers: Headers): Record<string, string> | undefined {
	const selected: Record<string, string> = {};
	for (const [name, value] of headers.entries()) {
		if (!isSafeHeaderName(name)) continue;
		selected[name] = redactDiagnosticHeader(name, value);
	}
	return Object.keys(selected).length > 0 ? selected : undefined;
}
