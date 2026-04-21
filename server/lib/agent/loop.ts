import { logger } from "../logger";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import {
	getAnthropicProviderConfig,
	getModelContextWindow,
	isAnthropicProvider,
	settings,
	usesCodexApiMode,
	usesStatefulApi,
} from "../settings";
import {
	extractErrorMessage,
	isContextOverflowMessage,
	isContextOverflowReason,
	isContextWindowExceededError,
	isOutputTruncationReason,
	isRetryableError,
	isRetryableInvalidStateReason,
} from "./error-handling";
import { estimateTokens } from "./estimate-tokens";
import { resolveProviderAndModel } from "./provider";
import { ApiRequestDumpCollector } from "./request-dump";
import { executeTool, sanitizeBrokenInput, type ToolExecResult } from "./tool-executor";
import { toolRegistry } from "./tool-registry";
import { SHELL_TOOL_NAME } from "./tools/bash";
import type {
	AgentConfig,
	AgentEvent,
	AgentToolUse,
	ContentBlock,
	ResolvedToolDefinition,
} from "./types";
import {
	PLAN_MODE_ALLOWED_TOOLS,
	type ReasoningProviderMetadata,
	TRANSIENT_RETRY_BASE_MS,
} from "./types";

export { isRetryableError } from "./error-handling";

const EMPTY_RESPONSE_MESSAGE =
	"Provider returned an empty response. This often indicates an API configuration error " +
	"(base URL, model, or credentials).";

/** Max retries specifically for empty responses (request succeeded but no content). */
const MAX_EMPTY_RESPONSE_RETRIES = 3;

function dedupeToolUsesInPlace(
	toolUses: AgentToolUse[],
	provider: string,
	model: string,
): AgentToolUse[] {
	if (toolUses.length < 2) return toolUses;
	const seen = new Set<string>();
	const deduped: AgentToolUse[] = [];
	const duplicateIds: string[] = [];
	for (const tu of toolUses) {
		if (seen.has(tu.toolUseId)) {
			duplicateIds.push(tu.toolUseId);
			continue;
		}
		seen.add(tu.toolUseId);
		deduped.push(tu);
	}
	if (duplicateIds.length > 0) {
		logger.error("Deduplicated repeated tool calls in a single turn", {
			provider,
			model,
			duplicateCount: duplicateIds.length,
			toolUseIds: [...new Set(duplicateIds)].slice(0, 20),
		});
		toolUses.length = 0;
		toolUses.push(...deduped);
	}
	return toolUses;
}

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
	reasoningBlockMap: Map<string, ReasoningBlockEntry>,
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
					outputIndex: entry.outputIndex,
				},
			};
		}
	}
	if (assistantText) {
		yield { type: "block_complete", block: { type: "text", text: assistantText } };
	}
}

/** Tools that can safely run in parallel when multiple appear in the same turn. */
const PARALLEL_TOOLS = new Set([
	"Agent",
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	SHELL_TOOL_NAME,
]);

type ReasoningBlockEntry = {
	text: string;
	providerMetadata?: ReasoningProviderMetadata;
	outputIndex?: number;
};

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

function collectCompletedWebSearches(
	map: Map<
		string,
		{
			query?: string;
			queries?: string[];
			emitted: boolean;
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
		}
	>,
):
	| Array<{
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
	  }>
	| undefined {
	const blocks: Array<{
		id: string;
		query?: string;
		queries?: string[];
		outputIndex?: number;
		action?: import("./provider").WebSearchAction;
	}> = [];
	for (const [id, entry] of map.entries()) {
		if (!entry.query && !entry.queries?.length && !entry.action) continue;
		blocks.push({
			id,
			query: entry.query,
			queries: entry.queries,
			outputIndex: entry.outputIndex,
			action: entry.action,
		});
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
	if (usesCodexApiMode(effectiveProvider) || isOfficialAnthropic) {
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
		const reasoningBlockMap = new Map<string, ReasoningBlockEntry>();
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
				/** Accumulated input delta since last yield (flushed on each yield) */
				pendingDelta: string;
				startedAt: number;
				extractedFilePath?: string;
				extractedFields?: Record<string, string>;
				lastYieldedAt: number;
			}
		>();
		// Accumulator for native web search calls (Codex web_search tool)
		const webSearchAccum = new Map<
			string,
			{
				query?: string;
				queries?: string[];
				emitted: boolean;
				outputIndex?: number;
				action?: import("./provider").WebSearchAction;
			}
		>();
		// Track whether the provider reported usage data during this turn
		let receivedUsage = false;

		// API request tracking variables (moved outside retry loop)
		let requestId: string | undefined;
		let requestStartTime: number | undefined;
		let requestTtftMs: number | undefined;
		let requestUsage:
			| {
					promptTokens?: number;
					inputTokens?: number;
					completionTokens?: number;
					reasoningTokens?: number;
					cachedInputTokens?: number;
					cacheCreationInputTokens?: number;
					cacheCreation5mTokens?: number;
					cacheCreation1hTokens?: number;
			  }
			| undefined;
		let requestContextPercent: number | undefined;
		let requestMeterUsage: number | undefined;
		let requestMeterUnit: string | undefined;
		let sawMeaningfulResponse = false;
		let requestDump: ApiRequestDumpCollector | undefined;

		// ── Transient-error retry loop ──
		// we can safely retry the exact same provider.chat() call with identical
		// history, content, and toolResults — no server-side state was mutated.
		// Stateful providers (responses/codex) cannot retry here because the
		// server already consumed the request.
		const maxChatRetries = usesStatefulApi(effectiveProvider)
			? 0
			: (config.maxTransientRetries ?? 0);
		const backoffCeil = config.retryBackoffCeilMs ?? 20_000;
		let chatRetryCount = 0;
		let emptyResponseRetries = 0;

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
			sawMeaningfulResponse = false;

			// Generate unique request ID for this API call (reset on each retry)
			requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
			requestStartTime = Date.now();
			requestTtftMs = undefined;
			requestUsage = undefined;
			requestContextPercent = undefined;
			requestMeterUsage = undefined;
			requestMeterUnit = undefined;

			// Initialize request dump collector if enabled
			requestDump = settings.agent.requestDumpEnabled
				? new ApiRequestDumpCollector({
						provider: effectiveProvider,
						model: effectiveModel,
					})
				: undefined;

			// Emit API request start event
			yield {
				type: "api_request_start",
				requestId,
				provider: effectiveProvider,
				model: effectiveModel,
				credentialId,
			};

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
					requestDump,
					...(isFirstTurn && images?.length ? { images } : {}),
				});

				for await (const parsed of stream) {
					// Record TTFT (time to first token) for this request
					if (
						requestTtftMs === undefined &&
						(parsed.text || parsed.toolUseChunk || parsed.reasoning)
					) {
						requestTtftMs = Date.now() - requestStartTime;
					}

					if (
						parsed.text ||
						parsed.toolUses ||
						parsed.toolUseChunk ||
						parsed.reasoning ||
						parsed.webSearch
					) {
						sawMeaningfulResponse = true;
					}

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
										pendingDelta: "",
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
									acc.pendingDelta += input;

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

										// Flush accumulated delta since last yield
										const inputDelta = acc.pendingDelta;
										acc.pendingDelta = "";

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
											...(inputDelta && { inputDelta }),
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
									const inputDelta = acc.pendingDelta;
									acc.pendingDelta = "";
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
										...(inputDelta && { inputDelta }),
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
										if (sr.updatedInput) prevTu.input = sr.updatedInput;
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

					if (parsed.silentDisconnect) {
						yield { type: "silent_disconnect" };
						return;
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
							if (parsed.reasoningOutputIndex != null) {
								existing.outputIndex = parsed.reasoningOutputIndex;
							}
						} else {
							reasoningBlockMap.set(itemKey, {
								text: parsed.reasoning,
								providerMetadata: parsed.reasoningMetadata,
								outputIndex: parsed.reasoningOutputIndex,
							});
						}
						yield {
							type: "stream_reasoning",
							text: parsed.reasoning,
							providerMetadata: parsed.reasoningMetadata,
							outputIndex: parsed.reasoningOutputIndex,
						};
					} else if (parsed.reasoningMetadata) {
						// Metadata-only event (e.g. final encrypted_content from output_item.done).
						// Update the stored metadata without emitting a streaming event.
						const itemKey = parsed.reasoningMetadata?.openai?.itemId ?? "__default";
						const existing = reasoningBlockMap.get(itemKey);
						if (existing) {
							existing.providerMetadata = parsed.reasoningMetadata;
							if (parsed.reasoningOutputIndex != null) {
								existing.outputIndex = parsed.reasoningOutputIndex;
							}
						} else {
							// Metadata arrived before any text — create an empty-text entry
							reasoningBlockMap.set(itemKey, {
								text: "",
								providerMetadata: parsed.reasoningMetadata,
								outputIndex: parsed.reasoningOutputIndex,
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
						requestMeterUsage = parsed.metering.usage;
						requestMeterUnit = parsed.metering.unit;
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
					// Generic gateway-injected queue/quota events (OpenAI/Anthropic via unified gateway)
					if (parsed.queueStatus) {
						yield {
							type: "queue_status",
							position: parsed.queueStatus.position,
							queueDepth: parsed.queueStatus.queueDepth,
						};
					}
					if (parsed.quotaBalance !== undefined) {
						yield { type: "quota_balance", quotaBalance: parsed.quotaBalance };
					}
					// Convert OpenAI/Anthropic usage to context_usage percentage
					if (parsed.usage && parsed.usage.promptTokens != null) {
						receivedUsage = true;
						// Store usage for API request tracking
						requestUsage = {
							promptTokens: parsed.usage.promptTokens,
							inputTokens: parsed.usage.inputTokens,
							completionTokens: parsed.usage.completionTokens,
							reasoningTokens: parsed.usage.reasoningTokens,
							cachedInputTokens: parsed.usage.cachedInputTokens,
							cacheCreationInputTokens: parsed.usage.cacheCreationInputTokens,
							cacheCreation5mTokens: parsed.usage.cacheCreation5mTokens,
							cacheCreation1hTokens: parsed.usage.cacheCreation1hTokens,
						};
						const contextWindow = getModelContextWindow(effectiveModel, effectiveProvider);
						if (contextWindow) {
							const percentage = (parsed.usage.promptTokens / contextWindow) * 100;
							requestContextPercent = Math.min(percentage, 100);
							yield {
								type: "context_usage",
								percentage: requestContextPercent,
								promptTokens: parsed.usage.promptTokens,
								inputTokens: parsed.usage.inputTokens,
								completionTokens: parsed.usage.completionTokens,
								reasoningTokens: parsed.usage.reasoningTokens,
								cachedInputTokens: parsed.usage.cachedInputTokens,
								cacheCreationInputTokens: parsed.usage.cacheCreationInputTokens,
								cacheCreation5mTokens: parsed.usage.cacheCreation5mTokens,
								cacheCreation1hTokens: parsed.usage.cacheCreation1hTokens,
								contextWindow,
							};
						}
					}
					if (parsed.webSearch) {
						const ws = parsed.webSearch;
						if (!webSearchAccum.has(ws.id)) {
							webSearchAccum.set(ws.id, { emitted: false, outputIndex: ws.outputIndex });
						}
						// biome-ignore lint/style/noNonNullAssertion: just set above
						const acc = webSearchAccum.get(ws.id)!;
						// Update query info when available (from output_item.done)
						if (ws.query) acc.query = ws.query;
						if (ws.queries) acc.queries = ws.queries;
						if (ws.outputIndex != null) acc.outputIndex = ws.outputIndex;
						if (ws.action) acc.action = ws.action;
						// Emit block_complete only from the final output_item.done payload so
						// the persisted block keeps the search query and stable output order.
						if (ws.final && (acc.query || acc.queries || acc.action) && !acc.emitted) {
							acc.emitted = true;
							yield {
								type: "block_complete",
								block: {
									type: "web_search",
									id: ws.id,
									query: acc.query,
									queries: acc.queries,
									outputIndex: acc.outputIndex,
									action: acc.action,
								},
							};
						}
						yield {
							type: "web_search",
							id: ws.id,
							status: ws.status,
							query: ws.query,
							queries: ws.queries,
							outputIndex: acc.outputIndex,
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
							// -1 means infinite retries (consistent with handleTransientError)
							if (
								(maxChatRetries === -1 || chatRetryCount < maxChatRetries) &&
								!config.signal.aborted
							) {
								chatRetryCount++;
								const delayMs = Math.min(
									TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
									backoffCeil,
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
				const msg = extractErrorMessage(err);
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
					// -1 means infinite retries (consistent with handleTransientError)
					if (
						(maxChatRetries === -1 || chatRetryCount < maxChatRetries) &&
						!config.signal.aborted
					) {
						chatRetryCount++;
						const delayMs = Math.min(
							TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
							backoffCeil,
						);
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

			// Empty response check — request succeeded but returned no content.
			// Use a dedicated counter (max 3 retries) separate from transient error retries.
			if (!sawMeaningfulResponse && !assistantText && toolUses.length === 0) {
				emptyResponseRetries++;
				if (emptyResponseRetries <= MAX_EMPTY_RESPONSE_RETRIES && !config.signal.aborted) {
					const delayMs = Math.min(
						TRANSIENT_RETRY_BASE_MS * 2 ** (emptyResponseRetries - 1),
						backoffCeil,
					);
					const message = `${effectiveProvider}: ${EMPTY_RESPONSE_MESSAGE}`;
					logger.warn("Provider returned empty response, retrying", {
						narratorId: config.narratorId,
						provider: effectiveProvider,
						model: effectiveModel,
						requestId,
						attempt: emptyResponseRetries,
						maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
					});
					yield {
						type: "retrying",
						message,
						attempt: emptyResponseRetries,
						maxRetries: MAX_EMPTY_RESPONSE_RETRIES,
						delayMs,
					};
					await abortableSleep(delayMs, config.signal);
					if (config.signal.aborted) {
						yield { type: "error", message: "Aborted" };
						return;
					}
					continue; // retry provider.chat()
				}
				// Exhausted empty-response retries — surface as invalid_state
				logger.warn("Provider returned empty response, retries exhausted", {
					narratorId: config.narratorId,
					provider: effectiveProvider,
					model: effectiveModel,
					requestId,
				});
				yield {
					type: "invalid_state",
					reason: "empty_response",
					message: `${effectiveProvider}: ${EMPTY_RESPONSE_MESSAGE}`,
				};
				return;
			}

			// Chat call succeeded — break out of the retry loop
			break;
		} // end for (;;) retry loop

		// Final safety net: if a provider/parser accidentally surfaced the same toolUseId
		// multiple times in one turn, collapse them before any drain/execution logic below.
		dedupeToolUsesInPlace(toolUses, effectiveProvider, effectiveModel);

		// ── Estimate token usage when provider doesn't report it ──
		// For these cases, we estimate based on text length to provide usage statistics.
		if (!requestUsage) {
			const historyText = JSON.stringify(history);
			const systemText = config.systemPrompt ?? "";
			const estimatedInputTokens =
				estimateTokens(historyText) + estimateTokens(systemText) + estimateTokens(content);
			const estimatedOutputTokens = estimateTokens(assistantText);

			requestUsage = {
				inputTokens: estimatedInputTokens,
				promptTokens: estimatedInputTokens,
				completionTokens: estimatedOutputTokens,
			};
		}

		// Emit API request end event
		const requestDurationMs = Date.now() - requestStartTime;
		yield {
			type: "api_request_end",
			requestId,
			credentialId,
			usage: requestUsage,
			ttftMs: requestTtftMs,
			durationMs: requestDurationMs,
			contextPercent: requestContextPercent,
			meterUsage: requestMeterUsage,
			meterUnit: requestMeterUnit,
			rawDump: requestDump?.snapshot(),
		};

		// Reset retry counter after a successful turn so the next turn's
		// backoff starts from the base delay instead of the ceiling.
		chatRetryCount = 0;

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
				if (sr.updatedInput) tu.input = sr.updatedInput;
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
				credentialId,
			};

			if (toolUses.length === 0) {
				// No complete tool calls at all — push the text-only assistant turn
				// and inject a reminder so the model retries with a different strategy.
				provider.pushAssistantTurn(
					history,
					assistantText,
					[],
					collectReasoningBlocks(reasoningBlockMap),
					collectCompletedWebSearches(webSearchAccum),
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
				if (sr.updatedInput) tu.input = sr.updatedInput;
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
				credentialId,
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

		// Group tool calls into runs: consecutive parallel-safe tools form a batch,
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
				// When the permission handler redirected the input (e.g. conclusion file),
				// update the in-memory tool_use so pushAssistantTurn writes the correct
				// input into history — otherwise the model sees the original (wrong) path.
				if (result.updatedInput) tu.input = result.updatedInput;
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
					if (result.updatedInput) tu.input = result.updatedInput;
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
				collectCompletedWebSearches(webSearchAccum),
				messageId,
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
			pendingToolResults = pendingToolResults.filter((tr) => {
				const toolUseId =
					(tr as { toolUseId?: string; call_id?: string; tool_call_id?: string }).toolUseId ??
					(tr as { toolUseId?: string; call_id?: string; tool_call_id?: string }).call_id ??
					(tr as { toolUseId?: string; call_id?: string; tool_call_id?: string }).tool_call_id;
				return !toolUseId || !brokenToolUseIds.has(toolUseId);
			});
			provider.pushAssistantTurn(
				history,
				assistantText,
				cleanToolUses,
				collectReasoningBlocks(reasoningBlockMap),
				collectCompletedWebSearches(webSearchAccum),
				messageId,
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
				collectCompletedWebSearches(webSearchAccum),
				messageId,
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
