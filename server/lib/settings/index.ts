/**
 * Settings module — barrel re-exports + core load/save logic.
 *
 * All existing `import { ... } from "../lib/settings"` paths continue to work
 * because this index re-exports everything from the sub-modules.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrateLegacyCodexOAuth } from "../codex-manager";
import { generateShortId } from "../id";
import { logger } from "../logger";
import { invalidateModelCardCache } from "../model-cards";
import {
	bindModelCatalogSettings,
	markLegacyWindowSettingsSaved,
	reconcileLegacyWindowSettings,
	settingsWithRawModelCatalog,
	startModelCatalogDailyCheck,
} from "../model-catalog";
import { getNarraforkHome } from "../narrafork-home";
import {
	normalizeDefaultNarratorVisibility,
	normalizeDefaultNarratorWriteAudience,
} from "../narrator-audiences";
import { normalizeLegacyPermissionMode, shouldMigrateLegacyPlanMode } from "../permission-modes";
import { normalizeSearchSettings } from "../search/settings";
import { normalizeCustomApiProviderSettings } from "./custom-api-providers";
import { DEFAULTS } from "./defaults";
import { _bindSettings } from "./provider";
import type { NarraForkSettings } from "./types";

export {
	customApiProtocolFromAnthropic,
	customApiProtocolFromOpenAI,
	customApiProtocolToOpenAIApiMode,
	customApiProvidersToAnthropic,
	customApiProvidersToGemini,
	customApiProvidersToOpenAI,
	deriveCustomApiProvidersFromLegacy,
	getProviderPrefixChanges,
	isAnthropicCustomApiProtocol,
	isGeminiCustomApiProtocol,
	isOpenAICustomApiProtocol,
	migrateProviderPrefixReferences,
	normalizeCustomApiProviderSettings,
	type ProviderPrefixChange,
	rewriteModelReference,
} from "./custom-api-providers";
export { DEFAULTS, SETTING_DOCS } from "./defaults";
export {
	_bindSettings,
	AGG_MODEL_PREFIX,
	anthropicProviderPrefix,
	buildAggModelValue,
	DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
	DEFAULT_CONTEXT_THRESHOLDS,
	DEFAULT_CONTEXT_WINDOW,
	expandAllowedPoolForDisplay,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	geminiProviderPrefix,
	getAggregation,
	getAnthropicProviderConfig,
	getAutoCompactKeepPairs,
	getBuiltinCodexModels,
	getBuiltinModelContextWindows,
	getContextThresholds,
	getFirstNugProvider,
	getGeminiProviderConfig,
	getModelContextWindow,
	getModelMaxCompletionTokens,
	getNugProviderConfig,
	getOpenaiProviderConfig,
	getQueueDuringCompaction,
	getReasoningEffortBlocklist,
	getSubagentVisibleModels,
	getSummaryModelContextWindow,
	getVisibleModels,
	hasConfiguredGeminiProvider,
	hasConfiguredNugProvider,
	isAnthropicProvider,
	isGeminiProvider,
	LARGE_CONTEXT_BOUNDARY,
	type ModelContextWindowResolution,
	type ModelContextWindowSource,
	nugProviderPrefix,
	openaiProviderPrefix,
	parseAggModelValue,
	parseModelId,
	registerAnthropicModelChecker,
	registerAnthropicModelLister,
	registerCodexModelChecker,
	registerCodexModelLister,
	registerExtraModelSource,
	registerGeminiModelChecker,
	registerGeminiModelLister,
	registerNugModelChecker,
	registerNugModelLister,
	registerOpenaiModelChecker,
	registerOpenaiModelLister,
	resolveAggregation,
	resolveAllowedModelCandidate,
	resolveAllowedModelCandidateMatch,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveModelContextWindow,
	resolveProvider,
	resolveTranslationModelOverride,
	usesCodexApiMode,
	usesCodexModel,
	usesStatefulApi,
	usesStatefulModel,
} from "./provider";
// Re-export everything from sub-modules so existing imports keep working
export * from "./types";

// ---------------------------------------------------------------------------
// Core settings load / save
// ---------------------------------------------------------------------------

// Keep settings on the same root as the database and other global data so an
// isolated test process cannot touch the developer's real ~/.narrafork.
export const narraforkDir = getNarraforkHome();
const settingsPath = resolve(narraforkDir, "settings.json");

const DANGER_REFLECTION_LEVELS = new Set(["off", "light", "standard", "strict"]);

/** The superseded 1MB `agent.requestDumpMaxSize` default, rewritten on load. */
const LEGACY_REQUEST_DUMP_MAX_SIZE = 1024 * 1024;

export function stripObsoleteSettingsKeys(settings: Record<string, unknown>): boolean {
	let changed = false;
	for (const key of OBSOLETE_TOP_LEVEL_SETTINGS_KEYS) {
		if (key in settings) {
			delete settings[key];
			changed = true;
		}
	}
	const agent = settings.agent;
	if (agent && typeof agent === "object" && !Array.isArray(agent)) {
		const values = agent as Record<string, unknown>;
		for (const key of ["defaultPruneEnabled", "minPruneRatio", "autoCompactPruneThreshold"]) {
			if (key in values) {
				delete values[key];
				changed = true;
			}
		}
		const thresholds = values.contextThresholds;
		if (thresholds && typeof thresholds === "object" && !Array.isArray(thresholds)) {
			for (const tier of ["standard", "large"]) {
				const value = (thresholds as Record<string, unknown>)[tier];
				if (value && typeof value === "object" && "pruneStart" in value) {
					delete (value as Record<string, unknown>).pruneStart;
					changed = true;
				}
			}
		}
	}
	return changed;
}

function normalizeDangerReflectionSettings(
	merged: NarraForkSettings,
	raw: Record<string, unknown>,
): boolean {
	const rawAgent =
		raw.agent && typeof raw.agent === "object" && !Array.isArray(raw.agent)
			? (raw.agent as Record<string, unknown>)
			: undefined;
	const rawLevel = rawAgent?.dangerReflectionLevel;
	const hasValidLevel = typeof rawLevel === "string" && DANGER_REFLECTION_LEVELS.has(rawLevel);
	const nextLevel = hasValidLevel
		? (rawLevel as NarraForkSettings["agent"]["dangerReflectionLevel"])
		: rawAgent?.dangerReflectionEnabled === false
			? "off"
			: "standard";
	let changed = false;
	if (merged.agent.dangerReflectionLevel !== nextLevel) {
		merged.agent.dangerReflectionLevel = nextLevel;
		changed = true;
	}
	const nextEnabled = nextLevel !== "off";
	if (merged.agent.dangerReflectionEnabled !== nextEnabled) {
		merged.agent.dangerReflectionEnabled = nextEnabled;
		changed = true;
	}
	return changed;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function deepMerge<T extends Record<string, any>>(
	defaults: T,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	overrides: Record<string, any>,
): T {
	const result = { ...defaults };
	for (const key of Object.keys(overrides)) {
		const val = overrides[key];
		if (val && typeof val === "object" && !Array.isArray(val) && key in defaults) {
			result[key as keyof T] = deepMerge(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				defaults[key as keyof T] as Record<string, any>,
				val,
			) as T[keyof T];
		} else {
			result[key as keyof T] = val;
		}
	}
	return result;
}

/**
 * Load settings from disk, with migrations.
 * After initial load, returns the in-memory cache to avoid repeated disk I/O.
 * Use `reloadSettings()` to force a re-read from disk.
 */
export function loadSettings(): NarraForkSettings {
	if (_cache.current) return _cache.current;
	return loadSettingsFromDisk();
}

/**
 * Force re-read settings from disk, bypassing the in-memory cache.
 * Use this after external modifications to settings.json.
 */
export function reloadSettings(): NarraForkSettings {
	const fresh = loadSettingsFromDisk();
	settingsRevision++;
	if (_cache.current) {
		for (const key of Object.keys(fresh) as Array<keyof NarraForkSettings>) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(_cache.current as any)[key] = fresh[key];
		}
	} else {
		_cache.current = fresh;
	}
	for (const listener of settingsChangeListeners) listener();
	// biome-ignore lint/style/noNonNullAssertion: guaranteed non-null after assignment above
	return _cache.current!;
}

function loadSettingsFromDisk(): NarraForkSettings {
	mkdirSync(narraforkDir, { recursive: true, mode: 0o700 });
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, JSON.stringify(DEFAULTS, null, 2), { mode: 0o600 });
	}
	const raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
	const merged = deepMerge(DEFAULTS, raw);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON migration
	const mergedAny = merged as any;

	let needsSave = false;
	if (stripObsoleteSettingsKeys(mergedAny)) {
		needsSave = true;
	}

	// Auto-generate JWT secret on first run
	if (!merged.auth.jwtSecret) {
		merged.auth.jwtSecret = randomBytes(32).toString("hex");
		needsSave = true;
	}

	// Migrate editor.legacyEncoding → agent.legacyEncoding
	if (raw.editor?.legacyEncoding === true && !raw.agent?.legacyEncoding) {
		merged.agent.legacyEncoding = true;
		delete (merged.editor as Record<string, unknown>).legacyEncoding;
		needsSave = true;
	}

	// Migrate legacy YOLO read-only skip setting to danger reflection naming.
	if (
		raw.agent?.yoloSkipReadOnlyConfirmations === true &&
		raw.agent?.dangerSkipReadOnlyConfirmations === undefined
	) {
		merged.agent.dangerSkipReadOnlyConfirmations = true;
		needsSave = true;
	}
	if (raw.agent?.yoloSkipReadOnlyConfirmations !== undefined) {
		delete (merged.agent as Record<string, unknown>).yoloSkipReadOnlyConfirmations;
		needsSave = true;
	}

	if (normalizeDangerReflectionSettings(merged, raw)) {
		needsSave = true;
	}

	// Remove obsolete smart output interruption check setting.
	if (raw.agent?.smartInterruptionCheck !== undefined) {
		delete (merged.agent as Record<string, unknown>).smartInterruptionCheck;
		needsSave = true;
	}

	// Old installs persisted 16, overriding the raised default forever. Record this
	// migration once so an operator can still deliberately choose 16 afterwards.
	if (merged.devices && (raw.devices?.rpcConcurrencyDefaultsVersion ?? 0) < 1) {
		if (raw.devices?.maxConcurrentRpcPerDevice === 16) {
			const next = DEFAULTS.devices?.maxConcurrentRpcPerDevice ?? 64;
			merged.devices.maxConcurrentRpcPerDevice = next;
			// Also catches a deliberate 16 set before this migration existed, so leave
			// a trace; setting 16 again afterwards is preserved.
			logger.info("Migrated devices.maxConcurrentRpcPerDevice to the raised default", {
				from: 16,
				to: next,
			});
		}
		merged.devices.rpcConcurrencyDefaultsVersion = 1;
		needsSave = true;
	}

	// Raise the superseded 1MB raw-dump ceiling.
	//
	// 1MB was the old default and is below the size of essentially any request worth
	// dumping (full history + replayed tool output), so it truncated the request body of
	// every capture. Because it was a *default* rather than a deliberate choice, it sits
	// in settings.json verbatim for existing installs and would survive the new default
	// forever. Only the exact old default is rewritten: any other value — including a
	// smaller one — is an operator decision and is left alone.
	if (raw.agent?.requestDumpMaxSize === LEGACY_REQUEST_DUMP_MAX_SIZE) {
		merged.agent.requestDumpMaxSize = DEFAULTS.agent.requestDumpMaxSize;
		needsSave = true;
	}

	const defaultVisibility = normalizeDefaultNarratorVisibility(
		merged.agent.defaultNarratorVisibility,
	);
	if (merged.agent.defaultNarratorVisibility !== defaultVisibility) {
		merged.agent.defaultNarratorVisibility = defaultVisibility;
		needsSave = true;
	}

	const defaultWriteAudience = normalizeDefaultNarratorWriteAudience(
		merged.agent.defaultNarratorWriteAudience,
	);
	if (merged.agent.defaultNarratorWriteAudience !== defaultWriteAudience) {
		merged.agent.defaultNarratorWriteAudience = defaultWriteAudience;
		needsSave = true;
	}

	// Normalize legacy / invalid permission modes. Plan mode is now an independent trait.
	if (raw.agent?.defaultPermissionMode !== undefined) {
		const normalized = normalizeLegacyPermissionMode(raw.agent.defaultPermissionMode, "default");
		if (merged.agent.defaultPermissionMode !== normalized) {
			merged.agent.defaultPermissionMode = normalized;
			needsSave = true;
		}
		if (shouldMigrateLegacyPlanMode(raw.agent.defaultPermissionMode)) {
			merged.agent.defaultStartInPlanMode = true;
			needsSave = true;
		}
	}

	// Migrate legacy single openai config → openaiProviders array
	if (mergedAny.openai?.apiKey && !merged.openaiProviders?.length) {
		const legacyId = generateMigrationId();
		merged.openaiProviders = [
			{
				id: legacyId,
				name: "OpenAI",
				prefix: "openai",
				apiKey: mergedAny.openai.apiKey,
				baseUrl: mergedAny.openai.baseUrl || "",
				defaultModel: mergedAny.openai.defaultModel || "",
				responsesApi: mergedAny.openai.responsesApi,
				apiMode: mergedAny.openai.apiMode,
				codexAccountId: mergedAny.openai.codexAccountId,
			},
		];
		needsSave = true;
	}

	// Migrate providers without prefix field
	if (merged.openaiProviders?.length) {
		let migrated = false;
		for (const p of merged.openaiProviders) {
			if (!p.prefix) {
				p.prefix = "openai";
				migrated = true;
			}
		}
		if (migrated) needsSave = true;
	}

	// Normalize nullable codex.defaultReasoningEffort from legacy values
	if (
		(merged.codex as { defaultReasoningEffort?: string | null } | undefined)
			?.defaultReasoningEffort === null
	) {
		if (merged.codex) {
			delete (merged.codex as { defaultReasoningEffort?: string }).defaultReasoningEffort;
		}
		needsSave = true;
	}

	// Clean up legacy openai field
	if (mergedAny.openai !== undefined) {
		delete mergedAny.openai;
		needsSave = true;
	}

	// Migrate subagentAllowedModels from flat string[] to per-type object
	const rawPool = raw.agent?.subagentAllowedModels;
	if (Array.isArray(rawPool)) {
		merged.agent.subagentAllowedModels = {
			explore: [...rawPool],
			plan: [...rawPool],
			general: [...rawPool],
		};
		needsSave = true;
	}

	// Migrate legacy per-provider codexOAuth to centralized credential pool
	// biome-ignore lint/suspicious/noExplicitAny: migration needs to read removed fields
	const legacyProviders = merged.openaiProviders?.filter((p: any) => p.codexOAuth) as
		| Array<{
				codexOAuth?: {
					refreshToken?: string;
					accessToken?: string;
					expiresAt?: number;
					accountId?: string;
				};
				codexProxy?: string;
		  }>
		| undefined;
	if (legacyProviders?.length) {
		migrateLegacyCodexOAuth(legacyProviders);
		for (const p of merged.openaiProviders ?? []) {
			// biome-ignore lint/suspicious/noExplicitAny: migration needs to delete removed fields
			if ((p as any).codexOAuth) {
				// biome-ignore lint/suspicious/noExplicitAny: migration needs to delete removed fields
				delete (p as any).codexOAuth;
				// biome-ignore lint/suspicious/noExplicitAny: migration needs to delete removed fields
				delete (p as any).codexProxy;
				needsSave = true;
			}
		}
	}

	if (!Array.isArray((raw as { customApiProviders?: unknown }).customApiProviders)) {
		merged.customApiProviders = undefined;
	}
	if (normalizeCustomApiProviderSettings(merged)) {
		needsSave = true;
	}

	if (normalizeMcpServerIds(merged)) {
		needsSave = true;
	}

	if (migrateLegacyMcpBehaviors(merged)) {
		needsSave = true;
	}

	// Clean up agent fields that reference models from providers no longer in settings
	const activePrefixes = new Set<string>();
	for (const prov of merged.openaiProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.anthropicProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.nugProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.geminiProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const b of ["codex"]) activePrefixes.add(b);

	if (purgeStaleAgentModelRefs(merged, (prefix) => !activePrefixes.has(prefix))) {
		needsSave = true;
	}

	if (migrateGlobalProxy(merged, raw)) {
		needsSave = true;
	}

	if (normalizeSettingsProxyUrls(merged)) {
		needsSave = true;
	}

	if (normalizeSearchSettings(merged, raw)) {
		needsSave = true;
	}

	if (needsSave) saveSettings(merged);

	// Pricing lives in its own module so cost attribution does not have to pull in
	// the settings module graph; push the operator overrides into it on load.

	return merged;
}

/**
 * Feed price overrides into the pricing module from both sources.
 *
 * Two of them exist because `pricing.overrides` predates model cards and had no
 * UI at all — it could only be hand-edited into settings.json. Model cards are
 * that UI, so their `officialPricing` is the way forward, but existing
 * hand-written overrides must keep working.
 *
 * Cards are applied first and `pricing.overrides` second, so a legacy entry
 * still wins. That ordering is deliberate: someone who hand-edited a price did
 * so to correct a specific model, and having a card silently outrank it would
 * revert a correction they cannot see being reverted. New edits go through cards
 * and land in the same place.
 */
// Legacy pricing is migrated once by bindModelCatalogSettings. New estimates
// read the same effective metadata as request construction, never a projection.

/** Simple 8-char random ID for migration (avoids importing nanoid at this level). */
function generateMigrationId(): string {
	return randomBytes(6).toString("base64url").slice(0, 8);
}

type LegacyMcpServerConfig = {
	defaultBehavior?: string;
	toolPermissions?: Array<{ behavior?: string }>;
};

/** Raw settings edits bypass the MCP create route, but every UI action needs a unique string ID. */
export function normalizeMcpServerIds(settings: NarraForkSettings): boolean {
	if (!Array.isArray(settings.mcpServers)) return false;
	const isValidId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;
	// Reserve existing IDs before generating replacements so valid references stay intact.
	const reserved = new Set(settings.mcpServers.map((server) => server.id).filter(isValidId));
	const seen = new Set<string>();
	let dirty = false;
	for (const server of settings.mcpServers) {
		if (!isValidId(server.id) || seen.has(server.id)) {
			let id: string;
			do {
				id = generateShortId();
			} while (reserved.has(id));
			server.id = id;
			reserved.add(id);
			dirty = true;
		}
		seen.add(server.id);
	}
	return dirty;
}

/** Migrate pre readOnly/readWrite MCP behavior values. */
export function migrateLegacyMcpBehaviors(settings: NarraForkSettings): boolean {
	let dirty = false;
	const servers = Array.isArray(settings.mcpServers)
		? (settings.mcpServers as LegacyMcpServerConfig[])
		: [];
	for (const server of servers) {
		if (server.defaultBehavior === "allow") {
			server.defaultBehavior = "readWrite";
			dirty = true;
		}
		for (const rule of server.toolPermissions ?? []) {
			if (rule.behavior === "allow") {
				rule.behavior = "readWrite";
				dirty = true;
			}
		}
	}
	return dirty;
}

/**
 * Purge stale model references from agent settings.
 */
export function purgeStaleAgentModelRefs(
	settings: NarraForkSettings,
	isPrefixStale: (prefix: string) => boolean,
): boolean {
	const isStale = (val: string | undefined): boolean => {
		if (!val) return false;
		const prefix = val.split(":")[0];
		return !!prefix && isPrefixStale(prefix);
	};

	let dirty = false;
	if (isStale(settings.agent.summaryModel)) {
		logger.warn("Cleared stale summary model reference", {
			previousValue: settings.agent.summaryModel,
			stalePrefix: settings.agent.summaryModel.split(":")[0],
		});
		settings.agent.summaryModel = "";
		dirty = true;
	}
	if (isStale(settings.agent.translationModel)) {
		settings.agent.translationModel = "__summary__";
		dirty = true;
	}
	if (isStale(settings.agent.promptOptimizeModel)) {
		settings.agent.promptOptimizeModel = "__summary__";
		dirty = true;
	}
	for (const key of ["explore", "plan", "search", "review"] as const) {
		if (isStale(settings.agent.subagentModels[key])) {
			settings.agent.subagentModels[key] = "";
			dirty = true;
		}
	}
	const origHidden = settings.agent.hiddenModels ?? [];
	const cleanedHidden = origHidden.filter((m) => !isStale(m));
	if (cleanedHidden.length !== origHidden.length) {
		settings.agent.hiddenModels = cleanedHidden;
		dirty = true;
	}
	const origWindows = settings.agent.modelContextWindows ?? {};
	const cleanedWindows: Record<string, number> = {};
	for (const [k, v] of Object.entries(origWindows)) {
		if (!isStale(k)) cleanedWindows[k] = v;
	}
	if (Object.keys(cleanedWindows).length !== Object.keys(origWindows).length) {
		settings.agent.modelContextWindows = cleanedWindows;
		dirty = true;
	}
	const origCustom = settings.agent.customModels ?? [];
	const cleanedCustom = origCustom.filter((m) => !isStale(m.value));
	if (cleanedCustom.length !== origCustom.length) {
		settings.agent.customModels = cleanedCustom;
		dirty = true;
	}
	return dirty;
}

/** Internal mutable holder. */
const _cache: { current: NarraForkSettings | null } = { current: null };

let settingsRevision = 0;
const settingsChangeListeners = new Set<() => void>();

/** Subscribe to persisted settings after the runtime singleton has been updated. */
export function subscribeSettingsChanges(listener: () => void): () => void {
	settingsChangeListeners.add(listener);
	return () => settingsChangeListeners.delete(listener);
}

export function getSettingsRevision(): number {
	return settingsRevision;
}

const URL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize user-entered proxy addresses.
 * If a user enters only host:port, assume an HTTP proxy by default.
 */
export function normalizeProxyUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const normalized = URL_PROTOCOL_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		const protocol = new URL(normalized).protocol;
		return protocol === "http:" || protocol === "https:" ? normalized : undefined;
	} catch {
		return undefined;
	}
}

export function normalizeSettingsProxyUrls(settings: NarraForkSettings): boolean {
	const proxy = settings.proxy;
	if (!proxy) return false;
	if (proxy.mode !== "custom") {
		// url is only meaningful in custom mode — drop stale values.
		if (proxy.url !== undefined) {
			delete proxy.url;
			return true;
		}
		return false;
	}
	const before = proxy.url;
	const after = normalizeProxyUrl(before);
	if (before === after) return false;
	if (before && !after) {
		// Preserve unsupported or malformed legacy values so the transport fails
		// closed and the UI can ask the user to migrate them. Silently switching
		// to direct mode would bypass an explicitly configured network boundary.
		return false;
	}
	proxy.url = after;
	return true;
}

/**
 * Migrate the legacy per-provider proxy fields to the unified `settings.proxy`
 * policy. Runs once when `raw.proxy` is absent, then clears the old fields.
 *
 * Precedence for a custom URL: legacy WebFetch custom url →
 * codex.proxy → first Anthropic provider's proxy. When no URL is found, the
 * mode defaults to "direct" (no proxy) unless the legacy WebFetch mode was
 * explicitly "system" (follow the OS/env proxy), which is preserved.
 */
export function migrateGlobalProxy(
	settings: NarraForkSettings,
	raw: Record<string, unknown>,
): boolean {
	const rawHasProxy =
		raw.proxy && typeof raw.proxy === "object" && !Array.isArray(raw.proxy) && "mode" in raw.proxy;

	// biome-ignore lint/suspicious/noExplicitAny: reading deprecated fields from raw for migration
	const r = raw as any;
	const legacyWebFetch = r.agent?.webFetchPolicy?.proxy as
		| { mode?: string; url?: string }
		| undefined;
	const legacyCodex = r.codex?.proxy as string | undefined;
	const legacyAnthropic = (Array.isArray(r.anthropicProviders) ? r.anthropicProviders : []).find(
		(p: { proxy?: string }) => p?.proxy,
	)?.proxy as string | undefined;
	const legacyCustomApi = (Array.isArray(r.customApiProviders) ? r.customApiProviders : []).find(
		(p: { proxy?: string }) => p?.proxy,
	)?.proxy as string | undefined;

	// biome-ignore lint/suspicious/noExplicitAny: mutating deprecated fields on merged settings
	const s = settings as any;

	let changed = false;

	if (!rawHasProxy) {
		const customUrl = normalizeProxyUrl(
			(legacyWebFetch?.mode === "custom" ? legacyWebFetch.url : undefined) ||
				legacyCodex ||
				legacyAnthropic ||
				legacyCustomApi,
		);
		if (customUrl) {
			settings.proxy = { mode: "custom", url: customUrl };
		} else if (legacyWebFetch?.mode === "system") {
			settings.proxy = { mode: "system" };
		} else {
			settings.proxy = { mode: "direct" };
		}
		changed = true;
	}

	// Clear ONLY the legacy string-form per-location proxy fields. The new
	// per-location ProxyOverride is an object ({ mode, url }); never delete it.
	// biome-ignore lint/suspicious/noExplicitAny: probing deprecated field shape
	const isLegacyStringProxy = (obj: any): boolean => typeof obj?.proxy === "string";
	if (s.codex && isLegacyStringProxy(s.codex)) {
		delete s.codex.proxy;
		changed = true;
	}
	if (s.agent?.webFetchPolicy && typeof s.agent.webFetchPolicy.proxy === "string") {
		delete s.agent.webFetchPolicy.proxy;
		changed = true;
	}
	for (const provider of settings.anthropicProviders ?? []) {
		if (isLegacyStringProxy(provider)) {
			// biome-ignore lint/suspicious/noExplicitAny: deleting deprecated field
			delete (provider as any).proxy;
			changed = true;
		}
	}
	for (const provider of settings.customApiProviders ?? []) {
		if (isLegacyStringProxy(provider)) {
			// biome-ignore lint/suspicious/noExplicitAny: deleting deprecated field
			delete (provider as any).proxy;
			changed = true;
		}
	}

	return changed;
}

export function saveSettings(newSettings: NarraForkSettings): void {
	stripObsoleteSettingsKeys(newSettings as unknown as Record<string, unknown>);
	normalizeCustomApiProviderSettings(newSettings);
	normalizeSettingsProxyUrls(newSettings);
	normalizeSearchSettings(newSettings);
	normalizeMcpServerIds(newSettings);
	reconcileLegacyWindowSettings(newSettings);
	mkdirSync(narraforkDir, { recursive: true, mode: 0o700 });
	const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(settingsWithRawModelCatalog(newSettings), null, 2), {
			mode: 0o600,
		});
		renameSync(tempPath, settingsPath);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
	markLegacyWindowSettingsSaved(newSettings);
	settingsRevision++;

	// The card index is memoized on the identity of the cards array. A save that
	// mutated the existing array in place would keep that identity, so the cache
	// is dropped explicitly rather than relying on a new reference arriving.
	invalidateModelCardCache();
	if (_cache.current) {
		stripObsoleteSettingsKeys(_cache.current as unknown as Record<string, unknown>);
		for (const key of Object.keys(_cache.current) as Array<keyof NarraForkSettings>) {
			if (!Object.hasOwn(newSettings, key)) {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				delete (_cache.current as any)[key];
			}
		}
		for (const key of Object.keys(newSettings) as Array<keyof NarraForkSettings>) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(_cache.current as any)[key] = newSettings[key];
		}
	}
	for (const listener of settingsChangeListeners) listener();
}

export const settings: NarraForkSettings = loadSettings();
_cache.current = settings;
// Bind settings to provider module so it can access the singleton
_bindSettings(settings);
bindModelCatalogSettings(settings, () => saveSettings(settings));
if (process.env.NODE_ENV !== "test") startModelCatalogDailyCheck();

/** Returns a copy of the default settings (for reset / comparison). */
export function getDefaults(): NarraForkSettings {
	return structuredClone(DEFAULTS);
}
