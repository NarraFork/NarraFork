import { z } from "zod/v4";
import { type NarraForkSettings, SETTING_DOCS } from "../../../lib/settings/index";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * NarraForkAdmin — optional tool for reading and writing NarraFork settings.
 *
 * Only loadable by admin users (enforced in handleLoadToolCommand).
 * Write operations (update/reset) require user permission via requestPermission.
 * Read operations (get) rely on loop-layer permission checks.
 * Field documentation lives in settings/index.ts as SETTING_DOCS.
 */

// Lazy imports to avoid circular/dead-load issues
async function getSettingsModule() {
	return import("../../../lib/settings/index");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask sensitive fields before returning settings to the agent */
function maskSensitive(obj: Record<string, unknown>): Record<string, unknown> {
	const result = { ...obj };
	if (result.auth && typeof result.auth === "object") {
		const auth = { ...(result.auth as Record<string, unknown>) };
		if (typeof auth.jwtSecret === "string" && auth.jwtSecret.length > 0) {
			auth.jwtSecret = "***MASKED***";
		}
		result.auth = auth;
	}
	// Mask API keys in provider arrays
	for (const key of [
		"openaiProviders",
		"anthropicProviders",
		"nugProviders",
		"clineProviders",
	]) {
		const arr = result[key];
		if (Array.isArray(arr)) {
			result[key] = arr.map((p: Record<string, unknown>) => {
				const masked = { ...p };
				if (typeof masked.apiKey === "string") masked.apiKey = "***MASKED***";
				return masked;
			});
		}
	}
	}
	return result;
}

/** Get a nested value by dot-path (e.g. "agent.defaultModel") */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = obj;
	for (const part of parts) {
		if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
			current = (current as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	return current;
}

/**
 * Delete a nested key by dot-path, then clean up empty parent objects.
 * Walks upward from the deletion point; removes the nearest empty ancestor and stops.
 */
function deleteByPathAndClean(obj: Record<string, unknown>, path: string): boolean {
	const parts = path.split(".");
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
			return false;
		}
		current = current[part] as Record<string, unknown>;
	}
	const lastKey = parts[parts.length - 1];
	if (!(lastKey in current)) return false;
	delete current[lastKey];

	// Clean up nearest empty parent
	let parent = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const segment = parts[i];
		const child = parent[segment] as Record<string, unknown>;
		if (child && typeof child === "object" && Object.keys(child).length === 0) {
			delete parent[segment];
			break;
		}
		parent = child;
	}
	return true;
}

/**
 * Build an annotated object: for every leaf that has a doc entry,
 * replace the scalar value with { value, default, desc }.
 * Non-leaf objects are recursed into. Undocumented leaves keep raw value.
 */
function annotateSettings(
	current: Record<string, unknown>,
	defaults: Record<string, unknown>,
	prefix: string,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(current)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const curVal = current[key];
		const defVal = defaults[key];
		const doc = SETTING_DOCS[path];

		if (curVal && typeof curVal === "object" && !Array.isArray(curVal)) {
			// Object node — recurse
			result[key] = annotateSettings(
				curVal as Record<string, unknown>,
				(defVal && typeof defVal === "object" && !Array.isArray(defVal) ? defVal : {}) as Record<
					string,
					unknown
				>,
				path,
			);
		} else {
			// Leaf node
			if (doc) {
				result[key] = {
					value: curVal,
					default: defVal,
					desc: doc.desc,
					type: doc.type,
					...(doc.valid ? { valid: doc.valid } : {}),
				};
			} else {
				result[key] = curVal;
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const narraforkAdminTool: ToolDefinition = {
	name: "NarraForkAdmin",
	description:
		"Manage NarraFork server settings (admin only). " +
		"Actions: get_settings (all settings with docs), " +
		"get_setting (single key by dot-path), " +
		"update_settings (partial merge, requires approval), " +
		"reset_setting (revert to default, requires approval).",
	isAvailable: () => false,
	parameters: z.object({
		action: z
			.enum(["get_settings", "get_setting", "update_settings", "reset_setting"])
			.describe("The action to perform"),
		path: z
			.string()
			.optional()
			.describe(
				"Dot-separated path to a setting key (e.g. 'agent.defaultModel', 'chapters.maxActiveWorktrees'). " +
					"Required for 'get_setting' and 'reset_setting'.",
			),
		value: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				"Settings object to merge (for 'update_settings'). " +
					"Supports partial updates via deep merge. Example: { agent: { maxTurns: 300 } }",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { action, path, value } = args as {
			action: "get_settings" | "get_setting" | "update_settings" | "reset_setting";
			path?: string;
			value?: Record<string, unknown>;
		};

		const settingsMod = await getSettingsModule();

		switch (action) {
			case "get_settings": {
				const current = settingsMod.loadSettings();
				const defaults = settingsMod.getDefaults();
				const masked = maskSensitive(current as unknown as Record<string, unknown>);
				const annotated = annotateSettings(
					masked,
					defaults as unknown as Record<string, unknown>,
					"",
				);
				return {
					output: JSON.stringify(annotated, null, 2),
					title: "All settings (annotated)",
				};
			}

			case "get_setting": {
				if (!path) {
					return { output: "Error: 'path' is required for get_setting.", isError: true };
				}
				const current = settingsMod.loadSettings();
				const val = getByPath(current as unknown as Record<string, unknown>, path);
				if (val === undefined) {
					return {
						output: `Setting '${path}' not found.`,
						isError: true,
					};
				}
				const doc = SETTING_DOCS[path];
				const defVal = getByPath(
					settingsMod.getDefaults() as unknown as Record<string, unknown>,
					path,
				);
				if (doc) {
					return {
						output: JSON.stringify(
							{
								value: val,
								default: defVal,
								desc: doc.desc,
								type: doc.type,
								...(doc.valid ? { valid: doc.valid } : {}),
							},
							null,
							2,
						),
						title: `Setting: ${path}`,
					};
				}
				return {
					output: JSON.stringify(val, null, 2),
					title: `Setting: ${path}`,
				};
			}

			case "update_settings": {
				// Write operation — require user permission
				const perm = await ctx.requestPermission(
					"NarraForkAdmin",
					{ action, path, value },
					ctx.currentToolUseId ?? "admin",
				);
				if (perm.behavior === "deny") {
					return {
						output: perm.message ?? "User denied the NarraForkAdmin operation.",
						isError: true,
					};
				}
				if (!value || Object.keys(value).length === 0) {
					return { output: "Error: 'value' is required for update_settings.", isError: true };
				}
				const current = settingsMod.loadSettings();
				const merged = settingsMod.deepMerge(current as unknown as Record<string, unknown>, value);
				settingsMod.saveSettings(merged as unknown as NarraForkSettings);
				return {
					output: `Settings updated successfully. Changed keys: ${Object.keys(value).join(", ")}`,
					title: "Settings updated",
				};
			}

			case "reset_setting": {
				// Write operation — require user permission
				const perm = await ctx.requestPermission(
					"NarraForkAdmin",
					{ action, path, value },
					ctx.currentToolUseId ?? "admin",
				);
				if (perm.behavior === "deny") {
					return {
						output: perm.message ?? "User denied the NarraForkAdmin operation.",
						isError: true,
					};
				}
				if (!path) {
					return { output: "Error: 'path' is required for reset_setting.", isError: true };
				}
				const current = settingsMod.loadSettings();
				const currentObj = current as unknown as Record<string, unknown>;
				const existed = deleteByPathAndClean(currentObj, path);
				if (!existed) {
					return {
						output: `Setting '${path}' not found or already at default.`,
						isError: true,
					};
				}
				settingsMod.saveSettings(current as unknown as NarraForkSettings);
				const defVal = getByPath(
					settingsMod.getDefaults() as unknown as Record<string, unknown>,
					path,
				);
				return {
					output: `Setting '${path}' has been reset to default (${JSON.stringify(defVal)}).`,
					title: `Reset: ${path}`,
				};
			}

			default:
				return { output: `Unknown action: ${action}`, isError: true };
		}
	},
};
