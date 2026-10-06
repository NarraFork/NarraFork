const REDACTED = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"proxy-authorization",
	"x-csrf-token",
	"x-xsrf-token",
	"x-api-key",
	"api-key",
]);

const URL_HEADER_NAMES = new Set([
	"referer",
	"referrer",
	"location",
	"x-original-url",
	"x-original-uri",
	"x-forwarded-uri",
	"x-forwarded-url",
]);

const SENSITIVE_KEY_PARTS = new Set([
	"password",
	"passwd",
	"pwd",
	"token",
	"secret",
	"cookie",
	"session",
	"csrf",
	"xsrf",
	"authorization",
	"auth",
]);

function splitKeyParts(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.toLowerCase()
		.split("_")
		.filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
	const parts = splitKeyParts(key);
	if (parts.some((part) => SENSITIVE_KEY_PARTS.has(part))) return true;
	if (parts.join("") === "apikey") return true;
	return parts.some((part, index) => part === "api" && parts[index + 1] === "key");
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => {
			const lowerKey = key.toLowerCase();
			if (SENSITIVE_HEADER_NAMES.has(lowerKey) || isSensitiveKey(key)) {
				return [key, REDACTED];
			}
			if (URL_HEADER_NAMES.has(lowerKey)) {
				return [key, redactUrl(value)];
			}
			return [key, value];
		}),
	);
}

function redactUrlObject(url: URL): void {
	if (url.username) url.username = REDACTED;
	if (url.password) url.password = REDACTED;
	for (const key of [...url.searchParams.keys()]) {
		if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
	}
}

function redactUrlByPattern(rawUrl: string): string {
	return rawUrl.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, prefix, key) =>
		isSensitiveKey(key) ? `${prefix}${key}=${REDACTED}` : match,
	);
}

export function redactUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		redactUrlObject(url);
		return url.toString();
	} catch {
		return redactUrlByPattern(rawUrl);
	}
}

function redactObject(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactObject);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = isSensitiveKey(key) ? REDACTED : redactObject(item);
	}
	return result;
}

function contentType(headers: Record<string, string>): string {
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type");
	return entry?.[1]?.toLowerCase() ?? "";
}

export function redactPostData(
	postData: string | undefined,
	headers: Record<string, string> = {},
): string | undefined {
	if (postData === undefined) return undefined;
	const type = contentType(headers);
	if (type.includes("application/json")) {
		try {
			return JSON.stringify(redactObject(JSON.parse(postData)));
		} catch {
			return `[REDACTED POST DATA: invalid JSON, ${postData.length} chars]`;
		}
	}
	if (
		type.includes("application/x-www-form-urlencoded") ||
		(postData.includes("=") && postData.includes("&"))
	) {
		try {
			const params = new URLSearchParams(postData);
			for (const key of [...params.keys()]) {
				if (isSensitiveKey(key)) params.set(key, REDACTED);
			}
			return params.toString();
		} catch {
			return `[REDACTED POST DATA: form parse failed, ${postData.length} chars]`;
		}
	}
	if (type.startsWith("text/") || type.includes("xml")) {
		return postData.replace(/([A-Za-z][\w-]*)(["'\s:=]+)([^\s&"'<>]+)/g, (match, key, separator) =>
			isSensitiveKey(key) ? `${key}${separator}${REDACTED}` : match,
		);
	}
	return `[REDACTED POST DATA: ${postData.length} chars]`;
}
