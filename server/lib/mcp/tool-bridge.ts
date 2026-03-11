import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { toolRegistry } from "../agent/tool-registry";
import type { ToolContext, ToolDefinition, ToolResult } from "../agent/types";
import { logger } from "../logger";
import { mcpManager } from "./manager";

/**
 * Build a NarraFork tool name from MCP server name + tool name.
 * Format: mcp__<sanitizedServerName>__<toolName>
 */
function buildToolName(serverName: string, toolName: string): string {
	const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
	return `mcp__${sanitized}__${toolName}`;
}

/**
 * Create a Zod schema that passes through any object.
 * MCP tools use JSON Schema which we can't easily convert to Zod,
 * so we accept any object and let the MCP server validate.
 */
function createPassthroughSchema(inputSchema?: Tool["inputSchema"]): z.ZodType {
	if (!inputSchema?.properties || Object.keys(inputSchema.properties).length === 0) {
		return z.object({}).passthrough();
	}
	// Build a Zod object with all properties as optional unknown,
	// preserving the property names for AI tool-use formatting.
	const shape: Record<string, z.ZodType> = {};
	const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
	for (const key of Object.keys(inputSchema.properties)) {
		const prop = inputSchema.properties[key] as { description?: string };
		const base = z.any().describe(prop?.description ?? "");
		shape[key] = required.has(key) ? base : base.optional();
	}
	return z.object(shape).passthrough();
}

/**
 * Clean an MCP inputSchema for use as rawJsonSchema sent to AI providers.
 * is known to accept, recursively cleaning nested schemas.
 */
function cleanMcpSchema(inputSchema?: Tool["inputSchema"]): Record<string, unknown> | undefined {
	if (!inputSchema) return undefined;

	const ALLOWED_KEYS = new Set([
		"type",
		"description",
		"properties",
		"required",
		"items",
		"enum",
		"const",
		"anyOf",
		"oneOf",
		"allOf",
		"minimum",
		"maximum",
		"minLength",
		"maxLength",
		"minItems",
		"maxItems",
		"default",
		"additionalProperties",
		"nullable",
	]);

	function cleanNode(node: Record<string, unknown>): Record<string, unknown> {
		const cleaned: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			if (!ALLOWED_KEYS.has(key)) continue;
			if (key === "properties" && typeof value === "object" && value !== null) {
				const props: Record<string, unknown> = {};
				for (const [pKey, pVal] of Object.entries(value as Record<string, unknown>)) {
					if (typeof pVal === "object" && pVal !== null) {
						props[pKey] = cleanNode(pVal as Record<string, unknown>);
					} else {
						props[pKey] = pVal;
					}
				}
				cleaned[key] = props;
			} else if (key === "items" && typeof value === "object" && value !== null) {
				cleaned[key] = cleanNode(value as Record<string, unknown>);
			} else if (key === "additionalProperties" && typeof value === "object" && value !== null) {
				cleaned[key] = cleanNode(value as Record<string, unknown>);
			} else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
				cleaned[key] = value.map((v) =>
					typeof v === "object" && v !== null ? cleanNode(v as Record<string, unknown>) : v,
				);
			} else {
				cleaned[key] = value;
			}
		}
		// Ensure `type` exists on property nodes
		if (!cleaned.type && !cleaned.anyOf && !cleaned.oneOf && !cleaned.allOf && !cleaned.const) {
			cleaned.type = "string";
		}
		return cleaned;
	}

	const result: Record<string, unknown> = { type: "object" };
	if (inputSchema.properties) {
		const props: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(inputSchema.properties)) {
			if (typeof val === "object" && val !== null) {
				props[key] = cleanNode(val as Record<string, unknown>);
			} else {
				props[key] = val;
			}
		}
		result.properties = props;
	}
	if (Array.isArray(inputSchema.required) && inputSchema.required.length > 0) {
		result.required = inputSchema.required;
	}
	result.additionalProperties = false;
	return result;
}

/**
 * Sync MCP tools into the tool registry.
 * Removes stale MCP tools and registers new ones.
 */
export function syncMcpTools(): void {
	// Remove all existing MCP tools from registry
	const existing = toolRegistry.all().filter((t) => t.name.startsWith("mcp__"));
	for (const tool of existing) {
		toolRegistry.unregister(tool.name);
	}

	// Register tools from all connected servers
	const mcpTools = mcpManager.getAvailableTools();
	for (const { serverId, serverName, tool } of mcpTools) {
		const name = buildToolName(serverName, tool.name);
		// Track original property names so we can strip injected dummy params before calling MCP
		const originalProps = new Set(
			tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [],
		);
		const def: ToolDefinition = {
			name,
			description: `[MCP: ${serverName}] ${tool.description ?? tool.name}`,
			parameters: createPassthroughSchema(tool.inputSchema),
			rawJsonSchema: cleanMcpSchema(tool.inputSchema),
			isAvailable: () => {
				// Check if the server is still connected
				const statuses = mcpManager.getServerStatuses();
				return statuses.some((s) => s.id === serverId && s.status === "connected");
			},
			async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
				const start = Date.now();
				// Trigger long-running notification after 60s (same threshold as bash tool)
				let longRunningTimer: ReturnType<typeof setTimeout> | undefined;
				if (ctx.currentToolUseId && ctx.emitLongRunning) {
					const toolUseId = ctx.currentToolUseId;
					longRunningTimer = setTimeout(() => {
						ctx.emitLongRunning?.(toolUseId, Date.now() - start);
					}, 60_000);
				}

				try {
					// Strip any params not in the original MCP schema (e.g. dummy "confirm")
					const cleanArgs: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(args)) {
						if (originalProps.size === 0 || originalProps.has(k)) {
							cleanArgs[k] = v;
						}
					}
					const result = await mcpManager.callTool(serverId, tool.name, cleanArgs, ctx.signal);
					// Handle all content types: text, image, resource
					const parts: string[] = [];
					for (const c of result.content) {
						if (c.type === "text" && c.text) {
							parts.push(c.text);
						} else if (c.type === "image" && c.data) {
							parts.push(`[image: ${c.mimeType ?? "image/png"}, ${c.data.length} bytes base64]`);
						} else if (c.type === "resource" && c.resource) {
							const res = c.resource as { uri?: string; text?: string };
							parts.push(res.text ?? `[resource: ${res.uri ?? "unknown"}]`);
						}
					}
					return {
						output: parts.join("\n\n") || "(no output)",
						isError: result.isError,
					};
				} catch (err) {
					if (ctx.signal.aborted) {
						return {
							output: "MCP tool call was aborted by user",
							isError: true,
						};
					}
					return {
						output: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
						isError: true,
					};
				} finally {
					if (longRunningTimer) clearTimeout(longRunningTimer);
				}
			},
		};
		toolRegistry.register(def);
	}

	const count = mcpTools.length;
	if (count > 0) {
		logger.info(`MCP: synced ${count} tool(s) into tool registry`);
	}
}
