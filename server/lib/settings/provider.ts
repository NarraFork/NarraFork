/**
 * Provider resolution, model parsing, context window management, and model registry.
 * Extracted from the monolithic settings/index.ts.
 */
import { getCodexManager } from "../codex-manager";
import { resolveNugModelMeta } from "../nug-model-cache";
import type {
	AnthropicProviderConfig,
	ClineProviderConfig,
	GeminiProviderConfig,
	ModelAggregation,
	NarraForkSettings,
	NUGProviderConfig,
	OpenAIProviderConfig,
} from "./types";

// The settings singleton is imported lazily to avoid circular dependency.
// All functions that need settings receive it via the module-level getter.
let _settings: NarraForkSettings | null = null;
export function _bindSettings(s: NarraForkSettings): void {
	_settings = s;
}
function s(): NarraForkSettings {
	if (!_settings) throw new Error("settings not initialized — call _bindSettings first");
	return _settings;
}

// ---------------------------------------------------------------------------
// Built-in model lists
// ---------------------------------------------------------------------------

	"claude-haiku-4.5",
	"claude-sonnet-4.5",
	"claude-opus-4.5",
	"claude-opus-4.6",
	// Legacy short names (for resolveProvider backward compat)
	"claude-haiku",
	"claude-sonnet",
	"claude-opus",
];
const BUILTIN_CODEX_MODELS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
];

/** Built-in Codex model IDs (without provider prefix). */
export function getBuiltinCodexModels(): string[] {
	return [...BUILTIN_CODEX_MODELS];
}

// ---------------------------------------------------------------------------
// Model checker / lister registry (avoids circular imports)
// ---------------------------------------------------------------------------

let openaiModelChecker: ((model: string) => boolean) | null = null;
let anthropicModelChecker: ((model: string) => boolean) | null = null;
let codexModelChecker: ((model: string) => boolean) | null = null;
let nugModelChecker: ((model: string) => boolean) | null = null;
let clineModelChecker: ((model: string) => boolean) | null = null;
let geminiModelChecker: ((model: string) => string | undefined) | null = null;
let openaiModelLister: (() => string[]) | null = null;
let anthropicModelLister: (() => string[]) | null = null;
let codexModelLister: (() => string[]) | null = null;
let nugModelLister: (() => string[]) | null = null;
let clineModelLister: (() => string[]) | null = null;
let geminiModelLister: (() => string[]) | null = null;

// Register codex model checker and lister immediately
registerCodexModelChecker((model) => BUILTIN_CODEX_MODELS.includes(model));
registerCodexModelLister(() => BUILTIN_CODEX_MODELS.map((m) => `codex:${m}`));

export function registerOpenaiModelChecker(checker: (model: string) => boolean): void {
	openaiModelChecker = checker;
}
}
export function registerOpenaiModelLister(lister: () => string[]): void {
	openaiModelLister = lister;
}
}
export function registerAnthropicModelChecker(checker: (model: string) => boolean): void {
	anthropicModelChecker = checker;
}
export function registerAnthropicModelLister(lister: () => string[]): void {
	anthropicModelLister = lister;
}
export function registerCodexModelChecker(checker: (model: string) => boolean): void {
	codexModelChecker = checker;
}
export function registerCodexModelLister(lister: () => string[]): void {
	codexModelLister = lister;
}
export function registerNugModelChecker(checker: (model: string) => boolean): void {
	nugModelChecker = checker;
}
export function registerNugModelLister(lister: () => string[]): void {
	nugModelLister = lister;
}
export function registerClineModelChecker(checker: (model: string) => boolean): void {
	clineModelChecker = checker;
}
export function registerClineModelLister(lister: () => string[]): void {
	clineModelLister = lister;
}
export function registerGeminiModelChecker(checker: (model: string) => string | undefined): void {
	geminiModelChecker = checker;
}
export function registerGeminiModelLister(lister: () => string[]): void {
	geminiModelLister = lister;
}

// ---------------------------------------------------------------------------
// Model ID parsing & effective model resolution
// ---------------------------------------------------------------------------

/**
 * Sentinel value stored in `narrators.model` to indicate "follow the default model from settings".
 */
export const FOLLOW_DEFAULT_MODEL = "__default__";

/**
 * Sentinel value indicating "follow the summary model from settings"
 * (`settings.agent.summaryModel`). Like FOLLOW_DEFAULT_MODEL it is a meta
 * reference that resolves dynamically, so it keeps following the user's
 * summary-model setting rather than being pinned to a concrete model.
 */
export const FOLLOW_SUMMARY_MODEL = "__summary__";

/** Hard fallback used if the configured default model is accidentally self-referential. */

/**
 * Prefix for model aggregation values stored in narrators.model.
 * Format: "__agg__:{aggId}" for auto mode, "__agg__:{aggId}:{provider:model}" for pinned provider.
 */
export const AGG_MODEL_PREFIX = "__agg__:";

/**
 * Parse a model string that may contain a "provider:" prefix.
 */
export function parseModelId(raw?: string): { provider?: string; model: string } {
	if (!raw) return { model: "" };
	const idx = raw.indexOf(":");
	if (idx > 0) {
		const prefix = raw.slice(0, idx);
		return { provider: prefix, model: raw.slice(idx + 1) };
	}
	return { model: raw };
}

/**
 * Parse an aggregation model value.
 * Returns null if the value is not an aggregation.
 */
export function parseAggModelValue(raw?: string | null): {
	aggId: string;
	pinnedModel?: string;
} | null {
	if (!raw?.startsWith(AGG_MODEL_PREFIX)) return null;
	const rest = raw.slice(AGG_MODEL_PREFIX.length);
	// rest is either "aggId" or "aggId:provider:model"
	const firstColon = rest.indexOf(":");
	if (firstColon < 0) return { aggId: rest };
	const aggId = rest.slice(0, firstColon);
	const pinnedModel = rest.slice(firstColon + 1);
	return { aggId, pinnedModel: pinnedModel || undefined };
}

/**
 * Build an aggregation model value string.
 */
export function buildAggModelValue(aggId: string, pinnedModel?: string): string {
	if (pinnedModel) return `${AGG_MODEL_PREFIX}${aggId}:${pinnedModel}`;
	return `${AGG_MODEL_PREFIX}${aggId}`;
}

/**
 * Get an aggregation config by ID.
 */
export function getAggregation(aggId: string): ModelAggregation | undefined {
	return (s().agent.modelAggregations ?? []).find((a) => a.id === aggId);
}

function getDisabledProviderPrefixes(): Set<string> {
	const disabled = new Set(s().agent.disabledProviders ?? []);
	for (const provider of [
		...(s().customApiProviders ?? []),
		...(s().openaiProviders ?? []),
		...(s().anthropicProviders ?? []),
		...(s().nugProviders ?? []),
		...(s().clineProviders ?? []),
		...(s().geminiProviders ?? []),
	]) {
		if (provider.disabled && provider.prefix) disabled.add(provider.prefix);
	}
	return disabled;
}

function isModelProviderDisabled(modelValue: string): boolean {
	const { provider } = parseModelId(modelValue);
	return !!provider && getDisabledProviderPrefixes().has(provider);
}

/** Round-robin counter for balanced aggregation routing. */
const aggRoundRobin = new Map<string, number>();

/**
 * Resolve an aggregation to a concrete model value.
 * @param aggId - The aggregation ID
 * @param stickyProvider - Provider prefix from the last successful call in this session
 * @returns The concrete "provider:model" value, or null if no member is available
 */
export function resolveAggregation(aggId: string, stickyProvider?: string): string | null {
	const agg = getAggregation(aggId);
	if (!agg || agg.models.length === 0) return null;

	const candidates = agg.models.filter((model) => !isModelProviderDisabled(model));
	if (candidates.length === 0) return null;

	if (agg.routingMode === "balanced") {
		// Balanced: the member order sets the round-robin starting sequence, and the
		// sticky provider keeps a given session pinned to the member it landed on so
		// its cache/context stays warm across turns.
		if (stickyProvider) {
			const stickyMatch = candidates.find((m) => parseModelId(m).provider === stickyProvider);
			if (stickyMatch) return stickyMatch;
		}
		const idx = aggRoundRobin.get(aggId) ?? 0;
		const model = candidates[idx % candidates.length];
		aggRoundRobin.set(aggId, idx + 1);
		return model;
	}

	// Priority mode: always honor the configured order and return the first enabled
	// member. Intentionally ignores stickyProvider so the "topmost model is tried
	// first" contract holds — reordering members (or re-enabling a higher-priority
	// one) takes effect on the next request instead of being pinned to whatever the
	// session happened to use last.
	return candidates[0];
}

/**
 * Resolve the effective model string. If the stored value is null, undefined,
 * or the `__default__` sentinel (including accidental `provider:__default__` values),
 * fall back to the configured default model. If that default is itself a sentinel,
 * use a hard fallback so the placeholder is never sent upstream.
 * If the value is an aggregation (`__agg__:id` or `__agg__:id:provider:model`),
 * resolve to the pinned model or delegate to aggregation routing.
 */
function isFollowDefaultModelValue(model: string): boolean {
	if (model === FOLLOW_DEFAULT_MODEL) return true;
	const parsed = parseModelId(model);
	return !!parsed.provider && parsed.model === FOLLOW_DEFAULT_MODEL;
}

function isFollowSummaryModelValue(model: string): boolean {
	if (model === FOLLOW_SUMMARY_MODEL) return true;
	const parsed = parseModelId(model);
	return !!parsed.provider && parsed.model === FOLLOW_SUMMARY_MODEL;
}

function sanitizeResolvedModelCandidate(model: string | null | undefined): string | null {
	const trimmed = model?.trim();
	if (!trimmed) return null;
	if (isFollowDefaultModelValue(trimmed)) return FALLBACK_DEFAULT_MODEL;
	return trimmed;
}

function resolveConfiguredDefaultModel(stickyProvider?: string): string {
	const configured = s().agent.defaultModel?.trim();
	if (!configured || isFollowDefaultModelValue(configured)) return FALLBACK_DEFAULT_MODEL;

	const agg = parseAggModelValue(configured);
	if (agg) {
		if (agg.pinnedModel) {
			return sanitizeResolvedModelCandidate(agg.pinnedModel) ?? FALLBACK_DEFAULT_MODEL;
		}
		return (
			sanitizeResolvedModelCandidate(resolveAggregation(agg.aggId, stickyProvider)) ??
			FALLBACK_DEFAULT_MODEL
		);
	}

	return configured;
}

function resolveConfiguredSummaryModel(stickyProvider?: string): string {
	const configured = s().agent.summaryModel?.trim();
	// Fall back to the default model when summary is unset/self-referential.
	if (!configured || isFollowSummaryModelValue(configured)) {
		return resolveConfiguredDefaultModel(stickyProvider);
	}
	if (isFollowDefaultModelValue(configured)) return resolveConfiguredDefaultModel(stickyProvider);

	const agg = parseAggModelValue(configured);
	if (agg) {
		if (agg.pinnedModel) {
			return sanitizeResolvedModelCandidate(agg.pinnedModel) ?? FALLBACK_DEFAULT_MODEL;
		}
		return (
			sanitizeResolvedModelCandidate(resolveAggregation(agg.aggId, stickyProvider)) ??
			FALLBACK_DEFAULT_MODEL
		);
	}

	return configured;
}

/**
 * Strip a trailing human-readable display annotation from a model reference,
 * e.g. "default (currently S2A:gpt-5.5)" -> "default" or
 * "__agg__:abc (→ x, y)" -> "__agg__:abc". This lets a caller pass back either
 * the bare sentinel/token or the full annotated string shown in descriptions.
 */
function stripModelDisplayAnnotation(model: string): string {
	return model.replace(/\s*\((?:currently|→)[^)]*\)\s*$/i, "").trim();
}

function normalizeModelReference(model: string | null | undefined): string | null {
	const trimmed = stripModelDisplayAnnotation(model?.trim() ?? "");
	if (!trimmed) return null;
	if (trimmed === "default") return FOLLOW_DEFAULT_MODEL;
	if (trimmed === "summary") return FOLLOW_SUMMARY_MODEL;
	return trimmed;
}

function isMetaModelReference(model: string): boolean {
	return (
		isFollowDefaultModelValue(model) ||
		isFollowSummaryModelValue(model) ||
		!!parseAggModelValue(model)
	);
}

function expandModelReferenceForMatching(
	model: string | null | undefined,
	seen = new Set<string>(),
): Set<string> {
	const normalized = normalizeModelReference(model);
	const values = new Set<string>();
	if (!normalized) return values;

	values.add(normalized);
	if (seen.has(normalized)) return values;
	seen.add(normalized);

	if (isFollowDefaultModelValue(normalized)) {
		for (const value of expandModelReferenceForMatching(s().agent.defaultModel, seen)) {
			values.add(value);
		}
		return values;
	}

	if (isFollowSummaryModelValue(normalized)) {
		for (const value of expandModelReferenceForMatching(s().agent.summaryModel, seen)) {
			values.add(value);
		}
		return values;
	}

	const agg = parseAggModelValue(normalized);
	if (!agg) return values;

	if (agg.pinnedModel) {
		for (const value of expandModelReferenceForMatching(agg.pinnedModel, seen)) {
			values.add(value);
		}
		return values;
	}

	for (const member of getAggregation(agg.aggId)?.models ?? []) {
		for (const value of expandModelReferenceForMatching(member, seen)) {
			values.add(value);
		}
	}
	return values;
}

function findConcreteIntersection(left: Set<string>, right: Set<string>): string | null {
	for (const value of left) {
		if (right.has(value) && !isMetaModelReference(value)) return value;
	}
	return null;
}

/**
 * Resolve a candidate model against an allowed-model pool without triggering
 * aggregation routing. This is important for balanced aggregations: validation
 * should not advance round-robin state before the model is actually selected.
 */
export function resolveAllowedModelCandidate(
	candidate: string | null | undefined,
	allowedPool: string[],
): string | null {
	const raw = normalizeModelReference(candidate);
	if (!raw) return null;
	if (allowedPool.length === 0) return raw;

	const candidateValues = expandModelReferenceForMatching(raw);
	for (const allowedRaw of allowedPool) {
		const allowed = normalizeModelReference(allowedRaw);
		if (!allowed) continue;

		const allowedValues = expandModelReferenceForMatching(allowed);
		if (allowedValues.has(raw)) return raw;

		const concrete = findConcreteIntersection(candidateValues, allowedValues);
		if (concrete) return concrete;
	}

	return null;
}

/**
 * Format a pool of (possibly meta) model references for human/agent display.
 *
 * Meta references are kept as their token to preserve their "follow" semantics,
 * but annotated with what they currently resolve to so the agent can pick
 * correctly without guessing:
 *   - follow-default sentinel  -> "default (currently <model>)"
 *   - aggregation              -> "__agg__:<id> (currently <models>)"
 * Concrete models are shown as-is. Order is preserved; duplicate tokens removed.
 *
 * Pass the resulting string (or just the bare token, e.g. "default") back as a
 * model argument — `normalizeModelReference` strips the annotation.
 */
export function expandAllowedPoolForDisplay(pool: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of pool) {
		const normalized = normalizeModelReference(raw);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);

		if (!isMetaModelReference(normalized)) {
			result.push(normalized);
			continue;
		}

		// Meta reference: keep the token, annotate the current concrete target(s).
		const concrete: string[] = [];
		const concreteSeen = new Set<string>();
		for (const value of expandModelReferenceForMatching(normalized)) {
			if (!isMetaModelReference(value) && !concreteSeen.has(value)) {
				concreteSeen.add(value);
				concrete.push(value);
			}
		}
		const token =
			normalized === FOLLOW_DEFAULT_MODEL
				? "default"
				: normalized === FOLLOW_SUMMARY_MODEL
					? "summary"
					: normalized;
		result.push(concrete.length > 0 ? `${token} (currently ${concrete.join(", ")})` : token);
	}
	return result;
}

export function resolveEffectiveModel(
	model: string | null | undefined,
	stickyProvider?: string,
): string {
	const raw = model?.trim();
	if (!raw || isFollowDefaultModelValue(raw)) return resolveConfiguredDefaultModel(stickyProvider);
	if (isFollowSummaryModelValue(raw)) return resolveConfiguredSummaryModel(stickyProvider);

	const agg = parseAggModelValue(raw);
	if (agg) {
		// Pinned to a specific provider within the aggregation
		if (agg.pinnedModel) {
			return (
				sanitizeResolvedModelCandidate(agg.pinnedModel) ??
				resolveConfiguredDefaultModel(stickyProvider)
			);
		}
		// Auto mode — resolve via aggregation routing
		const resolved = sanitizeResolvedModelCandidate(resolveAggregation(agg.aggId, stickyProvider));
		if (resolved) return resolved;
		// Fallback to default if aggregation has no members
		return resolveConfiguredDefaultModel(stickyProvider);
	}

	return raw;
}

/**
 * Get all available model values (provider:id format), excluding hidden models
 * and models from disabled providers.
 */
export function getVisibleModels(): string[] {
	const hidden = new Set(s().agent.hiddenModels ?? []);
	const disabledPrefixes = getDisabledProviderPrefixes();
	const openai = openaiModelLister?.() ?? [];
	const anthropic = anthropicModelLister?.() ?? [];
	const codex = codexModelLister?.() ?? [];
	const nug = nugModelLister?.() ?? [];
	const cline = clineModelLister?.() ?? [];
	const gemini = geminiModelLister?.() ?? [];
	const custom = (s().agent.customModels ?? []).map((m) => {
		const value = m.value ?? "";
		return value.includes(":") ? value : `${m.provider ?? "openai"}:${value}`;
	});
	const seen = new Set<string>();
	const result: string[] = [];
	for (const v of [
		...openai,
		...anthropic,
		...codex,
		...nug,
		...cline,
		...gemini,
		...custom,
	]) {
		if (seen.has(v) || hidden.has(v)) continue;
		const colonIdx = v.indexOf(":");
		if (colonIdx > 0 && disabledPrefixes.has(v.slice(0, colonIdx))) continue;
		seen.add(v);
		result.push(v);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Provider config getters
// ---------------------------------------------------------------------------

export function getOpenaiProviderConfig(prefix?: string): OpenAIProviderConfig | undefined {
	const providers = (s().openaiProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

export function usesCodexApiMode(prefix?: string): boolean {
	if (!prefix) return false;
	if (prefix === "codex") return true;
	return getOpenaiProviderConfig(prefix)?.apiMode === "codex";
}

function resolveNugChannelType(prefix?: string, model?: string): string | undefined {
	if (!prefix || !model) return undefined;
	const config = getNugProviderConfig(prefix);
	if (!config) return undefined;
	try {
		return resolveNugModelMeta(config.id, config.prefix, model).channelType;
	} catch {
		return undefined;
	}
}

export function usesCodexModel(prefix?: string, model?: string): boolean {
	if (usesCodexApiMode(prefix)) return true;
	return resolveNugChannelType(prefix, model) === "codex";
}

export function usesStatefulApi(prefix?: string): boolean {
	if (!prefix) return false;
	if (prefix === "codex") return true;
	const mode = getOpenaiProviderConfig(prefix)?.apiMode;
	return mode === "codex" || mode === "responses";
}

export function usesStatefulModel(prefix?: string, model?: string): boolean {
	if (usesStatefulApi(prefix)) return true;
	if (usesCodexModel(prefix, model)) return true;
	// NUG "responses" channel models use the stateful /responses endpoint too.
	return resolveNugChannelType(prefix, model) === "responses";
}

export function isAnthropicProvider(prefix?: string): boolean {
	if (!prefix) return false;
	return !!getAnthropicProviderConfig(prefix);
}

export function isGeminiProvider(prefix?: string): boolean {
	if (!prefix) return false;
	return !!getGeminiProviderConfig(prefix);
}

/**
 * The single global default reasoning effort. Applies to every model; each
 * provider clamps it down to the model's supported tiers at request time.
 * Per-provider default fields (codex/anthropic/customApi) are no longer
 * consumed — the global `agent.defaultReasoningEffort` is the sole source.
 *
 * The `provider`/`model` params are kept for call-site compatibility but
 * intentionally unused.
 */
export function resolveDefaultReasoningEffort(
	_provider?: string,
	_model?: string,
): "none" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
	return s().agent.defaultReasoningEffort ?? "max";
}

export function openaiProviderPrefix(config: OpenAIProviderConfig): string {
	return config.prefix;
}

export function getAnthropicProviderConfig(prefix?: string): AnthropicProviderConfig | undefined {
	const providers = (s().anthropicProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

export function anthropicProviderPrefix(config: AnthropicProviderConfig): string {
	return config.prefix;
}

export function getNugProviderConfig(prefix?: string): NUGProviderConfig | undefined {
	const providers = (s().nugProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

export function nugProviderPrefix(config: NUGProviderConfig): string {
	return config.prefix;
}

export function getClineProviderConfig(prefix?: string): ClineProviderConfig | undefined {
	const providers = (s().clineProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

export function clineProviderPrefix(config: ClineProviderConfig): string {
	return config.prefix;
}

export function hasConfiguredClineProvider(): boolean {
	const providers = s().clineProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.accessToken);
}

export function getGeminiProviderConfig(prefix?: string): GeminiProviderConfig | undefined {
	const providers = (s().geminiProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

export function geminiProviderPrefix(config: GeminiProviderConfig): string {
	return config.prefix;
}

export function hasConfiguredGeminiProvider(): boolean {
	const providers = s().geminiProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey);
}

function hasConfiguredOpenaiProvider(): boolean {
	const providers = s().openaiProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey);
}

function hasConfiguredAnthropicProvider(): boolean {
	const providers = s().anthropicProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey);
}

}

function hasConfiguredCodexProvider(): boolean {
	if (!s().codex) return false;
	try {
		return getCodexManager().availableCount > 0;
	} catch {
		return false;
	}
}

export function hasConfiguredNugProvider(): boolean {
	const providers = s().nugProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
}

export function getFirstNugProvider(): NUGProviderConfig | undefined {
	return (s().nugProviders ?? []).find((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

function getConfiguredProviderCandidates(): string[] {
	const available = new Set<string>();
	if (hasConfiguredOpenaiProvider()) {
		for (const p of s().openaiProviders ?? []) {
			if (!p.disabled && p.apiKey) available.add(p.prefix || "openai");
		}
	}
	if (hasConfiguredAnthropicProvider()) {
		for (const p of s().anthropicProviders ?? []) {
			if (!p.disabled && p.apiKey) available.add(p.prefix || "anthropic");
		}
	}
	if (hasConfiguredCodexProvider()) {
		available.add("codex");
	}
	if (hasConfiguredNugProvider()) {
		for (const p of s().nugProviders ?? []) {
			if (!p.disabled && p.apiKey && p.baseUrl) available.add(p.prefix || "nug");
		}
	}
	}
	if (hasConfiguredClineProvider()) {
		for (const p of s().clineProviders ?? []) {
			if (!p.disabled && p.accessToken) available.add(p.prefix || "cline");
		}
	}
	if (hasConfiguredGeminiProvider()) {
		for (const p of s().geminiProviders ?? []) {
			if (!p.disabled && p.apiKey) available.add(p.prefix || "gemini");
		}
	}
	const result: string[] = [];

	const preferredOpenai = (s().openaiProviders ?? []).find((p) => p.apiKey)?.prefix;
	if (preferredOpenai && available.has(preferredOpenai)) {
		result.push(preferredOpenai);
	}

	const preferredAnthropic = (s().anthropicProviders ?? []).find((p) => p.apiKey)?.prefix;
	if (preferredAnthropic && available.has(preferredAnthropic)) {
		result.push(preferredAnthropic);
	}

	if (available.has("codex")) {
		result.push("codex");
	}

	}

	for (const provider of available) {
		if (!result.includes(provider)) result.push(provider);
	}
	return result;
}

/** Resolve provider name for a given model (supports "provider:model" prefix). */
export function resolveProvider(model?: string): string {
	const { provider: explicit, model: bare } = parseModelId(model);
	if (explicit) return explicit;

	if (bare) {
		if (BUILTIN_CODEX_MODELS.includes(bare)) return "codex";

		const custom = s().agent.customModels ?? [];
		const found = custom.find((m) => m.value === bare || m.value === model);
		if (found?.provider) return found.provider;

		if (openaiModelChecker?.(bare)) return "openai";
		if (anthropicModelChecker?.(bare)) return "anthropic";
		if (codexModelChecker?.(bare)) return "codex";
		if (nugModelChecker?.(bare)) return "nug";
		if (clineModelChecker?.(bare)) return "cline";
		const geminiPrefix = geminiModelChecker?.(bare);
		if (geminiPrefix) return geminiPrefix;
	}

	const configured = getConfiguredProviderCandidates();
	if (configured.length > 0) {
		return configured[0];
	}

}

// ---------------------------------------------------------------------------
// Context window sizes
// ---------------------------------------------------------------------------

/**
 * Resolve a meta-model reference (follow-default sentinel or aggregation value)
 * to a representative concrete "provider:model" for capability/context-window
 * lookups. Unlike `resolveEffectiveModel`/`resolveAggregation`, this is side
 * effect free: balanced aggregations resolve to their first member instead of
 * advancing the round-robin counter, since lookups must not perturb routing.
 * Concrete or unknown values pass through unchanged.
 */
function resolveMetaModelForLookup(model: string, seen = new Set<string>()): string {
	const raw = model?.trim();
	if (!raw || seen.has(raw)) return raw ?? "";
	seen.add(raw);

	if (isFollowDefaultModelValue(raw)) {
		const configured = s().agent.defaultModel?.trim();
		if (!configured || isFollowDefaultModelValue(configured)) return FALLBACK_DEFAULT_MODEL;
		return resolveMetaModelForLookup(configured, seen);
	}

	const agg = parseAggModelValue(raw);
	if (!agg) return raw;

	if (agg.pinnedModel) return resolveMetaModelForLookup(agg.pinnedModel, seen);

	const first = getAggregation(agg.aggId)?.models[0];
	if (!first) return raw;
	return resolveMetaModelForLookup(first, seen);
}

interface ModelContextConfig {
	contextLength: number;
	maxCompletionTokens?: number;
}

const BUILTIN_CONTEXT_WINDOWS: Record<string, number | ModelContextConfig> = {
	// OpenAI models
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	"gpt-4-turbo": 128_000,
	"gpt-4": 8_192,
	"gpt-3.5-turbo": 16_385,
	o1: 200_000,
	"o1-mini": 128_000,
	"o3-mini": 200_000,
	// Codex models
	"gpt-5.6-sol": { contextLength: 372_000, maxCompletionTokens: 128_000 },
	"gpt-5.6-terra": { contextLength: 372_000, maxCompletionTokens: 128_000 },
	"gpt-5.6-luna": { contextLength: 372_000, maxCompletionTokens: 128_000 },
	"gpt-5-codex": { contextLength: 256_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-max": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-mini": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.5": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4-mini": { contextLength: 400_000, maxCompletionTokens: 128_000 },
	"gpt-5.3-codex-spark": { contextLength: 128_000, maxCompletionTokens: 128_000 },
	"gpt-5.3-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	// Common third-party models
	"deepseek-chat": 64_000,
	"deepseek-reasoner": 64_000,
	// Claude models (via OpenAI-compatible gateways)
	"claude-3-5-sonnet": 200_000,
	"claude-3-opus": 200_000,
	"claude-sonnet-4": 200_000,
	"claude-opus-4": 200_000,
	// Claude 4.6 models — 1M context
	"claude-sonnet-4-6": 1_000_000,
	"claude-opus-4-6": 1_000_000,
	"claude-sonnet-4.6": 1_000_000,
	"claude-opus-4.6": 1_000_000,
	// Anthropic native API models
	"claude-sonnet-4-20250514": 200_000,
	"claude-opus-4-20250514": 200_000,
	"claude-haiku-4-20250414": 200_000,
	"claude-3-5-sonnet-20241022": 200_000,
	"claude-3-5-haiku-20241022": 200_000,
	"claude-3-opus-20240229": 200_000,
	// Google Gemini models
	"gemini-2.5-pro": { contextLength: 1_048_576, maxCompletionTokens: 65_536 },
	"gemini-2.5-flash": { contextLength: 1_048_576, maxCompletionTokens: 65_536 },
	"gemini-2.5-flash-lite": { contextLength: 1_048_576, maxCompletionTokens: 65_536 },
	"gemini-2.0-flash": { contextLength: 1_048_576, maxCompletionTokens: 8_192 },
	"gemini-2.0-flash-lite": { contextLength: 1_048_576, maxCompletionTokens: 8_192 },
	"gemini-1.5-pro": 2_097_152,
	"gemini-1.5-flash": 1_048_576,
	"gemini-3-pro-preview": { contextLength: 1_048_576, maxCompletionTokens: 65_536 },
	"gemini-3-flash-preview": { contextLength: 1_048_576, maxCompletionTokens: 65_536 },
};

function getBuiltinModelContextWindow(model: string): number | null {
	const bareModel = parseModelId(model).model;
	const candidateModels = [bareModel];
	const channelIdx = bareModel.indexOf(":");
	if (channelIdx > 0 && channelIdx < bareModel.length - 1) {
		candidateModels.push(bareModel.slice(channelIdx + 1));
	}

	for (const candidate of candidateModels) {
		// Check built-in table (exact match)
		const builtinConfig = BUILTIN_CONTEXT_WINDOWS[candidate];
		if (builtinConfig !== undefined) {
			return typeof builtinConfig === "number" ? builtinConfig : builtinConfig.contextLength;
		}
	}

	// Fuzzy match
	const sortedEntries = Object.entries(BUILTIN_CONTEXT_WINDOWS).sort(
		(a, b) => b[0].length - a[0].length,
	);
	for (const candidate of candidateModels) {
		const normalizedBare = candidate.toLowerCase();
		for (const [pattern, config] of sortedEntries) {
			if (normalizedBare.startsWith(pattern)) {
				return typeof config === "number" ? config : config.contextLength;
			}
		}
	}

	return null;
}

function getNugModelContextWindow(model: string, provider: string): number | null {
	const config = getNugProviderConfig(provider);
	if (!config) return null;
	try {
		const meta = resolveNugModelMeta(config.id, config.prefix, model);
		return meta.contextWindow ?? getBuiltinModelContextWindow(meta.bareModel);
	} catch {
		return null;
	}
}

export function getBuiltinModelContextWindows(
	models: string[],
	provider: string,
): Record<string, number> {
	const result: Record<string, number> = {};
	for (const model of models) {
		const contextWindow = getBuiltinModelContextWindow(model);
		if (contextWindow) {
			const bareModel = parseModelId(model).model;
			result[provider ? `${provider}:${bareModel}` : model] = contextWindow;
		}
	}
	return result;
}

export function getModelContextWindow(model: string, provider: string): number | null {
	// Defensive: callers may pass a meta-model reference instead of a concrete
	// model — either the follow-default sentinel or an aggregation value. When an
	// aggregation value (`__agg__:<id>`) is split into provider/model halves by a
	// caller, it arrives as provider="__agg__", model="<id>". Resolve such meta
	// references to a representative concrete model first, otherwise the lookup
	// matches nothing and silently falls back to the 128k default (wrong tier for
	// large-context models). Resolution here is side-effect free: it does not
	// advance balanced-aggregation round-robin state.
	const reconstructed = provider ? `${provider}:${model}` : model;
	const metaRef = isMetaModelReference(reconstructed)
		? reconstructed
		: isMetaModelReference(model)
			? model
			: null;
	if (metaRef) {
		const concrete = resolveMetaModelForLookup(metaRef);
		if (concrete && concrete !== metaRef) {
			const parsed = parseModelId(concrete);
			return getModelContextWindow(parsed.model, parsed.provider ?? "");
		}
	}

	const bareModel = parseModelId(model).model;
	const fullModelValue = provider ? `${provider}:${bareModel}` : model;

	// 0. Check per-model user overrides (highest priority)
	const userOverrides = s().agent.modelContextWindows ?? {};
	if (userOverrides[fullModelValue]) {
		return userOverrides[fullModelValue];
	}
	if (model !== fullModelValue && userOverrides[model]) {
		return userOverrides[model];
	}

	// 1. Check NUG model-catalog metadata. NUG model ids often include a
	// channel prefix (e.g. antigravity:claude-opus-4-6-thinking), so the
	// built-in model table alone would otherwise miss them and fall back to 128k.
	const nugContextWindow = getNugModelContextWindow(model, provider);
	if (nugContextWindow) return nugContextWindow;

	// 2. Check provider configuration
		const oaiConfig = getOpenaiProviderConfig(provider);
		if (oaiConfig?.defaultContextWindow) {
			return oaiConfig.defaultContextWindow;
		}
		const anthropicConfig = getAnthropicProviderConfig(provider);
		if (anthropicConfig?.defaultContextWindow) {
			return anthropicConfig.defaultContextWindow;
		}
		const geminiConfig = getGeminiProviderConfig(provider);
		if (geminiConfig?.defaultContextWindow) {
			return geminiConfig.defaultContextWindow;
		}
	}

	// 3. Check built-in table and fuzzy matches
	return getBuiltinModelContextWindow(model) ?? 128_000;
}

/** Threshold above which a model is considered "large context". */
export const LARGE_CONTEXT_BOUNDARY = 600_000;

export const DEFAULT_CONTEXT_THRESHOLDS = {
	standard: { pruneStart: 95, compactStart: 99 },
	large: { pruneStart: 95, compactStart: 99 },
};

export const DEFAULT_AUTO_COMPACT_KEEP_PAIRS = 2;
export const DEFAULT_AUTO_COMPACT_PRUNE_THRESHOLD = 80;
export const DEFAULT_MIN_PRUNE_RATIO = 30;

/**
 * Resolve the summary model's effective context window (tokens).
 */
export function getSummaryModelContextWindow(modelOverride?: string): number {
	const summaryModel = modelOverride?.trim() || s().agent.summaryModel;
	const parsed = parseModelId(summaryModel);
	return getModelContextWindow(parsed.model, prov) ?? 128_000;
}

export function getContextThresholds(
	model: string,
	provider: string,
): { pruneStart: number; compactStart: number } {
	const ctxWin = getModelContextWindow(model, provider) ?? 128_000;
	const tier = ctxWin > LARGE_CONTEXT_BOUNDARY ? "large" : "standard";
	const userThresholds = s().agent.contextThresholds;
	const cfg = userThresholds?.[tier] ?? DEFAULT_CONTEXT_THRESHOLDS[tier];
	return {
		pruneStart: cfg.pruneStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].pruneStart,
		compactStart: cfg.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].compactStart,
	};
}

export function getAutoCompactKeepPairs(): number {
	const configured = s().agent.autoCompactKeepPairs;
	if (typeof configured !== "number" || !Number.isFinite(configured)) {
		return DEFAULT_AUTO_COMPACT_KEEP_PAIRS;
	}
	return Math.max(1, Math.min(25, Math.floor(configured)));
}

export function getAutoCompactPruneThreshold(): number {
	const configured = s().agent.autoCompactPruneThreshold;
	if (typeof configured !== "number" || !Number.isFinite(configured)) {
		return DEFAULT_AUTO_COMPACT_PRUNE_THRESHOLD;
	}
	return Math.max(0, Math.min(100, Math.floor(configured)));
}

/**
 * Minimum fraction (0–1) of remaining prunable messages to prune per pass.
 * Larger steps reduce prompt-cache prefix invalidations (lower cost) at the
 * expense of dropping more context at once.
 */
export function getMinPruneRatio(): number {
	const configured = s().agent.minPruneRatio;
	if (typeof configured !== "number" || !Number.isFinite(configured)) {
		return DEFAULT_MIN_PRUNE_RATIO / 100;
	}
	return Math.max(0, Math.min(100, Math.floor(configured))) / 100;
}

/**
 * Whether a newly-sent user message should wait for an in-progress context
 * compaction to finish before being sent. Default false = send immediately.
 */
export function getQueueDuringCompaction(): boolean {
	return s().agent.queueDuringCompaction ?? false;
}

export function getModelMaxCompletionTokens(model: string, _provider: string): number | null {
	const bareModel = parseModelId(model).model;

	const builtinConfig = BUILTIN_CONTEXT_WINDOWS[bareModel];
	if (builtinConfig !== undefined) {
		if (typeof builtinConfig === "object") {
			return builtinConfig.maxCompletionTokens ?? null;
		}
		return null;
	}

	const normalizedBare = bareModel.toLowerCase();
	for (const [pattern, config] of Object.entries(BUILTIN_CONTEXT_WINDOWS)) {
		if (normalizedBare.startsWith(pattern) && typeof config === "object") {
			return config.maxCompletionTokens ?? null;
		}
	}

	return null;
}
