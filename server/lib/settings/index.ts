import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface NarraForkSettings {
	server: { port: number };
	paths: { defaultProjectDir: string };
	agent: {
		defaultModel: string;
		defaultPermissionMode: string;
		summaryModel: string;
	};
	chapters: {
		maxActiveWorktrees: number;
		maxActiveContainers: number;
		worktreeSizeWarningMb: number;
		autoSaveOnDormant: boolean;
		dormantAfterMinutes: number;
	};
	containers: {
		runtime: "podman" | "docker";
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
}

const DEFAULTS: NarraForkSettings = {
	server: { port: 7778 },
	paths: { defaultProjectDir: resolve(homedir(), "projects") },
	agent: {
		defaultModel: "claude-sonnet-4-5",
		defaultPermissionMode: "default",
		summaryModel: "claude-haiku-4-5",
	},
	chapters: {
		maxActiveWorktrees: 10,
		maxActiveContainers: 5,
		worktreeSizeWarningMb: 500,
		autoSaveOnDormant: true,
		dormantAfterMinutes: 0,
	},
	containers: {
		runtime: "podman",
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

function deepMerge<T extends Record<string, any>>(defaults: T, overrides: Record<string, any>): T {
	const result = { ...defaults };
	for (const key of Object.keys(overrides)) {
		const val = overrides[key];
		if (val && typeof val === "object" && !Array.isArray(val) && key in defaults) {
			result[key as keyof T] = deepMerge(
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

export function saveSettings(settings: NarraForkSettings): void {
	mkdirSync(narraforkDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export const settings = loadSettings();
