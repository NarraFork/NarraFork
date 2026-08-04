/**
 * Official reference prices per model, in USD per 1M tokens.
 *
 * These are the vendors' published list prices, used to attribute a dollar
 * figure to token usage. For subscription-based access (Codex on a ChatGPT
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
 * intentionally unpriced here and depends on `settings.pricing.overrides`. Their
 * requests land in `unpricedRequestCount` and the UI marks the total partial,
 * which is the honest outcome: guessing a rate would silently fabricate spend.
 * Add a family here only with the vendor's published list prices in hand.
 *
 * Values are best-effort as of authoring. Vendors change prices faster than we
 * ship releases, so `settings.pricing.overrides` can correct any row at runtime
 * without waiting for an update.
 */

import { parseModelId } from "@shared/model-id";
import { logger } from "./logger";

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

/**
 * Suffixes that identify a dated snapshot or channel of the *same* model and
 * are therefore safe to strip before matching (`-2026-06-01`, `-20260601`,
 * `-260601`, `-latest`, `-preview`).
 *
 * Semantic suffixes (`-mini`, `-codex`, `-thinking`, `-fast`, `-max`, `-spark`)
 * are deliberately absent: stripping them would collapse a cheap variant onto
 * its far more expensive base model and silently inflate every cost figure.
 *
 * The numeric forms are constrained to plausible dates (`20` century for the
 * 8-digit form, months 01-12 for both) rather than "any 6 or 8 digits". Without
 * that, a name whose trailing digits are a *version* — `foo-202601`, `bar-5000`
 * — would be stripped, and if the reduced form happened to hit another table row
 * the request would be priced at the wrong rate instead of reported as unpriced.
 * Mispricing silently is worse than not pricing at all.
 */
const VOLATILE_SUFFIX_PATTERNS: readonly RegExp[] = [
	// 2026-06-01
	/-\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/,
	// 20260601 — four-digit year starting with 20, then a real month.
	/-20\d{2}(?:0[1-9]|1[0-2])\d{2}$/,
	// 260601 — two-digit year, then a real month.
	/-\d{2}(?:0[1-9]|1[0-2])\d{2}$/,
	/-latest$/,
	/-preview$/,
];

/** GPT / Codex rows. */
const GPT_PRICING: readonly ModelPricingEntry[] = [
	// GPT-5.6 family charges a separate cache-write fee (input × 1.25).
	{
		modelKey: "gpt-5.6-sol",
		aliases: ["gpt-5.6"],
		family: "gpt",
		input: 5.0,
		cacheWrite: 6.25,
		cacheRead: 0.5,
		output: 30.0,
	},
	{
		modelKey: "gpt-5.6-terra",
		family: "gpt",
		input: 2.5,
		cacheWrite: 3.125,
		cacheRead: 0.25,
		output: 15.0,
	},
	{
		modelKey: "gpt-5.6-luna",
		family: "gpt",
		input: 1.0,
		cacheWrite: 1.25,
		cacheRead: 0.1,
		output: 6.0,
	},
	// Pre-5.6 GPT rows: cached input is billed at a discount, no cache-write fee.
	{ modelKey: "gpt-5.5", family: "gpt", input: 5.0, cacheWrite: 0, cacheRead: 0.5, output: 30.0 },
	{ modelKey: "gpt-5.4", family: "gpt", input: 2.5, cacheWrite: 0, cacheRead: 0.25, output: 15.0 },
	{
		modelKey: "gpt-5.4-mini",
		family: "gpt",
		input: 0.75,
		cacheWrite: 0,
		cacheRead: 0.075,
		output: 4.5,
	},
	{
		modelKey: "gpt-5.3-codex",
		family: "gpt",
		input: 1.75,
		cacheWrite: 0,
		cacheRead: 0.175,
		output: 14.0,
	},
	{
		modelKey: "gpt-5.3-codex-spark",
		family: "gpt",
		input: 1.75,
		cacheWrite: 0,
		cacheRead: 0.175,
		output: 14.0,
	},
	{
		modelKey: "gpt-5.2",
		family: "gpt",
		input: 1.75,
		cacheWrite: 0,
		cacheRead: 0.175,
		output: 14.0,
	},
	{
		modelKey: "gpt-5.2-codex",
		family: "gpt",
		input: 1.75,
		cacheWrite: 0,
		cacheRead: 0.175,
		output: 14.0,
	},
	{
		modelKey: "gpt-5.1-codex",
		family: "gpt",
		input: 1.25,
		cacheWrite: 0,
		cacheRead: 0.125,
		output: 10.0,
	},
	{
		modelKey: "gpt-5.1-codex-max",
		family: "gpt",
		input: 1.25,
		cacheWrite: 0,
		cacheRead: 0.125,
		output: 10.0,
	},
	{
		modelKey: "gpt-5.1-codex-mini",
		family: "gpt",
		input: 0.25,
		cacheWrite: 0,
		cacheRead: 0.025,
		output: 2.0,
	},
	{ modelKey: "gpt-4o", family: "gpt", input: 2.5, cacheWrite: 0, cacheRead: 1.25, output: 10.0 },
	{
		modelKey: "gpt-4o-mini",
		family: "gpt",
		input: 0.15,
		cacheWrite: 0,
		cacheRead: 0.075,
		output: 0.6,
	},
];

/**
 * Claude rows. Keys use the date-stripped canonical form; dated snapshot names
 * (`claude-opus-4-6-20260514`) match after suffix stripping.
 *
 * The bare `claude-opus` / `claude-sonnet` / `claude-haiku` aliases exist
 * backward compatibility. They are pinned to the 4.5 rows — the generation they
 * instead of permanently inflating `unpricedRequestCount`. An operator who wants
 * a different generation can override the key.
 */
const CLAUDE_PRICING: readonly ModelPricingEntry[] = [
	{
		modelKey: "claude-opus-4-8",
		aliases: ["claude-opus-4.8"],
		family: "claude",
		input: 5.0,
		cacheWrite: 6.25,
		cacheRead: 0.5,
		output: 25.0,
	},
	{
		modelKey: "claude-opus-4-7",
		aliases: ["claude-opus-4.7"],
		family: "claude",
		input: 5.0,
		cacheWrite: 6.25,
		cacheRead: 0.5,
		output: 25.0,
	},
	{
		modelKey: "claude-opus-4-6",
		aliases: ["claude-opus-4.6"],
		family: "claude",
		input: 5.0,
		cacheWrite: 6.25,
		cacheRead: 0.5,
		output: 25.0,
	},
	{
		modelKey: "claude-opus-4-5",
		aliases: ["claude-opus-4.5", "claude-opus"],
		family: "claude",
		input: 5.0,
		cacheWrite: 6.25,
		cacheRead: 0.5,
		output: 25.0,
	},
	{
		modelKey: "claude-sonnet-4-6",
		aliases: ["claude-sonnet-4.6"],
		family: "claude",
		input: 3.0,
		cacheWrite: 3.75,
		cacheRead: 0.3,
		output: 15.0,
	},
	{
		modelKey: "claude-sonnet-4-5",
		aliases: ["claude-sonnet-4.5", "claude-sonnet"],
		family: "claude",
		input: 3.0,
		cacheWrite: 3.75,
		cacheRead: 0.3,
		output: 15.0,
	},
	{
		modelKey: "claude-haiku-4-5",
		aliases: ["claude-haiku-4.5", "claude-haiku"],
		family: "claude",
		input: 1.0,
		cacheWrite: 1.25,
		cacheRead: 0.1,
		output: 5.0,
	},
	// Legacy 3.x rows, kept so historical requests still price out.
	{
		modelKey: "claude-3-7-sonnet",
		aliases: ["claude-3.7-sonnet"],
		family: "claude",
		input: 3.0,
		cacheWrite: 3.75,
		cacheRead: 0.3,
		output: 15.0,
	},
	{
		modelKey: "claude-3-5-sonnet",
		aliases: ["claude-3.5-sonnet"],
		family: "claude",
		input: 3.0,
		cacheWrite: 3.75,
		cacheRead: 0.3,
		output: 15.0,
	},
	{
		modelKey: "claude-3-5-haiku",
		aliases: ["claude-3.5-haiku"],
		family: "claude",
		input: 0.8,
		cacheWrite: 1.0,
		cacheRead: 0.08,
		output: 4.0,
	},
];

export const MODEL_PRICING_TABLE: readonly ModelPricingEntry[] = [
	...GPT_PRICING,
	...CLAUDE_PRICING,
];

/**
 * Normalize a model identifier for lookup: strip any `provider:` prefix, lower
 * case it, and drop surrounding whitespace. Vendor-specific separators are left
 * alone — `gpt-5.4` and `gpt-5-4` are different strings and only the published
 * spelling is matched, with `aliases` covering the known alternates.
 */
export function normalizeModelPricingKey(model?: string): string {
	if (!model) return "";
	return parseModelId(model.trim()).model.trim().toLowerCase();
}

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
 * Progressively strip volatile date/snapshot suffixes, yielding each reduced
 * form. Applied repeatedly so `x-preview-2026-06-01` reduces step by step.
 */
function volatileCandidates(key: string): string[] {
	const seen = new Set<string>([key]);
	const candidates: string[] = [];
	let current = key;
	// Bounded so a pathological name cannot spin here.
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
	for (const stripped of volatileCandidates(key)) {
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
