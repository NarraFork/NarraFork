/**
 * Pure LDAP helpers: URL/name normalization, RFC 4515 filter escaping, RFC 4514 DN
 * escaping, and the `{username}` templates used by both connection modes.
 *
 * Everything here is deterministic and network-free, so it is unit-tested on its own
 * and reused by the Zod validators without pulling `ldapts` into the validator layer.
 */
import type { LdapSettings } from "../settings/types";

/**
 * `user_identities.provider` for the single configured directory.
 *
 * The colon is deliberate: OIDC provider ids are validated against
 * `^[a-z0-9][a-z0-9_-]*$`, so this value can never collide with an SSO provider id.
 */
export const LDAP_PROVIDER_ID = "ldap:default";

export const LDAP_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const LDAP_DEFAULT_TIMEOUT_MS = 5_000;
export const LDAP_DEFAULT_SEARCH_SCOPE = "sub" as const;
export const LDAP_DEFAULT_SEARCH_FILTER = "(&(objectClass=person)(uid={username}))";
export const LDAP_DEFAULT_USERNAME_ATTRIBUTE = "uid";
export const LDAP_DEFAULT_EMAIL_ATTRIBUTE = "mail";
export const LDAP_DEFAULT_DISPLAY_NAME_ATTRIBUTE = "cn";

/** The placeholder substituted with the escaped login name inside a template. */
export const LDAP_USERNAME_PLACEHOLDER = "{username}";

/**
 * Whether a URL is an `ldap://` or `ldaps://` endpoint we are willing to connect to.
 *
 * Credentials and a base DN are rejected on purpose: both have a dedicated setting, and
 * a URL that silently carries either is how an operator ends up with a bind that does
 * not use the account they think it does.
 */
export function isSupportedLdapUrl(value: string): boolean {
	const trimmed = value.trim();
	if (!/^ldaps?:\/\//i.test(trimmed)) return false;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return false;
	}
	if (parsed.protocol !== "ldap:" && parsed.protocol !== "ldaps:") return false;
	if (!parsed.hostname) return false;
	if (parsed.username || parsed.password) return false;
	if (parsed.pathname && parsed.pathname !== "/") return false;
	if (parsed.search || parsed.hash) return false;
	return true;
}

/**
 * Escape a value for use inside an LDAP search filter (RFC 4515 §3).
 *
 * Without this, a login name containing `*` or `)` rewrites the filter and can turn a
 * lookup of one account into a match on another — the directory-side equivalent of an
 * injection. The five special characters are the complete set the RFC defines.
 */
export function escapeFilterValue(value: string): string {
	let out = "";
	for (const ch of value) {
		switch (ch) {
			case "\\":
				out += "\\5c";
				break;
			case "*":
				out += "\\2a";
				break;
			case "(":
				out += "\\28";
				break;
			case ")":
				out += "\\29";
				break;
			case "\0":
				out += "\\00";
				break;
			default:
				out += ch;
		}
	}
	return out;
}

/** Characters RFC 4514 §2.4 requires escaped wherever they appear in an attribute value. */
const DN_ALWAYS_ESCAPED = new Set(["\\", ",", "+", '"', "<", ">", ";", "="]);

/**
 * Escape a value for use as an RDN attribute value inside a DN (RFC 4514 §2.4).
 *
 * Besides the reserved characters, a leading `#` and a leading/trailing space are also
 * escaped — those are the two positions the grammar treats specially, so a value that
 * begins or ends with one would otherwise change how the DN parses.
 */
export function escapeDnValue(value: string): string {
	const chars = [...value];
	let out = "";
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i] as string;
		if (ch === "\0") {
			out += "\\00";
			continue;
		}
		if (DN_ALWAYS_ESCAPED.has(ch)) {
			out += `\\${ch}`;
			continue;
		}
		const atStart = i === 0;
		const atEnd = i === chars.length - 1;
		if (ch === " " && (atStart || atEnd)) {
			out += "\\ ";
			continue;
		}
		if (ch === "#" && atStart) {
			out += "\\#";
			continue;
		}
		out += ch;
	}
	return out;
}

/** Whether a template carries the `{username}` placeholder. */
export function hasUsernamePlaceholder(template: string): boolean {
	return template.includes(LDAP_USERNAME_PLACEHOLDER);
}

/**
 * Substitute an escaped login name into a `{username}` template (a bind DN, a UPN, or a
 * search filter written in DN-value terms).
 *
 * Throws when the placeholder is missing: a template without it would bind every login
 * as the same fixed account, which is a configuration mistake no retry can fix.
 */
export function renderUsernameTemplate(template: string, username: string): string {
	if (!hasUsernamePlaceholder(template)) {
		throw new Error("LDAP template must contain {username}");
	}
	return template.split(LDAP_USERNAME_PLACEHOLDER).join(escapeDnValue(username));
}

/** Substitute an RFC 4515-escaped login name into a `{username}` search filter. */
export function renderFilterTemplate(template: string, username: string): string {
	if (!hasUsernamePlaceholder(template)) {
		throw new Error("LDAP filter must contain {username}");
	}
	return template.split(LDAP_USERNAME_PLACEHOLDER).join(escapeFilterValue(username));
}

/**
 * Reduce a directory-supplied name to something `users.username` accepts,
 * i.e. `[a-z0-9_-]{3,50}`.
 *
 * Only used when an account must be created. A name shorter than the 3-character
 * minimum is right-padded with `0` so the result is still storable and deterministic;
 * uniqueness on top of that is the caller's job.
 */
export function sanitizeDerivedUsername(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "")
		.slice(0, 50);
	return cleaned.length >= 3 ? cleaned : cleaned.padEnd(3, "0");
}

/**
 * Normalize a submitted login name for directory use: strip control characters, trim,
 * and reject empty.
 *
 * Control characters cannot appear in a directory account name and only serve to make
 * the filter/DN text ambiguous, so they are removed rather than escaped.
 */
export function normalizeLdapUsername(value: unknown): string {
	if (typeof value !== "string") return "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
	return stripped.slice(0, 256);
}

/**
 * Describe why a directory configuration cannot be used, or null when it is usable.
 *
 * The admin "test connection" button reports this as its `config` stage instead of
 * attempting a network call with a half-filled form, and the service refuses to enable
 * a directory that fails it.
 *
 * `ignoreEnabled` exists for that test button: an administrator tests the settings in
 * order to decide whether to switch them on, so the switch itself must not be what the
 * probe complains about.
 */
export function describeLdapConfigProblem(
	settings: LdapSettings,
	options: { ignoreEnabled?: boolean } = {},
): string | null {
	if (!options.ignoreEnabled && !settings.enabled) return "LDAP is disabled";
	const url = settings.url?.trim() ?? "";
	if (!url) return "Server URL is required";
	if (!isSupportedLdapUrl(url)) {
		return "Server URL must be an ldap:// or ldaps:// URL without credentials, path or query";
	}
	const mode = settings.mode ?? "search";
	if ((settings.bindDn?.trim() ?? "") !== "" && (settings.bindPassword ?? "") === "") {
		// A DN with an empty password is an *unauthenticated* bind, which servers may
		// answer with success — the service account would then not be authenticated at all.
		return "Service account DN requires a bind password";
	}
	if (mode === "search") {
		if (!settings.searchBase?.trim()) return "Search base DN is required in search mode";
		const filter = settings.searchFilter?.trim() || LDAP_DEFAULT_SEARCH_FILTER;
		if (!hasUsernamePlaceholder(filter)) return "Search filter must contain {username}";
	}
	if (mode === "direct") {
		const template = settings.bindDnTemplate?.trim() ?? "";
		if (!template) return "Bind DN template is required in direct mode";
		if (!hasUsernamePlaceholder(template)) return "Bind DN template must contain {username}";
	}
	if (settings.startTls && url.toLowerCase().startsWith("ldaps://")) {
		return "StartTLS applies only to ldap:// URLs";
	}
	return null;
}
