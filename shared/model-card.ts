/**
 * Model cards — one editable template per "same model", shared by frontend and
 * backend.
 *
 * A card carries the metadata that used to be hardcoded in four separate
 * tables: the context window and max completion tokens (settings/provider.ts),
 * the reasoning-effort tiers (openai-provider.ts for the backend clamp,
 * NarratorPanel.tsx for the menu), and the official USD reference prices
 * (model-pricing.ts). Cards make all of it adjustable without a release.
 *
 * "Not set" is expressed by absence (or 0 / empty array), and means *fall back
 * to the layer below* — never "override with nothing". A card may legitimately
 * carry only a price, or only effort tiers.
 *
 * Deliberately NOT ported from NUG's model_cards table, each for a concrete
 * reason:
 *
 * - `effortSchemaPath` — it tells a gateway which upstream request field
 *   carries the effort level. NarraFork *is* the thing making that request, and
 *   the field is decided by the provider implementation (`reasoning.effort` vs
 *   `output_config.effort`). Exposing it as a card field would hand the user a
 *   switch whose only non-broken position is the one the code already picks.
 * - `provisionChannels` — declaring models the upstream does not report is
 *   already `agent.customModels` here.
 * - `protocol` — a property of the provider, not of the model.
 * - `priorityMultiplier` / `defaultDiscount` — billing-side fields. NarraFork
 *   does not bill; it only attributes an equivalent USD cost.
 */

import { parseModelId } from "./model-id";
import type { ReasoningEffort } from "./reasoning-effort";

/** Official reference prices, USD per 1M tokens. */
export interface ModelCardPricing {
	/** USD per 1M input (uncached) tokens. */
	input?: number;
	/** USD per 1M output tokens. */
	output?: number;
	/** USD per 1M cache-read (cached input) tokens. */
	cacheRead?: number;
	/** USD per 1M cache-write tokens. 0 = the vendor charges no separate fee. */
	cacheWrite?: number;
}

export interface ModelCard {
	/** Canonical normalized (lower-cased, trimmed) match key. */
	modelKey: string;
	displayName?: string;
	/** Vendor family, for grouping and filtering: gpt / claude / gemini / … */
	family?: string;
	notes?: string;
	/**
	 * Seeded by NarraFork rather than the user. A UI hint only — builtin cards
	 * are fully editable and deletable.
	 */
	builtin?: boolean;

	/** Exact alternate keys. */
	aliases?: string[];
	/**
	 * Prefix rules. Any model id starting with one of these matches, longest
	 * prefix first, and only after exact/alias/suffix-stripped attempts fail.
	 *
	 * Explicit by design: the pre-card implementation applied a `startsWith`
	 * match against every table key unconditionally, so a new entry silently
	 * became a prefix rule for everything sharing its opening characters.
	 */
	matchPrefixes?: string[];

	/** Context window in tokens. Absent or 0 = do not override. */
	contextWindow?: number;
	/** Max completion tokens. Absent or 0 = do not override. */
	maxCompletionTokens?: number;
	/**
	 * Supported reasoning tiers, ascending. Absent or empty = do not override.
	 *
	 * `none` never belongs here. It means "reasoning off", which every consumer
	 * handles before consulting tiers: the backend early-returns on it, and the
	 * UI appends it based on whether the provider can disable thinking at all.
	 * Storing it would make it a clamp target, so a user asking for `low` on a
	 * model whose lowest real tier is `medium` could be silently clamped to
	 * `none` — thinking off, with nothing said about it.
	 */
	effortLevels?: ReasoningEffort[];
	/** Official reference prices. */
	officialPricing?: ModelCardPricing;

	/**
	 * Tombstone for a builtin card the user deleted. Needed because builtin
	 * cards are code, not data: without the marker, the merge would resurrect
	 * the card on the next load.
	 */
	deleted?: boolean;
}

/** How a lookup landed on a card. */
export type ModelCardMatch = "exact" | "alias" | "suffix-stripped" | "prefix";

export interface ModelCardLookupResult {
	card: ModelCard;
	matchedVia: ModelCardMatch;
	/** The (possibly suffix-stripped) key that matched. */
	matchedKey: string;
}

/**
 * Suffixes that identify a dated snapshot or release channel of the *same*
 * model and are therefore safe to strip before matching.
 *
 * Semantic suffixes (`-mini`, `-codex`, `-thinking`, `-fast`, `-max`, `-spark`)
 * are deliberately absent: stripping them would collapse a variant onto its
 * base model, which for pricing means silently charging a cheap model at its
 * expensive base's rate.
 *
 * The numeric forms are constrained to plausible dates (`20` century for the
 * 8-digit form, months 01-12 for both) rather than "any 6 or 8 digits". Without
 * that, a trailing *version* — `foo-202601`, `bar-5000` — would be stripped, and
 * if the reduced form hit another card the model would silently take that
 * card's window and price. Being wrong is worse than not matching.
 *
 * This is the single implementation; `server/lib/model-pricing.ts` consumes it
 * rather than keeping its own copy, so the two cannot drift.
 */
export const VOLATILE_SUFFIX_PATTERNS: readonly RegExp[] = [
	// 2026-06-01
	/-\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/,
	// 20260601 — four-digit year starting with 20, then a real month.
	/-20\d{2}(?:0[1-9]|1[0-2])\d{2}$/,
	// 260601 — two-digit year, then a real month.
	/-\d{2}(?:0[1-9]|1[0-2])\d{2}$/,
	/-latest$/,
	/-preview$/,
];

/**
 * Normalize a model identifier for lookup: strip any `provider:` prefix, lower
 * case, trim. Vendor separators are left alone — `gpt-5.4` and `gpt-5-4` are
 * different strings, and only the published spelling matches, with `aliases`
 * covering known alternates.
 */
export function normalizeModelCardKey(model?: string): string {
	if (!model) return "";
	return parseModelId(model.trim()).model.trim().toLowerCase();
}

/**
 * Progressively strip volatile date/snapshot suffixes, yielding each reduced
 * form (most specific first, excluding the input). Applied repeatedly so
 * `x-preview-2026-06-01` reduces step by step. Bounded so a pathological name
 * cannot spin.
 */
export function volatileKeyCandidates(key: string): string[] {
	const seen = new Set<string>([key]);
	const candidates: string[] = [];
	let current = key;
	for (let round = 0; round < 4; round++) {
		let reduced: string | undefined;
		for (const pattern of VOLATILE_SUFFIX_PATTERNS) {
			if (!pattern.test(current)) continue;
			reduced = current.replace(pattern, "");
			break;
		}
		if (!reduced || seen.has(reduced) || reduced.length === 0) break;
		seen.add(reduced);
		candidates.push(reduced);
		current = reduced;
	}
	return candidates;
}

interface ModelCardIndex {
	byKey: Map<string, ModelCard>;
	byAlias: Map<string, ModelCard>;
	/** Prefix rules sorted longest-first, so the most specific wins. */
	prefixes: Array<{ prefix: string; card: ModelCard }>;
}

/**
 * Build the lookup index for a card list.
 *
 * Exported so callers that resolve many models against a stable list can build
 * it once; `lookupModelCard` accepts either a list or a prebuilt index.
 */
export function buildModelCardIndex(cards: readonly ModelCard[]): ModelCardIndex {
	const byKey = new Map<string, ModelCard>();
	const byAlias = new Map<string, ModelCard>();
	const prefixes: Array<{ prefix: string; card: ModelCard }> = [];
	for (const card of cards) {
		if (card.deleted) continue;
		const key = normalizeModelCardKey(card.modelKey);
		if (!key) continue;
		byKey.set(key, card);
		for (const alias of card.aliases ?? []) {
			const normalized = normalizeModelCardKey(alias);
			// An alias must never shadow a real card key: two cards can legitimately
			// list overlapping alternates, but a card's own key is authoritative.
			if (normalized && !byKey.has(normalized)) byAlias.set(normalized, card);
		}
		for (const prefix of card.matchPrefixes ?? []) {
			const normalized = normalizeModelCardKey(prefix);
			if (normalized) prefixes.push({ prefix: normalized, card });
		}
	}
	// Longest prefix first. Without this, `claude-opus-4` (200k) would swallow
	// `claude-opus-4-8` (1M) — the exact regression the parity test guards.
	prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
	return { byKey, byAlias, prefixes };
}

function isIndex(value: readonly ModelCard[] | ModelCardIndex): value is ModelCardIndex {
	return !Array.isArray(value);
}

/**
 * Match a model id against the card list, in priority order:
 *
 *   1. exact normalized key
 *   2. alias exact match
 *   3. the same two, for each date/snapshot-suffix-stripped candidate
 *   4. declared prefixes, longest first
 *
 * Steps 1-3 never do loose matching, so `<base>-mini` cannot collide with
 * `<base>`. Step 4 only matches prefixes a card declares explicitly.
 */
export function lookupModelCard(
	model: string | undefined,
	cards: readonly ModelCard[] | ModelCardIndex,
): ModelCardLookupResult | null {
	const key = normalizeModelCardKey(model);
	if (!key) return null;
	const index = isIndex(cards) ? cards : buildModelCardIndex(cards);

	const candidates: Array<{ key: string; via: ModelCardMatch }> = [{ key, via: "exact" }];
	for (const stripped of volatileKeyCandidates(key)) {
		candidates.push({ key: stripped, via: "suffix-stripped" });
	}

	for (const candidate of candidates) {
		const exact = index.byKey.get(candidate.key);
		if (exact) {
			return { card: exact, matchedVia: candidate.via, matchedKey: candidate.key };
		}
		const aliased = index.byAlias.get(candidate.key);
		if (aliased) {
			return {
				card: aliased,
				matchedVia: candidate.via === "exact" ? "alias" : candidate.via,
				matchedKey: candidate.key,
			};
		}
	}

	for (const { prefix, card } of index.prefixes) {
		if (key.startsWith(prefix)) {
			return { card, matchedVia: "prefix", matchedKey: prefix };
		}
	}

	return null;
}

/**
 * Resolve one numeric capability, treating 0 and negatives as "not set".
 *
 * Zero has to mean "not set" rather than "zero tokens": a card the user created
 * for a price alone leaves the window at its form default of 0, and honouring
 * that literally would report a zero-token context window.
 */
function positiveOrUndefined(value: number | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.trunc(value);
}

/** The card's context window, or undefined when the card does not assert one. */
export function cardContextWindow(card: ModelCard | undefined): number | undefined {
	return positiveOrUndefined(card?.contextWindow);
}

/** The card's max completion tokens, or undefined when not asserted. */
export function cardMaxCompletionTokens(card: ModelCard | undefined): number | undefined {
	return positiveOrUndefined(card?.maxCompletionTokens);
}

/**
 * Resolve ONE field by walking the match chain until a card actually asserts it.
 *
 * Necessary because "the card that matches" and "the card that answers this
 * question" are not the same card. Cards are sparse by design — a price-only
 * card carries no window — and the match chain has several rungs, so
 * first-match-wins would let a card win the match and then answer `undefined`,
 * silently dropping the caller to its bottom fallback.
 *
 * Concretely: `claude-sonnet-4-5-20260101` strips to `claude-sonnet-4-5`, which
 * is a pricing card with no window. Stopping there reports 128k for a 200k
 * model. Continuing the walk reaches the `claude-sonnet-4` prefix card and its
 * real 200k — which is exactly what the pre-card fuzzy match returned.
 *
 * The walk order is identical to {@link lookupModelCard}; only the accept
 * condition differs (the extracted value must be defined).
 */
export function resolveModelCardField<T>(
	model: string | undefined,
	cards: readonly ModelCard[] | ModelCardIndex,
	extract: (card: ModelCard) => T | undefined,
): { value: T; card: ModelCard; matchedVia: ModelCardMatch } | null {
	const key = normalizeModelCardKey(model);
	if (!key) return null;
	const index = isIndex(cards) ? cards : buildModelCardIndex(cards);

	const candidates: Array<{ key: string; via: ModelCardMatch }> = [{ key, via: "exact" }];
	for (const stripped of volatileKeyCandidates(key)) {
		candidates.push({ key: stripped, via: "suffix-stripped" });
	}

	for (const candidate of candidates) {
		const exact = index.byKey.get(candidate.key);
		if (exact) {
			const value = extract(exact);
			if (value !== undefined) return { value, card: exact, matchedVia: candidate.via };
		}
		const aliased = index.byAlias.get(candidate.key);
		if (aliased) {
			const value = extract(aliased);
			if (value !== undefined) {
				return {
					value,
					card: aliased,
					matchedVia: candidate.via === "exact" ? "alias" : candidate.via,
				};
			}
		}
	}

	for (const { prefix, card } of index.prefixes) {
		if (!key.startsWith(prefix)) continue;
		const value = extract(card);
		if (value !== undefined) return { value, card, matchedVia: "prefix" };
	}

	return null;
}

/**
 * The card's effort tiers, or undefined when not asserted.
 *
 * `none` is filtered out even if a card somehow carries it (hand-edited
 * settings.json, or an older card written before this rule): letting it through
 * would make it a clamp target and could turn a requested `low` into thinking
 * being switched off entirely.
 */
export function cardEffortLevels(card: ModelCard | undefined): ReasoningEffort[] | undefined {
	const levels = card?.effortLevels;
	if (!levels?.length) return undefined;
	const filtered = levels.filter((level) => level !== "none");
	return filtered.length > 0 ? filtered : undefined;
}
