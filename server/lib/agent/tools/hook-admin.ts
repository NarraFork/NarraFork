import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";
import { errorResult, isAdminUser, requestWritePermission, truncateText } from "./admin-common";

/**
 * HookAdmin — optional, admin-only agent tool for managing lifecycle hooks.
 *
 * Hooks fire on narrator events (PreToolUse / PostToolUse / Stop / Attention /
 * AttentionResolved) and can execute arbitrary shell commands or HTTP requests,
 * so they are admin-only and every mutation requires user approval.
 * Headers may contain secrets and are never echoed back with values.
 */

const hookActionSchema = z.enum(["list", "get", "create", "update", "delete"]);
const hookEventSchema = z.enum([
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"Attention",
	"AttentionResolved",
]);
const hookTypeSchema = z.enum(["command", "http"]);

const hookFieldsSchema = {
	projectId: z.string().min(1).max(100).optional().describe("Optional project scope for the hook"),
	event: hookEventSchema.optional().describe("Narrator event that triggers the hook"),
	matcher: z
		.string()
		.max(200)
		.optional()
		.describe("Optional matcher (e.g. tool name for PreToolUse/PostToolUse)"),
	type: hookTypeSchema.optional().describe("Hook type: command (shell) or http (request)"),
	command: z
		.string()
		.max(10000)
		.nullable()
		.optional()
		.describe("Shell command to run (type=command)"),
	url: z.string().url().max(2000).nullable().optional().describe("HTTP URL to call (type=http)"),
	headers: z
		.record(z.string(), z.string().max(2000))
		.nullable()
		.optional()
		.describe("HTTP headers (secret values; never echoed back)"),
	timeout: z.number().int().min(1).max(600).optional().describe("Timeout in seconds (default 30)"),
	enabled: z.boolean().optional().describe("Whether the hook is enabled"),
	sortOrder: z.number().int().optional().describe("Execution order among matching hooks"),
};

export interface HookAdminToolDeps {
	/** Test seam: hook service-like object. Defaults to lazy import of hookService. */
	service?: HookServiceLike;
	/** Test seam: admin check. Defaults to DB role check. */
	isAdminUser?: (userId: string | null | undefined) => Promise<boolean> | boolean;
}

export interface HookServiceLike {
	listAll(): Promise<Array<Record<string, unknown>>>;
	get(id: string): Promise<Record<string, unknown> | undefined>;
	create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
	update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
	delete(id: string): Promise<void>;
}

export function createHookAdminTool(deps: HookAdminToolDeps = {}): ToolDefinition {
	return {
		name: "HookAdmin",
		description:
			"Manage narrator lifecycle hooks (admin only, mutating actions require approval). action=list/get read hooks; action=create registers a hook that runs a shell command or HTTP request on narrator events (PreToolUse, PostToolUse, Stop, Attention, AttentionResolved); action=update modifies one; action=delete removes one. Secret header values are never echoed back.",
		parameters: z.object({
			action: hookActionSchema.describe("The hook management action to perform."),
			id: z.string().min(1).max(100).optional().describe("Hook id (get/update/delete)."),
			...hookFieldsSchema,
		}),
		async execute(args, ctx): Promise<ToolResult> {
			const input = args as Record<string, unknown>;
			const action = input.action as string;
			const service = deps.service ?? (await loadHookService());
			const isAdmin = deps.isAdminUser ?? isAdminUser;
			try {
				if (action === "list") {
					const hooks = await service.listAll();
					return {
						output:
							hooks.length === 0
								? "No hooks configured."
								: JSON.stringify(hooks.map(sanitizeHook), null, 2),
						title: "Hooks",
						metadata: { tool: "HookAdmin", action, count: hooks.length },
					};
				}

				if (action === "get") {
					const id = input.id as string | undefined;
					if (!id) return errorResult("Error: 'id' is required for get.");
					const hook = await service.get(id);
					if (!hook) return errorResult(`Hook not found: ${id}`);
					return {
						output: JSON.stringify(sanitizeHook(hook), null, 2),
						title: "Hook",
						metadata: { tool: "HookAdmin", action, hookId: id },
					};
				}

				if (!(await isAdmin(ctx.userId))) {
					return errorResult("HookAdmin is restricted to administrators.", "HookAdmin denied");
				}

				if (action === "create") {
					const denied = await requestWritePermission(ctx, "HookAdmin", {
						action,
						...(input.event !== undefined && { event: input.event }),
						...(input.type !== undefined && { type: input.type }),
						...(input.command !== undefined && { command: input.command }),
						...(input.url !== undefined && { url: input.url }),
						...(input.projectId !== undefined && { projectId: input.projectId }),
						warning:
							"This will register a hook that runs on narrator events. command hooks execute arbitrary shell commands; http hooks send requests to the given URL.",
					});
					if (denied) return errorResult(denied, "HookAdmin denied");

					const { createHookSchema } = await import("../../validators");
					const parsed = createHookSchema.safeParse(input);
					if (!parsed.success) {
						return errorResult(`Invalid hook configuration: ${parsed.error.message}`);
					}
					const hook = await service.create(parsed.data);
					return {
						output: JSON.stringify(sanitizeHook(hook), null, 2),
						title: "Hook created",
						metadata: { tool: "HookAdmin", action, hookId: hook.id },
					};
				}

				if (action === "update" || action === "delete") {
					const id = input.id as string | undefined;
					if (!id) return errorResult("Error: 'id' is required for this action.");
					const existing = await service.get(id);
					if (!existing) return errorResult(`Hook not found: ${id}`);

					const denied = await requestWritePermission(ctx, "HookAdmin", {
						action,
						id,
						...(input.event !== undefined && { event: input.event }),
						warning:
							action === "delete"
								? "This will permanently delete the hook."
								: "This will modify the hook configuration.",
					});
					if (denied) return errorResult(denied, "HookAdmin denied");

					if (action === "delete") {
						await service.delete(id);
						return {
							output: `Deleted hook ${id}.`,
							title: "Hook deleted",
							metadata: { tool: "HookAdmin", action, hookId: id },
						};
					}

					const { updateHookSchema } = await import("../../validators");
					const parsed = updateHookSchema.safeParse(input);
					if (!parsed.success) {
						return errorResult(`Invalid hook update: ${parsed.error.message}`);
					}
					const effectiveType = parsed.data.type ?? existing.type;
					if (effectiveType === "command" && parsed.data.command === null) {
						return errorResult(
							"Cannot clear command without changing hook type — the hook would have no command to execute",
						);
					}
					if (effectiveType === "http" && parsed.data.url === null) {
						return errorResult(
							"Cannot clear url without changing hook type — the hook would have no URL to call",
						);
					}
					const hook = await service.update(id, parsed.data as Record<string, unknown>);
					if (!hook) return errorResult(`Hook not found: ${id}`);
					return {
						output: JSON.stringify(sanitizeHook(hook), null, 2),
						title: "Hook updated",
						metadata: { tool: "HookAdmin", action, hookId: id },
					};
				}

				return errorResult(`Unknown HookAdmin action: ${action}`);
			} catch (error) {
				return errorResult(
					`HookAdmin failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}

/** Project a hook for model output: truncate long payloads, redact header values. */
function sanitizeHook(hook: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of [
		"id",
		"projectId",
		"event",
		"matcher",
		"type",
		"timeout",
		"enabled",
		"sortOrder",
		"createdAt",
		"updatedAt",
	]) {
		if (hook[key] !== undefined) result[key] = hook[key];
	}
	if (hook.command !== undefined && hook.command !== null)
		result.command = truncateText(hook.command, 2_000);
	if (hook.url !== undefined) result.url = hook.url;
	if (hook.proxyMode !== undefined && hook.proxyMode !== null) result.proxyMode = hook.proxyMode;
	if (hook.proxyUrl !== undefined) result.proxyUrl = hook.proxyUrl;
	if (hook.headers && typeof hook.headers === "object" && !Array.isArray(hook.headers)) {
		result.headerKeys = Object.keys(hook.headers as Record<string, string>).sort();
	}
	return result;
}

async function loadHookService(): Promise<HookServiceLike> {
	const mod = await import("../../../services/hook-service");
	return mod.hookService as HookServiceLike;
}

export const hookAdminTool: ToolDefinition = createHookAdminTool();
