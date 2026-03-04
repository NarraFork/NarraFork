import { parseModelId, settings } from "../settings";
import { resolveProviderAndModel } from "./provider";
import { registerCoreTools } from "./tools";
import { initTruncateCleanup } from "./truncate";

// Auto-register core tools on module load
registerCoreTools();

// Start periodic cleanup of truncated output files
initTruncateCleanup();

export { agentLoop } from "./loop";
export type { DbMessage, DbToolCall, ParsedStreamEvent, ProviderAdapter } from "./provider";
export { getProvider, resolveProviderAndModel } from "./provider";
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
	const requestedModel = model || settings.agent.defaultModel;
	const parsed = parseModelId(requestedModel);
	const prefixedModel = parsed.provider
		? requestedModel
		: `${provider}:${parsed.model || "default"}`;
	const resolved = resolveProviderAndModel(prefixedModel);
	return resolved.adapter.buildHistory(dbMessages, resolved.model, narratorId);
}

/**
 * Simple text generation — no tools, no loop.
 * Routes to the correct provider based on the model.
 */
export async function agentGenerate(text: string, model?: string): Promise<string> {
	const requestedModel = model ?? settings.agent.defaultModel;
	const resolved = resolveProviderAndModel(requestedModel);
	return resolved.adapter.generate(text, resolved.model);
}

export async function agentGenerateWithMeta(
	text: string,
	model?: string,
	systemInstruction?: string,
): Promise<{ text: string; contextPercent?: number }> {
	const requestedModel = model ?? settings.agent.defaultModel;
	const resolved = resolveProviderAndModel(requestedModel);
	return resolved.adapter.generateWithMeta(text, resolved.model, systemInstruction);
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
	const requestedModel = model ?? settings.agent.defaultModel;
	const resolved = resolveProviderAndModel(requestedModel);
	return resolved.adapter.generateWithHistory(systemInstruction, content, resolved.model, locale);
}
