/**
 * Provider resolution, model parsing, context window management, and model registry.
 * Extracted from the monolithic settings/index.ts.
 */
import { DEFAULT_CONTEXT_THRESHOLDS } from "@shared/context-thresholds";
import { ERROR_CATALOG } from "@shared/error-catalog";
import type { ModelCard } from "@shared/model-card";
import { parseModelId } from "@shared/model-id";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { getCodexManager } from "../codex-manager";
import { AppError, ValidationError } from "../errors";
import { modelCardContextWindow, modelCardMaxCompletionTokens } from "../model-cards";
import { getEffectiveModelMetadata } from "../model-catalog";
import { isNugCachedModelAvailable, resolveNugModelMeta } from "../nug-model-cache";
import type {
	AnthropicProviderConfig,
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

const BUILTIN_CODEX_MODELS = [
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
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
let geminiModelChecker: ((model: string) => string | undefined) | null = null;
let openaiModelLister: (() => string[]) | null = null;
let anthropicModelLister: (() => string[]) | null = null;
let codexModelLister: (() => string[]) | null = null;
let nugModelLister: (() => string[]) | null = null;
let geminiModelLister: (() => string[]) | null = null;

/**
 * Extra model sources contributed at runtime, e.g. by executable plugin providers.
 *
 * Unlike the per-provider listers above this is a list, because the number of plugin
 * providers is not known at build time. Sources must be synchronous and cheap:
 * they are consulted on request paths (`getVisibleModels`, provider resolution).
 */
const extraModelSources = new Map<
	string,
	{ listModels: () => string[]; resolveProvider?: (bareModel: string) => string | undefined }
>();

/**
 * Register (or replace) a named model source.
 *
 * Returns a disposer so a subsystem can withdraw its models when it shuts down.
 * Registering the same name twice replaces the previous source rather than stacking,
 * which keeps repeated wiring idempotent.
 */
export function registerExtraModelSource(
	name: string,
	source: {
		listModels: () => string[];
		resolveProvider?: (bareModel: string) => string | undefined;
	},
): () => void {
	extraModelSources.set(name, source);
	return () => {
		if (extraModelSources.get(name) === source) extraModelSources.delete(name);
	};
}

function listExtraModels(): string[] {
	const values: string[] = [];
	for (const [name, source] of extraModelSources) {
		try {
			values.push(...source.listModels());
		} catch {
			// A broken source must not blank out the whole model list; skip it.
			void name;
		}
	}
	return values;
}

function resolveExtraProvider(bareModel: string): string | undefined {
	for (const source of extraModelSources.values()) {
		try {
			const prefix = source.resolveProvider?.(bareModel);
			if (prefix) return prefix;
		} catch {
			// Ignore and try the next source.
		}
	}
	return undefined;
}

// Register codex model checker and lister immediately
registerCodexModelChecker((model) => BUILTIN_CODEX_MODELS.includes(model));
registerCodexModelLister(() => BUILTIN_CODEX_MODELS.map((m) => `codex:${m}`));

export function registerOpenaiModelChecker(checker: (model: string) => boolean): void {
	openaiModelChecker = checker;
}
export function registerOpenaiModelLister(lister: () => string[]): void {
	openaiModelLister = lister;
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

/**
 * Raised when the default model cannot be resolved to a concrete model.
 *
 * There is deliberately NO hardcoded fallback model. A fallback looks harmless
 * but is actively misleading: it names a provider the user may never have
 * configured, so the failure surfaces later as "provider X is not
 * configured" from a model the user never chose — during setup that arrives as
 * a phantom model in a session the user asked to run on their own
 * provider. Failing here instead points at the real problem: no default model
 * is configured.
 *
 * Catalog-backed (503 + `DEFAULT_MODEL_NOT_CONFIGURED`) rather than a bare
 * Error, because a bare Error falls through the global Hono handler as an
 * opaque 500 "Internal server error" — which throws away the one thing the
 * operator needs to know. `name` is pinned because `isProviderUnavailableError`
 * matches on it to keep this out of the transient-retry path.
 */
export class DefaultModelNotConfiguredError extends AppError {
	constructor() {
		const entry = ERROR_CATALOG.DEFAULT_MODEL_NOT_CONFIGURED;
		super(entry.en, entry.status, entry.code, {
			messageCode: "DEFAULT_MODEL_NOT_CONFIGURED",
		});
		this.name = "DefaultModelNotConfiguredError";
	}
}

/**
 * The summary model setting is empty. Unlike {@link DefaultModelNotConfiguredError}
 * this does not mean "nothing is configured anywhere" — it means the code path
 * refuses to run without an explicit summary model, because handing an empty id
 * to the model catalog surfaces as an opaque schema error instead of an
 * actionable prompt. `name` is pinned for `isProviderUnavailableError`, which
 * keeps it out of the transient-retry path and lets the summary wrappers
 * broadcast the picker event.
 */
export class SummaryModelNotConfiguredError extends AppError {
	constructor() {
		const entry = ERROR_CATALOG.SUMMARY_MODEL_NOT_CONFIGURED;
		super(entry.en, entry.status, entry.code, {
			messageCode: "SUMMARY_MODEL_NOT_CONFIGURED",
		});
		this.name = "SummaryModelNotConfiguredError";
	}
}

/**
 * Prefix for model aggregation values stored in narrators.model.
 * Format: "__agg__:{aggId}" for auto mode, "__agg__:{aggId}:{provider:model}" for pinned provider.
 */
export const AGG_MODEL_PREFIX = "__agg__:";

/**
 * Parse a model string that may contain a "provider:" prefix.
 *
 * Re-exported from `@shared/model-id` so bundled plugin code can parse model
 * values without pulling this module's settings/Codex/NUG dependency graph.
 */
export { parseModelId };

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

/**
 * The model reference reasoning translation should use, or `undefined` when it
 * follows `agent.summaryModel`.
 *
 * `undefined` rather than a resolved concrete model on purpose: callers pass it
 * as `summaryGenerate`'s `modelOverride`, and an override pins the value at call
 * time. Returning the summary model here would freeze that binding, defeating
 * the "follow the summary model dynamically" contract of the `__summary__`
 * sentinel. Aggregations and `__default__` pass through untouched —
 * `resolveEffectiveModel` inside the generate path resolves them.
 */
export function resolveTranslationModelOverride(): string | undefined {
	const configured = s().agent.translationModel?.trim();
	if (!configured || isFollowSummaryModelValue(configured)) return undefined;
	return configured;
}

/**
 * Normalize a resolved candidate. Returns null when the candidate is empty or
 * still self-referential — callers decide whether that is fatal, so a broken
 * value never silently becomes a concrete model nobody selected.
 */
function sanitizeResolvedModelCandidate(model: string | null | undefined): string | null {
	const trimmed = model?.trim();
	if (!trimmed) return null;
	if (isFollowDefaultModelValue(trimmed)) return null;
	return trimmed;
}

function resolveConfiguredDefaultModel(stickyProvider?: string): string {
	const configured = s().agent.defaultModel?.trim();
	if (!configured || isFollowDefaultModelValue(configured)) {
		throw new DefaultModelNotConfiguredError();
	}

	const agg = parseAggModelValue(configured);
	if (agg) {
		const candidate = agg.pinnedModel
			? sanitizeResolvedModelCandidate(agg.pinnedModel)
			: sanitizeResolvedModelCandidate(resolveAggregation(agg.aggId, stickyProvider));
		if (!candidate) throw new DefaultModelNotConfiguredError();
		return candidate;
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
		// An empty/broken summary aggregation falls back to the default model,
		// mirroring the "unset summary follows default" rule above. The default
		// resolver throws if it too is unconfigured, so nothing invents a model.
		const candidate = agg.pinnedModel
			? sanitizeResolvedModelCandidate(agg.pinnedModel)
			: sanitizeResolvedModelCandidate(resolveAggregation(agg.aggId, stickyProvider));
		return candidate ?? resolveConfiguredDefaultModel(stickyProvider);
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
		model === FOLLOW_PARENT_MODEL ||
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
	return resolveAllowedModelCandidateMatch(candidate, allowedPool)?.model ?? null;
}

/** Keep the legacy model choice while retaining the pool reference that owns its metadata. */
export function resolveAllowedModelCandidateMatch(
	candidate: string | null | undefined,
	allowedPool: string[],
): { model: string; poolIndex?: number } | null {
	const raw = normalizeModelReference(candidate);
	if (!raw) return null;
	if (allowedPool.length === 0) return { model: raw };

	// A concrete entry (or explicitly named sentinel/aggregation) owns its metadata
	// ahead of overlapping references. This must NOT reorder the model search itself.
	const exactIndex = allowedPool.findIndex((entry) => normalizeModelReference(entry) === raw);
	const candidateValues = expandModelReferenceForMatching(raw);
	for (const [index, allowedRaw] of allowedPool.entries()) {
		const allowed = normalizeModelReference(allowedRaw);
		if (!allowed) continue;

		const allowedValues = expandModelReferenceForMatching(allowed);
		const model = allowedValues.has(raw)
			? raw
			: findConcreteIntersection(candidateValues, allowedValues);
		if (model) return { model, poolIndex: exactIndex === -1 ? index : exactIndex };
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
	if (raw === FOLLOW_PARENT_MODEL) {
		throw new ValidationError("Follow-parent model must be resolved in a subagent context");
	}
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
	const gemini = geminiModelLister?.() ?? [];
	const custom = (s().agent.customModels ?? []).map((m) => {
		const value = m.value ?? "";
		return value.includes(":") ? value : `${m.provider ?? "openai"}:${value}`;
	});
	// Plugin providers come last so a plugin can never displace a builtin model value
	// in the dedupe below, matching how provider resolution prefers builtins.
	const extra = listExtraModels();
	const seen = new Set<string>();
	const result: string[] = [];
	for (const v of [...openai, ...anthropic, ...codex, ...nug, ...gemini, ...custom, ...extra]) {
		if (seen.has(v) || hidden.has(v)) continue;
		const colonIdx = v.indexOf(":");
		if (colonIdx > 0 && disabledPrefixes.has(v.slice(0, colonIdx))) continue;
		seen.add(v);
		result.push(v);
	}
	return result;
}

/**
 * Models that may be exposed to the subagent tool. Unlike the regular picker,
 * subagents should not be offered NUG models explicitly marked unavailable.
 * Unknown cache state remains visible for compatibility with legacy gateways.
 */
export function getSubagentVisibleModels(): string[] {
	return getVisibleModels().filter((model) => {
		const colon = model.indexOf(":");
		if (colon <= 0) return true;
		const prefix = model.slice(0, colon);
		const config = getNugProviderConfig(prefix);
		if (!config) return true;
		const nugModelId = model.slice(colon + 1);
		return isNugCachedModelAvailable(config.id, nugModelId) !== false;
	});
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

/**
 * User-configured models that must NOT receive a reasoning-effort hint.
 *
 * Effort is sent to every model by default; this list plus the built-in
 * pre-4.6-Claude rule are the only exclusions. Read through
 * `modelAcceptsReasoningEffort` from @shared/reasoning-effort-support rather
 * than matched directly, so frontend and backend share one decision.
 */
export function getReasoningEffortBlocklist(): Array<{ pattern: string; enabled?: boolean }> {
	return s().agent.reasoningEffortBlocklist ?? [];
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
		const geminiPrefix = geminiModelChecker?.(bare);
		if (geminiPrefix) return geminiPrefix;
		// Consulted only after every builtin declined, so a plugin cannot shadow a
		// builtin model id. Plugin models normally carry an explicit prefix; this
		// covers values that lost theirs.
		const extraPrefix = resolveExtraProvider(bare);
		if (extraPrefix) return extraPrefix;
	}

	const configured = getConfiguredProviderCandidates();
	if (configured.length > 0) {
		return configured[0];
	}

	return "anthropic";
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
		// No default configured: return the sentinel unchanged rather than naming
		// a model nobody selected. This is a metadata lookup (context window,
		// capabilities), so the caller detects "did not resolve" and uses its own
		// tier default — it must not throw, and it must not fabricate a model
		// whose context window would then be reported as fact.
		if (!configured || isFollowDefaultModelValue(configured)) return raw;
		return resolveMetaModelForLookup(configured, seen);
	}

	const agg = parseAggModelValue(raw);
	if (!agg) return raw;

	if (agg.pinnedModel) return resolveMetaModelForLookup(agg.pinnedModel, seen);

	const first = getAggregation(agg.aggId)?.models[0];
	if (!first) return raw;
	return resolveMetaModelForLookup(first, seen);
}

/**
 * Model-card lookups, wrapped so this module reads the effective card set
 * (builtin seed data overlaid with the user's edits) with a single memoized
 * index rather than rebuilding one per call.
 *
 * `settingsRevision` keys the memo: it already increments on every save and
 * reload, which is exactly when the card set can change.
 */
function userModelCards(): readonly ModelCard[] {
	return s().agent.modelCards ?? [];
}

function getModelCardContextWindow(
	model: string,
	_provider: string,
): { contextWindow: number; userSet: boolean } | null {
	// Two shapes are probed, mirroring what the pre-card lookup did: the bare
	// model id, and the id with a leading channel segment removed. A
	// gateway-routed id keeps that segment (`anthropic:GLM-5.1`) after the
	// provider prefix is stripped, and only the second form matches a card key.
	const bare = parseModelId(model).model;
	const cards = userModelCards();
	const stripped = stripChannelSegment(bare);
	return (
		modelCardContextWindow(bare, cards) ??
		(stripped === bare ? null : modelCardContextWindow(stripped, cards))
	);
}

/**
 * Drop a leading channel segment from an id (`anthropic:GLM-5.1` → `GLM-5.1`).
 *
 * The pre-card lookup did the same thing by probing the substring after the
 * first colon, which is how gateway-routed ids ever matched the table.
 */
function stripChannelSegment(model: string): string {
	const idx = model.indexOf(":");
	if (idx > 0 && idx < model.length - 1) return model.slice(idx + 1);
	return model;
}

function getNugModelContextWindow(model: string, provider: string): number | null {
	const config = getNugProviderConfig(provider);
	if (!config) return null;
	try {
		const meta = resolveNugModelMeta(config.id, config.prefix, model);
		// The gateway's own number wins; a card is the fallback for a catalog that
		// reports no window (several channels never do).
		return (
			meta.contextWindow ?? getModelCardContextWindow(meta.bareModel, "")?.contextWindow ?? null
		);
	} catch {
		return null;
	}
}

/**
 * Seed windows for a list of models, used to prefill the per-model override
 * inputs in the provider settings UI.
 *
 * Reads card data, which is what the hardcoded builtin table became. The name is
 * kept because several call sites and the settings API response field use it.
 */
export function getBuiltinModelContextWindows(
	models: string[],
	provider: string,
): Record<string, number> {
	const result: Record<string, number> = {};
	for (const model of models) {
		const contextWindow = getModelCardContextWindow(model, "")?.contextWindow;
		if (contextWindow) {
			const bareModel = parseModelId(model).model;
			result[provider ? `${provider}:${bareModel}` : model] = contextWindow;
		}
	}
	return result;
}

/**
 * Where an effective context window came from, in descending priority.
 *
 * - `user`: an explicit binding/per-model override (including migrated settings)
 * - `card`: model/variant metadata the USER set (an edited or newly created card)
 * - `catalog`: model metadata reported by a gateway (NUG model catalog)
 * - `provider`: the provider's own `defaultContextWindow` field
 * - `builtin`: a model card field seeded by NarraFork and left untouched
 * - `fallback`: nothing matched, the {@link DEFAULT_CONTEXT_WINDOW} default
 *
 * Callers that apply a capability floor (e.g. Anthropic's 1M official-API
 * window) must skip the floor for `user` / `provider` / `card` so an explicitly
 * configured smaller window is not silently overridden.
 *
 * `card` and `builtin` both come from the card layer and differ ONLY in who set
 * the value — and that difference is load-bearing, not cosmetic. The floor
 * applies to `builtin`, which is why `claude-sonnet-4-5` (a 200k card row, but a
 * member of the Sonnet 4 family whose official path sends the 1M beta header)
 * still reports 1M exactly as it did before cards existed. Reporting `card` for
 * builtin values would skip the floor and silently drop those models to 200k.
 */
export type ModelContextWindowSource =
	| "user"
	| "card"
	| "provider"
	| "catalog"
	| "builtin"
	| "fallback";

export interface ModelContextWindowResolution {
	contextWindow: number;
	source: ModelContextWindowSource;
}

export function resolveModelContextWindow(
	model: string,
	provider: string,
): ModelContextWindowResolution {
	// Defensive: callers may pass a meta-model reference instead of a concrete
	// model — either the follow-default sentinel or an aggregation value. When an
	// aggregation value (`__agg__:<id>`) is split into provider/model halves by a
	// caller, it arrives as provider="__agg__", model="<id>". Resolve such meta
	// references to a representative concrete model first, otherwise the lookup
	// matches nothing and silently falls back to the default context window (wrong tier for
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
			return resolveModelContextWindow(parsed.model, parsed.provider ?? "");
		}
	}

	const bareModel = parseModelId(model).model;
	const fullModelValue = provider ? `${provider}:${bareModel}` : model;

	if (s().agent.modelCatalog) {
		const metadataModel =
			provider && !model.startsWith(`${provider}:`) ? `${provider}:${model}` : model;
		const resolved = getEffectiveModelMetadata(metadataModel);
		const window = resolved.metadata.limits?.contextWindow;
		const layer = resolved.provenance["limits.contextWindow"]?.layer;
		// Explicit unknown blocks fallback to stale legacy model cards.
		if (window === null) return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "fallback" };
		if (window !== undefined && (layer?.startsWith("local-") || layer === "discovered"))
			return {
				contextWindow: window,
				source: layer === "local-binding" ? "user" : layer === "discovered" ? "catalog" : "card",
			};
		// A provider's explicit budget outranks presets, but not local model/binding
		// decisions or the gateway's discovered window (the legacy NUG precedence).
		const configured =
			getOpenaiProviderConfig(provider)?.defaultContextWindow ??
			getAnthropicProviderConfig(provider)?.defaultContextWindow ??
			getGeminiProviderConfig(provider)?.defaultContextWindow;
		if (configured) return { contextWindow: configured, source: "provider" };
		return window !== undefined
			? { contextWindow: window, source: "builtin" }
			: { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "fallback" };
	}

	// 0. Check per-model user overrides (highest priority)
	const userOverrides = s().agent.modelContextWindows ?? {};
	if (userOverrides[fullModelValue]) {
		return { contextWindow: userOverrides[fullModelValue], source: "user" };
	}
	if (model !== fullModelValue && userOverrides[model]) {
		return { contextWindow: userOverrides[model], source: "user" };
	}

	// 1. Check model cards the user edited. Ranked above the gateway catalog
	// because an edited card is a deliberate local decision, while the catalog is
	// whatever the gateway reported. Untouched builtin cards are consulted later,
	// at step 4, so they keep losing to the catalog as the old builtin table did.
	const card = getModelCardContextWindow(model, provider);
	if (card?.userSet) return { contextWindow: card.contextWindow, source: "card" };

	// 2. Check NUG model-catalog metadata. NUG model ids often include a
	// channel prefix (e.g. antigravity:claude-opus-4-6-thinking), so the
	// card table alone would otherwise miss them and fall back to the default.
	const nugContextWindow = getNugModelContextWindow(model, provider);
	if (nugContextWindow) return { contextWindow: nugContextWindow, source: "catalog" };

	// 3. Check provider configuration
	{
		const oaiConfig = getOpenaiProviderConfig(provider);
		if (oaiConfig?.defaultContextWindow) {
			return { contextWindow: oaiConfig.defaultContextWindow, source: "provider" };
		}
		const anthropicConfig = getAnthropicProviderConfig(provider);
		if (anthropicConfig?.defaultContextWindow) {
			return { contextWindow: anthropicConfig.defaultContextWindow, source: "provider" };
		}
		const geminiConfig = getGeminiProviderConfig(provider);
		if (geminiConfig?.defaultContextWindow) {
			return { contextWindow: geminiConfig.defaultContextWindow, source: "provider" };
		}
	}

	// 4. Fall back to builtin card data (what the hardcoded table used to be).
	// Reported as `builtin` rather than `card` so the Anthropic 1M floor keeps
	// applying to it exactly as before.
	if (card) return { contextWindow: card.contextWindow, source: "builtin" };
	return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "fallback" };
}

export function getModelContextWindow(model: string, provider: string): number | null {
	return resolveModelContextWindow(model, provider).contextWindow;
}

/**
 * Fallback context window when a model has no configured, catalog, or card value.
 * Kept deliberately generous so unknown modern models do not compact too early.
 */
export const DEFAULT_CONTEXT_WINDOW = 272_000;

/** Threshold above which a model is considered "large context". */
export const LARGE_CONTEXT_BOUNDARY = 600_000;

// Re-exported from the shared single source of truth so existing importers
// (settings/index, narrator-event-handler) keep working unchanged.
export { DEFAULT_CONTEXT_THRESHOLDS };

export const DEFAULT_AUTO_COMPACT_KEEP_PAIRS = 2;

/**
 * Resolve the summary model's effective context window (tokens).
 * Uses the built-in card table when the provider has no explicit setting.
 */
export function getSummaryModelContextWindow(modelOverride?: string): number {
	const summaryModel = modelOverride?.trim() || s().agent.summaryModel;
	const parsed = parseModelId(summaryModel);
	const prov = parsed.provider ?? "anthropic";
	return getModelContextWindow(parsed.model, prov) ?? DEFAULT_CONTEXT_WINDOW;
}

export function getContextThresholds(model: string, provider: string): { compactStart: number } {
	const ctxWin = getModelContextWindow(model, provider) ?? DEFAULT_CONTEXT_WINDOW;
	const tier = ctxWin > LARGE_CONTEXT_BOUNDARY ? "large" : "standard";
	const userThresholds = s().agent.contextThresholds;
	const cfg = userThresholds?.[tier] ?? DEFAULT_CONTEXT_THRESHOLDS[tier];
	return {
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

/**
 * Whether a newly-sent user message should wait for an in-progress context
 * compaction to finish before being sent. Default false = send immediately.
 */
export function getQueueDuringCompaction(): boolean {
	return s().agent.queueDuringCompaction ?? false;
}

export function getModelMaxCompletionTokens(model: string, _provider: string): number | null {
	if (s().agent.modelCatalog) {
		const full = _provider && !model.startsWith(`${_provider}:`) ? `${_provider}:${model}` : model;
		return getEffectiveModelMetadata(full).metadata.limits?.maxOutputTokens ?? null;
	}
	const bareModel = parseModelId(model).model;
	const cards = userModelCards();
	const stripped = stripChannelSegment(bareModel);
	const fromCard =
		modelCardMaxCompletionTokens(bareModel, cards) ??
		(stripped === bareModel ? null : modelCardMaxCompletionTokens(stripped, cards));
	if (fromCard != null) return fromCard;

	return null;
}
