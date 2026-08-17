/**
 * Builtin model cards — the seed data that replaced four hardcoded tables.
 *
 * Merged, key by key, from:
 *
 *   1. `BUILTIN_CONTEXT_WINDOWS`   (settings/provider.ts)  → contextWindow,
 *                                                            maxCompletionTokens
 *   2. `CODEX_MODEL_REASONING_LEVELS` (agent/openai-provider.ts) → effortLevels
 *   3. `MODEL_PRICING_TABLE`       (model-pricing.ts)      → officialPricing,
 *                                                            aliases, family
 *   4. the per-model half of NarratorPanel's effort tables → effortLevels
 *
 * ## Why nearly every card declares its own key as a matchPrefix
 *
 * The pre-card window lookup ran an unconditional `startsWith` pass over every
 * table key, sorted longest-first. That implicit behaviour is what made ids the
 * table never listed resolve at all:
 *
 *   claude-opus-4-6-thinking   → claude-opus-4-6   → 1M   (Antigravity's naming)
 *   gpt-5.4-mini-2026-01-01    → gpt-5.4-mini      → 400k
 *   claude-sonnet-4-5-20260101 → claude-sonnet-4   → 200k
 *
 * Cards match strictly (exact → alias → date-suffix-stripped → declared
 * prefixes), so dropping the implicit pass would send all of those to the 128k
 * fallback — with no error, just auto-compact firing at the wrong time. Seeding
 * each key as its own prefix preserves the old semantics exactly, while new
 * user-authored cards start with no prefix rule (matching NUG's stricter
 * default, where a prefix is something an admin opts into).
 *
 * `tests/server/lib/model-card-context-window-parity.test.ts` holds the old
 * table and the old lookup as an independent oracle and asserts every id agrees.
 *
 * ## effortLevels never contain `none`
 *
 * The backend table omitted `none` (it early-returns before the lookup); the
 * frontend table included it (it drives menu items). Cards follow the backend
 * and omit it. Storing `none` would make it a clamp target, so a requested
 * `low` on a model whose lowest real tier is `medium` could clamp to `none` —
 * thinking silently switched off. The UI appends `none` when the provider can
 * disable thinking at all.
 *
 * ## Family-level effort tables are deliberately NOT expanded here
 *
 * Anthropic / Gemini / DeepSeek pick tiers by family, not per model (four tables
 * in NarratorPanel). Expanding those into hundreds of cards would be a
 * transcription exercise with no upside, and `isDeepSeekModel` is a substring
 * test that no card can express. Those cards leave `effortLevels` empty and the
 * existing family logic remains the fallback — the "a card may assert nothing"
 * policy doing its job.
 */

import type { ModelCard } from "@shared/model-card";

/**
 * Codex effort tiers, from `CODEX_MODEL_REASONING_LEVELS`.
 *
 * The upstream catalog also lists `ultra` for Sol/Terra, which NarraFork's enum
 * stops short of; it stays unsurfaced here for the same reason it did there.
 */
const CODEX_MAX_TIERS: ModelCard["effortLevels"] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_XHIGH_TIERS: ModelCard["effortLevels"] = ["low", "medium", "high", "xhigh"];

export const BUILTIN_MODEL_CARDS: readonly ModelCard[] = [
	// ---------------------------------------------------------------- GPT / Codex
	{
		modelKey: "gpt-5.6-sol",
		displayName: "GPT-5.6 Sol",
		family: "gpt",
		builtin: true,
		aliases: ["gpt-5.6"],
		matchPrefixes: ["gpt-5.6-sol"],
		contextWindow: 372_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_MAX_TIERS,
		officialPricing: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		modelKey: "gpt-5.6-terra",
		displayName: "GPT-5.6 Terra",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.6-terra"],
		contextWindow: 372_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_MAX_TIERS,
		officialPricing: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 3.125 },
	},
	{
		modelKey: "gpt-5.6-luna",
		displayName: "GPT-5.6 Luna",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.6-luna"],
		contextWindow: 372_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_MAX_TIERS,
		officialPricing: { input: 1.0, output: 6.0, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	{
		modelKey: "gpt-5.5",
		displayName: "GPT-5.5",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.5"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.4",
		displayName: "GPT-5.4",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.4"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.4-mini",
		displayName: "GPT-5.4 Mini",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.4-mini"],
		contextWindow: 400_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.3-codex",
		displayName: "GPT-5.3 Codex",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.3-codex"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.3-codex-spark",
		displayName: "GPT-5.3 Codex Spark",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.3-codex-spark"],
		contextWindow: 128_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.2",
		displayName: "GPT-5.2",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.2"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.2-codex",
		displayName: "GPT-5.2 Codex",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.2-codex"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.1-codex",
		displayName: "GPT-5.1 Codex",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.1-codex"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: ["low", "medium", "high"],
		officialPricing: { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.1-codex-max",
		displayName: "GPT-5.1 Codex Max",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.1-codex-max"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: CODEX_XHIGH_TIERS,
		officialPricing: { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5.1-codex-mini",
		displayName: "GPT-5.1 Codex Mini",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5.1-codex-mini"],
		contextWindow: 272_000,
		maxCompletionTokens: 128_000,
		effortLevels: ["medium", "high"],
		officialPricing: { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0 },
	},
	{
		modelKey: "gpt-5-codex",
		displayName: "GPT-5 Codex",
		family: "gpt",
		builtin: true,
		matchPrefixes: ["gpt-5-codex"],
		contextWindow: 256_000,
		maxCompletionTokens: 128_000,
	},

	// ------------------------------------------------------------------- DeepSeek
	{
		modelKey: "deepseek-chat",
		displayName: "DeepSeek Chat",
		family: "deepseek",
		builtin: true,
		matchPrefixes: ["deepseek-chat"],
		contextWindow: 64_000,
	},
	{
		modelKey: "deepseek-reasoner",
		displayName: "DeepSeek Reasoner",
		family: "deepseek",
		builtin: true,
		matchPrefixes: ["deepseek-reasoner"],
		contextWindow: 64_000,
	},

	// --------------------------------------------------------------------- Claude
	//
	// The 4.6+ / 5-series rows carry 1M. Both spellings of each version exist as
	// separate cards (`-4-6` and `-4.6`) exactly as the old table had them: they
	// are distinct strings, and the separator is not normalized away.
	{
		modelKey: "claude-opus-4-8",
		displayName: "Claude Opus 4.8",
		family: "claude",
		builtin: true,
		aliases: ["claude-opus-4.8"],
		matchPrefixes: ["claude-opus-4-8", "claude-opus-4.8"],
		contextWindow: 1_000_000,
		officialPricing: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		modelKey: "claude-sonnet-4-8",
		displayName: "Claude Sonnet 4.8",
		family: "claude",
		builtin: true,
		aliases: ["claude-sonnet-4.8"],
		matchPrefixes: ["claude-sonnet-4-8", "claude-sonnet-4.8"],
		contextWindow: 1_000_000,
	},
	{
		modelKey: "claude-opus-4-7",
		displayName: "Claude Opus 4.7",
		family: "claude",
		builtin: true,
		aliases: ["claude-opus-4.7"],
		matchPrefixes: ["claude-opus-4-7", "claude-opus-4.7"],
		contextWindow: 1_000_000,
		officialPricing: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		modelKey: "claude-sonnet-4-7",
		displayName: "Claude Sonnet 4.7",
		family: "claude",
		builtin: true,
		aliases: ["claude-sonnet-4.7"],
		matchPrefixes: ["claude-sonnet-4-7", "claude-sonnet-4.7"],
		contextWindow: 1_000_000,
	},
	{
		modelKey: "claude-opus-4-6",
		displayName: "Claude Opus 4.6",
		family: "claude",
		builtin: true,
		aliases: ["claude-opus-4.6"],
		matchPrefixes: ["claude-opus-4-6", "claude-opus-4.6"],
		contextWindow: 1_000_000,
		officialPricing: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		modelKey: "claude-sonnet-4-6",
		displayName: "Claude Sonnet 4.6",
		family: "claude",
		builtin: true,
		aliases: ["claude-sonnet-4.6"],
		matchPrefixes: ["claude-sonnet-4-6", "claude-sonnet-4.6"],
		contextWindow: 1_000_000,
		officialPricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		modelKey: "claude-opus-5",
		displayName: "Claude Opus 5",
		family: "claude",
		builtin: true,
		matchPrefixes: ["claude-opus-5"],
		contextWindow: 1_000_000,
	},
	{
		modelKey: "claude-sonnet-5",
		displayName: "Claude Sonnet 5",
		family: "claude",
		builtin: true,
		matchPrefixes: ["claude-sonnet-5"],
		contextWindow: 1_000_000,
	},
	{
		modelKey: "claude-fable-5",
		displayName: "Claude Fable 5",
		family: "claude",
		builtin: true,
		matchPrefixes: ["claude-fable-5"],
		contextWindow: 1_000_000,
	},
	{
		modelKey: "claude-mythos-5",
		displayName: "Claude Mythos 5",
		family: "claude",
		builtin: true,
		matchPrefixes: ["claude-mythos-5"],
		contextWindow: 1_000_000,
	},
	{
		modelKey: "claude-mythos-preview",
		displayName: "Claude Mythos Preview",
		family: "claude",
		builtin: true,
		matchPrefixes: ["claude-mythos-preview"],
		contextWindow: 1_000_000,
	},
	// The 4.5 generation: 200k, the oldest Claude still carried.
	//
	// Each row states its own `contextWindow` and prefix. Before the pre-4.5
	// models were dropped, these cards carried only a price and inherited 200k
	// from the `claude-opus-4` / `claude-sonnet-4` base rows; deleting those rows
	// would have sent every 4.5 model to the 128k fallback with no error — the
	// model would keep answering while auto-compact fired far too early.
	//
	// The `claude-opus` / `claude-sonnet` / `claude-haiku` bare aliases exist
	// stay pinned to the 4.5 generation they referred to when introduced.
	{
		modelKey: "claude-opus-4-5",
		displayName: "Claude Opus 4.5",
		family: "claude",
		builtin: true,
		aliases: ["claude-opus-4.5", "claude-opus"],
		matchPrefixes: ["claude-opus-4-5", "claude-opus-4.5"],
		contextWindow: 200_000,
		officialPricing: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		modelKey: "claude-sonnet-4-5",
		displayName: "Claude Sonnet 4.5",
		family: "claude",
		builtin: true,
		aliases: ["claude-sonnet-4.5", "claude-sonnet"],
		matchPrefixes: ["claude-sonnet-4-5", "claude-sonnet-4.5"],
		contextWindow: 200_000,
		officialPricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		// 200k is asserted here for the first time. Haiku 4.5 previously resolved
		// to the 128k fallback, because no `claude-haiku-4` base row ever existed
		// for it to inherit from — a real gap, not a consequence of this deletion.
		modelKey: "claude-haiku-4-5",
		displayName: "Claude Haiku 4.5",
		family: "claude",
		builtin: true,
		aliases: ["claude-haiku-4.5", "claude-haiku"],
		matchPrefixes: ["claude-haiku-4-5", "claude-haiku-4.5"],
		contextWindow: 200_000,
		officialPricing: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	{
		modelKey: "gemini-3-pro-preview",
		displayName: "Gemini 3 Pro Preview",
		family: "gemini",
		builtin: true,
		matchPrefixes: ["gemini-3-pro-preview"],
		contextWindow: 1_048_576,
		maxCompletionTokens: 65_536,
	},
	{
		modelKey: "gemini-3-flash-preview",
		displayName: "Gemini 3 Flash Preview",
		family: "gemini",
		builtin: true,
		matchPrefixes: ["gemini-3-flash-preview"],
		contextWindow: 1_048_576,
		maxCompletionTokens: 65_536,
	},
];
