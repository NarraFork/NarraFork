import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { toolRegistry } from "../agent/tool-registry";
import type { ToolDefinition, ToolResult } from "../agent/types";
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
		const def: ToolDefinition = {
			name,
			description: `[MCP: ${serverName}] ${tool.description ?? tool.name}`,
			parameters: createPassthroughSchema(tool.inputSchema),
			isAvailable: () => {
				// Check if the server is still connected
				const statuses = mcpManager.getServerStatuses();
				return statuses.some((s) => s.id === serverId && s.status === "connected");
			},
			async execute(args: Record<string, unknown>): Promise<ToolResult> {
				try {
					const result = await mcpManager.callTool(serverId, tool.name, args);
					const text = result.content
						.filter((c) => c.type === "text" && c.text)
						.map((c) => c.text)
						.join("\n\n");
					return {
						output: text || "(no output)",
						isError: result.isError,
					};
				} catch (err) {
					return {
						output: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
						isError: true,
					};
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
