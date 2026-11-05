/**
 * Provider import format (see docs/PROVIDER_IMPORT.md).
 *
 * Three entrances share one JSON payload and one confirmation page:
 * - an import code `NFP1.<base64url(JSON)>.<crc>` pasted into NarraFork;
 * - a `web+narrafork://import` link carrying either a whole code (full link) or a
 *   domain plus an API key (short link, config fetched from that domain);
 * - a domain typed into NarraFork, whose `/.well-known/narrafork-provider.json`
 *   the server fetches.
 *
 * Shared so the browser (input recognition, confirmation page) and the server
 * (re-validation, fetching, commit) apply the same whitelist and limits. Nothing
 * here trusts the payload: it only parses and validates it.
 */

import { getDomain } from "tldts";
import { z } from "zod";
import {
	ENDPOINT_POLICY_LIMITS,
	endpointPolicySchema,
	endpointUrlSchema,
} from "./provider-endpoints";

export const PROVIDER_IMPORT_VERSION = 1;
export const IMPORT_CODE_PREFIX = "NFP1";
/** Browser-registered scheme (`navigator.registerProtocolHandler` requires the `web+` form). */
export const IMPORT_LINK_SCHEME = "web+narrafork";
export const PROVIDER_WELL_KNOWN_PATH = "/.well-known/narrafork-provider.json";
/** Route of the confirmation page inside NarraFork. */
export const PROVIDER_IMPORT_PAGE_PATH = "/settings/providers/import";

export const PROVIDER_IMPORT_LIMITS = {
	/** Decoded JSON size for codes and links. */
	maxDecodedBytes: 16 * 1024,
	/** Response body size when fetching a well-known file. */
	maxFetchBytes: 64 * 1024,
	maxProviders: 10,
	maxBaseUrls: ENDPOINT_POLICY_LIMITS.maxBaseUrls,
	maxInputChars: 64 * 1024,
} as const;

export const IMPORT_PROTOCOLS = [
	"anthropic-messages",
	"openai-responses",
	"completions-compatible",
	"gemini-compatible",
] as const;

/**
 * Fields that are recognized but never imported: they describe the local
 * environment (proxy, TLS trust) or arbitrary request shaping, which a third
 * party must not be able to set.
 */
export const IMPORT_FORBIDDEN_FIELDS = [
	"tlsRejectUnauthorized",
	"proxy",
	"extraHeaders",
	"customUserAgent",
	"disabled",
] as const;

export const providerImportEntrySchema = z.object({
	id: z
		.string()
		.regex(/^[a-z0-9_-]{1,64}$/)
		.optional(),
	name: z.string().trim().min(1).max(100),
	protocol: z.enum(IMPORT_PROTOCOLS),
	baseUrl: endpointUrlSchema,
	baseUrls: z.array(endpointUrlSchema).max(PROVIDER_IMPORT_LIMITS.maxBaseUrls).optional(),
	prefix: z.string().trim().max(50).optional(),
	defaultModel: z.string().trim().max(200).optional(),
	geminiTransport: z.enum(["generate-content", "interactions"]).optional(),
	userAgentMode: z.enum(["narrafork", "claude-code", "codex"]).optional(),
	endpointPolicy: endpointPolicySchema.optional(),
	apiKey: z.string().trim().max(2000).optional(),
});

export const providerImportPayloadSchema = z.object({
	v: z.literal(PROVIDER_IMPORT_VERSION),
	issuer: z
		.object({
			name: z.string().trim().max(100).optional(),
			url: endpointUrlSchema.optional(),
		})
		.optional(),
	keyUrl: endpointUrlSchema.optional(),
	providers: z.array(providerImportEntrySchema).min(1).max(PROVIDER_IMPORT_LIMITS.maxProviders),
});

export type ProviderImportEntry = z.infer<typeof providerImportEntrySchema>;
export type ProviderImportPayload = z.infer<typeof providerImportPayloadSchema>;

export type ProviderImportErrorCode =
	| "empty"
	| "too-large"
	| "unrecognized"
	| "bad-code"
	| "bad-checksum"
	| "bad-json"
	| "invalid"
	| "bad-link"
	| "bad-domain";

export interface ProviderImportValidation {
	payload: ProviderImportPayload;
	/** Dotted paths of fields that were dropped (unknown or forbidden). */
	ignoredFields: string[];
	/** True when `apiKey` values were present but not allowed for this source. */
	droppedApiKey: boolean;
}

export type ProviderImportValidationResult =
	| ({ ok: true } & ProviderImportValidation)
	| { ok: false; error: "invalid" | "bad-json"; detail: string };

const TOP_LEVEL_KEYS = new Set(Object.keys(providerImportPayloadSchema.shape));
const ENTRY_KEYS = new Set(Object.keys(providerImportEntrySchema.shape));
const ISSUER_KEYS = new Set(["name", "url"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectIgnoredFields(raw: unknown): string[] {
	if (!isRecord(raw)) return [];
	const ignored: string[] = [];
	for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(key)) ignored.push(key);
	if (isRecord(raw.issuer)) {
		for (const key of Object.keys(raw.issuer))
			if (!ISSUER_KEYS.has(key)) ignored.push(`issuer.${key}`);
	}
	if (Array.isArray(raw.providers)) {
		raw.providers.forEach((entry, index) => {
			if (!isRecord(entry)) return;
			for (const key of Object.keys(entry))
				if (!ENTRY_KEYS.has(key)) ignored.push(`providers[${index}].${key}`);
		});
	}
	return ignored;
}

function describeIssues(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
}

/**
 * Validate an untrusted payload against the v1 whitelist. Unknown and forbidden
 * fields are dropped and reported; `apiKey` is dropped unless the source may
 * carry one (codes and full links may, public well-known files may not).
 */
export function validateImportPayload(
	raw: unknown,
	options: { allowApiKey: boolean },
): ProviderImportValidationResult {
	const ignoredFields = collectIgnoredFields(raw);
	const parsed = providerImportPayloadSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, error: "invalid", detail: describeIssues(parsed.error) };
	let droppedApiKey = false;
	const payload = parsed.data;
	if (!options.allowApiKey) {
		for (const entry of payload.providers) {
			if (entry.apiKey !== undefined) {
				droppedApiKey = true;
				delete entry.apiKey;
			}
		}
	}
	return { ok: true, payload, ignoredFields, droppedApiKey };
}

// ── API shapes (`/api/settings/provider-import/*`) ─────────────

export type ImportFetchAttemptOutcome =
	| "not-found"
	| "http-error"
	| "html"
	| "network"
	| "blocked"
	| "redirect-blocked"
	| "too-large"
	| "bad-json"
	| "invalid"
	| "ok";

export interface ImportFetchAttempt {
	url: string;
	outcome: ImportFetchAttemptOutcome;
	detail?: string;
}

export type ImportFetchResult =
	| ({
			ok: true;
			sourceUrl: string;
			host: string;
			attempts: ImportFetchAttempt[];
	  } & ProviderImportValidation)
	| { ok: false; error: "bad-domain" | "not-found" | "invalid"; attempts: ImportFetchAttempt[] };

export interface ImportPreviewResponse {
	entries: Array<{
		suggestedPrefix: string;
		/** Existing providers with the same base URL. Stored keys are never returned, only compared. */
		duplicates: Array<{
			id: string;
			name: string;
			prefix: string;
			/** The incoming key equals this provider's key. */
			sameKey: boolean;
		}>;
	}>;
	ignoredFields: string[];
}

export interface ImportCommitDecision {
	/** `add` creates an independent provider; `replace-key` updates `targetId`; `skip` saves nothing. */
	action: "add" | "replace-key" | "skip";
	targetId?: string;
	prefix?: string;
	name?: string;
	disabled?: boolean;
}

export interface ImportCommitResponse {
	results: Array<{
		status: "added" | "updated" | "skipped";
		providerId?: string;
		prefix?: string;
		protocol?: ProviderImportEntry["protocol"];
	}>;
	/** Site IDs that received a key and should refresh models. */
	refresh: ImportRefreshTarget[];
}

export interface ImportRefreshTarget {
	providerId: string;
}

/** One provider key checked before importing: `/models` fetched with an unsaved config. */
export interface ImportCheckResult {
	/** Index into `payload.providers`. */
	entry: number;
	ok: boolean;
	/** Number of models listed (ok only). */
	count?: number;
	error?: string;
}

export interface ImportCheckResponse {
	results: ImportCheckResult[];
	/** Some keys were not checked because the request named too many. */
	truncated: boolean;
}

// ── Import code codec ─────────────────────────────────────

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE 802.3, same as zlib) of an ASCII string. */
export function crc32(text: string): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < text.length; i++) {
		crc = crcTable[(crc ^ text.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function checksumOf(payload: string): string {
	return crc32(payload).toString(36).padStart(7, "0");
}

function base64UrlEncode(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
	const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeImportCode(payload: ProviderImportPayload): string {
	const encoded = base64UrlEncode(JSON.stringify(payload));
	return `${IMPORT_CODE_PREFIX}.${encoded}.${checksumOf(encoded)}`;
}

export type DecodeImportCodeResult =
	| { ok: true; raw: unknown }
	| { ok: false; error: "bad-code" | "bad-checksum" | "too-large" | "bad-json" };

/** Decode a code to raw JSON; validation is a separate step. Whitespace is ignored. */
export function decodeImportCode(code: string): DecodeImportCodeResult {
	const compact = code.replace(/\s+/g, "");
	const match = /^NFP1\.([A-Za-z0-9_-]+)\.([0-9a-z]{7})$/.exec(compact);
	if (!match) return { ok: false, error: "bad-code" };
	const [, encoded, checksum] = match;
	if (checksumOf(encoded) !== checksum) return { ok: false, error: "bad-checksum" };
	// base64 inflates by 4/3; reject before decoding anything oversized.
	if (encoded.length > Math.ceil((PROVIDER_IMPORT_LIMITS.maxDecodedBytes * 4) / 3)) {
		return { ok: false, error: "too-large" };
	}
	let json: string;
	try {
		json = base64UrlDecode(encoded);
	} catch {
		return { ok: false, error: "bad-code" };
	}
	try {
		return { ok: true, raw: JSON.parse(json) };
	} catch {
		return { ok: false, error: "bad-json" };
	}
}

// ── Input recognition ─────────────────────────────────────

/** Key material and selectors carried in a short link's fragment. */
export interface ImportLinkCredentials {
	key?: string;
	/** `providers[].id` the key applies to; all providers when absent. */
	provider?: string;
	/** Distinguishes several keys of one gateway in the provider name. */
	label?: string;
}

export type ParsedImportInput =
	| { kind: "payload"; raw: unknown; via: "code" | "link" | "json" }
	| ({
			kind: "remote";
			input: string;
			exact: boolean;
			via: "link" | "input";
	  } & ImportLinkCredentials)
	| { kind: "error"; error: ProviderImportErrorCode };

/**
 * Split `a=1&b=2` without URLSearchParams: `+` must stay `+` because API keys
 * may contain it and gateways do not always percent-encode it.
 */
function parseFragmentParams(fragment: string): Map<string, string> {
	const params = new Map<string, string>();
	for (const part of fragment.split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const name = eq < 0 ? part : part.slice(0, eq);
		const value = eq < 0 ? "" : part.slice(eq + 1);
		try {
			params.set(decodeURIComponent(name), decodeURIComponent(value));
		} catch {
			params.set(name, value);
		}
	}
	return params;
}

function credentialsFrom(fragment: string): ImportLinkCredentials {
	const params = parseFragmentParams(fragment);
	const pick = (name: string) => {
		const value = params.get(name)?.trim();
		return value ? value : undefined;
	};
	return {
		key: pick("key"),
		provider: pick("provider"),
		label: pick("label"),
	};
}

/** Parse `web+narrafork://import?domain=…#key=…` or `web+narrafork://import#NFP1…`. */
export function parseImportLink(link: string): ParsedImportInput {
	const trimmed = link.trim();
	const schemePrefix = `${IMPORT_LINK_SCHEME}:`;
	if (!trimmed.toLowerCase().startsWith(schemePrefix)) return { kind: "error", error: "bad-link" };
	const hashIndex = trimmed.indexOf("#");
	const beforeHash = hashIndex < 0 ? trimmed : trimmed.slice(0, hashIndex);
	const fragment = hashIndex < 0 ? "" : trimmed.slice(hashIndex + 1);
	const rest = beforeHash.slice(schemePrefix.length).replace(/^\/\//, "");
	const queryIndex = rest.indexOf("?");
	const action = (queryIndex < 0 ? rest : rest.slice(0, queryIndex)).replace(/\/+$/, "");
	if (action.toLowerCase() !== "import") return { kind: "error", error: "bad-link" };

	const compactFragment = fragment.replace(/\s+/g, "");
	if (compactFragment.startsWith(`${IMPORT_CODE_PREFIX}.`))
		return payloadFromCode(compactFragment, "link");

	const query = queryIndex < 0 ? "" : rest.slice(queryIndex + 1);
	const domain = parseFragmentParams(query).get("domain")?.trim();
	if (!domain) return { kind: "error", error: "bad-link" };
	return { kind: "remote", input: domain, exact: true, via: "link", ...credentialsFrom(fragment) };
}

function payloadFromCode(code: string, via: "code" | "link"): ParsedImportInput {
	const decoded = decodeImportCode(code);
	if (!decoded.ok) return { kind: "error", error: decoded.error };
	return { kind: "payload", raw: decoded.raw, via };
}

/**
 * Turn whatever the user pasted (or the confirmation page received from the
 * protocol handler) into either a payload to validate or a remote target to fetch.
 */
export function parseImportInput(text: string): ParsedImportInput {
	const trimmed = text.trim();
	if (!trimmed) return { kind: "error", error: "empty" };
	if (trimmed.length > PROVIDER_IMPORT_LIMITS.maxInputChars)
		return { kind: "error", error: "too-large" };

	if (trimmed.startsWith("{")) {
		try {
			return { kind: "payload", raw: JSON.parse(trimmed), via: "json" };
		} catch {
			return { kind: "error", error: "bad-json" };
		}
	}

	const compact = trimmed.replace(/\s+/g, "");
	if (compact.startsWith(`${IMPORT_CODE_PREFIX}.`)) return payloadFromCode(compact, "code");
	if (compact.toLowerCase().startsWith(`${IMPORT_LINK_SCHEME}:`)) return parseImportLink(compact);

	// A NarraFork import-page URL (the non-registered fallback) carries the same parts.
	if (/^https?:\/\//i.test(compact)) {
		try {
			const url = new URL(compact);
			if (url.pathname.replace(/\/+$/, "") === PROVIDER_IMPORT_PAGE_PATH) {
				const fromPage = importInputFromPageLocation(url.search, url.hash);
				if (fromPage) return fromPage;
				return { kind: "error", error: "bad-link" };
			}
		} catch {
			return { kind: "error", error: "unrecognized" };
		}
	}

	// Anything else is a website: domain, shorthand, page URL or direct config URL.
	return { kind: "remote", input: trimmed, exact: false, via: "input" };
}

/**
 * Read what the confirmation page was opened with. The protocol handler is
 * registered as `…/import#link=%s`; `?link=` is accepted for browsers that only
 * substitute into the query. Returns null when the page was opened plainly.
 */
export function importInputFromPageLocation(
	search: string,
	hash: string,
): ParsedImportInput | null {
	const fragment = hash.replace(/^#/, "");
	const query = search.replace(/^\?/, "");
	const fragmentParams = parseFragmentParams(fragment);
	const queryParams = parseFragmentParams(query);
	const link = fragmentParams.get("link") ?? queryParams.get("link");
	if (link) return parseImportLink(link);
	if (fragment.replace(/\s+/g, "").startsWith(`${IMPORT_CODE_PREFIX}.`)) {
		return payloadFromCode(fragment, "link");
	}
	const domain = queryParams.get("domain")?.trim();
	if (domain) {
		return {
			kind: "remote",
			input: domain,
			exact: true,
			via: "link",
			...credentialsFrom(fragment),
		};
	}
	return null;
}

// ── Protocol handler self-test ────────────────────────────

/**
 * Browsers cannot report whether `web+narrafork` is registered, so the import page
 * tests it end to end: it opens this link, and the page the handler opens answers
 * back. A nonce that survives the round trip also proves the `#link=%s` template
 * delivered the link's fragment.
 */
export function buildSelfTestLink(nonce: string): string {
	return `${IMPORT_LINK_SCHEME}://import#selftest=${encodeURIComponent(nonce)}`;
}

/** The `link` the handler passed in (fragment first, query fallback), or null. */
function pageLink(search: string, hash: string): string | null {
	const link =
		parseFragmentParams(hash.replace(/^#/, "")).get("link") ??
		parseFragmentParams(search.replace(/^\?/, "")).get("link");
	return link ? link : null;
}

/** Nonce of a self-test link the page was opened with, or null for any other visit. */
export function selfTestNonceFromPageLocation(search: string, hash: string): string | null {
	const link = pageLink(search, hash);
	const fragmentStart = link?.indexOf("#") ?? -1;
	if (!link || fragmentStart < 0) return null;
	const nonce = parseFragmentParams(link.slice(fragmentStart + 1)).get("selftest");
	return nonce && /^[A-Za-z0-9-]{8,64}$/.test(nonce) ? nonce : null;
}

// ── Remote (well-known) candidates ─────────────────────────

export type RemoteCandidatesResult =
	| { ok: true; kind: "direct" | "host"; urls: string[] }
	| { ok: false; error: "bad-domain" };

const SHORTHAND = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_NAMES = new Set(["localhost", "local", "localdomain", "internal"]);

function isIpLiteral(host: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

function wellKnownUrl(host: string): string {
	return `https://${host}${PROVIDER_WELL_KNOWN_PATH}`;
}

/** Lower-case, strip a trailing dot, punycode via the URL parser; null when unusable. */
function normalizeHost(raw: string): string | null {
	const host = raw.trim().toLowerCase().replace(/\.$/, "");
	if (!host || host.includes("@") || host.includes(":")) return null;
	try {
		const hostname = new URL(`https://${host}`).hostname;
		if (!hostname || isIpLiteral(hostname)) return null;
		return hostname;
	} catch {
		return null;
	}
}

/**
 * Where to look for a provider config, in order (docs/PROVIDER_IMPORT.md §5.1).
 * `exact` (short links) only ever probes the given host.
 */
export function resolveRemoteCandidates(
	input: string,
	options: { exact: boolean },
): RemoteCandidatesResult {
	const trimmed = input.trim();
	let hostPart = trimmed;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return { ok: false, error: "bad-domain" };
		}
		if (url.protocol !== "https:" || url.username || url.password || url.port) {
			return { ok: false, error: "bad-domain" };
		}
		if (!options.exact && /\.json$/i.test(url.pathname)) {
			const host = normalizeHost(url.hostname);
			if (!host) return { ok: false, error: "bad-domain" };
			return { ok: true, kind: "direct", urls: [`https://${host}${url.pathname}${url.search}`] };
		}
		hostPart = url.hostname;
	} else {
		hostPart = trimmed.split(/[/?#]/)[0] ?? "";
	}

	const host = normalizeHost(hostPart);
	if (!host || RESERVED_NAMES.has(host)) return { ok: false, error: "bad-domain" };

	if (!host.includes(".")) {
		if (options.exact || !SHORTHAND.test(host)) return { ok: false, error: "bad-domain" };
		return {
			ok: true,
			kind: "host",
			urls: [wellKnownUrl(`${host}.com`), wellKnownUrl(`www.${host}.com`)],
		};
	}
	if (options.exact) return { ok: true, kind: "host", urls: [wellKnownUrl(host)] };
	// Only the registrable domain itself (geek2api.com, geek2api.com.cn) gets a www fallback.
	const registrable = getDomain(host);
	if (registrable === host) {
		return { ok: true, kind: "host", urls: [wellKnownUrl(host), wellKnownUrl(`www.${host}`)] };
	}
	return { ok: true, kind: "host", urls: [wellKnownUrl(host)] };
}

/** Same registrable domain, e.g. geek2api.com ↔ www.geek2api.com. */
export function isSameSite(hostA: string, hostB: string): boolean {
	const a = getDomain(hostA);
	return !!a && a === getDomain(hostB);
}

// ── Display helpers ───────────────────────────────────────

/** Provider name with the link's key label, e.g. "Geek2API Claude · 工作". */
export function importedProviderName(entry: ProviderImportEntry, label?: string): string {
	return label ? `${entry.name} · ${label}`.slice(0, 100) : entry.name;
}

/** Apply a short link's key to the providers it targets (all when `provider` is absent). */
export function applyLinkCredentials(
	payload: ProviderImportPayload,
	credentials: ImportLinkCredentials,
): ProviderImportPayload {
	if (!credentials.key && !credentials.label) return payload;
	return {
		...payload,
		providers: payload.providers.map((entry) => {
			if (credentials.provider && entry.id !== credentials.provider) return entry;
			return {
				...entry,
				...(credentials.key ? { apiKey: credentials.key } : {}),
				name: importedProviderName(entry, credentials.label),
			};
		}),
	};
}

/** `https://api.example.com/v1` → `api.example.com`; the raw value when unparsable. */
export function importUrlHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
