import { registerCoreTools } from "./tools";

// Auto-register core tools on module load
registerCoreTools();

export { agentLoop } from "./loop";
export { buildHistory } from "./message-builder";
export { toolRegistry } from "./tool-registry";
export type {
	AgentConfig,
	AgentEvent,
	AgentToolUse,
	PermissionResult,
	ToolContext,
	ToolDefinition,
	ToolResult,
} from "./types";

/**
 * Simple text generation — no tools, no loop.
 */
export async function agentGenerate(text: string, model?: string): Promise<string> {
}
