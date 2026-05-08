/**
 * Settings module — barrel re-exports + core load/save logic.
 *
 * All existing `import { ... } from "../lib/settings"` paths continue to work
 * because this index re-exports everything from the sub-modules.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { migrateLegacyCodexOAuth } from "../codex-manager";
import { normalizeLegacyPermissionMode, shouldMigrateLegacyPlanMode } from "../permission-modes";
import { normalizeCustomApiProviderSettings } from "./custom-api-providers";
import { DEFAULTS } from "./defaults";
import { _bindSettings } from "./provider";
import type { NarraForkSettings } from "./types";

export {
	customApiProtocolFromAnthropic,
	customApiProtocolFromOpenAI,
	customApiProtocolToOpenAIApiMode,
	customApiProvidersToAnthropic,
	customApiProvidersToOpenAI,
	deriveCustomApiProvidersFromLegacy,
	isAnthropicCustomApiProtocol,
	isOpenAICustomApiProtocol,
	normalizeCustomApiProviderSettings,
} from "./custom-api-providers";
export { DEFAULTS, SETTING_DOCS } from "./defaults";
export {
	_bindSettings,
	AGG_MODEL_PREFIX,
	anthropicProviderPrefix,
	buildAggModelValue,
	clineProviderPrefix,
	DEFAULT_CONTEXT_THRESHOLDS,
	FOLLOW_DEFAULT_MODEL,
	getAggregation,
	getAnthropicProviderConfig,
	getBuiltinCodexModels,
	getBuiltinModelContextWindows,
	getClineProviderConfig,
	getContextThresholds,
	getFirstNugProvider,
	getModelContextWindow,
	getModelMaxCompletionTokens,
	getNugProviderConfig,
	getOpenaiProviderConfig,
	getSummaryModelContextWindow,
	getVisibleModels,
	hasConfiguredClineProvider,
	hasConfiguredNugProvider,
	isAnthropicProvider,
	LARGE_CONTEXT_BOUNDARY,
	nugProviderPrefix,
	openaiProviderPrefix,
	parseAggModelValue,
	parseModelId,
	registerAnthropicModelChecker,
	registerAnthropicModelLister,
	registerClineModelChecker,
	registerClineModelLister,
	registerCodexModelChecker,
	registerCodexModelLister,
	registerNugModelChecker,
	registerNugModelLister,
	registerOpenaiModelChecker,
	registerOpenaiModelLister,
	resolveAggregation,
	resolveAllowedModelCandidate,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	usesCodexApiMode,
	usesStatefulApi,
} from "./provider";
// Re-export everything from sub-modules so existing imports keep working
export * from "./types";

// ---------------------------------------------------------------------------
// Core settings load / save
// ---------------------------------------------------------------------------

export const narraforkDir = resolve(homedir(), ".narrafork");
const settingsPath = resolve(narraforkDir, "settings.json");

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
	// biome-ignore lint/style/noNonNullAssertion: guaranteed non-null after assignment above
	return _cache.current!;
}

function loadSettingsFromDisk(): NarraForkSettings {
	mkdirSync(narraforkDir, { recursive: true });
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, JSON.stringify(DEFAULTS, null, 2));
	}
	const raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
	const merged = deepMerge(DEFAULTS, raw);

	let needsSave = false;

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

	// Remove obsolete smart output interruption check setting.
	if (raw.agent?.smartInterruptionCheck !== undefined) {
		delete (merged.agent as Record<string, unknown>).smartInterruptionCheck;
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
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON migration
	const mergedAny = merged as any;
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
		| Array<{ codexOAuth?: { refreshToken: string }; codexProxy?: string }>
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
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.nugProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.clineProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}

	if (purgeStaleAgentModelRefs(merged, (prefix) => !activePrefixes.has(prefix))) {
		needsSave = true;
	}

	if (normalizeSettingsProxyUrls(merged)) {
		needsSave = true;
	}

	if (needsSave) saveSettings(merged);

	return merged;
}

/** Simple 8-char random ID for migration (avoids importing nanoid at this level). */
function generateMigrationId(): string {
	return randomBytes(6).toString("base64url").slice(0, 8);
}

type LegacyMcpServerConfig = {
	defaultBehavior?: string;
	toolPermissions?: Array<{ behavior?: string }>;
};

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
		settings.agent.summaryModel = "";
		dirty = true;
	}
	for (const key of ["explore", "plan"] as const) {
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

export function getSettingsRevision(): number {
	return settingsRevision;
}

const PROXY_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize user-entered proxy addresses.
 * If a user enters only host:port, assume an HTTP proxy by default.
 */
export function normalizeProxyUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (PROXY_PROTOCOL_RE.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}

function normalizeProxyField(target: { proxy?: string }): boolean {
	const before = target.proxy;
	const after = normalizeProxyUrl(before);
	if (before === after) return false;
	target.proxy = after;
	return true;
}

function normalizeWebFetchProxyUrl(settings: NarraForkSettings): boolean {
	const proxy = settings.agent.webFetchPolicy?.proxy;
	if (!proxy) return false;
	const before = proxy.url;
	const after = normalizeProxyUrl(before);
	if (before === after) return false;
	proxy.url = after;
	return true;
}

export function normalizeSettingsProxyUrls(settings: NarraForkSettings): boolean {
	let changed = false;
	if (settings.codex) changed = normalizeProxyField(settings.codex) || changed;
	for (const provider of settings.anthropicProviders ?? []) {
		changed = normalizeProxyField(provider) || changed;
	}
	changed = normalizeWebFetchProxyUrl(settings) || changed;
	return changed;
}

export function saveSettings(newSettings: NarraForkSettings): void {
	normalizeCustomApiProviderSettings(newSettings);
	normalizeSettingsProxyUrls(newSettings);
	mkdirSync(narraforkDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
	settingsRevision++;
	if (_cache.current) {
		for (const key of Object.keys(newSettings) as Array<keyof NarraForkSettings>) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(_cache.current as any)[key] = newSettings[key];
		}
	}
}

export const settings: NarraForkSettings = loadSettings();
_cache.current = settings;
// Bind settings to provider module so it can access the singleton
_bindSettings(settings);

/** Returns a copy of the default settings (for reset / comparison). */
export function getDefaults(): NarraForkSettings {
	return structuredClone(DEFAULTS);
}
