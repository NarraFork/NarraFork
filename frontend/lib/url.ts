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
