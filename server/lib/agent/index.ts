import { getProvider } from "./provider";
import { registerCoreTools } from "./tools";

// Auto-register core tools on module load
registerCoreTools();

export { agentLoop } from "./loop";
export type { DbMessage, DbToolCall, ParsedStreamEvent, ProviderAdapter } from "./provider";
export { getProvider } from "./provider";
export { resolveModel } from "./resolve-model";
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
 * Convert DB narrator messages into provider history format.
 * Routes to the correct provider based on the provider name.
 */
export function buildHistory(
	dbMessages: import("./provider").DbMessage[],
	model: string,
): { history: unknown[]; trailingToolResults: unknown[] } {
	return getProvider(provider).buildHistory(dbMessages, model);
}

/**
 * Simple text generation — no tools, no loop.
 */
export async function agentGenerate(text: string, model?: string): Promise<string> {
	const { resolveModel } = await import("./resolve-model");
}

export async function agentGenerateWithMeta(
	text: string,
	model?: string,
): Promise<{ text: string; contextPercent?: number }> {
	const { resolveModel } = await import("./resolve-model");
}
