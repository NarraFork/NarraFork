const URL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;

interface AuthorityParts {
	authority: string;
	suffix: string;
}

export function normalizeUrlProtocol(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (URL_PROTOCOL_RE.test(trimmed)) return trimmed;
	if (shouldSkipProtocolCompletion(trimmed)) return trimmed;

	const candidate = trimmed.startsWith("//") ? trimmed.slice(2) : trimmed;
	const ipv6Candidate = normalizeBareIpv6Candidate(candidate);
	if (ipv6Candidate) return `http://${ipv6Candidate}`;

	const parsed = parseHttpCandidate(candidate);
	if (!parsed) return trimmed;

	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostname === "localhost" || isValidIpv4Address(hostname) || isValidIpv6Address(hostname)) {
		return `http://${candidate}`;
	}

	return `https://${candidate}`;
}

export function normalizeHttpUrlProtocol(value: string | null | undefined): string | undefined {
	const normalized = normalizeUrlProtocol(value);
	if (!normalized) return undefined;
	return /^https?:\/\//i.test(normalized) ? normalized : undefined;
}

function shouldSkipProtocolCompletion(value: string): boolean {
	return (
		/[\s\\]/.test(value) ||
		WINDOWS_ABSOLUTE_PATH_RE.test(value) ||
		(value.startsWith("/") && !value.startsWith("//")) ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("?") ||
		value.startsWith("#")
	);
}

function parseHttpCandidate(candidate: string): URL | null {
	try {
		return new URL(`http://${candidate}`);
	} catch {
		return null;
	}
}

function normalizeBareIpv6Candidate(candidate: string): string | null {
	const parts = splitAuthority(candidate);
	if (!parts?.authority.includes(":")) return null;
	if (parts.authority.includes("@") || parts.authority.includes("[")) return null;
	if (!isValidIpv6Address(parts.authority)) return null;
	return `[${parts.authority}]${parts.suffix}`;
}

function splitAuthority(candidate: string): AuthorityParts | null {
	const match = /^(?<authority>[^/?#]*)(?<suffix>[/?#].*)?$/s.exec(candidate);
	if (!match?.groups?.authority) return null;
	return {
		authority: match.groups.authority,
		suffix: match.groups.suffix ?? "",
	};
}

function isValidIpv4Address(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	return parts.every((part) => {
		if (!/^\d+$/.test(part)) return false;
		const number = Number(part);
		return number >= 0 && number <= 255 && String(number) === part;
	});
}

function isValidIpv6Address(value: string): boolean {
	if (!value.includes(":")) return false;
	try {
		new URL(`http://[${value}]`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Extract the primary domain label from a base URL's hostname, suitable for
 * use as a provider name/prefix seed. Takes the second-to-last hostname label.
 *
 * Examples:
 *   https://api.openai.com/v1      → "openai"
 *   https://api.deepseek.com       → "deepseek"
 *   https://open.bigmodel.cn       → "bigmodel"
 *   https://dashscope.aliyuncs.com → "aliyuncs"
 *   https://openai.com             → "openai"
 *
 * Returns "" for single-label hosts (e.g. "localhost"), IP addresses, or
 * anything that cannot be parsed. The result never contains an ASCII colon.
 */
export function extractPrimaryDomainLabel(value: string | null | undefined): string {
	const normalized = normalizeHttpUrlProtocol(value);
	if (!normalized) return "";

	let hostname: string;
	try {
		hostname = new URL(normalized).hostname;
	} catch {
		return "";
	}

	hostname = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!hostname || hostname === "localhost") return "";
	if (isValidIpv4Address(hostname) || isValidIpv6Address(hostname)) return "";

	const labels = hostname.split(".").filter(Boolean);
	if (labels.length < 2) return "";

	// Second-to-last label is the primary registrable label for the common
	// "sub.domain.tld" shape (e.g. api.openai.com → openai). Multi-part suffixes
	// like "aliyuncs.com" resolve to their registrable base
	// (dashscope.aliyuncs.com → aliyuncs), matching the requested behavior.
	const label = labels[labels.length - 2] ?? "";
	return label.replace(/:/g, "");
}
