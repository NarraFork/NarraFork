import { z } from "zod/v4";
import { normalizeToolName, sanitizeToolNameSegment } from "../agent/tool-name";
import { toolRegistry } from "../agent/tool-registry";
import type { ToolContext, ToolDefinition, ToolResult } from "../agent/types";
import { type McpDirectoryEntry, mcpManager } from "./manager";

/**
 * Build a NarraFork tool name from MCP server name + tool name.
 * Format: mcp__<sanitizedServerName>__<sanitizedToolName>
 *
 * Both segments are sanitized: MCP itself places no alphabet restriction on tool
 * names, so servers legitimately expose dotted/namespaced names like
 * `github.search_issues`, while providers reject anything outside
 * `^[a-zA-Z0-9_-]+$` — and they reject the *whole request*, not just that tool.
 * The assembled name is normalized once more to enforce the length budget.
 */
function buildToolName(serverName: string, toolName: string): string {
	const safeName = sanitizeToolNameSegment(serverName).toLowerCase();
	const safeTool = sanitizeToolNameSegment(toolName);
	return normalizeToolName(`mcp__${safeName}__${safeTool}`);
}

/** MCP owns input validation; locally require an object without dropping dynamic keys. */
const mcpParameters = z.object({}).passthrough();

function createMcpToolDefinition(
	{ serverId, serverName, tool }: McpDirectoryEntry,
	name: string,
): ToolDefinition {
	const originalName = tool.name;
	return {
		name,
		description: `[MCP: ${serverName}] ${tool.description ?? originalName}`,
		parameters: mcpParameters,
		// Own one unchanged schema snapshot per changed declaration; directory producers may
		// reuse their objects on refresh. Provider-specific projection belongs at the boundary.
		rawJsonSchema: structuredClone(tool.inputSchema),
		metadata: {
			mcpServerId: serverId,
			mcpServerName: serverName,
			mcpToolName: originalName,
		},
		isAvailable: () => mcpManager.isServerConnected(serverId),
		async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
			const start = Date.now();
			let longRunningTimer: ReturnType<typeof setTimeout> | undefined;
			if (ctx.currentToolUseId && ctx.emitLongRunning) {
				const toolUseId = ctx.currentToolUseId;
				longRunningTimer = setTimeout(() => {
					ctx.emitLongRunning?.(toolUseId, Date.now() - start);
				}, 60_000);
			}
			try {
				const result = await mcpManager.callTool(serverId, originalName, args, ctx.signal);
				const parts: string[] = [];
				for (const item of result.content) {
					if (item.type === "text" && item.text) {
						parts.push(item.text);
					} else if (item.type === "image" && item.data) {
						parts.push(
							`[image: ${item.mimeType ?? "image/png"}, ${item.data.length} bytes base64]`,
						);
					} else if (item.type === "resource" && item.resource) {
						const resource = item.resource as { uri?: string; text?: string };
						parts.push(resource.text ?? `[resource: ${resource.uri ?? "unknown"}]`);
					}
				}
				return { output: parts.join("\n\n") || "(no output)", isError: result.isError };
			} catch (error) {
				if (ctx.signal.aborted) {
					return { output: "MCP tool call was aborted by user", isError: true };
				}
				return {
					output: `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
					isError: true,
				};
			} finally {
				if (longRunningTimer) clearTimeout(longRunningTimer);
			}
		},
	};
}

// Only the inputs that determine a registry definition are compared, once per directory update.
// Weak keys do not retain retired definitions or their unused outputSchema objects.
const definitionInputs = new WeakMap<ToolDefinition, string>();

/** Prepare off the publication boundary; the returned synchronous commit either applies all or none. */
export async function prepareMcpTools(tools: readonly McpDirectoryEntry[]): Promise<() => boolean> {
	const revision = toolRegistry.revision;
	const all = new Map(toolRegistry.all().map((tool) => [tool.name, tool]));
	const owned = new Map(
		[...all].filter(
			([name, tool]) =>
				name.startsWith("mcp__") &&
				typeof tool.metadata?.mcpServerId === "string" &&
				typeof tool.metadata?.mcpToolName === "string",
		),
	);
	const desired = new Map<string, ToolDefinition>();
	let slice = performance.now();
	for (const entry of tools) {
		const { serverId, serverName, tool } = entry;
		const name = buildToolName(serverName, tool.name);
		if (desired.has(name)) throw new Error(`MCP tool name collision: "${name}"`);
		if (all.has(name) && !owned.has(name)) {
			throw new Error(`MCP tool name conflicts with an existing non-MCP tool: "${name}"`);
		}
		const inputs = JSON.stringify([
			serverId,
			serverName,
			tool.name,
			tool.description ?? tool.name,
			tool.inputSchema,
		]);
		const previous = owned.get(name);
		if (previous && definitionInputs.get(previous) === inputs) {
			desired.set(name, previous);
		} else {
			const definition = createMcpToolDefinition(entry, name);
			definitionInputs.set(definition, inputs);
			desired.set(name, definition);
		}
		if (performance.now() - slice >= 8) {
			await Bun.sleep(0);
			slice = performance.now();
		}
	}
	const removed = [...owned.keys()].filter((name) => !desired.has(name));
	const changed = [...desired.values()].filter((tool) => owned.get(tool.name) !== tool);
	return () => {
		// Another registry producer may have run while preparation yielded. Recompute, never
		// overwrite its changes or partially publish a directory based on an obsolete registry.
		if (toolRegistry.revision !== revision) return false;
		for (const name of removed) toolRegistry.unregister(name);
		for (const definition of changed) toolRegistry.register(definition);
		return true;
	};
}
