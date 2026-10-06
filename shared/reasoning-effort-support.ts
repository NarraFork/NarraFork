/**
 * Whether a model accepts a reasoning-effort hint at all.
 *
 * Policy (blacklist, not whitelist): effort is a near-universal parameter now,
 * so any model is assumed to accept it. Only models known to REJECT it are
 * excluded. The old whitelist gated on "is this a Claude 4.6+ id", which hid
 * the tier menu for every third-party model behind an Anthropic-compatible
 * relay (GLM, Kimi, MiniMax, ...) whose ids can never match a Claude version.
 *
 * Two exclusion sources, both applied here so frontend and backend agree:
 *   1. A built-in rule for pre-4.6 Claude, where the official Anthropic API
 *      returns 400 on `output_config.effort`.
 *   2. A user-configurable pattern list (`agent.reasoningEffortBlocklist`), so
 *      a strict relay can be excluded without waiting for a release.
 */

import {
	clampReasoningEffort,
	REASONING_EFFORT_VALUES,
	type ReasoningEffort,
} from "./reasoning-effort";

/** Claude model families whose capabilities are derived from a version number. */
export type ClaudeFamily = "sonnet" | "opus" | "haiku" | "fable" | "mythos";

export interface ParsedClaudeModel {
	family: ClaudeFamily;
	major: number;
	minor: number;
}

/**
 * Versioned Claude families (`claude-sonnet-4.6`, `claude-opus-4-8`, ...).
 *
 * Both the major and the minor segment need a right boundary, because the two
 * Claude id shapes put the date suffix in different places:
 *
 *   - family-first (`claude-sonnet-4-20250514`): an unbounded MINOR segment
 *     would swallow `20250514` and yield version 4.20250514.
 *   - family-last (`claude-3-5-sonnet-20241022`): an unbounded MAJOR segment
 *     would swallow `20241022` and yield major 20241022 — making Claude 3.5
 *     look newer than every real model.
 *
 * `\d{1,2}(?!\d)` / `\d{1,3}(?!\d)` reject those date runs while still
 * accepting two-digit majors (a hypothetical `claude-opus-50`).
 */
const CLAUDE_VERSIONED_FAMILY_PATTERN =
	/(sonnet|opus|haiku|fable|mythos)[-_.]?(\d{1,2})(?!\d)(?:[._-](\d{1,3})(?!\d))?/i;

/** Claude Mythos Preview carries no version number; treat it as a 5-series model. */
const CLAUDE_MYTHOS_PREVIEW_PATTERN = /mythos[-_.]?preview/i;

/**
 * The legacy family-last shape, where the version precedes the family:
 * `claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`.
 *
 * Recognizing these matters under a blacklist policy: Claude 3.x genuinely
 * rejects the effort parameter, so an id that fails to parse would otherwise
 * be treated as "unknown model, send effort" and 400. Anchored on the literal
 * `claude` so a third-party id cannot trip it.
 */
const CLAUDE_FAMILY_LAST_PATTERN =
	/claude[-_.]?(\d{1,2})(?!\d)(?:[._-](\d{1,3})(?!\d))?[-_.]?(sonnet|opus|haiku|fable|mythos)/i;

/**
 * Parse a Claude model id into family + version. Returns null when the id does
 * not look like a versioned Claude model — which, under the blacklist policy,
 * means "not a Claude we have rules for", NOT "unsupported".
 */
export function parseClaudeModel(model: string): ParsedClaudeModel | null {
	if (CLAUDE_MYTHOS_PREVIEW_PATTERN.test(model)) {
		return { family: "mythos", major: 5, minor: 0 };
	}
	// Family-first (`claude-sonnet-4.6`) is the modern shape, so try it first.
	const match = CLAUDE_VERSIONED_FAMILY_PATTERN.exec(model);
	if (match) {
		const major = Number(match[2]);
		if (!Number.isFinite(major)) return null;
		const minor = match[3] != null ? Number(match[3]) : 0;
		return {
			family: match[1].toLowerCase() as ClaudeFamily,
			major,
			minor: Number.isFinite(minor) ? minor : 0,
		};
	}
	const legacy = CLAUDE_FAMILY_LAST_PATTERN.exec(model);
	if (!legacy) return null;
	const major = Number(legacy[1]);
	if (!Number.isFinite(major)) return null;
	const minor = legacy[2] != null ? Number(legacy[2]) : 0;
	return {
		family: legacy[3].toLowerCase() as ClaudeFamily,
		major,
		minor: Number.isFinite(minor) ? minor : 0,
	};
}

/** Whether a parsed version is at least `major.minor`. */
export function claudeVersionAtLeast(
	parsed: ParsedClaudeModel,
	major: number,
	minor: number,
): boolean {
	return parsed.major > major || (parsed.major === major && parsed.minor >= minor);
}

/**
 * Whether an id names a Claude model released before the effort parameter
 * existed (3.x and the 4.0–4.5 era). Those are the models known to hard 400 on
 * `output_config.effort`, and they are the built-in blacklist entry.
 *
 * Version-gated by family rather than globally, because the families arrived at
 * different times:
 *   - Sonnet/Opus: effort lands in 4.6, so anything below that is excluded.
 *   - Haiku: never listed in Anthropic's effort docs at any version. Left OUT
 *     of the blacklist on purpose — the docs omission is not a documented
 *     rejection, a relay may well accept it, and the whitelist era already
 *     hid the menu for Haiku with no evidence that it had to.
 *   - Fable/Mythos: no pre-effort generation exists, never excluded.
 */
export function isPreEffortClaudeModel(model: string): boolean {
	const parsed = parseClaudeModel(model);
	if (!parsed) return false;
	if (parsed.family === "sonnet" || parsed.family === "opus") {
		return !claudeVersionAtLeast(parsed, 4, 6);
	}
	// Haiku 3.x predates extended thinking entirely, so it cannot take effort;
	// 4.x+ Haiku is left enabled per the note above.
	if (parsed.family === "haiku") return parsed.major < 4;
	return false;
}

/**
 * Channel segments that can still prefix a model id on the request path.
 *
 * A gateway routes a model through a channel, so stripping the provider prefix
 * is not enough to reach the bare id: `nug:anthropic:GLM-5.1` becomes
 * `anthropic:GLM-5.1`. The frontend resolves the same model to `GLM-5.1` from
 * the catalog, so leaving the segment in place made the two sides disagree — a
 * blocklist entry anchored as `/^glm/` hid the tier menu while the request still
 * sent the parameter, defeating the only reason the entry exists.
 *
 * Restricted to the known channel names so a third-party id that happens to
 * contain a colon is left untouched.
 */
const CHANNEL_PREFIX_PATTERN = /^(?:codex|openai|anthropic|responses):/i;

/**
 * Reduce a request-path model id to the bare id both sides must agree on.
 * Idempotent, so it is safe to call on an id that is already bare.
 */
export function bareModelForEffort(model: string): string {
	return model.replace(CHANNEL_PREFIX_PATTERN, "");
}

/** A user-configured exclusion pattern. */
export interface ReasoningEffortBlocklistEntry {
	/** Case-insensitive substring, or `/regex/flags` when wrapped in slashes. */
	pattern: string;
	/** Absent or true = active. */
	enabled?: boolean;
}

/**
 * Match a model id against one user pattern.
 *
 * Plain patterns are case-insensitive substrings (the same shape as the
 * WebFetch policy lists, which users already know). A pattern wrapped in
 * slashes is compiled as a regex; an invalid regex never matches rather than
 * throwing into a request path.
 */
function matchesPattern(model: string, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	const lastSlash = trimmed.lastIndexOf("/");
	if (trimmed.startsWith("/") && lastSlash > 0) {
		const body = trimmed.slice(1, lastSlash);
		const flags = trimmed.slice(lastSlash + 1);
		if (!body) return false;
		try {
			return new RegExp(body, flags.includes("i") ? flags : `${flags}i`).test(model);
		} catch {
			return false;
		}
	}
	return model.toLowerCase().includes(trimmed.toLowerCase());
}

/** Whether any enabled blocklist entry matches the model id. */
export function matchesReasoningEffortBlocklist(
	model: string,
	blocklist?: readonly ReasoningEffortBlocklistEntry[] | null,
): boolean {
	if (!model || !blocklist?.length) return false;
	for (const entry of blocklist) {
		if (entry?.enabled === false) continue;
		if (entry?.pattern && matchesPattern(model, entry.pattern)) return true;
	}
	return false;
}

/**
 * The single decision both sides use: does this model accept an effort hint?
 *
 * `model` should already have its `provider:` prefix removed. A remaining
 * CHANNEL segment is stripped here rather than at each call site, because the
 * request path and the frontend arrive at this id differently (the backend peels
 * one prefix off `nug:anthropic:GLM-5.1`; the frontend reads `bareModel` from the
 * catalog) and a blocklist entry that matched only one of them would silently do
 * nothing.
 */
export function modelAcceptsReasoningEffort(
	model: string | undefined,
	blocklist?: readonly ReasoningEffortBlocklistEntry[] | null,
): boolean {
	if (!model) return false;
	const bare = bareModelForEffort(model);
	if (!bare) return false;
	if (isPreEffortClaudeModel(bare)) return false;
	return !matchesReasoningEffortBlocklist(bare, blocklist);
}

/**
 * Effort tiers offered for a model with no protocol-specific tier table.
 *
 * `none` is included: disabling reasoning is expressed as an effort value
 * across every provider we speak to, so it belongs in the generic ladder.
 * Unknown models expose every tier so newly released capabilities do not need
 * to wait for a catalog update.
 */
export const GENERIC_REASONING_EFFORT_TIERS: readonly ReasoningEffort[] = REASONING_EFFORT_VALUES;

/**
 * Clamp an effort onto the generic ladder for a wire protocol that has no tier
 * table of its own. Returns undefined when reasoning should not be requested
 * (no effort set, or the model is blacklisted).
 */
export function mapGenericReasoningEffort(
	model: string | undefined,
	reasoningEffort: string | undefined,
	blocklist?: readonly ReasoningEffortBlocklistEntry[] | null,
): ReasoningEffort | undefined {
	if (!reasoningEffort) return undefined;
	if (!modelAcceptsReasoningEffort(model, blocklist)) return undefined;
	if (reasoningEffort === "none") return "none";
	return clampReasoningEffort(reasoningEffort as ReasoningEffort, GENERIC_REASONING_EFFORT_TIERS);
}
