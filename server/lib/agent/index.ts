import { type TrackApiRequestOptions, trackApiRequest } from "../api-request-tracker";
import { logger } from "../logger";
import { parseModelId, settings } from "../settings";
import { isRetryableError } from "./loop";
import { type GenerateOptions, resolveProviderAndModel } from "./provider";
import { registerCoreTools } from "./tools";
import { initTruncateCleanup } from "./truncate";

// Auto-register core tools on module load
registerCoreTools();

// Start periodic cleanup of truncated output files
initTruncateCleanup();

export type { ReflectionLoopRunOptions } from "./loop";
export { agentLoop, runReflectionLoop } from "./loop";
export type {
	DbMessage,
	DbToolCall,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
export { getProvider, resolveProviderAndModel } from "./provider";
export { resolveModel } from "./resolve-model";
export { toolRegistry } from "./tool-registry";
export type {
	AgentConfig,
	AgentEvent,
	AgentToolUse,
	PermissionResult,
	ReasoningEffort,
	ReflectionLoopConfig,
	ReflectionLoopContext,
	RuntimeSettingsOverride,
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
	options?: GenerateOptions,
	tracking?: Omit<TrackApiRequestOptions, "provider" | "model">,
): Promise<import("./provider").GenerateMetaResult> {
	const requestedModel = model ?? settings.agent.defaultModel;
	const resolved = resolveProviderAndModel(requestedModel);
	const generate = () =>
		resolved.adapter.generateWithMeta(text, resolved.model, systemInstruction, options);
	if (!tracking) return generate();
	return trackApiRequest(
		{
			...tracking,
			provider: resolved.provider,
			model: resolved.model,
		},
		generate,
	);
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
	options?: GenerateOptions,
): Promise<string> {
	const result = await agentGenerateWithHistoryWithMeta(
		systemInstruction,
		content,
		model,
		locale,
		options,
	);
	return result.text;
}

export async function agentGenerateWithHistoryWithMeta(
	systemInstruction: string,
	content: string,
	model?: string,
	locale?: string,
	options?: GenerateOptions,
): Promise<import("./provider").GenerateMetaResult> {
	const requestedModel = model ?? settings.agent.defaultModel;
	const resolved = resolveProviderAndModel(requestedModel);
	if (resolved.adapter.generateWithHistoryWithMeta) {
		return resolved.adapter.generateWithHistoryWithMeta(
			systemInstruction,
			content,
			resolved.model,
			locale,
			options,
		);
	}
	return {
		text: await resolved.adapter.generateWithHistory(
			systemInstruction,
			content,
			resolved.model,
			locale,
			options,
		),
	};
}

// === Summary model wrappers ===
// These wrap the standard generate functions with the summary model from settings.
// When the summary model's provider is unavailable, they broadcast a
// `summary_model_unavailable` event via WebSocket so the frontend can prompt
// the user to pick a new model. A 30-second debounce prevents flooding.
// Transient errors (rate limits, overloaded, network issues) are retried with
// exponential backoff — same patterns as the main narrator agent loop.

/** Max retries for transient errors in summary model calls. */
const SUMMARY_MAX_TRANSIENT_RETRIES = 3;
/** Base delay for exponential backoff (ms). */
const SUMMARY_RETRY_BASE_MS = 3_000;
/** Maximum backoff delay (ms). */
const SUMMARY_RETRY_MAX_MS = 15_000;

/** Timestamp of the last `summary_model_unavailable` broadcast. */
let lastSummaryUnavailableBroadcast = 0;
/** Timestamp of the last `summary_model_error` broadcast. */
let lastSummaryErrorBroadcast = 0;
const SUMMARY_UNAVAILABLE_DEBOUNCE_MS = 30_000;
const SUMMARY_GENERATE_OPTIONS: GenerateOptions = { reasoningEffort: "none" };

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
async function broadcastSummaryUnavailable(error?: string): Promise<void> {
	const now = Date.now();
	if (now - lastSummaryUnavailableBroadcast < SUMMARY_UNAVAILABLE_DEBOUNCE_MS) return;
	lastSummaryUnavailableBroadcast = now;
	try {
		const { broadcastToAll } = await import("../../websocket/narrator-ws");
		broadcastToAll({
			type: "summary_model_unavailable",
			model: settings.agent.summaryModel,
			error: error ?? "Provider not available",
		});
	} catch {
		// WS module not loaded yet — ignore
	}
}

/**
 * Broadcast a `summary_model_error` event to all WS clients (debounced).
 * Used for non-provider errors (API failures, auth errors, etc.) after retries are exhausted.
 */
async function broadcastSummaryError(error: string): Promise<void> {
	const now = Date.now();
	if (now - lastSummaryErrorBroadcast < SUMMARY_UNAVAILABLE_DEBOUNCE_MS) return;
	lastSummaryErrorBroadcast = now;
	try {
		const { broadcastToAll } = await import("../../websocket/narrator-ws");
		broadcastToAll({
			type: "summary_model_error",
			model: settings.agent.summaryModel,
			error,
		});
	} catch {
		// WS module not loaded yet — ignore
	}
}

/**
 * Retry wrapper for summary model calls.
 * Retries transient errors with exponential backoff; immediately re-throws
 * provider-unavailable errors after broadcasting a WS event.
 */
async function withSummaryRetry<T>(fn: () => Promise<T>): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= SUMMARY_MAX_TRANSIENT_RETRIES; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const errMsg = err instanceof Error ? err.message : String(err);
			if (isSummaryProviderError(err)) {
				logger.warn("Summary model unavailable, broadcasting to clients", {
					model: settings.agent.summaryModel,
					error: errMsg,
				});
				broadcastSummaryUnavailable(errMsg);
				throw err;
			}
			if (attempt < SUMMARY_MAX_TRANSIENT_RETRIES && isRetryableError(err)) {
				const delayMs = Math.min(SUMMARY_RETRY_BASE_MS * 2 ** attempt, SUMMARY_RETRY_MAX_MS);
				logger.warn("Summary model transient error, retrying", {
					model: settings.agent.summaryModel,
					attempt: attempt + 1,
					maxRetries: SUMMARY_MAX_TRANSIENT_RETRIES,
					delayMs,
					error: errMsg,
				});
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}
			// Non-provider, non-retryable (or retries exhausted) — broadcast error
			logger.warn("Summary model error, broadcasting to clients", {
				model: settings.agent.summaryModel,
				error: errMsg,
			});
			broadcastSummaryError(errMsg);
			throw err;
		}
	}
	/* istanbul ignore next — unreachable: every iteration ends with return/throw/continue */
	throw lastErr;
}

/**
 * Generate text using the summary model (with meta).
 * Retries transient errors with exponential backoff.
 * On provider-unavailable errors, broadcasts a WS event and re-throws.
 */
export async function summaryGenerate(
	text: string,
	systemInstruction?: string,
	tracking?: Omit<TrackApiRequestOptions, "provider" | "model">,
): Promise<import("./provider").GenerateMetaResult> {
	return withSummaryRetry(() =>
		agentGenerateWithMeta(
			text,
			settings.agent.summaryModel,
			systemInstruction,
			SUMMARY_GENERATE_OPTIONS,
			tracking,
		),
	);
}

/**
 * Generate text using the summary model (with history).
 * Retries transient errors with exponential backoff.
 * On provider-unavailable errors, broadcasts a WS event and re-throws.
 */
export async function summaryGenerateWithHistory(
	systemInstruction: string,
	content: string,
	locale?: string,
	tracking?: Omit<TrackApiRequestOptions, "provider" | "model">,
): Promise<string> {
	const generate = () =>
		agentGenerateWithHistoryWithMeta(
			systemInstruction,
			content,
			settings.agent.summaryModel,
			locale,
			SUMMARY_GENERATE_OPTIONS,
		);
	const result = await withSummaryRetry(async () => {
		if (!tracking) return generate();
		const resolved = resolveProviderAndModel(settings.agent.summaryModel);
		return trackApiRequest(
			{
				...tracking,
				provider: resolved.provider,
				model: resolved.model,
			},
			generate,
		);
	});
	return result.text;
}
