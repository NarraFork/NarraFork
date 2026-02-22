import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ModelOption {
	value: string;
	label: string;
	provider?: string;
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
		extendedContext: boolean;
		maxTurns: number;
		subagentModels: {
			explore: string;
			plan: string;
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
	};
	editor: {
		type: "vscode" | "cursor" | "windsurf" | "zed";
	};
	auth: {
		jwtSecret: string;
		registrationOpen: boolean;
	};
		credentialsPath: string;
		configPath: string;
		defaultModel?: string;
	};
	openai?: {
		apiKey: string;
		baseUrl: string;
		defaultModel: string;
	};
}

const DEFAULTS: NarraForkSettings = {
	server: { port: 7778 },
	paths: { defaultProjectDir: resolve(homedir(), "projects") },
	agent: {
		defaultModel: "claude-sonnet",
		defaultPermissionMode: "default",
		summaryModel: "claude-haiku",
		customModels: [],
		hiddenModels: [],
		extendedContext: false,
		maxTurns: 200,
		subagentModels: {
			explore: "",
			plan: "",
		},
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

	// Auto-generate JWT secret on first run
	if (!merged.auth.jwtSecret) {
		merged.auth.jwtSecret = randomBytes(32).toString("hex");
		saveSettings(merged);
	}

	return merged;
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


/** Resolve provider name for a given model by looking up customModels in settings. */
export function resolveProvider(model?: string): string {
	const custom = settings.agent.customModels ?? [];
	const found = custom.find((m) => m.value === model);
}
