const MCP_SERVER_PREFIX = "mcp-server:";
const MCP_TOOL_PREFIX = "mcp-tool:";

/** Kept in this dependency-free module so command and search loading share one ceiling. */
export const ADMIN_ONLY_LOAD_TOOLS = new Set([
	"NarraForkAdmin",
	"KnowledgeAdmin",
	"PluginInstall",
	"McpAdmin",
	"HookAdmin",
	"ScheduledTaskAdmin",
]);

/** Loading is not an authorization grant: recheck the acting user's current role. */
export async function isAdminToolExecutionAllowed(
	toolName: string,
	userId: string | null | undefined,
): Promise<boolean> {
	if (!ADMIN_ONLY_LOAD_TOOLS.has(toolName)) return true;
	if (!userId) return false;
	const { isAdminUser } = await import("../lib/agent/tools/admin-common");
	return isAdminUser(userId);
}

export function mcpServerMarker(serverId: string): string {
	return `${MCP_SERVER_PREFIX}${serverId}`;
}

export function parseMcpServerMarker(value: string): string | undefined {
	return value.startsWith(MCP_SERVER_PREFIX) && value.length > MCP_SERVER_PREFIX.length
		? value.slice(MCP_SERVER_PREFIX.length)
		: undefined;
}

/** Explicit single-tool intent, distinct from legacy implicit resident tool names. */
export function mcpToolMarker(serverId: string, canonicalName: string): string {
	return `${MCP_TOOL_PREFIX}${serverId}:${canonicalName}`;
}

export function parseMcpToolMarker(
	value: string,
): { serverId: string; canonicalName: string } | undefined {
	if (!value.startsWith(MCP_TOOL_PREFIX)) return undefined;
	const separator = value.lastIndexOf(":");
	if (separator <= MCP_TOOL_PREFIX.length || separator === value.length - 1) return undefined;
	const canonicalName = value.slice(separator + 1);
	if (!canonicalName.startsWith("mcp__")) return undefined;
	return { serverId: value.slice(MCP_TOOL_PREFIX.length, separator), canonicalName };
}
