import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getCodexManager, migrateLegacyCodexOAuth } from "../codex-manager";

export interface ModelOption {
	value: string;
	label: string;
	provider?: string;
}

export interface OpenAIProviderConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name, e.g. "DeepSeek", "Groq", "OpenAI". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/**
	 * User-defined provider prefix used in model IDs, e.g. "openai", "deepseek", "groq".
	 * Model IDs are formatted as "{prefix}:{model}", e.g. "deepseek:deepseek-chat".
	 * Must be unique across all providers. Defaults to "openai" for legacy compat.
	 */
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	/** @deprecated Use `apiMode` instead. Kept for backward compatibility. */
	responsesApi?: boolean;
	/**
	 * Which OpenAI API variant to use:
	 *   - "responses"   — OpenAI Responses API (/responses endpoint, developer role, function_call items)
	 *   - "completions"  — Standard Chat Completions API (/chat/completions, system role, tool_calls)
	 *   - "codex"        — Codex: Responses API format to /responses endpoint,
	 *                       default baseUrl https://chatgpt.com/backend-api/codex,
	 *                       extra headers (originator, ChatGPT-Account-Id).
	 * Defaults to "responses".
	 */
	apiMode?: "responses" | "completions" | "codex";
	/** Codex: ChatGPT account ID sent as ChatGPT-Account-Id header (for org subscriptions). */
	codexAccountId?: string;
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
}

export interface AnthropicProviderConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name, e.g. "Anthropic", "Anthropic Proxy". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/**
	 * User-defined provider prefix used in model IDs, e.g. "anthropic".
	 * Model IDs are formatted as "{prefix}:{model}", e.g. "anthropic:claude-sonnet-4-20250514".
	 * Must be unique across all providers.
	 */
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
	/**
	 * Default reasoning effort for Anthropic models when narrator reasoningEffort is unset.
	 * Maps to thinking config (adaptive/disabled) and effort parameter for supported models.
	 */
	defaultReasoningEffort?: "none" | "low" | "medium" | "high";
	/** Optional HTTPS proxy URL for all requests to this provider. */
	proxy?: string;
	/** Skip TLS certificate verification (for use with MITM proxies or self-signed certs). */
	tlsRejectUnauthorized?: boolean;
	/**
	 * Whether this provider connects to the official Anthropic API (or an official relay).
	 * When true, enables Claude Code protocol features: server-side web search,
	 * beta flags, cache_control, billing header, Bearer auth, etc.
	 * When false (default), uses standard Anthropic Messages API compatible with
	 * third-party proxy/relay services.
	 */
	officialApi?: boolean;
}

	/** Unique short ID (8 chars). */
	id: string;
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	/** Default model (bare name without prefix). */
	defaultModel: string;
}

export interface NUGProviderConfig {
	/** Unique short ID (8 chars). */
	id: string;
	/** User-defined display name, e.g. "NUG Production". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/** Provider prefix used in model IDs, e.g. "nug". */
	prefix: string;
	/** NUG API Key for authentication. */
	apiKey: string;
	/** NUG service base URL, e.g. "http://127.0.0.1:7790". */
	baseUrl: string;
	defaultModel: string;
	/** NUG account username (auto-filled after login). */
	nugUsername?: string;
	/** NUG account user ID (auto-filled after login). */
	nugUserId?: string;
}

export interface ClineProviderConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name, e.g. "Cline", "Cline Production". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/** Provider prefix used in model IDs, e.g. "cline". */
	prefix: string;
	/** Cline API base URL, e.g. "https://openrouter.ai/api/v1". */
	baseUrl: string;
	/** OAuth access token (workos: prefix will be added automatically). */
	accessToken?: string;
	/** Default model (bare name without prefix). */
	defaultModel: string;
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
	/** User-selected models from the OpenRouter pool. Only these are available for use. */
	enabledModels?: string[];
}

export interface McpServerConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name. */
	name: string;
	/** Transport type. */
	transport: "stdio" | "streamable-http" | "sse";
	/** stdio: executable command. */
	command?: string;
	/** stdio: command arguments. */
	args?: string[];
	/** stdio: working directory. */
	cwd?: string;
	/** Environment variables passed to the MCP server process or HTTP requests. */
	env?: Record<string, string>;
	/** sse/streamable-http: server URL. */
	url?: string;
	/** sse/streamable-http: custom request headers. */
	headers?: Record<string, string>;
	/** Whether this server is enabled. */
	enabled: boolean;
}

export interface TlsConfig {
	enabled: boolean;
	/** Path to PEM-formatted TLS certificate file. */
	certFile: string;
	/** Path to PEM-formatted TLS private key file. */
	keyFile: string;
	/** Passphrase for the private key (if encrypted). */
	passphrase?: string;
	/** Path to CA certificate file (overrides default trusted CAs). */
	caFile?: string;
}

export interface NarraForkSettings {
	server: {
		port: number;
		host: string;
		/** Browser launch behaviour on server start: "off" | "browser" | "app" */
		openBrowser: "off" | "browser" | "app";
		/** Optional TLS configuration for HTTPS. */
		tls?: TlsConfig;
	};
	paths: { defaultProjectDir: string };
	agent: {
		defaultModel: string;
		defaultPermissionMode: string;
		summaryModel: string;
		customModels: ModelOption[];
		hiddenModels: string[];
		maxTurns: number;
		subagentModels: {
			explore: string;
			plan: string;
		};
		/** Per-type allowed model pools for subagents. Empty array = no restriction. */
		subagentAllowedModels: {
			explore: string[];
			plan: string[];
			general: string[];
		};
		legacyEncoding: boolean;
		/**
		 * Per-model context window overrides (tokens).
		 * Key is the full model value ("provider:modelId"), value is the context window size.
		 * Takes highest priority in getModelContextWindow().
		 */
		modelContextWindows: Record<string, number>;
		/** Translate reasoning/thinking blocks via summaryModel after each block completes. */
		translateReasoning: boolean;
		/** Default value for the relaxed plan toggle on new narrators. */
		defaultRelaxedPlan: boolean;
		/** Smart output interruption check — auto-detect and retry interrupted model output. */
		smartInterruptionCheck: boolean;
		/** Maximum retries for recoverable (transient) API errors. -1 = infinite. */
		maxTransientRetries: number;
		/** User-defined retryable error rules. Matched errors are treated as transient. */
		customRetryRules?: Array<{
			id: string;
			/** Domain keyword to match in error message (case-insensitive). */
			domain?: string;
			/** HTTP status code to match. */
			statusCode?: number;
			/** Content keyword to match in error message (case-insensitive). */
			keyword?: string;
			enabled?: boolean;
			/** User note for this rule. */
			note?: string;
		}>;
		/** Global whitelist directories — merged with project and narrator level. */
		whitelistDirs?: Array<{
			path: string;
			accessLevel: "readOnly" | "readWrite" | "full";
			enabled?: boolean;
		}>;
		/** Global blacklist directories — merged with project and narrator level. */
		blacklistDirs?: Array<{
			path: string;
			denyLevel: "denyWrite" | "denyAll";
			enabled?: boolean;
		}>;
		/** Global command whitelist — commands auto-allowed for all narrators. */
		commandWhitelist?: Array<{
			pattern: string;
			enabled?: boolean;
		}>;
		/** Global command blacklist — commands auto-denied for all narrators. */
		commandBlacklist?: Array<{
			pattern: string;
			denyPrompt?: string;
			enabled?: boolean;
		}>;
		/** Default system prompt — used as base prompt for all narrators when their own systemPrompt is null. */
		defaultSystemPrompt?: string;
		/** WebFetch permission policy. */
		webFetchPolicy?: {
			/** When true, all URLs are auto-allowed without user approval. */
			allowAll?: boolean;
			/** URL keyword whitelist — matching URLs are auto-allowed. */
			whitelist?: Array<{ pattern: string; enabled?: boolean }>;
			/** URL keyword blacklist — matching URLs are auto-denied (priority over whitelist). */
			blacklist?: Array<{ pattern: string; enabled?: boolean }>;
			/** Proxy configuration for WebFetch HTTP requests and browser. */
			proxy?: {
				/**
				 * Proxy mode:
				 * - "direct": no proxy
				 * - "system": auto-detect from HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars
				 * - "custom": use the manually specified URL
				 */
				mode: "direct" | "system" | "custom";
				/** Proxy URL, only used when mode is "custom". */
				url?: string;
			};
		};
		/**
		 * Context window management thresholds (percentage, 0–100).
		 * Split by model context window size: standard (≤600k) vs large (>600k).
		 * - pruneStart: begin progressive message pruning at this percentage
		 * - compactStart: trigger context compaction at this percentage
		 */
		contextThresholds?: {
			standard: { pruneStart: number; compactStart: number };
			large: { pruneStart: number; compactStart: number };
		};
	};
	chapters: {
		maxActiveWorktrees: number;
		maxActiveContainers: number;
		worktreeSizeWarningMb: number;
		autoSaveOnDormant: boolean;
		dormantAfterMinutes: number;
	};
	containers: {
		portRangeStart: number;
		portRangeEnd: number;
		proxy: {
			enabled: boolean;
			port: number;
		};
	};
	editor: {
		type: "vscode" | "cursor" | "windsurf" | "zed";
		/** @deprecated Moved to `agent.legacyEncoding`. Kept for migration. */
		legacyEncoding?: boolean;
	};
	auth: {
		jwtSecret: string;
		registrationOpen: boolean;
	};
		credentialsPath: string;
		configPath: string;
		defaultModel?: string;
	};
	/**
	 * Codex (ChatGPT Pro/Plus) provider configuration.
	 * Credentials are managed separately in ~/.narrafork/codex-credentials.json.
	 */
	codex?: {
		/** Default HTTPS proxy for all Codex requests (can be overridden per-credential). */
		proxy?: string;
		/** Load balancing mode: "priority" (use highest priority) or "balanced" (round-robin). */
		loadBalancingMode?: "priority" | "balanced";
		/** Default reasoning effort for Codex models when narrator reasoningEffort is unset. */
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
	};
	/** Built-in routines configuration. */
	routines: {
		/** Globally disabled routine IDs (blacklist — all enabled by default). */
		disabledRoutines: string[];
		/** Explicitly enabled routine IDs (for routines with defaultEnabled: false). */
		enabledRoutines: string[];
	};
	/** Multiple OpenAI-compatible API providers. */
	openaiProviders?: OpenAIProviderConfig[];
	/** Anthropic native API providers. */
	anthropicProviders?: AnthropicProviderConfig[];
	/** NUG (Narrafork Unified Gateway) providers — unified AI gateway. */
	nugProviders?: NUGProviderConfig[];
	/** Cline API providers — OpenRouter-compatible with OAuth authentication. */
	clineProviders?: ClineProviderConfig[];
	/** External MCP server configurations. */
	mcpServers?: McpServerConfig[];
	/** Delta update configuration. */
	update?: {
		/** Update server URL. */
		serverUrl: string;
		/** Product ID for multi-product update servers. */
		product: string;
		/** Update channel: stable or beta. */
		channel: "stable" | "beta";
		/** Auto-check interval in minutes (0 to disable). */
		checkIntervalMinutes: number;
		/** Automatically download updates when available. */
		autoDownload: boolean;
	};
	/** File sharing configuration (ShareFile tool). */
	shares?: {
		/** Default expiry time in hours for shared files (default: 24). */
		defaultExpiryHours: number;
		/** Maximum file/folder size in MB allowed for sharing (default: 4096). */
		maxFileSizeMb: number;
	};
}

const DEFAULTS: NarraForkSettings = {
	server: { port: 7778, host: "localhost", openBrowser: "browser" },
	paths: { defaultProjectDir: resolve(homedir(), "projects") },
	agent: {
		defaultPermissionMode: "acceptEdits",
		customModels: [],
		hiddenModels: [],
		maxTurns: 200,
		subagentModels: {
			explore: "",
			plan: "",
		},
		subagentAllowedModels: {
			explore: [],
			plan: [],
			general: [],
		},
		legacyEncoding: false,
		modelContextWindows: {},
		translateReasoning: false,
		defaultRelaxedPlan: false,
		smartInterruptionCheck: true,
		maxTransientRetries: 10,
	},
	chapters: {
		maxActiveWorktrees: 10,
		maxActiveContainers: 5,
		worktreeSizeWarningMb: 500,
		autoSaveOnDormant: true,
		dormantAfterMinutes: 0,
	},
	containers: {
		portRangeStart: 10000,
		portRangeEnd: 20000,
		proxy: {
			enabled: false,
			port: 7780,
		},
	},
	editor: {
		type: "vscode",
	},
	auth: {
		jwtSecret: "",
		registrationOpen: true,
	},
	routines: {
		disabledRoutines: [],
		enabledRoutines: [],
	},
	codex: {
		// codex-reversed 显示官方默认 reasoning level 为 medium，避免默认 high 过快消耗额度。
		defaultReasoningEffort: "medium",
	},
	update: {
		serverUrl: "https://narrafork-update.b.domexie.cn",
		product: "narrafork",
		channel: "stable",
		checkIntervalMinutes: 60,
		autoDownload: false,
	},
	shares: {
		defaultExpiryHours: 24,
		maxFileSizeMb: 4096,
	},
};

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
	// Return cached settings if already loaded (avoids EMFILE on Windows)
	if (_cache.current) return _cache.current;
	return loadSettingsFromDisk();
}

/**
 * Force re-read settings from disk, bypassing the in-memory cache.
 * Use this after external modifications to settings.json.
 */
export function reloadSettings(): NarraForkSettings {
	const fresh = loadSettingsFromDisk();
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

	// Migrate providers without prefix field (added in multi-provider update)
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

	// Clean up legacy openai field from settings.json
	if (mergedAny.openai !== undefined) {
		delete mergedAny.openai;
		needsSave = true;
	}

	// Migrate subagentAllowedModels from flat string[] to per-type object.
	// Old format: string[] — applied uniformly to all subagent types.
	// New format: { explore: string[], plan: string[], general: string[] }
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
		// Clean up codexOAuth and codexProxy from providers
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

	// Clean up agent fields that reference models from providers no longer in settings.
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
	// Also allow built-in providers that have no provider config

	if (purgeStaleAgentModelRefs(merged, (prefix) => !activePrefixes.has(prefix))) {
		needsSave = true;
	}

	if (needsSave) saveSettings(merged);

	return merged;
}

/** Simple 8-char random ID for migration (avoids importing nanoid at this level). */
function generateMigrationId(): string {
	return randomBytes(6).toString("base64url").slice(0, 8);
}

/**
 * Purge stale model references from agent settings.
 * `isPrefixStale` receives the prefix portion of a model value (before ":") and
 * returns true if that prefix should be considered stale.
 * Mutates `settings.agent` in place. Returns true if any field was changed.
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
	return dirty;
}

/** Internal mutable holder — `settings` re-exports its properties via the proxy-like sync in saveSettings. */
const _cache: { current: NarraForkSettings | null } = { current: null };

export function saveSettings(newSettings: NarraForkSettings): void {
	mkdirSync(narraforkDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
	// Sync in-memory cache so all modules see the updated values immediately
	if (_cache.current) {
		for (const key of Object.keys(newSettings) as Array<keyof NarraForkSettings>) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(_cache.current as any)[key] = newSettings[key];
		}
	}
}

export const settings: NarraForkSettings = loadSettings();
_cache.current = settings;

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

/** Registry for external model checkers and listers (avoids circular imports). */
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

/**
 * Sentinel value stored in `narrators.model` to indicate "follow the default model from settings".
 * When the user changes `settings.agent.defaultModel`, narrators with this value automatically
 * pick up the new default on their next session start.
 */
export const FOLLOW_DEFAULT_MODEL = "__default__";

/**
 * Resolve the effective model string.  If the stored value is null, undefined,
 * or the `__default__` sentinel, fall back to `settings.agent.defaultModel`.
 */
export function resolveEffectiveModel(model: string | null | undefined): string {
	if (!model || model === FOLLOW_DEFAULT_MODEL) return settings.agent.defaultModel;
	return model;
}

/**
 * Get all available model values (provider:id format), excluding hidden models.
 */
export function getVisibleModels(): string[] {
	const hidden = new Set(settings.agent.hiddenModels ?? []);
	const openai = openaiModelLister?.() ?? [];
	const anthropic = anthropicModelLister?.() ?? [];
	const codex = codexModelLister?.() ?? [];
	const nug = nugModelLister?.() ?? [];
	const cline = clineModelLister?.() ?? [];
	const custom = (settings.agent.customModels ?? []).map((m) => m.value);
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
		if (!seen.has(v) && !hidden.has(v)) {
			seen.add(v);
			result.push(v);
		}
	}
	return result;
}

/**
 * Parse a model string that may contain a "provider:" prefix.
 * Supports any provider prefix that is alphanumeric + hyphen + underscore.
 * Examples:
 *   "openai:gpt-4o"           → { provider: "openai", model: "gpt-4o" }
 *   "deepseek:deepseek-chat"  → { provider: "deepseek", model: "deepseek-chat" }
 *   "gpt-4o"                  → { provider: undefined, model: "gpt-4o" }
 */
export function parseModelId(raw?: string): { provider?: string; model: string } {
	if (!raw) return { model: "" };
	const idx = raw.indexOf(":");
	if (idx > 0) {
		const prefix = raw.slice(0, idx);
		if (/^[a-zA-Z0-9_-]+$/.test(prefix)) {
			return { provider: prefix, model: raw.slice(idx + 1) };
		}
	}
	return { model: raw };
}

/**
 * Get the OpenAI provider config by its prefix.
 * If prefix is undefined, returns the first provider (legacy compat).
 */
export function getOpenaiProviderConfig(prefix?: string): OpenAIProviderConfig | undefined {
	const providers = (settings.openaiProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/** Whether a provider uses Codex API mode and supports Codex-only controls. */
export function usesCodexApiMode(prefix?: string): boolean {
	if (!prefix) return false;
	if (prefix === "codex") return true;
	return getOpenaiProviderConfig(prefix)?.apiMode === "codex";
}

/**
 * Whether a provider uses a stateful server-side conversation (Responses API).
 * Stateful providers cannot safely retry the same API call because the server
 * already consumed the previous request and advanced its internal state.
 *
 * `prefix === "codex"` is hard-coded because Codex uses a dedicated config path
 * (not the openaiProviders array), so `getOpenaiProviderConfig("codex")` would
 * return undefined.  All other stateful providers are detected via `apiMode`.
 */
export function usesStatefulApi(prefix?: string): boolean {
	if (!prefix) return false;
	if (prefix === "codex") return true;
	const mode = getOpenaiProviderConfig(prefix)?.apiMode;
	return mode === "codex" || mode === "responses";
}

/** Whether a provider is an Anthropic provider (supports thinking/effort controls). */
export function isAnthropicProvider(prefix?: string): boolean {
	if (!prefix) return false;
	return !!getAnthropicProviderConfig(prefix);
}

/**
 * Resolve the default reasoning effort for a provider.
 * Checks Codex settings first, then Anthropic provider config.
 * Returns undefined if no default is configured.
 */
export function resolveDefaultReasoningEffort(
	provider?: string,
): "none" | "low" | "medium" | "high" | "xhigh" | undefined {
	if (usesCodexApiMode(provider)) {
		return settings.codex?.defaultReasoningEffort;
	}
	if (isAnthropicProvider(provider)) {
		return getAnthropicProviderConfig(provider)?.defaultReasoningEffort;
	}
	return undefined;
}

/**
 * Get the provider prefix for a given OpenAI provider config.
 * Simply returns the config's prefix field.
 */
export function openaiProviderPrefix(config: OpenAIProviderConfig): string {
	return config.prefix;
}

/**
 * Get the Anthropic provider config by its prefix.
 * If prefix is undefined, returns the first provider.
 */
export function getAnthropicProviderConfig(prefix?: string): AnthropicProviderConfig | undefined {
	const providers = (settings.anthropicProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/**
 * Get the provider prefix for a given Anthropic provider config.
 * Simply returns the config's prefix field.
 */
export function anthropicProviderPrefix(config: AnthropicProviderConfig): string {
	return config.prefix;
}

/**
 * If prefix is undefined, returns the first provider.
 */
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

	return config.prefix;
}

/**
 * Get the NUG provider config by its prefix.
 * If prefix is undefined, returns the first provider.
 */
export function getNugProviderConfig(prefix?: string): NUGProviderConfig | undefined {
	const providers = (settings.nugProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/** Get the provider prefix for a given NUG provider config. */
export function nugProviderPrefix(config: NUGProviderConfig): string {
	return config.prefix;
}

/**
 * Get the Cline provider config by its prefix.
 * If prefix is undefined, returns the first provider.
 */
export function getClineProviderConfig(prefix?: string): ClineProviderConfig | undefined {
	const providers = (settings.clineProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/** Get the provider prefix for a given Cline provider config. */
export function clineProviderPrefix(config: ClineProviderConfig): string {
	return config.prefix;
}

export function hasConfiguredClineProvider(): boolean {
	const providers = settings.clineProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.accessToken);
}

function hasConfiguredOpenaiProvider(): boolean {
	const providers = settings.openaiProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey);
}

function hasConfiguredAnthropicProvider(): boolean {
	const providers = settings.anthropicProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey);
}

}

function hasConfiguredCodexProvider(): boolean {
	if (!settings.codex) return false;
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
	const providers = settings.nugProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
}

/** Get the first configured NUG provider. */
export function getFirstNugProvider(): NUGProviderConfig | undefined {
	return (settings.nugProviders ?? []).find((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
}

function getConfiguredProviderCandidates(): string[] {
	const available = new Set<string>();
	if (hasConfiguredOpenaiProvider()) {
		for (const p of settings.openaiProviders ?? []) {
			if (!p.disabled && p.apiKey) available.add(p.prefix || "openai");
		}
	}
	if (hasConfiguredAnthropicProvider()) {
		for (const p of settings.anthropicProviders ?? []) {
			if (!p.disabled && p.apiKey) available.add(p.prefix || "anthropic");
		}
	}
	if (hasConfiguredCodexProvider()) {
		available.add("codex");
	}
		}
	}
	if (hasConfiguredNugProvider()) {
		for (const p of settings.nugProviders ?? []) {
			if (!p.disabled && p.apiKey && p.baseUrl) available.add(p.prefix || "nug");
		}
	}
	}
	if (hasConfiguredClineProvider()) {
		for (const p of settings.clineProviders ?? []) {
			if (!p.disabled && p.accessToken) available.add(p.prefix || "cline");
		}
	}
	const result: string[] = [];

	const preferredOpenai = (settings.openaiProviders ?? []).find((p) => p.apiKey)?.prefix;
	if (preferredOpenai && available.has(preferredOpenai)) {
		result.push(preferredOpenai);
	}

	const preferredAnthropic = (settings.anthropicProviders ?? []).find((p) => p.apiKey)?.prefix;
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

		const custom = settings.agent.customModels ?? [];
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

	// Preserve legacy fallback when no provider can be inferred.
}

// === Context Window Sizes ===

/**
 * Model context window configuration.
 * Reference: https://platform.openai.com/docs/models
 * Codex models reference: internal/registry/model_definitions_static_data.go
 */
interface ModelContextConfig {
	/**
	 * Total context window size (input + output tokens).
	 * This is the maximum total tokens the model can process in a single request.
	 */
	contextLength: number;
	/**
	 * Maximum output/completion tokens the model can generate in a single response.
	 * This is typically smaller than contextLength to leave room for input tokens.
	 * If not specified, defaults to contextLength (no separate output limit).
	 *
	 * Note: For Codex Responses API, max_completion_tokens parameter is not supported
	 * and will be stripped from requests. This value is for reference/display only.
	 */
	maxCompletionTokens?: number;
}

/**
 * Built-in model context window sizes (tokens).
 * For models with only contextLength specified, maxCompletionTokens defaults to contextLength.
 */
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
	// Codex models (ChatGPT Pro/Plus)
	// Context windows here mirror the official model catalog exposed by codex-reversed.
	"gpt-5-codex": { contextLength: 256_000, maxCompletionTokens: 128_000 },
	// codex-reversed 内置 model catalog 显示这些模型的 context_window 为 272000。
	"gpt-5.1-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-max": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-mini": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4-mini": { contextLength: 400_000, maxCompletionTokens: 128_000 },
	"gpt-5.3-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	// Common third-party models (via OpenAI-compatible APIs)
	"deepseek-chat": 64_000,
	"deepseek-reasoner": 64_000,
	// Claude models (via OpenAI-compatible gateways)
	"claude-3-5-sonnet": 200_000,
	"claude-3-opus": 200_000,
	"claude-sonnet-4": 200_000,
	"claude-opus-4": 200_000,
	// Claude 4.6 models — 1M context (GA since 2026-03-11)
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

/**
 * Get the context window size for a model.
 * Falls back to 128k for unknown models.
 */
export function getModelContextWindow(model: string, provider: string): number | null {
	const bareModel = parseModelId(model).model;
	const fullModelValue = provider ? `${provider}:${bareModel}` : model;

	// 0. Check per-model user overrides (highest priority)
	const userOverrides = settings.agent.modelContextWindows ?? {};
	if (userOverrides[fullModelValue]) {
		return userOverrides[fullModelValue];
	}
	// Also try the raw model string in case it already has provider prefix
	if (model !== fullModelValue && userOverrides[model]) {
		return userOverrides[model];
	}

	// 1. Check provider configuration (OpenAI or Anthropic)
		const oaiConfig = getOpenaiProviderConfig(provider);
		if (oaiConfig?.defaultContextWindow) {
			return oaiConfig.defaultContextWindow;
		}
		const anthropicConfig = getAnthropicProviderConfig(provider);
		if (anthropicConfig?.defaultContextWindow) {
			return anthropicConfig.defaultContextWindow;
		}
	}

	// 2. Check built-in table (exact match)
	const builtinConfig = BUILTIN_CONTEXT_WINDOWS[bareModel];
	if (builtinConfig) {
		return typeof builtinConfig === "number" ? builtinConfig : builtinConfig.contextLength;
	}

	// 3. Fuzzy match (handles -latest, -preview, date suffixes, etc.)
	// Sort by pattern length descending so longer (more specific) patterns match first.
	// e.g. "claude-sonnet-4-6" should match before "claude-sonnet-4".
	const normalizedBare = bareModel.toLowerCase();
	const sortedEntries = Object.entries(BUILTIN_CONTEXT_WINDOWS).sort(
		(a, b) => b[0].length - a[0].length,
	);
	for (const [pattern, config] of sortedEntries) {
		if (normalizedBare.startsWith(pattern)) {
			return typeof config === "number" ? config : config.contextLength;
		}
	}

	// 4. Unknown model — return default 128k (conservative estimate)
	return 128_000;
}

/** Threshold above which a model is considered "large context". */
export const LARGE_CONTEXT_BOUNDARY = 600_000;

export const DEFAULT_CONTEXT_THRESHOLDS = {
	standard: { pruneStart: 95, compactStart: 99 },
	large: { pruneStart: 95, compactStart: 99 },
};

/**
 * Get the prune/compact thresholds for a model based on its context window size.
 * Models with context window > 600k use the "large" thresholds; others use "standard".
 */
export function getContextThresholds(
	model: string,
	provider: string,
): { pruneStart: number; compactStart: number } {
	const ctxWin = getModelContextWindow(model, provider) ?? 128_000;
	const tier = ctxWin > LARGE_CONTEXT_BOUNDARY ? "large" : "standard";
	const userThresholds = settings.agent.contextThresholds;
	const cfg = userThresholds?.[tier] ?? DEFAULT_CONTEXT_THRESHOLDS[tier];
	return {
		pruneStart: cfg.pruneStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].pruneStart,
		compactStart: cfg.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].compactStart,
	};
}

/**
 * Get the maximum completion tokens for a model.
 * Returns null if not specified (meaning no separate limit).
 */
export function getModelMaxCompletionTokens(model: string, _provider: string): number | null {
	const bareModel = parseModelId(model).model;

	// Check built-in table (exact match first)
	const builtinConfig = BUILTIN_CONTEXT_WINDOWS[bareModel];
	if (builtinConfig !== undefined) {
		// Exact match found
		if (typeof builtinConfig === "object") {
			return builtinConfig.maxCompletionTokens ?? null;
		}
		// Simple number config means no separate completion limit
		return null;
	}

	// Fuzzy match (handles -latest, -preview, date suffixes, etc.)
	const normalizedBare = bareModel.toLowerCase();
	for (const [pattern, config] of Object.entries(BUILTIN_CONTEXT_WINDOWS)) {
		if (normalizedBare.startsWith(pattern) && typeof config === "object") {
			return config.maxCompletionTokens ?? null;
		}
	}

	return null;
}
