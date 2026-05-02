/**
 * Provider resolution, model parsing, context window management, and model registry.
 * Extracted from the monolithic settings/index.ts.
 */
import { getCodexManager } from "../codex-manager";
import type {
	AnthropicProviderConfig,
	ClineProviderConfig,
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
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
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
let openaiModelLister: (() => string[]) | null = null;
let anthropicModelLister: (() => string[]) | null = null;
let codexModelLister: (() => string[]) | null = null;
let nugModelLister: (() => string[]) | null = null;
let clineModelLister: (() => string[]) | null = null;

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
}
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

// ---------------------------------------------------------------------------
// Model ID parsing & effective model resolution
// ---------------------------------------------------------------------------

/**
 * Sentinel value stored in `narrators.model` to indicate "follow the default model from settings".
 */
export const FOLLOW_DEFAULT_MODEL = "__default__";

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

	// If sticky provider matches a member, prefer it
	if (stickyProvider) {
		const stickyMatch = agg.models.find((m) => {
			const parsed = parseModelId(m);
			return parsed.provider === stickyProvider;
		});
		if (stickyMatch) return stickyMatch;
	}

	if (agg.routingMode === "balanced") {
		const idx = aggRoundRobin.get(aggId) ?? 0;
		const model = agg.models[idx % agg.models.length];
		aggRoundRobin.set(aggId, idx + 1);
		return model;
	}

	// Priority mode: return first member
	return agg.models[0];
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

function normalizeModelReference(model: string | null | undefined): string | null {
	const trimmed = model?.trim();
	if (!trimmed) return null;
	return trimmed === "default" ? FOLLOW_DEFAULT_MODEL : trimmed;
}

function isMetaModelReference(model: string): boolean {
	return isFollowDefaultModelValue(model) || !!parseAggModelValue(model);
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

export function resolveEffectiveModel(
	model: string | null | undefined,
	stickyProvider?: string,
): string {
	const raw = model?.trim();
	if (!raw || isFollowDefaultModelValue(raw)) return resolveConfiguredDefaultModel(stickyProvider);

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
	const disabledPrefixes = new Set(s().agent.disabledProviders ?? []);
	const openai = openaiModelLister?.() ?? [];
	const anthropic = anthropicModelLister?.() ?? [];
	const codex = codexModelLister?.() ?? [];
	const nug = nugModelLister?.() ?? [];
	const cline = clineModelLister?.() ?? [];
	const custom = (s().agent.customModels ?? []).map((m) => m.value);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const v of [
		...openai,
		...anthropic,
		...codex,
		...nug,
		...cline,
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

export function usesStatefulApi(prefix?: string): boolean {
	if (!prefix) return false;
	if (prefix === "codex") return true;
	const mode = getOpenaiProviderConfig(prefix)?.apiMode;
	return mode === "codex" || mode === "responses";
}

export function isAnthropicProvider(prefix?: string): boolean {
	if (!prefix) return false;
	return !!getAnthropicProviderConfig(prefix);
}

export function resolveDefaultReasoningEffort(
	provider?: string,
): "none" | "low" | "medium" | "high" | "xhigh" | undefined {
	if (usesCodexApiMode(provider)) {
		return s().codex?.defaultReasoningEffort ?? s().agent.defaultReasoningEffort;
	}
	if (isAnthropicProvider(provider)) {
		return (
			getAnthropicProviderConfig(provider)?.defaultReasoningEffort ??
			s().agent.defaultReasoningEffort
		);
	}
	return s().agent.defaultReasoningEffort;
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

	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

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

	return providers.some((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
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
		}
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
	}

	const configured = getConfiguredProviderCandidates();
	if (configured.length > 0) {
		return configured[0];
	}

}

// ---------------------------------------------------------------------------
// Context window sizes
// ---------------------------------------------------------------------------

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
	"gpt-5-codex": { contextLength: 256_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-max": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-mini": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.5": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4-mini": { contextLength: 400_000, maxCompletionTokens: 128_000 },
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
};

function getBuiltinModelContextWindow(model: string): number | null {
	const bareModel = parseModelId(model).model;

	// Check built-in table (exact match)
	const builtinConfig = BUILTIN_CONTEXT_WINDOWS[bareModel];
	if (builtinConfig !== undefined) {
		return typeof builtinConfig === "number" ? builtinConfig : builtinConfig.contextLength;
	}

	// Fuzzy match
	const normalizedBare = bareModel.toLowerCase();
	const sortedEntries = Object.entries(BUILTIN_CONTEXT_WINDOWS).sort(
		(a, b) => b[0].length - a[0].length,
	);
	for (const [pattern, config] of sortedEntries) {
		if (normalizedBare.startsWith(pattern)) {
			return typeof config === "number" ? config : config.contextLength;
		}
	}

	return null;
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

	// 1. Check provider configuration
		const oaiConfig = getOpenaiProviderConfig(provider);
		if (oaiConfig?.defaultContextWindow) {
			return oaiConfig.defaultContextWindow;
		}
		const anthropicConfig = getAnthropicProviderConfig(provider);
		if (anthropicConfig?.defaultContextWindow) {
			return anthropicConfig.defaultContextWindow;
		}
	}

	// 2. Check built-in table and fuzzy matches
	return getBuiltinModelContextWindow(model) ?? 128_000;
}

/** Threshold above which a model is considered "large context". */
export const LARGE_CONTEXT_BOUNDARY = 600_000;

export const DEFAULT_CONTEXT_THRESHOLDS = {
	standard: { pruneStart: 95, compactStart: 99 },
	large: { pruneStart: 95, compactStart: 99 },
};

/**
 * Resolve the summary model's effective context window (tokens).
 */
export function getSummaryModelContextWindow(): number {
	const summaryModel = s().agent.summaryModel;
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
