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
export { PLAN_MODE_ALLOWED_TOOLS } from "./types";

/**
 * Convert DB narrator messages into provider history format.
 * Routes to the correct provider based on the provider name.
 */
export async function buildHistory(
	dbMessages: import("./provider").DbMessage[],
	model: string,
	narratorId?: string,
): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
	return getProvider(provider).buildHistory(dbMessages, model, narratorId);
}

/** Resolve provider name for a model by checking custom models in settings. */
function resolveProviderForModel(model?: string): string {
	try {
		// Dynamic import to avoid circular dependency at module load time
		const { settings } = require("../settings");
		const custom = settings.agent?.customModels ?? [];
		const found = custom.find((m: { value: string; provider?: string }) => m.value === model);
	} catch {
	}
}

/**
 * Simple text generation — no tools, no loop.
 * Routes to the correct provider based on the model.
 */
export async function agentGenerate(text: string, model?: string): Promise<string> {
	const provider = getProvider(resolveProviderForModel(model));
	return provider.generate(text, model ?? "claude-sonnet");
}

export async function agentGenerateWithMeta(
	text: string,
	model?: string,
): Promise<{ text: string; contextPercent?: number }> {
	const provider = getProvider(resolveProviderForModel(model));
	return provider.generateWithMeta(text, model ?? "claude-sonnet");
}

/**
 * Generate text using a history-based conversation.
 * Routes to the correct provider based on the model.
 */
export async function agentGenerateWithHistory(
	systemInstruction: string,
	content: string,
	model?: string,
	locale?: string,
): Promise<string> {
	const provider = getProvider(resolveProviderForModel(model));
	return provider.generateWithHistory(systemInstruction, content, model ?? "claude-sonnet", locale);
}
