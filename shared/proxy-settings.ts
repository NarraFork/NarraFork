import { z } from "zod";

const URL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** HTTP(S) proxy address normalization shared by settings validation and UI. */
export function normalizeProxyUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls that the URL parser silently strips
	if (!trimmed || /[\u0000-\u0020\u007f]/.test(trimmed)) return undefined;
	const normalized = URL_PROTOCOL_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		const parsed = new URL(normalized);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname
			? normalized
			: undefined;
	} catch {
		return undefined;
	}
}

/** Empty addresses are absent; malformed non-empty addresses must fail validation. */
export const proxyUrlSchema = z.preprocess(
	(value) => {
		if (typeof value !== "string") return value;
		const trimmed = value.trim();
		return trimmed ? (normalizeProxyUrl(trimmed) ?? trimmed) : undefined;
	},
	z
		.string()
		.max(500)
		.refine((value) => normalizeProxyUrl(value) === value, {
			message: "Proxy must use a valid HTTP or HTTPS URL",
		})
		.optional(),
);

/** Absent/default inherits the global policy; custom always requires a valid URL. */
export const proxyOverrideSchema = z
	.object({
		mode: z.enum(["default", "direct", "system", "custom"]),
		url: proxyUrlSchema,
	})
	.superRefine((value, ctx) => {
		if (value.mode === "custom" && !value.url) {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: "Custom proxy mode requires a valid HTTP or HTTPS URL",
			});
		}
	})
	.optional();

// ---------------------------------------------------------------------------
// no_proxy rules
// ---------------------------------------------------------------------------

/** Matching kinds a no_proxy rule can use. */
export const NO_PROXY_MATCH_KINDS = ["wildcard", "regex"] as const;
export type NoProxyMatchKind = (typeof NO_PROXY_MATCH_KINDS)[number];

/** Hard limits, so one settings PATCH cannot make every request walk a huge list. */
export const MAX_NO_PROXY_RULES = 200;
export const NO_PROXY_PATTERN_MAX_CHARS = 500;

/**
 * One "skip the proxy for these URLs" rule.
 *
 * A rule never enables a proxy — it only exempts a target the proxy policy would
 * otherwise proxy, exactly like the ambient `NO_PROXY` environment variable. The
 * exception list is global (`settings.proxy.noProxyRules`) so every proxied
 * channel sees the same rules.
 */
export interface NoProxyRule {
	/** Client-generated identifier; purely for UI keying, never used for matching. */
	id?: string;
	match: NoProxyMatchKind;
	pattern: string;
	/** Absent means enabled. A disabled rule is kept in the list but never matched. */
	enabled?: boolean;
}

/**
 * Validate one rule pattern for the given kind.
 * Returns an error message, or `undefined` when the pattern is usable.
 */
export function validateNoProxyPattern(
	kind: NoProxyMatchKind,
	pattern: string,
): string | undefined {
	const trimmed = pattern.trim();
	if (!trimmed) return "Pattern must not be empty";
	if (trimmed.length > NO_PROXY_PATTERN_MAX_CHARS) {
		return `Pattern must be at most ${NO_PROXY_PATTERN_MAX_CHARS} characters`;
	}
	if (kind === "regex") {
		try {
			new RegExp(trimmed);
		} catch (error) {
			return error instanceof Error ? error.message : "Invalid regular expression";
		}
	}
	return undefined;
}

/** One no_proxy rule. Regex rules are compile-checked at save time. */
export const noProxyRuleSchema = z
	.object({
		id: z.string().min(1).max(64).optional(),
		match: z.enum(NO_PROXY_MATCH_KINDS),
		pattern: z.string().trim().min(1).max(NO_PROXY_PATTERN_MAX_CHARS),
		enabled: z.boolean().optional(),
	})
	.superRefine((value, ctx) => {
		const error = validateNoProxyPattern(value.match, value.pattern);
		if (error) ctx.addIssue({ code: "custom", path: ["pattern"], message: error });
	});

/** The global no_proxy rule list (`settings.proxy.noProxyRules`). */
export const noProxyRulesSchema = z.array(noProxyRuleSchema).max(MAX_NO_PROXY_RULES).optional();
