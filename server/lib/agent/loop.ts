import { logger } from "../logger";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import {
	getAnthropicProviderConfig,
	getModelContextWindow,
	isAnthropicProvider,
	settings,
	usesStatefulApi,
} from "../settings";
import { StreamStaleError } from "../stream-timeout";
import { estimateTokens } from "./estimate-tokens";
import { resolveProviderAndModel } from "./provider";
import { toolRegistry } from "./tool-registry";
import { truncateOutput } from "./truncate";
import type {
	AgentConfig,
	AgentEvent,
	AgentToolUse,
	ContentBlock,
	ResolvedToolDefinition,
	ToolContext,
} from "./types";
import {
	PLAN_MODE_ALLOWED_TOOLS,
	type ReasoningProviderMetadata,
	TRANSIENT_RETRY_BASE_MS,
} from "./types";

const PROGRESS_INTERVAL_MS = 5_000;

/** Abort-aware sleep that resolves early when the signal fires. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/** Yield block_complete events for accumulated reasoning blocks and assistant text.
 *  Used in every early-return / error path to persist partial progress. */
function* flushPartialContent(
	reasoningBlockMap: Map<string, { text: string; providerMetadata?: ReasoningProviderMetadata }>,
	assistantText: string,
): Generator<AgentEvent> {
	for (const entry of reasoningBlockMap.values()) {
		if (entry.text || entry.providerMetadata) {
			yield {
				type: "block_complete",
				block: {
					type: "reasoning",
					text: entry.text,
					providerMetadata: entry.providerMetadata,
				},
			};
		}
	}
	if (assistantText) {
		yield { type: "block_complete", block: { type: "text", text: assistantText } };
	}
}

/** Max size of output pushed via tool_output events (UI preview only). */
const MAX_STREAM_OUTPUT_LENGTH = 30_000;

/** Patterns that indicate a transient API error worth retrying. */
const RETRYABLE_PATTERNS = [
	"MODEL_TEMPORARILY_UNAVAILABLE",
	"overloaded",
	"too many requests",
	"rate limit",
	"throttl",
	"service unavailable",
	"temporarily unavailable",
	"capacity",
	"try again",
	"socket connection was closed unexpectedly",
	"connection was closed unexpectedly",
	"socket hang up",
	"connection reset",
	"econnreset",
	"etimedout",
	"eai_again",
	"fetch failed",
	"failed to fetch",
	"network error",
	"unable to connect",
	"the operation timed out",
	"server_error",
	"internal_server_error",
	"the server had an error",
	"internal server error",
];

/** Error codes that represent transient network/transport failures. */
const RETRYABLE_ERROR_CODES = new Set([
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENETDOWN",
	"ENETUNREACH",
	"ECONNREFUSED",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	// Bun-specific error codes (PascalCase instead of Node.js SCREAMING_SNAKE_CASE)
	"CONNECTIONREFUSED",
	"CONNECTIONRESET",
	"CONNECTIONABORTED",
]);

const NON_RETRYABLE_PATTERNS = [
	"usage_limit_reached",
	"usage limit has been reached",
	"insufficient_quota",
	"quota exceeded",
	'"plan_type":"free"',
];

/** Patterns that indicate the request exceeded model input context. */
const CONTEXT_OVERFLOW_PATTERNS = [
	"exceeds the context window",
	"context window",
	"context length",
	"maximum context length",
	"context_length_exceeded",
	"input is too long",
	"prompt is too long",
	"too many tokens",
];

/** HTTP status codes that indicate transient server-side issues. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

/** Reasons from invalidState that indicate a transient server-side issue worth retrying. */
const RETRYABLE_INVALID_STATE_REASONS = new Set([
	"server_error",
	"internal_error",
	"internal_server_error",
	"service_unavailable",
	"temporarily_unavailable",
]);

function isRetryableInvalidStateReason(reason: string, message?: string): boolean {
	if (RETRYABLE_INVALID_STATE_REASONS.has(reason.toLowerCase())) return true;
	// Also check the message for retryable patterns (e.g. "Too many requests",
	// "status 429") — providers may use non-standard reason codes like
	// "stream_initialization_failed" while the message contains the real cause.
	if (message) {
		const m = message.toLowerCase();
		if (NON_RETRYABLE_PATTERNS.some((p) => m.includes(p))) return false;
		if (RETRYABLE_PATTERNS.some((p) => m.includes(p))) return true;
		// Check for HTTP status codes embedded in the message
		if (/\b(429|500|502|503|529)\b/.test(m)) return true;
	}
	return false;
}

function isContextOverflowReason(reason: string): boolean {
	const r = reason.toLowerCase();
	return (
		r.includes("context_length") ||
		r.includes("context_window") ||
		r === "input_too_long" ||
		r === "prompt_too_long" ||
		r === "context_overflow"
	);
}

function isOutputTruncationReason(reason: string): boolean {
	const r = reason.toLowerCase();
	return r === "max_tokens" || r === "max_output_tokens" || r === "length";
}

function isContextOverflowMessage(message: string): boolean {
	const m = message.toLowerCase();
	return CONTEXT_OVERFLOW_PATTERNS.some((p) => m.includes(p));
}

function isContextWindowExceededError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const obj = err as Record<string, unknown>;

	if (typeof obj.code === "string" && isContextOverflowReason(obj.code)) return true;
	if (typeof obj.reason === "string" && isContextOverflowReason(obj.reason)) return true;

	if (typeof obj.message === "string" && isContextOverflowMessage(obj.message)) return true;
	if (typeof obj.error === "string" && isContextOverflowMessage(obj.error)) return true;

	const nested = obj.error;
	if (nested && typeof nested === "object") {
		const n = nested as Record<string, unknown>;
		if (typeof n.code === "string" && isContextOverflowReason(n.code)) return true;
		if (typeof n.type === "string" && isContextOverflowReason(n.type)) return true;
		if (typeof n.message === "string" && isContextOverflowMessage(n.message)) return true;
	}

	return false;
}

export function isRetryableError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	// Stream stale timeout is always retryable
	if (err instanceof StreamStaleError) return true;

	const obj = err as Record<string, unknown>;
	const nested = obj.error;
	const nestedObj =
		nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
	const cause = obj.cause;
	const causeObj =
		cause && typeof cause === "object" ? (cause as Record<string, unknown>) : undefined;

	const msgCandidates = [
		obj.message,
		typeof obj.error === "string" ? obj.error : undefined,
		nestedObj?.message,
		typeof nestedObj?.error === "string" ? nestedObj.error : undefined,
		causeObj?.message,
		typeof causeObj?.error === "string" ? causeObj.error : undefined,
	]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.toLowerCase());

	// Message-based hard quota / plan restrictions should never retry.
	if (msgCandidates.some((msg) => NON_RETRYABLE_PATTERNS.some((p) => msg.includes(p)))) {
		return false;
	}

	// Check for known retryable reason/code fields.
	if (
		obj.reason === "MODEL_TEMPORARILY_UNAVAILABLE" ||
	) {
		return true;
	}

	const directCode =
		typeof obj.code === "string"
			? obj.code.toUpperCase()
			: typeof obj.reason === "string"
				? obj.reason.toUpperCase()
				: undefined;
	if (directCode && RETRYABLE_ERROR_CODES.has(directCode)) {
		return true;
	}

	const nestedCode =
		typeof nestedObj?.code === "string"
			? nestedObj.code.toUpperCase()
			: typeof nestedObj?.type === "string"
				? nestedObj.type.toUpperCase()
				: typeof nestedObj?.reason === "string"
					? nestedObj.reason.toUpperCase()
					: undefined;
	if (nestedCode && RETRYABLE_ERROR_CODES.has(nestedCode)) {
		return true;
	}

	const causeCode =
		typeof causeObj?.code === "string"
			? causeObj.code.toUpperCase()
			: typeof causeObj?.reason === "string"
				? causeObj.reason.toUpperCase()
				: undefined;
	if (causeCode && RETRYABLE_ERROR_CODES.has(causeCode)) {
		return true;
	}

	// Check HTTP status codes.
	if (typeof obj.status === "number" && RETRYABLE_STATUS_CODES.has(obj.status)) return true;
	if (typeof obj.statusCode === "number" && RETRYABLE_STATUS_CODES.has(obj.statusCode)) {
		return true;
	}
	if (typeof nestedObj?.status === "number" && RETRYABLE_STATUS_CODES.has(nestedObj.status)) {
		return true;
	}
	if (
		typeof nestedObj?.statusCode === "number" &&
		RETRYABLE_STATUS_CODES.has(nestedObj.statusCode)
	) {
		return true;
	}
	if (typeof causeObj?.status === "number" && RETRYABLE_STATUS_CODES.has(causeObj.status)) {
		return true;
	}
	if (typeof causeObj?.statusCode === "number" && RETRYABLE_STATUS_CODES.has(causeObj.statusCode)) {
		return true;
	}

	if (msgCandidates.some((msg) => RETRYABLE_PATTERNS.some((p) => msg.includes(p)))) {
		return true;
	}

	// Check user-defined custom retry rules from settings
	return matchesCustomRetryRules(obj, msgCandidates);
}

/** Match error against user-defined custom retry rules (AND within rule, OR across rules). */
function matchesCustomRetryRules(obj: Record<string, unknown>, msgCandidates: string[]): boolean {
	const rules = settings.agent.customRetryRules;
	if (!rules?.length) return false;

	const statusCodes = new Set<number>();
	for (const field of [obj, obj.error, obj.cause]) {
		if (field && typeof field === "object") {
			const f = field as Record<string, unknown>;
			if (typeof f.status === "number") statusCodes.add(f.status);
			if (typeof f.statusCode === "number") statusCodes.add(f.statusCode);
		}
	}

	const allText = msgCandidates.join(" ");

	for (const rule of rules) {
		if (rule.enabled === false) continue;
		let matched = true;
		let hasCondition = false;

		if (rule.domain) {
			hasCondition = true;
			if (!allText.includes(rule.domain.toLowerCase())) matched = false;
		}
		if (matched && rule.statusCode) {
			hasCondition = true;
			if (!statusCodes.has(rule.statusCode)) matched = false;
		}
		if (matched && rule.keyword) {
			hasCondition = true;
			if (!allText.includes(rule.keyword.toLowerCase())) matched = false;
		}

		if (hasCondition && matched) return true;
	}
	return false;
}

/** Minimum interval between tool_output events (ms). */
const OUTPUT_THROTTLE_MS = 100;

/** Tools that can safely run in parallel when multiple appear in the same turn. */
const PARALLEL_TOOLS = new Set(["Agent"]);

type ReasoningBlockEntry = { text: string; providerMetadata?: ReasoningProviderMetadata };

/** Convert the per-itemId reasoning map to the blocks array expected by pushAssistantTurn. */
function collectReasoningBlocks(
	map: Map<string, ReasoningBlockEntry>,
): ReasoningBlockEntry[] | undefined {
	if (map.size === 0) return undefined;
	const blocks: ReasoningBlockEntry[] = [];
	for (const entry of map.values()) {
		if (entry.text || entry.providerMetadata) {
			blocks.push(entry);
		}
	}
	return blocks.length > 0 ? blocks : undefined;
}

/**
 * Core agent loop. Delegates all provider-specific logic to a ProviderAdapter.
 * Yields AgentEvent objects for the caller to consume.
 */
export async function* agentLoop(
	config: AgentConfig,
	userText: string,
	history: unknown[],
	initialToolResults?: unknown[],
	images?: Array<{ format: string; base64: string }>,
): AsyncGenerator<AgentEvent> {
	const resolvedProvider = resolveProviderAndModel(config.model);
	let provider = resolvedProvider.adapter;
	let effectiveModel = resolvedProvider.model;
	let effectiveProvider = resolvedProvider.provider;
	const maxTurns = config.maxTurns ?? settings.agent.maxTurns;
	const locale = (config.locale as Locale) ?? "en";
	let allTools: ResolvedToolDefinition[] = toolRegistry
		.all()
		.filter((t) => t.name && (!t.isAvailable || t.isAvailable()))
		.map((t) => ({
			...t,
			description: typeof t.description === "function" ? t.description(config) : t.description,
		}));

	// Apply toolFilter if provided (used by subagents to restrict available tools)
	if (config.toolFilter) {
		allTools = allTools.filter(config.toolFilter);
	}

	// Codex and official Anthropic providers use native server-side web_search —
	// remove the WebSearch function tool to avoid duplicate search capabilities.
	// Non-official (proxy) Anthropic providers keep the WebSearch function tool.
	const isOfficialAnthropic =
		isAnthropicProvider(effectiveProvider) &&
		!!getAnthropicProviderConfig(effectiveProvider)?.officialApi;
	if (effectiveProvider === "codex" || isOfficialAnthropic) {
		allTools = allTools.filter((t) => t.name !== "WebSearch");
	}

	// In plan mode, override descriptions for forbidden tools so the model knows not to call them.
	// When relaxedPlan is enabled, skip this — tools remain fully available.
	if (config.planMode && !config.relaxedPlan) {
		const disabledDesc = getToolMessage("planModeToolDisabled", locale);
		allTools = allTools.map((t) =>
			PLAN_MODE_ALLOWED_TOOLS.has(t.name)
				? t
				: {
						...t,
						description: disabledDesc,
					},
		);
	}

	let tools = provider.formatTools(allTools);
	let pendingToolResults: unknown[] = initialToolResults ?? [];
	let turnIndex = 0;

	// Shallow-copy to avoid mutating the caller's array
	history = [...history];

	// Inject system prompt via provider-specific mechanism
	if (config.systemPrompt) {
		provider.injectSystemPrompt(history, config.systemPrompt, effectiveModel, config.locale);
	}

	// Extra content to prepend to the next turn's user message (e.g. broken-tool reminder).
	// Consumed once and reset to empty after use.
	let nextTurnContent = "";

	while (turnIndex < maxTurns) {
		if (config.signal.aborted) {
			yield { type: "error", message: "Aborted" };
			return;
		}

		const isFirstTurn = turnIndex === 0;

		// Allow caller to rebuild history mid-loop (e.g. after prune boundary changes or compact)
		if (!isFirstTurn && config.onBeforeTurn) {
			const replacement = await config.onBeforeTurn(turnIndex);
			if (replacement) {
				history = replacement.history;
				if (replacement.systemPrompt != null) {
					config.systemPrompt = replacement.systemPrompt;
				}
				if (config.systemPrompt) {
					provider.injectSystemPrompt(history, config.systemPrompt, effectiveModel, config.locale);
				}
				pendingToolResults = replacement.pendingToolResults;
			}
		}

		// Check for mid-loop model switch (only between turns, not on the first turn)
		if (!isFirstTurn && config.getModelOverride) {
			const newModel = config.getModelOverride();
			if (newModel) {
				try {
					const newResolved = resolveProviderAndModel(newModel);
					const providerChanged = newResolved.provider !== effectiveProvider;

					effectiveModel = newResolved.model;
					effectiveProvider = newResolved.provider;
					config.model = newModel;
					config.provider = newResolved.provider;

					if (providerChanged) {
						// Provider changed — rebuild tools and history for the new adapter
						provider = newResolved.adapter;
						tools = provider.formatTools(allTools);

						// Force history rebuild via onBeforeTurn so messages are
						// re-serialised in the new provider's format.
						if (config.onBeforeTurn) {
							const replacement = await config.onBeforeTurn(turnIndex);
							if (replacement) {
								history = replacement.history;
								pendingToolResults = replacement.pendingToolResults;
							}
						}
						if (config.systemPrompt) {
							provider.injectSystemPrompt(
								history,
								config.systemPrompt,
								effectiveModel,
								config.locale,
							);
						}
					}

					yield { type: "model_switched", model: effectiveModel, provider: effectiveProvider };
				} catch {
					// resolveProviderAndModel failed — keep current model, skip switch
				}
			}
		}

		const content = isFirstTurn ? userText : nextTurnContent;
		nextTurnContent = ""; // consume once

		// Call provider and collect the response
		let assistantText = "";
		/**
		 * Reasoning blocks accumulated during streaming, keyed by itemId.
		 * Supports multiple reasoning items per turn (e.g. interleaved with tool calls).
		 * Falls back to a synthetic key "__default" for providers that don't supply itemId.
		 */
		const reasoningBlockMap = new Map<
			string,
			{ text: string; providerMetadata?: ReasoningProviderMetadata }
		>();
		const toolUses: AgentToolUse[] = [];
		let messageId: string | undefined;
		let credentialId: string | undefined;
		// Map of tool executions started during streaming (toolUseId → Promise)
		const earlyExecMap = new Map<string, Promise<ToolExecResult>>();
		// Synchronously queryable map of settled early-exec results (populated via .then())
		const settledResults = new Map<string, ToolExecResult>();
		// Track which tool_results have already been yielded during streaming
		const yieldedToolResults = new Set<string>();
		// Track tool calls whose input was broken (output cut off mid-stream)
		const brokenToolUseIds = new Set<string>();
		// Accumulator for streaming tool use events (input arrives in chunks)
		const toolUseAccum = new Map<
			string,
			{
				name: string;
				inputChunks: string[];
				totalChars: number;
				startedAt: number;
				extractedFilePath?: string;
				extractedFields?: Record<string, string>;
				lastYieldedAt: number;
			}
		>();
		// Accumulator for native web search calls (Codex web_search tool)
		const webSearchAccum = new Map<
			string,
			{ query?: string; queries?: string[]; emitted: boolean }
		>();
		// Track whether the provider reported usage data during this turn
		let receivedUsage = false;

		// ── Transient-error retry loop ──
		// we can safely retry the exact same provider.chat() call with identical
		// history, content, and toolResults — no server-side state was mutated.
		// Stateful providers (responses/codex) cannot retry here because the
		// server already consumed the request.
		const maxChatRetries = usesStatefulApi(effectiveProvider)
			? 0
			: (config.maxTransientRetries ?? 0);
		let chatRetryCount = 0;

		for (;;) {
			// Reset per-attempt accumulators so a retry starts with a clean slate.
			// (On the first attempt these are already empty; on retries they may
			// contain partial data from the failed stream.)
			//
			// NOTE: earlyExecMap.clear() drops references to in-flight tool Promises
			// from a failed attempt.  Those Promises are .catch()-wrapped so they
			// won't cause unhandled rejections, but any side-effects (e.g. Bash
			// commands) may still complete in the background.  In practice, retries
			// only trigger on transient API errors that occur before tool execution
			// begins (the stream fails during the model's response, not after tool
			// dispatch), so this is safe.
			assistantText = "";
			reasoningBlockMap.clear();
			toolUses.length = 0;
			messageId = undefined;
			credentialId = undefined;
			earlyExecMap.clear();
			settledResults.clear();
			yieldedToolResults.clear();
			brokenToolUseIds.clear();
			toolUseAccum.clear();
			webSearchAccum.clear();
			receivedUsage = false;

			try {
				const stream = provider.chat({
					conversationId: config.conversationId,
					content,
					model: effectiveModel,
					cwd: config.cwd,
					history,
					tools,
					toolResults: pendingToolResults,
					signal: config.signal,
					stickySessionKey: config.narratorId,
					reasoningEffort: config.reasoningEffort,
					serviceTier: config.serviceTier,
					metadata: config.metadata,
					...(isFirstTurn && images?.length ? { images } : {}),
				});

				for await (const parsed of stream) {
					if (parsed.text) {
						assistantText += parsed.text;
						yield { type: "stream_text", text: parsed.text };
					}
					if (parsed.toolUses) {
						// ── Tool use dedup ──
						// via BOTH the non-streaming `parsed.toolUses` array AND the streaming
						// `parsed.toolUseChunk` path. This commonly happens for tools with
						// empty or very small parameters (e.g. EnterPlanMode). Without dedup,
						// the tool would be executed twice and yield duplicate events.
						//
						// Strategy:
						// 1. Skip any toolUse whose ID is already in `toolUses` (streaming
						//    path completed it first).
						// 2. Remove matching entries from `toolUseAccum` (streaming accumulator)
						//    so the streaming stop handler doesn't re-process them.
						// 3. Yield block_complete + tool_call + start eager execution here,
						//    mirroring what the streaming stop path would have done.
						for (const tu of parsed.toolUses) {
							// Skip duplicates — the streaming path may have already
							// completed this tool call via toolUseChunk stop.
							if (toolUses.some((t) => t.toolUseId === tu.toolUseId)) continue;

							toolUses.push(tu);

							// If this tool was also being streamed via toolUseChunk, remove it
							// from the accumulator so it isn't flagged as orphaned.
							// the same call — especially for tools with empty parameters.
							const wasStreaming = toolUseAccum.has(tu.toolUseId);
							if (wasStreaming) {
								toolUseAccum.delete(tu.toolUseId);
							}

							// Yield block_complete so the tool call is persisted
							// (the streaming path would have done this on stop, but
							// non-streaming toolUses skip that path entirely).
							yield {
								type: "block_complete",
								block: {
									type: "tool_use",
									toolUseId: tu.toolUseId,
									name: tu.name,
									input: tu.input,
								} satisfies ContentBlock,
							};

							// Start eager execution (same as the streaming stop path)
							if (!earlyExecMap.has(tu.toolUseId)) {
								const execPromise = executeTool(tu, config).catch(
									(err): ToolExecResult => ({
										output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
										isError: true,
										durationMs: 0,
									}),
								);
								execPromise.then((r) => settledResults.set(tu.toolUseId, r));
								earlyExecMap.set(tu.toolUseId, execPromise);
							}

							yield {
								type: "tool_call",
								toolUseId: tu.toolUseId,
								toolName: tu.name,
								input: tu.input,
							};
						}
					}

					// Handle streaming tool use chunks
					if (parsed.toolUseChunk) {
						const { toolUseId: id, name, input, stop } = parsed.toolUseChunk;
						if (id) {
							if (!toolUseAccum.has(id) && name) {
								// Don't create accumulator if this tool was already
								// completed via non-streaming parsed.toolUses
								if (toolUses.some((t) => t.toolUseId === id)) {
									// Still yield the chunk so the frontend sees it
									yield {
										type: "tool_use_chunk",
										toolUseId: id,
										toolName: name,
										inputCharsTotal: 0,
									};
								} else {
									toolUseAccum.set(id, {
										name,
										inputChunks: [],
										totalChars: 0,
										startedAt: Date.now(),
										lastYieldedAt: Date.now(),
									});
									// Yield immediately so the frontend knows the tool name early
									yield {
										type: "tool_use_chunk",
										toolUseId: id,
										toolName: name,
										inputCharsTotal: 0,
									};
								}
							}
							const acc = toolUseAccum.get(id);
							if (acc) {
								if (typeof input === "string") {
									acc.inputChunks.push(input);
									acc.totalChars += input.length;

									// For Write/Edit tools, try to extract file_path from first chunk
									let filePathJustExtracted = false;
									if (!acc.extractedFilePath && (acc.name === "Write" || acc.name === "Edit")) {
										const raw = acc.inputChunks.join("");
										const filePathMatch = raw.match(/"file_path"\s*:\s*"([^"]+)"/);
										if (filePathMatch) {
											acc.extractedFilePath = filePathMatch[1];
											filePathJustExtracted = true;
										}
									}

									// For Agent tool, extract description/subagent_type/model from early chunks
									let fieldsJustExtracted = false;
									if (acc.name === "Agent" || acc.name === "Task") {
										const raw = acc.inputChunks.join("");
										const wantedKeys = ["description", "subagent_type", "model"] as const;
										for (const key of wantedKeys) {
											if (acc.extractedFields?.[key]) continue;
											const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*?)"`);
											const m = raw.match(re);
											if (m) {
												if (!acc.extractedFields) acc.extractedFields = {};
												acc.extractedFields[key] = m[1];
												fieldsJustExtracted = true;
											}
										}
									}

									// Throttle: yield at most once per 50ms per tool to reduce WS pressure.
									// Bypass throttle when file_path or fields are first extracted so the
									// frontend can display them immediately instead of waiting for the next
									// content chunk.
									const now = Date.now();
									if (
										filePathJustExtracted ||
										fieldsJustExtracted ||
										now - acc.lastYieldedAt >= 50
									) {
										acc.lastYieldedAt = now;

										// Calculate content chars (total minus file_path JSON overhead)
										let contentChars = acc.totalChars;
										if (acc.extractedFilePath) {
											// Rough estimate: subtract the file_path field size
											const filePathFieldSize = `"file_path":"${acc.extractedFilePath}",`.length;
											contentChars = Math.max(0, acc.totalChars - filePathFieldSize);
										}

										yield {
											type: "tool_use_chunk",
											toolUseId: id,
											toolName: acc.name,
											inputCharsTotal: acc.totalChars,
											...(acc.extractedFilePath && {
												extractedFilePath: acc.extractedFilePath,
											}),
											...(acc.extractedFilePath && {
												contentCharsReceived: contentChars,
											}),
											...(acc.extractedFields && {
												extractedFields: acc.extractedFields,
											}),
										};
									}
								}
								if (stop) {
									// Yield final chunk with latest totals before completing
									let contentChars = acc.totalChars;
									if (acc.extractedFilePath) {
										const filePathFieldSize = `"file_path":"${acc.extractedFilePath}",`.length;
										contentChars = Math.max(0, acc.totalChars - filePathFieldSize);
									}
									yield {
										type: "tool_use_chunk",
										toolUseId: id,
										toolName: acc.name,
										inputCharsTotal: acc.totalChars,
										...(acc.extractedFilePath && {
											extractedFilePath: acc.extractedFilePath,
										}),
										...(acc.extractedFilePath && {
											contentCharsReceived: contentChars,
										}),
										...(acc.extractedFields && {
											extractedFields: acc.extractedFields,
										}),
									};

									const raw = acc.inputChunks.join("");
									let parsedInput: Record<string, unknown> = {};
									if (raw) {
										try {
											parsedInput = JSON.parse(raw);
										} catch {
											parsedInput = { _raw: raw };
										}
									}
									const tu: AgentToolUse = {
										toolUseId: id,
										name: acc.name,
										input: parsedInput,
										streamStartedAt: acc.startedAt,
									};
									// Skip if already added via non-streaming parsed.toolUses
									const alreadyAdded = toolUses.some((t) => t.toolUseId === id);
									if (!alreadyAdded) {
										toolUses.push(tu);
									}
									toolUseAccum.delete(id);

									// If already handled via non-streaming parsed.toolUses,
									// skip block_complete / execution / tool_call — they were
									// already yielded in the parsed.toolUses handler above.
									if (alreadyAdded) continue;

									// Block is complete — yield for immediate persistence
									yield {
										type: "block_complete",
										block: {
											type: "tool_use",
											toolUseId: id,
											name: tu.name,
											input: parsedInput,
											streamStartedAt: acc.startedAt,
										} satisfies ContentBlock,
									};

									// Start tool execution eagerly (don't await — collect later).
									// Wrap with .catch() so a rejected permissionHandler doesn't
									// create an unhandled rejection; the error surfaces as isError.
									// The .then() populates settledResults synchronously so the
									// streaming loop can drain completed results without awaiting.
									const execPromise = executeTool(tu, config).catch(
										(err): ToolExecResult => ({
											output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
											isError: true,
											durationMs: 0,
										}),
									);
									execPromise.then((r) => settledResults.set(id, r));
									earlyExecMap.set(id, execPromise);

									// Notify frontend the tool has started
									yield {
										type: "tool_call",
										toolUseId: id,
										toolName: tu.name,
										input: parsedInput,
										streamStartedAt: acc.startedAt,
									};

									// Drain any tool results that settled during streaming.
									// This lets fast tools (Read, Glob, etc.) report completion
									// before the model finishes outputting subsequent tool calls.
									for (const prevTu of toolUses) {
										const sr = settledResults.get(prevTu.toolUseId);
										if (!sr || yieldedToolResults.has(prevTu.toolUseId)) continue;
										yieldedToolResults.add(prevTu.toolUseId);
										if (sr.broken) brokenToolUseIds.add(prevTu.toolUseId);
										const brokenOverride = sr.broken
											? sanitizeBrokenInput(prevTu.name, prevTu.input, locale)
											: undefined;
										yield {
											type: "tool_result",
											toolUseId: prevTu.toolUseId,
											toolName: prevTu.name,
											output: sr.broken
												? getToolMessage("brokenToolCallResult", locale)
												: sr.output,
											isError: sr.isError ?? false,
											durationMs: sr.durationMs,
											brokenInputOverride: brokenOverride,
											updatedInput: brokenOverride ?? sr.updatedInput,
											metadata: sr.metadata,
										};
										if (sr.fatal) {
											yield { type: "error", message: sr.output };
											return;
										}
									}
								}
							}
						}
					}

					if (parsed.messageId) messageId = parsed.messageId;
					if (parsed.credentialId) credentialId = parsed.credentialId;

					if (parsed.reasoning) {
						const itemKey = parsed.reasoningMetadata?.openai?.itemId ?? "__default";
						const existing = reasoningBlockMap.get(itemKey);
						if (existing) {
							existing.text += parsed.reasoning;
							if (parsed.reasoningMetadata) {
								existing.providerMetadata = parsed.reasoningMetadata;
							}
						} else {
							reasoningBlockMap.set(itemKey, {
								text: parsed.reasoning,
								providerMetadata: parsed.reasoningMetadata,
							});
						}
						yield {
							type: "stream_reasoning",
							text: parsed.reasoning,
							providerMetadata: parsed.reasoningMetadata,
						};
					} else if (parsed.reasoningMetadata) {
						// Metadata-only event (e.g. final encrypted_content from output_item.done).
						// Update the stored metadata without emitting a streaming event.
						const itemKey = parsed.reasoningMetadata?.openai?.itemId ?? "__default";
						const existing = reasoningBlockMap.get(itemKey);
						if (existing) {
							existing.providerMetadata = parsed.reasoningMetadata;
						} else {
							// Metadata arrived before any text — create an empty-text entry
							reasoningBlockMap.set(itemKey, {
								text: "",
								providerMetadata: parsed.reasoningMetadata,
							});
						}
					}
					if (parsed.contextUsagePercentage != null) {
						receivedUsage = true;
						// Estimate token count from conversation content (char-based heuristic)
						const ctxWin = getModelContextWindow(effectiveModel, effectiveProvider);
						const estimatedPromptTokens =
							estimateTokens(JSON.stringify(history)) +
							estimateTokens(config.systemPrompt ?? "") +
							estimateTokens(content) +
							estimateTokens(assistantText);
						yield {
							type: "context_usage",
							percentage: parsed.contextUsagePercentage,
							promptTokens: estimatedPromptTokens,
							contextWindow: ctxWin ?? undefined,
							isEstimated: true,
						};
					}
					if (parsed.metering) {
						yield {
							type: "metering",
							unit: parsed.metering.unit,
							unitPlural: parsed.metering.unitPlural,
							usage: parsed.metering.usage,
							credentialId,
						};
					}
					}
						yield {
						};
					}
					// Convert OpenAI/Anthropic usage to context_usage percentage
					if (parsed.usage && parsed.usage.promptTokens != null) {
						receivedUsage = true;
						const contextWindow = getModelContextWindow(effectiveModel, effectiveProvider);
						if (contextWindow) {
							const percentage = (parsed.usage.promptTokens / contextWindow) * 100;
							yield {
								type: "context_usage",
								percentage: Math.min(percentage, 100),
								promptTokens: parsed.usage.promptTokens,
								completionTokens: parsed.usage.completionTokens,
								reasoningTokens: parsed.usage.reasoningTokens,
								cachedInputTokens: parsed.usage.cachedInputTokens,
								contextWindow,
							};
						}
					}
					if (parsed.webSearch) {
						const ws = parsed.webSearch;
						if (!webSearchAccum.has(ws.id)) {
							webSearchAccum.set(ws.id, { emitted: false });
						}
						// biome-ignore lint/style/noNonNullAssertion: just set above
						const acc = webSearchAccum.get(ws.id)!;
						// Update query info when available (from output_item.done)
						if (ws.query) acc.query = ws.query;
						if (ws.queries) acc.queries = ws.queries;
						// Emit block_complete when search is done (use accumulated query data
						// since query info may arrive in earlier events than the completed status)
						if (ws.status === "completed" && (acc.query || acc.queries) && !acc.emitted) {
							acc.emitted = true;
							yield {
								type: "block_complete",
								block: {
									type: "web_search",
									id: ws.id,
									query: acc.query,
									queries: acc.queries,
								},
							};
						}
						yield {
							type: "web_search",
							id: ws.id,
							status: ws.status,
							query: ws.query,
							queries: ws.queries,
						};
					}
					if (parsed.invalidState) {
						const reason = String(parsed.invalidState.reason ?? "api_error");
						const message = String(parsed.invalidState.message ?? "Unknown provider error");
						if (isContextOverflowReason(reason) || isContextOverflowMessage(message)) {
							yield* flushPartialContent(reasoningBlockMap, assistantText);
							yield { type: "context_length_exceeded", message };
							return;
						}
						if (isRetryableInvalidStateReason(reason, message)) {
							// In-loop retry: skip block_complete persistence and retry
							// the same chat() call with identical parameters.
							if (chatRetryCount < maxChatRetries && !config.signal.aborted) {
								chatRetryCount++;
								const delayMs = Math.min(
									TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
									20_000,
								);
								yield {
									type: "retrying",
									message,
									attempt: chatRetryCount,
									maxRetries: maxChatRetries,
									delayMs,
								};
								await abortableSleep(delayMs, config.signal);
								if (config.signal.aborted) {
									yield { type: "error", message: "Aborted" };
									return;
								}
								continue; // retry provider.chat()
							}
							// Exhausted retries — yield block_complete for partial content
							// then signal retryable_error to the caller.
							yield* flushPartialContent(reasoningBlockMap, assistantText);
							yield { type: "retryable_error", message };
							return;
						}
						// Output truncated by max_tokens — not an error, let smart
						// interruption check handle the auto-continue.
						if (isOutputTruncationReason(reason)) {
							yield { type: "output_truncated", message };
							// Don't return — fall through to yield assistant_message
							// so the truncated content is persisted normally.
						} else {
							yield {
								type: "invalid_state",
								reason,
								message,
							};
						}
					}
				}
			} catch (err) {
				if (config.signal.aborted) {
					// Even on abort, yield block_complete for accumulated content so it can be persisted
					yield* flushPartialContent(reasoningBlockMap, assistantText);
					yield { type: "error", message: "Aborted" };
					return;
				}
				const msg = err instanceof Error ? err.message : String(err);
				if (
					err &&
					typeof err === "object" &&
					"code" in err &&
					(err as { code: string }).code === "CONTEXT_LENGTH_EXCEEDED"
				) {
					// Persist partial content before signalling overflow
					yield* flushPartialContent(reasoningBlockMap, assistantText);
					yield { type: "context_length_exceeded", message: msg };
					return;
				}
				// Detect context overflow errors from OpenAI/Codex-compatible providers.
				// Treat as context_length_exceeded so caller can prune/compact+retry.
				if (isContextWindowExceededError(err)) {
					yield* flushPartialContent(reasoningBlockMap, assistantText);
					yield { type: "context_length_exceeded", message: msg };
					return;
				}
				// Detect transient/retryable API errors (e.g. MODEL_TEMPORARILY_UNAVAILABLE,
				// throttling, 429/529 overloaded)
				if (isRetryableError(err)) {
					// In-loop retry for stateless providers
					if (chatRetryCount < maxChatRetries && !config.signal.aborted) {
						chatRetryCount++;
						const delayMs = Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1), 20_000);
						yield {
							type: "retrying",
							message: msg,
							attempt: chatRetryCount,
							maxRetries: maxChatRetries,
							delayMs,
						};
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					// Exhausted retries — persist partial content and signal caller
					yield* flushPartialContent(reasoningBlockMap, assistantText);
					yield { type: "retryable_error", message: msg };
					return;
				}
				// Non-retryable error — persist partial content and signal caller
				yield* flushPartialContent(reasoningBlockMap, assistantText);
				yield { type: "error", message: msg };
				return;
			}

			// Chat call succeeded — break out of the retry loop
			break;
		} // end for (;;) retry loop

		// ── Fallback: estimate context usage when the provider reported nothing ──
		if (!receivedUsage) {
			const contextWindow = getModelContextWindow(effectiveModel, effectiveProvider);
			if (contextWindow) {
				// Estimate prompt tokens from history + system prompt + current turn content
				const historyText = JSON.stringify(history);
				const systemText = config.systemPrompt ?? "";
				const estimatedPromptTokens =
					estimateTokens(historyText) +
					estimateTokens(systemText) +
					estimateTokens(content) +
					estimateTokens(assistantText);
				const percentage = Math.min((estimatedPromptTokens / contextWindow) * 100, 100);
				yield {
					type: "context_usage",
					percentage,
					promptTokens: estimatedPromptTokens,
					contextWindow,
					isEstimated: true,
				};
			}
		}

		// Detect orphaned tool uses — tool calls whose streaming input was cut off
		// before receiving a stop signal (typically due to API max_tokens truncation).
		// These are silently dropped by the accumulator, so we must detect and handle them.
		const hasOrphanedToolUses = toolUseAccum.size > 0;
		if (hasOrphanedToolUses) {
			const orphanedNames = [...toolUseAccum.values()].map((a) => a.name).join(", ");
			toolUseAccum.clear();

			// Yield accumulated content before truncation
			yield* flushPartialContent(reasoningBlockMap, assistantText);

			// Drain settled tool results before assistant_message so the DB
			// has correct tool call statuses when the message is broadcast.
			for (const tu of toolUses) {
				const sr = settledResults.get(tu.toolUseId);
				if (!sr || yieldedToolResults.has(tu.toolUseId)) continue;
				yieldedToolResults.add(tu.toolUseId);
				if (sr.broken) brokenToolUseIds.add(tu.toolUseId);
				const brokenOverride = sr.broken
					? sanitizeBrokenInput(tu.name, tu.input, locale)
					: undefined;
				yield {
					type: "tool_result",
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					output: sr.broken ? getToolMessage("brokenToolCallResult", locale) : sr.output,
					isError: sr.isError ?? false,
					durationMs: sr.durationMs,
					brokenInputOverride: brokenOverride,
					updatedInput: brokenOverride,
					metadata: sr.metadata,
				};
				if (sr.fatal) {
					yield { type: "error", message: sr.output };
					return;
				}
			}

			// Persist the assistant message (only the complete tool calls survive)
			yield {
				type: "assistant_message",
				text: assistantText,
				toolUses,
				messageId,
			};

			if (toolUses.length === 0) {
				// No complete tool calls at all — push the text-only assistant turn
				// and inject a reminder so the model retries with a different strategy.
				provider.pushAssistantTurn(
					history,
					assistantText,
					[],
					collectReasoningBlocks(reasoningBlockMap),
				);
				nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
					toolNames: orphanedNames,
				});
				yield { type: "turn_complete", turnIndex };
				turnIndex++;
				continue;
			}
			// Some complete tool calls exist alongside orphaned ones — fall through
			// to execute them. The orphaned ones are already gone from toolUses.
			// Set nextTurnContent so the model gets a reminder after execution.
			nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
				toolNames: orphanedNames,
			});
		}

		if (!hasOrphanedToolUses) {
			// Yield block_complete for accumulated content now that streaming is done
			yield* flushPartialContent(reasoningBlockMap, assistantText);

			// Drain settled tool results before assistant_message so the DB
			// has correct tool call statuses when the message is broadcast.
			for (const tu of toolUses) {
				const sr = settledResults.get(tu.toolUseId);
				if (!sr || yieldedToolResults.has(tu.toolUseId)) continue;
				yieldedToolResults.add(tu.toolUseId);
				if (sr.broken) brokenToolUseIds.add(tu.toolUseId);
				const brokenOverride = sr.broken
					? sanitizeBrokenInput(tu.name, tu.input, locale)
					: undefined;
				yield {
					type: "tool_result",
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					output: sr.broken ? getToolMessage("brokenToolCallResult", locale) : sr.output,
					isError: sr.isError ?? false,
					durationMs: sr.durationMs,
					brokenInputOverride: brokenOverride,
					updatedInput: brokenOverride,
					metadata: sr.metadata,
				};
				if (sr.fatal) {
					yield { type: "error", message: sr.output };
					return;
				}
			}

			// Yield the complete assistant message
			yield {
				type: "assistant_message",
				text: assistantText,
				toolUses,
				messageId,
			};
		}

		// No tool calls → we're done
		if (toolUses.length === 0) {
			yield { type: "done" };
			return;
		}

		// Push the current user turn into history for the next turn.
		// This must happen AFTER the API call (not before), because
		// chat() references the history array directly.
		if (isFirstTurn) {
			provider.pushUserTurn(history, userText, effectiveModel, initialToolResults ?? []);
		} else if (pendingToolResults.length > 0) {
			provider.pushUserTurn(history, "", effectiveModel, pendingToolResults);
		}

		// Execute each tool call
		pendingToolResults = [];
		// Nudge threshold: append a wrap-up reminder when ≥80% of maxTurns used
		const nudgeThreshold = Math.floor(maxTurns * 0.8);
		const shouldNudge = turnIndex >= nudgeThreshold;
		const nudgeText = shouldNudge
			? getToolMessageWithParams("turnNudge", locale, {
					turnIndex: turnIndex + 1,
					maxTurns,
				})
			: "";

		// Group tool calls into runs: consecutive Task calls form a parallel batch,
		// everything else executes serially (one tool per group).
		const groups: AgentToolUse[][] = [];
		for (const tu of toolUses) {
			const isParallel = PARALLEL_TOOLS.has(tu.name);
			const lastGroup = groups[groups.length - 1];
			if (isParallel && lastGroup && PARALLEL_TOOLS.has(lastGroup[0].name)) {
				lastGroup.push(tu);
			} else {
				groups.push([tu]);
			}
		}

		let toolIndex = 0;
		// Tracks cumulative execution time of preceding serial tools in this turn,
		// used to subtract wait time when computing display duration for fast tools.
		let prevToolsExecMs = 0;
		for (const group of groups) {
			if (config.signal.aborted) {
				yield { type: "error", message: "Aborted" };
				return;
			}

			if (group.length === 1) {
				// Serial execution (single tool)
				const tu = group[0];
				const earlyPromise = earlyExecMap.get(tu.toolUseId);
				const result = earlyPromise ? await earlyPromise : await executeTool(tu, config);
				if (result.broken) brokenToolUseIds.add(tu.toolUseId);
				const isLastTool = toolIndex === toolUses.length - 1;
				const outputForModel =
					isLastTool && shouldNudge ? result.output + nudgeText : result.output;

				pendingToolResults.push(
					provider.formatToolResult(
						tu.toolUseId,
						outputForModel,
						result.isError ?? false,
						result.images,
					),
				);

				if (yieldedToolResults.has(tu.toolUseId)) {
					// Already yielded during streaming — just accumulate timing
					prevToolsExecMs += result.durationMs;
					toolIndex++;
					if (result.fatal) {
						// Fatal was already yielded in the drain loop
						return;
					}
				} else {
					// Only yield tool_call if not already yielded during streaming
					if (!earlyPromise) {
						yield {
							type: "tool_call",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							input: tu.input,
							streamStartedAt: tu.streamStartedAt,
						};
					}

					// For tools with streamStartedAt, compute display duration as
					// total elapsed minus time spent executing preceding tools.
					let durationMs = result.durationMs;
					if (tu.streamStartedAt != null) {
						const totalElapsed = Date.now() - tu.streamStartedAt;
						const adjusted = totalElapsed - prevToolsExecMs;
						durationMs = Math.max(adjusted, result.durationMs);
					}
					prevToolsExecMs += result.durationMs;

					// For broken tool calls, sanitize the persisted input and output
					// so the DB shows a clean message instead of truncated garbage.
					const brokenInputOverride = result.broken
						? sanitizeBrokenInput(tu.name, tu.input, locale)
						: undefined;
					const displayOutput = result.broken
						? getToolMessage("brokenToolCallResult", locale)
						: result.output;

					yield {
						type: "tool_result",
						toolUseId: tu.toolUseId,
						toolName: tu.name,
						output: displayOutput,
						isError: result.isError ?? false,
						durationMs,
						brokenInputOverride,
						updatedInput: brokenInputOverride ?? result.updatedInput,
						metadata:
							durationMs !== result.durationMs
								? { ...result.metadata, execDurationMs: result.durationMs }
								: result.metadata,
					};
					toolIndex++;

					if (result.fatal) {
						yield { type: "error", message: result.output };
						return;
					}
				}
			} else {
				// Parallel execution (multiple Task calls)
				// Yield tool_call events for tools not already started during streaming
				for (const tu of group) {
					if (!earlyExecMap.has(tu.toolUseId) && !yieldedToolResults.has(tu.toolUseId)) {
						yield {
							type: "tool_call",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							input: tu.input,
							streamStartedAt: tu.streamStartedAt,
						};
					}
				}

				// Start all executions concurrently, but yield results as each completes
				// (instead of waiting for all via Promise.all) so the frontend can update
				// individual tool cards immediately.
				const execEntries = group.map((tu) => ({
					tu,
					promise: earlyExecMap.get(tu.toolUseId) ?? executeTool(tu, config),
				}));

				// Wrap each promise to carry its index so we know which resolved
				const indexed = execEntries.map((e, i) => e.promise.then((result) => ({ i, result })));

				const settled = new Array<ToolExecResult | undefined>(group.length);
				let remaining = new Set(indexed);
				let hasFatal = false;
				let maxParallelMs = 0;

				while (remaining.size > 0) {
					const winner = await Promise.race(remaining);
					const { i, result } = winner;
					settled[i] = result;

					// Remove the settled promise from the race set
					remaining = new Set([...remaining].filter((p) => p !== indexed[i]));

					const tu = group[i];
					if (result.broken) brokenToolUseIds.add(tu.toolUseId);
					const isLastTool = toolIndex === toolUses.length - 1 && remaining.size === 0;
					const outputForModel =
						isLastTool && shouldNudge ? result.output + nudgeText : result.output;

					pendingToolResults.push(
						provider.formatToolResult(
							tu.toolUseId,
							outputForModel,
							result.isError ?? false,
							result.images,
						),
					);

					if (!yieldedToolResults.has(tu.toolUseId)) {
						const brokenInputOverride = result.broken
							? sanitizeBrokenInput(tu.name, tu.input, locale)
							: undefined;
						const displayOutput = result.broken
							? getToolMessage("brokenToolCallResult", locale)
							: result.output;

						yield {
							type: "tool_result",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							output: displayOutput,
							isError: result.isError ?? false,
							durationMs: result.durationMs,
							brokenInputOverride,
							updatedInput: brokenInputOverride ?? result.updatedInput,
							metadata: result.metadata,
						};
					}
					toolIndex++;
					if (result.durationMs > maxParallelMs) maxParallelMs = result.durationMs;

					if (result.fatal) hasFatal = true;
				}
				prevToolsExecMs += maxParallelMs;

				if (hasFatal) {
					const fatalResult = settled.find((r) => r?.fatal);
					const fatalMsg = fatalResult?.output ?? "Fatal tool error";
					yield { type: "error", message: fatalMsg };
					return;
				}
			}
		}

		// Graceful stop requested (e.g. feedback injection) — exit without aborting processes.
		// Unlike abort, this lets the current tool finish normally and preserves its result.
		if (config.shouldStop?.()) {
			provider.pushAssistantTurn(
				history,
				assistantText,
				toolUses,
				collectReasoningBlocks(reasoningBlockMap),
			);
			yield { type: "turn_complete", turnIndex };
			return;
		}

		// Strip broken tool calls from the history sent to the model.
		// The UI already has the full picture (tool_result events were yielded above),
		// but the model should not see the broken tool_use + tool_result pair —
		// they waste context and cause retry loops.
		if (brokenToolUseIds.size > 0) {
			const cleanToolUses = toolUses.filter((tu) => !brokenToolUseIds.has(tu.toolUseId));
			pendingToolResults = pendingToolResults.filter(
				(tr) => !brokenToolUseIds.has((tr as { toolUseId: string }).toolUseId),
			);
			provider.pushAssistantTurn(
				history,
				assistantText,
				cleanToolUses,
				collectReasoningBlocks(reasoningBlockMap),
			);

			// Inject a user-side reminder so the model knows what happened and
			// switches strategy instead of blindly retrying the same large write.
			const brokenNames = toolUses
				.filter((tu) => brokenToolUseIds.has(tu.toolUseId))
				.map((tu) => tu.name);
			nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
				toolNames: brokenNames.join(", "),
			});
		} else {
			// Append assistant message to history for next turn
			provider.pushAssistantTurn(
				history,
				assistantText,
				toolUses,
				collectReasoningBlocks(reasoningBlockMap),
			);
		}

		// Allow external code (e.g. onExitPlanMode) to inject text into the next
		// user turn. This text rides alongside the pending tool results so the
		// model sees both the tool output and the injected message in one request.
		if (config.getInjectedUserText) {
			const injected = config.getInjectedUserText();
			if (injected) {
				nextTurnContent = nextTurnContent ? `${nextTurnContent}\n\n${injected}` : injected;
			}
		}

		yield { type: "turn_complete", turnIndex };
		turnIndex++;
	}

	yield { type: "error", message: `Max turns (${maxTurns}) exceeded` };
}

// === Internal helpers ===

interface ToolExecResult {
	output: string;
	isError?: boolean;
	durationMs: number;
	fatal?: boolean;
	/** Set when the tool call was rejected because the model's output was
	 *  cut off mid-stream (malformed JSON, suspiciously large content, etc.).
	 *  The loop will strip this tool_use + tool_result from the history sent
	 *  to the model and inject a user-side reminder instead. */
	broken?: boolean;
	/** Optional metadata from the tool (e.g. line numbers for Edit). */
	metadata?: Record<string, unknown>;
	/** Base64-encoded images to include in the tool result (for multimodal providers). */
	images?: Array<{ format: string; base64: string }>;
	/** When the permission handler redirected the input (e.g. plan-mode file path),
	 *  this holds the effective input that was actually executed. */
	updatedInput?: Record<string, unknown>;
}

async function executeTool(tu: AgentToolUse, config: AgentConfig): Promise<ToolExecResult> {
	const tool = toolRegistry.get(tu.name);
	const locale = (config.locale as Locale) ?? "en";

	// Defense-in-depth: Codex and official Anthropic use native server-side web_search.
	// The WebSearch function tool is filtered from the API request (line ~407), but the
	// non-official codex endpoint may not validate tool names strictly — the model could
	// still invoke "WebSearch" based on training data / tool descriptions. Block execution
	const isOfficialAnthropic =
		isAnthropicProvider(config.provider) &&
		!!getAnthropicProviderConfig(config.provider)?.officialApi;
	if (tu.name === "WebSearch" && (config.provider === "codex" || isOfficialAnthropic)) {
		logger.warn("Blocked WebSearch function tool for native-search provider", {
			provider: config.provider,
			model: config.model,
			narratorId: config.narratorId,
		});
		return {
			output:
				"This provider uses native server-side web search. The WebSearch function tool is not available.",
			isError: true,
			durationMs: 0,
		};
	}

	if (!tool) {
		return {
			output: `Unknown tool: ${tu.name}`,
			isError: true,
			durationMs: 0,
		};
	}

	// Permission check
	const permission = await config.permissionHandler(tu.name, tu.input, tu.toolUseId);
	if (permission.behavior === "deny") {
		const userMessage =
			permission.rawMessage && permission.message
				? permission.message
				: permission.message
					? getToolMessageWithParams("permissionDeniedWithMessage", locale, {
							message: permission.message,
						})
					: getToolMessage("permissionDeniedByUser", locale);
		return {
			output: userMessage,
			isError: true,
			durationMs: 0,
			fatal: permission.fatal,
		};
	}

	// Start timing after permission is granted
	const start = Date.now();

	const effectiveInput = permission.updatedInput ?? tu.input;
	const permissionNotice = permission.behavior === "allow" ? permission.notice : undefined;
	// Track whether the permission handler redirected the input (e.g. plan-mode file path)
	const redirectedInput =
		permission.updatedInput && permission.updatedInput !== tu.input
			? permission.updatedInput
			: undefined;

	// Check if the tool input is malformed JSON (_raw field) — a sign of output truncation
	if ("_raw" in effectiveInput) {
		const rawLen = typeof effectiveInput._raw === "string" ? effectiveInput._raw.length : 0;
		return {
			output:
				`The tool call input was truncated — received malformed JSON (${rawLen} chars of raw input). ` +
				`The ${tu.name} was NOT executed to avoid corrupting files. ` +
				"Each tool call's total input must be under 10,000 characters. " +
				"Use skeleton-first approach: Write a skeleton with SPLICE markers, " +
				"then Edit to fill each marker with real content.",
			isError: true,
			durationMs: Date.now() - start,
			broken: true,
		};
	}

	// Detect empty input for file-writing tools — a sign of complete truncation
	// where the stream sent tool name/id but no input chunks at all.
	const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
	if (FILE_TOOLS.has(tu.name) && Object.keys(effectiveInput).length === 0) {
		return {
			output:
				`The ${tu.name} call received no input at all (complete truncation). ` +
				`The ${tu.name} was NOT executed. ` +
				"Each tool call's total input must be under 10,000 characters. " +
				"Use skeleton-first approach: Write a skeleton with SPLICE markers, " +
				"then Edit to fill each marker with real content.",
			isError: true,
			durationMs: Date.now() - start,
			broken: true,
		};
	}

	// Validate parameters
	const parsed = tool.parameters.safeParse(effectiveInput);
	if (!parsed.success) {
		return {
			output: `Invalid parameters: ${parsed.error.message}`,
			isError: true,
			durationMs: Date.now() - start,
		};
	}

	// Progress timer
	let progressTimer: ReturnType<typeof setInterval> | undefined;
	if (config.onEvent) {
		const onEvent = config.onEvent;
		let elapsed = 0;
		progressTimer = setInterval(() => {
			elapsed += PROGRESS_INTERVAL_MS / 1000;
			onEvent({ type: "tool_progress", toolUseId: tu.toolUseId, elapsed });
		}, PROGRESS_INTERVAL_MS);
	}

	const ctx: ToolContext = {
		narratorId: config.narratorId,
		cwd: config.cwd,
		signal: config.signal,
		locale: config.locale ?? "en",
		chapterId: config.chapterId,
		planFileId: config.planFileId,
		skillRoot: config.skillRoot,
		requestPermission: config.permissionHandler,
		currentToolUseId: tu.toolUseId,
	};

	// Wire up emitLongRunning: notify UI when a process exceeds 60s
	if (config.onEvent) {
		const onEvent = config.onEvent;
		ctx.emitLongRunning = (toolUseId: string, elapsed: number) => {
			onEvent({ type: "tool_long_running", toolUseId, elapsed });
		};
	}

	// Wire up emitOutput: throttled streaming of tool output to the UI
	let pendingOutputTimer: ReturnType<typeof setTimeout> | undefined;
	if (config.onEvent) {
		const onEvent = config.onEvent;
		let lastEmitTime = 0;
		let latestOutput = "";

		const flush = () => {
			lastEmitTime = Date.now();
			onEvent({ type: "tool_output", toolUseId: tu.toolUseId, output: latestOutput });
		};

		ctx.emitOutput = (output: string) => {
			latestOutput =
				output.length > MAX_STREAM_OUTPUT_LENGTH
					? `${output.slice(0, MAX_STREAM_OUTPUT_LENGTH)}\n\n...`
					: output;

			const elapsed = Date.now() - lastEmitTime;
			if (elapsed >= OUTPUT_THROTTLE_MS) {
				if (pendingOutputTimer) {
					clearTimeout(pendingOutputTimer);
					pendingOutputTimer = undefined;
				}
				flush();
			} else if (!pendingOutputTimer) {
				pendingOutputTimer = setTimeout(() => {
					pendingOutputTimer = undefined;
					flush();
				}, OUTPUT_THROTTLE_MS - elapsed);
			}
		};
	}

	try {
		const result = await tool.execute(effectiveInput, ctx);
		// Append permission notice (e.g. plan-mode file redirect) to non-error output
		const appendNotice = permissionNotice && !result.isError ? `\n\n${permissionNotice}` : "";
		// If the tool already truncated its output, pass through as-is.
		if (result.truncated) {
			return {
				output: result.output + appendNotice,
				isError: result.isError,
				fatal: result.fatal,
				durationMs: Date.now() - start,
				metadata: result.metadata,
				images: result.images,
				updatedInput: redirectedInput,
			};
		}
		const truncated = truncateOutput(result.output);
		return {
			output: truncated.content + appendNotice,
			isError: result.isError,
			fatal: result.fatal,
			durationMs: Date.now() - start,
			metadata: result.metadata,
			images: result.images,
			updatedInput: redirectedInput,
		};
	} catch (err) {
		return {
			output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			durationMs: Date.now() - start,
			updatedInput: redirectedInput,
		};
	} finally {
		if (progressTimer) clearInterval(progressTimer);
		if (pendingOutputTimer) {
			clearTimeout(pendingOutputTimer);
			pendingOutputTimer = undefined;
		}
	}
}

/**
 * Build a sanitized version of a broken tool call's input for DB persistence.
 * Keeps structural parameters (file_path, etc.) but replaces large content
 * fields with a short placeholder so the DB record is readable.
 */
function sanitizeBrokenInput(
	toolName: string,
	input: Record<string, unknown>,
	locale: string,
): Record<string, unknown> {
	const placeholder = getToolMessage("brokenToolCallInputPlaceholder", (locale as Locale) ?? "en");
	const clean: Record<string, unknown> = {};
	const isEdit = toolName === "Edit" || toolName === "MultiEdit";

	// If input is just { _raw: "..." }, extract file_path from the incomplete JSON
	if ("_raw" in input && Object.keys(input).length === 1) {
		const raw = input._raw as string;
		const filePathMatch = raw.match(/"file_path"\s*:\s*"([^"]+)"/);
		clean.file_path = filePathMatch ? filePathMatch[1] : "";
		// Use the correct field names so the frontend can render properly
		if (isEdit) {
			clean.old_string = placeholder;
			clean.new_string = placeholder;
		} else {
			clean.content = placeholder;
		}
	} else {
		// Normal case: copy non-content fields, replace content fields
		for (const [key, value] of Object.entries(input)) {
			if (key === "_raw") continue;
			if (key === "content" || key === "old_string" || key === "new_string") {
				clean[key] = placeholder;
			} else {
				clean[key] = value;
			}
		}
		// Ensure file_path is always present
		if (!("file_path" in clean)) {
			clean.file_path = "";
		}
		// Ensure content fields exist with correct names for the tool type
		if (isEdit) {
			if (!("old_string" in clean)) clean.old_string = placeholder;
			if (!("new_string" in clean)) clean.new_string = placeholder;
		} else if (!("content" in clean)) {
			clean.content = placeholder;
		}
	}

	return clean;
}
