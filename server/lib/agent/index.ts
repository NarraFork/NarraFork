import { logger } from "../logger";
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

// === Summary model wrappers ===
// These wrap the standard generate functions with the summary model from settings.
// When the summary model's provider is unavailable, they broadcast a
// `summary_model_unavailable` event via WebSocket so the frontend can prompt
// the user to pick a new model. A 30-second debounce prevents flooding.

/** Timestamp of the last `summary_model_unavailable` broadcast. */
let lastSummaryUnavailableBroadcast = 0;
const SUMMARY_UNAVAILABLE_DEBOUNCE_MS = 30_000;

/**
 * Check whether an error indicates the summary model's provider is unavailable
 * (not configured, not available, disabled, etc.).
 */
function isSummaryProviderError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("not configured") || msg.includes("not available") || msg.includes("is disabled")
	);
}

/**
 * Broadcast a `summary_model_unavailable` event to all WS clients (debounced).
 * Lazy-imports narrator-ws to avoid circular dependency.
 */
async function broadcastSummaryUnavailable(): Promise<void> {
	const now = Date.now();
	if (now - lastSummaryUnavailableBroadcast < SUMMARY_UNAVAILABLE_DEBOUNCE_MS) return;
	lastSummaryUnavailableBroadcast = now;
	try {
		const { broadcastToAll } = await import("../../websocket/narrator-ws");
		broadcastToAll({
			type: "summary_model_unavailable",
			model: settings.agent.summaryModel,
		});
	} catch {
		// WS module not loaded yet — ignore
	}
}

/**
 * Generate text using the summary model (with meta).
 * On provider-unavailable errors, broadcasts a WS event and re-throws.
 */
export async function summaryGenerate(
	text: string,
	systemInstruction?: string,
): Promise<{ text: string; contextPercent?: number }> {
	try {
		return await agentGenerateWithMeta(text, settings.agent.summaryModel, systemInstruction);
	} catch (err) {
		if (isSummaryProviderError(err)) {
			logger.warn("Summary model unavailable, broadcasting to clients", {
				model: settings.agent.summaryModel,
				error: String(err),
			});
			broadcastSummaryUnavailable();
		}
		throw err;
	}
}

/**
 * Generate text using the summary model (with history).
 * On provider-unavailable errors, broadcasts a WS event and re-throws.
 */
export async function summaryGenerateWithHistory(
	systemInstruction: string,
	content: string,
	locale?: string,
): Promise<string> {
	try {
		return await agentGenerateWithHistory(
			systemInstruction,
			content,
			settings.agent.summaryModel,
			locale,
		);
	} catch (err) {
		if (isSummaryProviderError(err)) {
			logger.warn("Summary model unavailable, broadcasting to clients", {
				model: settings.agent.summaryModel,
				error: String(err),
			});
			broadcastSummaryUnavailable();
		}
		throw err;
	}
}
