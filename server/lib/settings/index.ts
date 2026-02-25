import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
}

export interface NarraForkSettings {
	server: { port: number };
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
		legacyEncoding: boolean;
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
	/** Multiple OpenAI-compatible API providers. */
	openaiProviders?: OpenAIProviderConfig[];
}

const DEFAULTS: NarraForkSettings = {
	server: { port: 7778 },
	paths: { defaultProjectDir: resolve(homedir(), "projects") },
	agent: {
		defaultPermissionMode: "default",
		customModels: [],
		hiddenModels: [],
		maxTurns: 200,
		subagentModels: {
			explore: "",
			plan: "",
		},
		legacyEncoding: false,
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
	},
	editor: {
		type: "vscode",
	},
	auth: {
		jwtSecret: "",
		registrationOpen: true,
	},
};

const narraforkDir = resolve(homedir(), ".narrafork");
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

export function loadSettings(): NarraForkSettings {
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

	// Clean up legacy openai field from settings.json
	if (mergedAny.openai !== undefined) {
		delete mergedAny.openai;
		needsSave = true;
	}

	if (needsSave) saveSettings(merged);

	return merged;
}

/** Simple 8-char random ID for migration (avoids importing nanoid at this level). */
function generateMigrationId(): string {
	return randomBytes(6).toString("base64url").slice(0, 8);
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


/** Registry for external model checkers and listers (avoids circular imports). */
let openaiModelChecker: ((model: string) => boolean) | null = null;
let openaiModelLister: (() => string[]) | null = null;

export function registerOpenaiModelChecker(checker: (model: string) => boolean): void {
	openaiModelChecker = checker;
}

}

export function registerOpenaiModelLister(lister: () => string[]): void {
	openaiModelLister = lister;
}

}

/**
 * Get all available model values (provider:id format), excluding hidden models.
 */
export function getVisibleModels(): string[] {
	const hidden = new Set(settings.agent.hiddenModels ?? []);
	const openai = openaiModelLister?.() ?? [];
	const custom = (settings.agent.customModels ?? []).map((m) => m.value);
	const seen = new Set<string>();
	const result: string[] = [];
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
	const providers = settings.openaiProviders ?? [];
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/**
 * Get the provider prefix for a given OpenAI provider config.
 * Simply returns the config's prefix field.
 */
export function openaiProviderPrefix(config: OpenAIProviderConfig): string {
	return config.prefix;
}

/** Resolve provider name for a given model (supports "provider:model" prefix). */
export function resolveProvider(model?: string): string {
	const { provider: explicit, model: bare } = parseModelId(model);
	if (explicit) return explicit;
	const custom = settings.agent.customModels ?? [];
	const found = custom.find((m) => m.value === bare || m.value === model);
	if (found?.provider) return found.provider;
	if (openaiModelChecker?.(bare)) return "openai";
	// If the model is unknown but any OpenAI provider is configured, assume it's an OpenAI model.
	const providers = settings.openaiProviders ?? [];
	if (providers.some((p) => p.apiKey)) return providers[0]?.prefix ?? "openai";
}
