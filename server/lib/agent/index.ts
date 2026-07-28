import { type TrackApiRequestOptions, trackApiRequest } from "../api-request-tracker";
import { logger } from "../logger";
import { parseModelId, settings } from "../settings";
import { auxiliaryRetryDelayMs, getAuxiliaryMaxRetries } from "./error-handling";
import { isRetryableError } from "./loop";
import {
	type BuiltHistory,
	type GenerateOptions,
	type ProviderResolution,
	resolveProviderAndModel,
} from "./provider";
import { stripPlanBodyForModel } from "./strip-plan-body";
import "./tools";
import { uniquifyDbMessageToolUseIds } from "./tool-use-id-dedup";
import { initTruncateCleanup } from "./truncate";

// Start periodic cleanup of truncated output files
initTruncateCleanup();

export type { ReflectionLoopRunOptions } from "./loop";
export { agentLoop, runReflectionLoop, TODO_REMINDER_TOOL_INTERVAL } from "./loop";
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
	AgentHistoryReplacement,
	AgentToolUse,
	DangerInfo,
	DangerSeverity,
	PermissionHandlerOptions,
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
): Promise<BuiltHistory> {
	const requestedModel = model || settings.agent.defaultModel;
	const parsed = parseModelId(requestedModel);
	const prefixedModel = parsed.provider
		? requestedModel
		: `${provider}:${parsed.model || "default"}`;
	const resolved = resolveProviderAndModel(prefixedModel);
	// Replace file-based ExitPlanMode plan bodies with a short path reference so
	// the model history does not carry the full plan text on every rebuild. The
	// persisted DB rows keep the full plan for the UI; this only mutates the
	// in-memory copy passed to the provider adapter.
	const modelMessages = stripPlanBodyForModel(dbMessages);
	// Some providers mint the same tool_use id for every call (e.g. "call_go_0"),
	// which only breaks once several turns accumulate: the replayed history then
	// carries duplicate ids and the API rejects the request with 400. Rename the
	// later collisions in this in-memory copy — DB rows keep the original ids.
	const uniqueMessages = uniquifyDbMessageToolUseIds(modelMessages, {
		narratorId,
		provider: resolved.provider,
		model: resolved.model,
	});
	return resolved.adapter.buildHistory(uniqueMessages, resolved.model, narratorId);
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

export async function agentGenerateWithMetaResolved(
	text: string,
	resolved: ProviderResolution,
	systemInstruction?: string,
	options?: GenerateOptions,
	tracking?: Omit<TrackApiRequestOptions, "provider" | "model">,
): Promise<import("./provider").GenerateMetaResult> {
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

export async function agentGenerateWithMeta(
	text: string,
	model?: string,
	systemInstruction?: string,
	options?: GenerateOptions,
	tracking?: Omit<TrackApiRequestOptions, "provider" | "model">,
): Promise<import("./provider").GenerateMetaResult> {
	const requestedModel = model ?? settings.agent.defaultModel;
	return agentGenerateWithMetaResolved(
		text,
		resolveProviderAndModel(requestedModel),
		systemInstruction,
		options,
		tracking,
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

// Retry count follows the user-configured `agent.maxTransientRetries` (so custom
// retry preferences apply to summaries/titles too) but is hard-capped at 10 for
// these auxiliary calls — see getAuxiliaryMaxRetries() / auxiliaryRetryDelayMs().

/** Timestamp of the last `summary_model_unavailable` broadcast. */
let lastSummaryUnavailableBroadcast = 0;
/** Timestamp of the last `summary_model_error` broadcast. */
let lastSummaryErrorBroadcast = 0;
const SUMMARY_UNAVAILABLE_DEBOUNCE_MS = 30_000;
const SUMMARY_GENERATE_OPTIONS: GenerateOptions = { reasoningEffort: "none" };

/** Check whether an error is an abort/cancellation error. */
function isAbortError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === "AbortError") return true;
	if (err instanceof Error && err.name === "AbortError") return true;
	return false;
}

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
async function broadcastSummaryUnavailable(model: string, error?: string): Promise<void> {
	const now = Date.now();
	if (now - lastSummaryUnavailableBroadcast < SUMMARY_UNAVAILABLE_DEBOUNCE_MS) return;
	lastSummaryUnavailableBroadcast = now;
	try {
		const { broadcastToAll } = await import("../../websocket/narrator-ws");
		broadcastToAll({
			type: "summary_model_unavailable",
			model,
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
async function broadcastSummaryError(model: string, error: string): Promise<void> {
	const now = Date.now();
	if (now - lastSummaryErrorBroadcast < SUMMARY_UNAVAILABLE_DEBOUNCE_MS) return;
	lastSummaryErrorBroadcast = now;
	try {
		const { broadcastToAll } = await import("../../websocket/narrator-ws");
		broadcastToAll({
			type: "summary_model_error",
			model,
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
 * When a `signal` is provided, retries stop as soon as it is aborted and the
 * abort error is re-thrown without broadcasting a summary-model error.
 */
async function withSummaryRetry<T>(
	fn: () => Promise<T>,
	signal: AbortSignal | undefined,
	model: string,
	reportSummaryModelErrors = true,
): Promise<T> {
	const maxRetries = getAuxiliaryMaxRetries();
	let lastErr: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal?.aborted) {
			throw new DOMException("Summary generation aborted", "AbortError");
		}
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			// Aborted by caller (e.g. compact cancellation) — propagate without
			// retrying or broadcasting a summary-model error.
			if (isAbortError(err) || signal?.aborted) {
				throw err;
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			if (isSummaryProviderError(err)) {
				logger.warn("Summary model unavailable, broadcasting to clients", {
					model,
					error: errMsg,
				});
				if (reportSummaryModelErrors) broadcastSummaryUnavailable(model, errMsg);
				throw err;
			}
			if (attempt < maxRetries && isRetryableError(err)) {
				const delayMs = auxiliaryRetryDelayMs(attempt);
				logger.warn("Summary model transient error, retrying", {
					model,
					attempt: attempt + 1,
					maxRetries,
					delayMs,
					error: errMsg,
				});
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}
			// Non-provider, non-retryable (or retries exhausted) — broadcast error
			logger.warn("Summary model error, broadcasting to clients", {
				model,
				error: errMsg,
			});
			if (reportSummaryModelErrors) broadcastSummaryError(model, errMsg);
			throw err;
		}
	}
	/* istanbul ignore next — unreachable: every iteration ends with return/throw/continue */
	throw lastErr;
}

/**
 * Generic retry wrapper for auxiliary (non-primary) AI calls that don't need the
 * summary-model unavailable/error broadcast behavior — e.g. AskUserQuestion
 * reflection/suggestion. Follows the user-configured retry policy (custom retry
 * rules included via {@link isRetryableError}) but hard-caps the number of
 * attempts at the auxiliary cap. `signal` aborts stop retrying immediately and
 * propagate the abort error.
 */
export async function withAuxiliaryRetry<T>(
	fn: () => Promise<T>,
	options: { signal?: AbortSignal; label?: string } = {},
): Promise<T> {
	const { signal, label = "auxiliary AI call" } = options;
	const maxRetries = getAuxiliaryMaxRetries();
	let lastErr: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal?.aborted) {
			throw new DOMException(`${label} aborted`, "AbortError");
		}
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (isAbortError(err) || signal?.aborted) throw err;
			if (attempt < maxRetries && isRetryableError(err)) {
				const delayMs = auxiliaryRetryDelayMs(attempt);
				logger.warn(`${label} transient error, retrying`, {
					attempt: attempt + 1,
					maxRetries,
					delayMs,
					error: err instanceof Error ? err.message : String(err),
				});
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}
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
 * When `signal` is provided, the underlying request can be cancelled (e.g.
 * when the user cancels an in-progress compact).
 */
export async function summaryGenerate(
	text: string,
	systemInstruction?: string,
	tracking?: Omit<TrackApiRequestOptions, "provider" | "model">,
	signal?: AbortSignal,
	onTextDelta?: GenerateOptions["onTextDelta"],
	modelOverride?: string,
	maxOutputTokens?: number,
	reportSummaryModelErrors = true,
	onReasoningDelta?: GenerateOptions["onReasoningDelta"],
): Promise<import("./provider").GenerateMetaResult> {
	const model = modelOverride?.trim() || settings.agent.summaryModel;
	const generateOptions: GenerateOptions = {
		...SUMMARY_GENERATE_OPTIONS,
		...(signal ? { signal } : {}),
		...(onTextDelta ? { onTextDelta } : {}),
		...(onReasoningDelta ? { onReasoningDelta } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
	return withSummaryRetry(
		() => agentGenerateWithMeta(text, model, systemInstruction, generateOptions, tracking),
		signal,
		model,
		reportSummaryModelErrors,
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
	options?: Pick<GenerateOptions, "signal" | "onTextDelta" | "onReasoningDelta">,
): Promise<string> {
	const generateOptions: GenerateOptions = { ...SUMMARY_GENERATE_OPTIONS, ...options };
	const model = settings.agent.summaryModel;
	const generate = () =>
		agentGenerateWithHistoryWithMeta(systemInstruction, content, model, locale, generateOptions);
	const result = await withSummaryRetry(
		async () => {
			if (!tracking) return generate();
			const resolved = resolveProviderAndModel(model);
			return trackApiRequest(
				{
					...tracking,
					provider: resolved.provider,
					model: resolved.model,
				},
				generate,
			);
		},
		options?.signal,
		model,
	);
	return result.text;
}
