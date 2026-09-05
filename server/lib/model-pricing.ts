/**
 * Official reference prices per model, in USD per 1M tokens.
 *
 * These are the vendors' published list prices, used to attribute a dollar
 * figure to token usage. For subscription-based access (Codex on a ChatGPT
 * Pro/Plus plan) the resulting number is an *equivalent* cost —
 * what the same tokens would have cost through the metered API — not an amount
 * actually billed. Call sites that surface it to users must say so.
 *
 * Cache columns follow each vendor's own rule:
 *   - OpenAI GPT-5.6+: cacheCreation = input × 1.25, cacheRead = input × 0.10
 *   - Other OpenAI rows: no separate cache-write fee, so cacheCreation = 0 and
 *     cacheRead is the published cached-input price
 *   - Anthropic: cacheCreation = input × 1.25, cacheRead = input × 0.10
 *
 * SCOPE: this table covers the `gpt` and `claude` families only — the models
 * reachable through Codex, Anthropic and OpenAI. Every other provider
 * (gemini, nug and any custom OpenAI-compatible endpoint) is
 * intentionally unpriced here and depends on `settings.pricing.overrides`. Their
 * requests land in `unpricedRequestCount` and the UI marks the total partial,
 * which is the honest outcome: guessing a rate would silently fabricate spend.
 * Add a family here only with the vendor's published list prices in hand.
 *
 * Values are best-effort as of authoring. Vendors change prices faster than we
 * ship releases, so `settings.pricing.overrides` can correct any row at runtime
 * without waiting for an update.
 */

import { normalizeModelCardKey, volatileKeyCandidates } from "@shared/model-card";
import { logger } from "./logger";
import { BUILTIN_MODEL_CARDS } from "./model-cards/builtin";

export interface ModelPricing {
	/** USD per 1M input (uncached) tokens. */
	input: number;
	/** USD per 1M output tokens. */
	output: number;
	/** USD per 1M cache-read (cached input) tokens. */
	cacheRead: number;
	/** USD per 1M cache-write tokens. 0 = the vendor charges no separate fee. */
	cacheWrite: number;
}

export interface ModelPricingEntry extends ModelPricing {
	/** Canonical, already-normalized model key. */
	modelKey: string;
	/** Alternate spellings that resolve to this row. */
	aliases?: readonly string[];
	/** Vendor family, for grouping in diagnostics. */
	family: string;
}

export interface ResolvedModelPricing extends ModelPricing {
	/** The table row that matched, after alias/suffix resolution. */
	modelKey: string;
	/** How the lookup landed on this row. */
	matchedVia: "exact" | "alias" | "suffix-stripped" | "override";
	/** True when a settings override contributed any field. */
	overridden: boolean;
}

/*
 * The date/snapshot suffix rules and the key normalization used here now live in
 * `@shared/model-card` (VOLATILE_SUFFIX_PATTERNS / volatileKeyCandidates /
 * normalizeModelCardKey), because model cards need exactly the same matching.
 * Keeping a second copy here would let the two drift, and a drift shows up as a
 * model priced from one row while its window comes from another.
 */

/**
 * The priced rows, derived from the builtin model cards.
 *
 * The prices used to live here as two literal arrays, duplicating the window and
 * effort data that also described the same models. They are now one field on one
 * card per model, and this table is projected from the cards that carry a price.
 *
 * Deriving rather than duplicating is the point: a hand-maintained copy drifts,
 * and drift here is invisible — a model would be priced from one row while its
 * context window came from another, with both numbers looking plausible.
 *
 * Cards with no `officialPricing` are skipped: they exist to describe a window or
 * effort tiers, and inventing a zero price for them would report a real request
 * as costing nothing instead of as unpriced.
 */
function pricingEntriesFromCards(): ModelPricingEntry[] {
	const entries: ModelPricingEntry[] = [];
	for (const card of BUILTIN_MODEL_CARDS) {
		const pricing = card.officialPricing;
		if (!pricing) continue;
		const input = pricing.input ?? 0;
		const output = pricing.output ?? 0;
		// A card whose price fields are all zero is not a priced card.
		if (input <= 0 && output <= 0) continue;
		entries.push({
			modelKey: normalizeModelCardKey(card.modelKey),
			...(card.aliases?.length ? { aliases: card.aliases } : {}),
			family: card.family ?? "",
			input,
			output,
			cacheRead: pricing.cacheRead ?? 0,
			cacheWrite: pricing.cacheWrite ?? 0,
		});
	}
	return entries;
}

export const MODEL_PRICING_TABLE: readonly ModelPricingEntry[] = pricingEntriesFromCards();

/**
 * Normalize a model identifier for lookup: strip any `provider:` prefix, lower
 * case it, and drop surrounding whitespace. Vendor-specific separators are left
 * alone — `gpt-5.4` and `gpt-5-4` are different strings and only the published
 * spelling is matched, with `aliases` covering the known alternates.
 *
 * Re-exported under the pricing name for the existing call sites; the
 * implementation is shared with model cards so both resolve a given id the same
 * way.
 */
export const normalizeModelPricingKey = normalizeModelCardKey;

interface PricingIndex {
	byKey: Map<string, ModelPricingEntry>;
	byAlias: Map<string, ModelPricingEntry>;
}

let cachedIndex: PricingIndex | undefined;

function pricingIndex(): PricingIndex {
	if (cachedIndex) return cachedIndex;
	const byKey = new Map<string, ModelPricingEntry>();
	const byAlias = new Map<string, ModelPricingEntry>();
	for (const entry of MODEL_PRICING_TABLE) {
		byKey.set(entry.modelKey.toLowerCase(), entry);
		for (const alias of entry.aliases ?? []) {
			byAlias.set(alias.toLowerCase(), entry);
		}
	}
	cachedIndex = { byKey, byAlias };
	return cachedIndex;
}

/**
 * Overrides supplied by the operator. Kept as a module-level snapshot rather
 * than reading `settings` on every call: pricing is consulted once per request
 * completion, but `settings` pulls in a large module graph and we do not want
 * this file to depend on it.
 */
let pricingOverrides: Record<string, Partial<ModelPricing>> = {};

/** Install operator pricing overrides (keys are normalized on the way in). */
export function setModelPricingOverrides(
	overrides?: Record<string, Partial<ModelPricing>> | null,
): void {
	const next: Record<string, Partial<ModelPricing>> = {};
	for (const [rawKey, value] of Object.entries(overrides ?? {})) {
		const key = normalizeModelPricingKey(rawKey);
		if (!key || !value) continue;
		next[key] = value;
	}
	pricingOverrides = next;
}

/** Current overrides, for diagnostics and tests. */
export function getModelPricingOverrides(): Record<string, Partial<ModelPricing>> {
	return { ...pricingOverrides };
}

function finiteNonNegative(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

function applyOverride(
	base: ModelPricing,
	override?: Partial<ModelPricing>,
): { pricing: ModelPricing; overridden: boolean } {
	if (!override) return { pricing: base, overridden: false };
	const input = finiteNonNegative(override.input);
	const output = finiteNonNegative(override.output);
	const cacheRead = finiteNonNegative(override.cacheRead);
	const cacheWrite = finiteNonNegative(override.cacheWrite);
	if (
		input === undefined &&
		output === undefined &&
		cacheRead === undefined &&
		cacheWrite === undefined
	) {
		return { pricing: base, overridden: false };
	}
	return {
		pricing: {
			input: input ?? base.input,
			output: output ?? base.output,
			cacheRead: cacheRead ?? base.cacheRead,
			cacheWrite: cacheWrite ?? base.cacheWrite,
		},
		overridden: true,
	};
}

const ZERO_PRICING: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const loggedUnknownModels = new Set<string>();

/**
 * Resolve the reference price for a model, in priority order:
 *
 *   1. exact normalized key
 *   2. alias exact match
 *   3. the same two, for each date/snapshot-suffix-stripped candidate
 *
 * Returns null when nothing matches, so callers can distinguish "free" from
 * "unpriced" instead of recording a misleading 0. An override alone is enough
 * to price a model that has no table row at all.
 */
export function resolveModelPricing(model?: string): ResolvedModelPricing | null {
	const key = normalizeModelPricingKey(model);
	if (!key) return null;

	const { byKey, byAlias } = pricingIndex();

	const candidates: Array<{ key: string; via: ResolvedModelPricing["matchedVia"] }> = [
		{ key, via: "exact" },
	];
	for (const stripped of volatileKeyCandidates(key)) {
		candidates.push({ key: stripped, via: "suffix-stripped" });
	}

	for (const candidate of candidates) {
		const override = pricingOverrides[candidate.key];
		const exact = byKey.get(candidate.key);
		if (exact) {
			const { pricing, overridden } = applyOverride(exact, override);
			return { ...pricing, modelKey: exact.modelKey, matchedVia: candidate.via, overridden };
		}
		const aliased = byAlias.get(candidate.key);
		if (aliased) {
			const { pricing, overridden } = applyOverride(aliased, override);
			return {
				...pricing,
				modelKey: aliased.modelKey,
				matchedVia: candidate.via === "exact" ? "alias" : candidate.via,
				overridden,
			};
		}
		// An override for an unknown model is authoritative on its own: it lets an
		// operator price a newly released model before the table catches up.
		if (override) {
			const { pricing, overridden } = applyOverride(ZERO_PRICING, override);
			if (overridden) {
				return { ...pricing, modelKey: candidate.key, matchedVia: "override", overridden: true };
			}
		}
	}

	// Log each unknown model once so missing rows are discoverable without
	// spamming a line per request.
	if (!loggedUnknownModels.has(key)) {
		loggedUnknownModels.add(key);
		logger.debug("No reference price for model; cost will be omitted", { model: key });
	}
	return null;
}

/** Test helper: drop the memoized index, overrides and unknown-model log. */
export function __resetModelPricingForTests(): void {
	cachedIndex = undefined;
	pricingOverrides = {};
	loggedUnknownModels.clear();
}
