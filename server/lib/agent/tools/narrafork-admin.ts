import { applyMcpLoadingPatch } from "@shared/mcp-loading-mode";
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

/** Raw settings array replacements use PATCH semantics for matching server IDs. */
function prepareMcpServersWrite(
	current: unknown,
	incoming: unknown,
): Array<Record<string, unknown>> {
	if (!Array.isArray(incoming)) throw new Error("MCP servers must be an array");
	const previous = new Map<string, Record<string, unknown>>();
	for (const server of Array.isArray(current) ? current : []) {
		if (server && typeof server === "object" && typeof server.id === "string")
			previous.set(server.id, server);
	}
	return incoming.map((server: unknown) => {
		if (!server || typeof server !== "object" || Array.isArray(server))
			throw new Error("Invalid MCP server configuration");
		const input = server as Record<string, unknown>;
		const existing = typeof input.id === "string" ? previous.get(input.id) : undefined;
		// For a new entry, using the entry as its own base both validates the explicit
		// write and retains creation defaults (notably legacy enabled=true → resident).
		return { ...input, ...applyMcpLoadingPatch(existing ?? input, input) };
	});
}

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
	for (const key of ["openaiProviders", "anthropicProviders", "nugProviders"]) {
		const arr = result[key];
		if (Array.isArray(arr)) {
			result[key] = arr.map((p: Record<string, unknown>) => {
				const masked = { ...p };
				if (typeof masked.apiKey === "string") masked.apiKey = "***MASKED***";
				return masked;
			});
		}
	}
	return result;
}

/**
 * Whether a setting key name holds a credential whose value must never be returned raw.
 *
 * Suffix-based so it matches `jwtSecret`, `oauthClientSecret`, `clientSecret`, any
 * `apiKey`, `relayToken` / other `*Token`, and `*password`. Only applied to STRING
 * values, so numeric settings like `maxTokens` are never affected.
 */
function isSensitiveSettingKey(key: string): boolean {
	const lower = key.toLowerCase();
	return (
		lower.endsWith("secret") ||
		lower.endsWith("apikey") ||
		lower.endsWith("token") ||
		lower.endsWith("password")
	);
}

/**
 * Recursively replace string values held under a sensitive key with the mask.
 *
 * `maskSensitive` masks by the known settings STRUCTURE (auth.jwtSecret, provider
 * apiKeys); this masks by key NAME, so a single `get_setting` value — including a nested
 * object or one of the credential keys that structural masking does not model — is never
 * returned in the clear.
 */
function maskSensitiveByKey(key: string, value: unknown): unknown {
	if (typeof value === "string" && value.length > 0 && isSensitiveSettingKey(key)) {
		return "***MASKED***";
	}
	if (Array.isArray(value)) {
		return value.map((item) => maskSensitiveByKey(key, item));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = maskSensitiveByKey(k, v);
		}
		return out;
	}
	return value;
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

export function isPermissionRuleAutoApproveMutation(
	action: string,
	path?: string,
	value?: Record<string, unknown>,
): boolean {
	if (action === "reset_setting") {
		return !path || path === "agent" || path === "agent.permissionRuleAutoApprove";
	}
	if (action !== "update_settings" || !value) return false;
	if (Object.hasOwn(value, "agent.permissionRuleAutoApprove")) return true;
	if (!Object.hasOwn(value, "agent")) return false;
	const agent = value.agent;
	return (
		!agent ||
		typeof agent !== "object" ||
		Array.isArray(agent) ||
		Object.hasOwn(agent, "permissionRuleAutoApprove")
	);
}

export const narraforkAdminTool: ToolDefinition = {
	name: "NarraForkAdmin",
	description:
		"Manage NarraFork server settings (admin only). " +
		"Actions: get_settings (all settings with docs), " +
		"get_setting (single key by dot-path), " +
		"update_settings (partial merge, requires approval), " +
		"reset_setting (revert to default, requires approval).",
	parameters: z.object({
		action: z
			.enum(["get_settings", "get_setting", "update_settings", "reset_setting"])
			.describe("The action to perform"),
		path: z
			.string()
			.optional()
			.describe(
				"Dot-separated path to a setting key (e.g. 'agent.defaultModel', 'workspace.treeSnapshotsEnabled'). " +
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

		// Application authorization guard, not an OS sandbox. Only the authenticated
		// administrator settings route can change this opt-in, never an agent tool.
		if (isPermissionRuleAutoApproveMutation(action, path, value)) {
			return {
				output:
					"permissionRuleAutoApprove can only be changed by a human administrator in settings.",
				isError: true,
			};
		}
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
				// Apply the SAME structural masking as get_settings, then read the path from
				// the masked object so provider apiKeys and auth.jwtSecret come back masked.
				const maskedSettings = maskSensitive(current as unknown as Record<string, unknown>);
				const rawVal = getByPath(maskedSettings, path);
				if (rawVal === undefined) {
					return {
						output: `Setting '${path}' not found.`,
						isError: true,
					};
				}
				// Defense in depth: also mask by key name, covering credential keys the
				// structural mask does not model (oauthClientSecret, clientSecret, relayToken, …).
				const leafKey = path.split(".").pop() ?? path;
				const val = maskSensitiveByKey(leafKey, rawVal);
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
				let patch = value;
				if (Object.hasOwn(value, "mcpServers")) {
					try {
						patch = {
							...value,
							mcpServers: prepareMcpServersWrite(current.mcpServers, value.mcpServers),
						};
					} catch (error) {
						return {
							output: `Error: ${error instanceof Error ? error.message : String(error)}`,
							isError: true,
						};
					}
				}
				const merged = settingsMod.deepMerge(current as unknown as Record<string, unknown>, patch);
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
