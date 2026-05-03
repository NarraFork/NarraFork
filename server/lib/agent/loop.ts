import { logger } from "../logger";
import { getPrompt, getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
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
import { YOLO_REFLECTION_TOOLS } from "./tools/yolo-pause";
import type {
	AgentConfig,
	AgentEvent,
	AgentToolUse,
	ContentBlock,
	PermissionResult,
	ResolvedToolDefinition,
} from "./types";
import {
	PLAN_MODE_ALLOWED_TOOLS,
	type ReasoningProviderMetadata,
	TRANSIENT_RETRY_BASE_MS,
} from "./types";

export { isRetryableError } from "./error-handling";

// ── Incomplete JSON field extractor ─────────────────────────────
// Parses streaming JSON fragments to extract field values without
// requiring a complete JSON object. Used to provide structured
// field data to the frontend instead of raw JSON.

/** Find the unescaped closing quote in a JSON string value. Returns -1 if not found. */
function findClosingQuote(s: string, start: number): number {
	for (let i = start; i < s.length; i++) {
		if (s.charCodeAt(i) === 0x5c /* \ */) {
			i++; // skip escaped char
			continue;
		}
		if (s.charCodeAt(i) === 0x22 /* " */) return i;
	}
	return -1;
}

/** Unescape JSON string escapes (\\n, \\t, \\r, \\", \\\\) */
function unescapeJsonString(s: string): string {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

interface ExtractedFieldsResult {
	/** Completed short fields (key → unescaped value) */
	fields: Record<string, string>;
	/** The field currently being written (no closing quote yet), or null */
	activeField: { name: string; rawStart: number } | null;
}

/**
 * Extract all string fields from an incomplete JSON object.
 * Scans for `"key": "value"` patterns, handling escaped quotes correctly.
 * Returns completed fields and identifies the currently-streaming field.
 */
function extractJsonFields(raw: string, wantedKeys: ReadonlySet<string>): ExtractedFieldsResult {
	const fields: Record<string, string> = {};
	let activeField: ExtractedFieldsResult["activeField"] = null;

	// Match `"key" :` patterns
	const keyRe = /"(\w+)"\s*:\s*/g;
	for (;;) {
		const m = keyRe.exec(raw);
		if (m === null) break;
		const key = m[1];
		if (!wantedKeys.has(key)) continue;
		const afterColon = m.index + m[0].length;
		// Expect a string value starting with "
		if (afterColon >= raw.length || raw.charCodeAt(afterColon) !== 0x22 /* " */) continue;
		const valueStart = afterColon + 1;
		const closeQuote = findClosingQuote(raw, valueStart);
		if (closeQuote !== -1) {
			// Complete field
			fields[key] = unescapeJsonString(raw.slice(valueStart, closeQuote));
			// Advance past this field so we don't re-match inside the value
			keyRe.lastIndex = closeQuote + 1;
		} else {
			// No closing quote — this field is still being written
			activeField = { name: key, rawStart: valueStart };
			break; // Nothing meaningful after an incomplete string value
		}
	}
	return { fields, activeField };
}

/** Per-tool mapping: which fields to extract, and which are "large" (streamed incrementally) */
const TOOL_FIELD_CONFIG: Record<string, { short: string[]; large: string[] }> = {
	Write: { short: ["file_path"], large: ["content"] },
	Edit: { short: ["file_path"], large: ["old_string", "new_string"] },
	Bash: { short: ["description"], large: ["command"] },
	Grep: { short: ["pattern", "path", "glob", "output_mode", "type"], large: [] },
	Glob: { short: ["pattern", "path"], large: [] },
	Read: { short: ["file_path", "offset", "limit"], large: [] },
	Agent: {
		short: ["description", "subagent_type", "model", "reasoning_effort"],
		large: ["prompt"],
	},
	Task: { short: ["description", "subagent_type", "model", "reasoning_effort"], large: ["prompt"] },
	Await: { short: ["type", "id", "timeout", "wait_for_text"], large: [] },
	Send: {
		short: ["id", "ids", "name", "names", "doInterrupt", "await", "timeout"],
		large: ["message"],
	},
	WebSearch: { short: ["query"], large: [] },
	WebFetch: { short: ["url", "mode"], large: [] },
	Skill: { short: ["skill"], large: [] },
	ExitPlanMode: { short: [], large: ["plan"] },
	StartPipeline: { short: ["label", "maxPreviewChars"], large: [] },
	EndPipeline: { short: ["aliases", "format", "maxChars"], large: ["rule"] },
	AskUserQuestion: { short: [], large: [] },
};

function getToolWantedKeys(toolName: string): Set<string> {
	const config = TOOL_FIELD_CONFIG[toolName];
	if (!config) return new Set();
	return new Set([...config.short, ...config.large]);
}

/** Tools whose input is short enough that streaming JSON parsing adds no value.
 *  We still emit tool_use_chunk events (so the frontend shows the shimmer),
 *  but skip extractJsonFields / streaming field extraction entirely.
 *  Tools with short fields (e.g. Grep.pattern, Read.file_path) still need extraction. */
function isShortInputTool(name: string): boolean {
	const config = TOOL_FIELD_CONFIG[name];
	if (!config) return true; // not in config → short by default
	return config.large.length === 0 && config.short.length === 0;
}

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
	textOutputIndex?: number,
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
		yield {
			type: "block_complete",
			block: { type: "text", text: assistantText, outputIndex: textOutputIndex },
		};
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
	"Await",
	"Send",
	SHELL_TOOL_NAME,
]);

/** Whether a tool use should skip parallel grouping and early execution. */
function isStrictSerial(tu: AgentToolUse): boolean {
	return (
		(tu.name === SHELL_TOOL_NAME && tu.input.strict_serial === true) ||
		tu.name === "StartPipeline" ||
		tu.name === "EndPipeline"
	);
}

type ReasoningBlockEntry = {
	text: string;
	providerMetadata?: ReasoningProviderMetadata;
	outputIndex?: number;
	/** When true, the next reasoning delta should be preceded by a separator. */
	_needsSeparator?: boolean;
};

function reasoningBlockKey(event: {
	reasoningMetadata?: ReasoningProviderMetadata;
	reasoningOutputIndex?: number;
}): string {
	const openaiItemId = event.reasoningMetadata?.openai?.itemId;
	if (openaiItemId) return `openai:${openaiItemId}`;

	const anthropicBlockIndex = event.reasoningMetadata?.anthropic?.blockIndex;
	if (anthropicBlockIndex != null) return `anthropic:${anthropicBlockIndex}`;

	return "__default";
}

/** Convert the per-itemId reasoning map to the blocks array expected by pushAssistantTurn. */
function collectReasoningBlocks(
	map: Map<string, ReasoningBlockEntry>,
): ReasoningBlockEntry[] | undefined {
	if (map.size === 0) return undefined;
	const blocks: ReasoningBlockEntry[] = [];
	for (const entry of map.values()) {
		if (entry.text || entry.providerMetadata) {
			// Strip internal-only _needsSeparator before passing to pushAssistantTurn
			const { _needsSeparator: _, ...block } = entry;
			blocks.push(block);
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

function collectCompletedImageGenerations(
	map: Map<
		string,
		{
			revisedPrompt?: string;
			result?: string;
			emitted: boolean;
			outputIndex?: number;
		}
	>,
):
	| Array<{
			id: string;
			revisedPrompt?: string;
			result?: string;
			outputIndex?: number;
	  }>
	| undefined {
	const blocks: Array<{
		id: string;
		revisedPrompt?: string;
		result?: string;
		outputIndex?: number;
	}> = [];
	for (const [id, entry] of map.entries()) {
		// Skip entries with no meaningful data (e.g. generation started but never completed)
		if (!entry.revisedPrompt && !entry.result) continue;
		blocks.push({
			id,
			revisedPrompt: entry.revisedPrompt,
			result: entry.result,
			outputIndex: entry.outputIndex,
		});
	}
	return blocks.length > 0 ? blocks : undefined;
}

function bulletList(items: string[]): string {
	return items.map((item) => `- ${item}`).join("\n");
}

function formatYoloDetails(details: string[] | undefined, locale: Locale): string {
	if (!details?.length) return "";
	return locale === "zh-CN"
		? `\n详情：\n${bulletList(details)}`
		: `\nDetails:\n${bulletList(details)}`;
}

function buildYoloReflectionPrompt(
	pause: NonNullable<ToolExecResult["yoloPause"]>,
	toolName: string,
	input: Record<string, unknown>,
	locale: Locale,
): string {
	return getPrompt("yoloReflection", locale)
		.replaceAll("{requestId}", pause.requestId)
		.replaceAll("{toolName}", toolName)
		.replaceAll("{inputJson}", JSON.stringify(input, null, 2))
		.replaceAll("{summary}", pause.danger.summary)
		.replaceAll("{detailsSection}", formatYoloDetails(pause.danger.details, locale))
		.replaceAll("{consequencesList}", bulletList(pause.danger.consequences))
		.replaceAll("{alternativesList}", bulletList(pause.danger.saferAlternatives));
}

async function runYoloReflectionLoop(
	parentConfig: AgentConfig,
	history: unknown[],
	pause: NonNullable<ToolExecResult["yoloPause"]>,
	toolUse: AgentToolUse,
	reflectionAbort: AbortController,
): Promise<void> {
	const onParentAbort = () => reflectionAbort.abort();
	parentConfig.signal.addEventListener("abort", onParentAbort, { once: true });
	try {
		const reflectionConfig: AgentConfig = {
			...parentConfig,
			signal: reflectionAbort.signal,
			maxTurns: 1,
			yoloReflection: { requestId: pause.requestId, toolUseId: toolUse.toolUseId },
			onEvent: undefined,
			onBeforeTurn: undefined,
			getInjectedUserText: undefined,
			shouldStop: undefined,
			toolFilter: undefined,
			permissionHandler: async (toolName, input, toolUseId) => {
				if (YOLO_REFLECTION_TOOLS.has(toolName)) return { behavior: "allow" };
				return parentConfig.permissionHandler(toolName, input, toolUseId);
			},
		};
		const locale = (parentConfig.locale as Locale) ?? "en";
		for await (const event of agentLoop(
			reflectionConfig,
			buildYoloReflectionPrompt(pause, toolUse.name, toolUse.input, locale),
			[...history],
		)) {
			if (event.type === "error") {
				logger.warn("YOLO reflection loop ended with error", {
					narratorId: parentConfig.narratorId,
					requestId: pause.requestId,
					message: event.message,
				});
			}
		}
	} finally {
		parentConfig.signal.removeEventListener("abort", onParentAbort);
	}
}

function formatYoloDeniedForModel(decision: PermissionResult, locale: Locale): string {
	const reason =
		decision.behavior === "deny" && decision.message?.trim()
			? decision.message.trim()
			: "YOLO safety pause cancelled. The operation was not executed.";
	return getToolMessageWithParams("permissionDeniedWithMessage", locale, { message: reason });
}

async function resolveYoloPauseDecision(
	config: AgentConfig,
	history: unknown[],
	pause: NonNullable<ToolExecResult["yoloPause"]>,
	toolUse: AgentToolUse,
): Promise<PermissionResult> {
	const reflectionAbort = new AbortController();
	let reflectionDone = false;
	const reflectionPromise = runYoloReflectionLoop(
		config,
		history,
		pause,
		toolUse,
		reflectionAbort,
	).finally(() => {
		reflectionDone = true;
	});
	const decision = await Promise.race([
		pause.decision.finally(() => reflectionAbort.abort()),
		reflectionPromise.then(async () => {
			const fallbackMessage =
				"YOLO reflection loop did not call YoloConfirm or YoloCancel in its single allowed response";
			const { cancelYoloPause } = await import("@server/services/narrator-permission");
			const cancelled = await cancelYoloPause(pause.requestId, fallbackMessage);
			if (cancelled) return pause.decision;

			// If the cancellation path could not find the pending request, do not leave the
			// parent narrator waiting on an unresolved decision. Prefer an already-settled
			// decision (e.g. the user resolved it at the same time); otherwise fail closed.
			const alreadySettled = await Promise.race<PermissionResult | null>([
				pause.decision,
				Promise.resolve(null),
			]);
			const fallbackDecision: PermissionResult = { behavior: "deny", message: fallbackMessage };
			return alreadySettled ?? fallbackDecision;
		}),
	]);
	if (!reflectionDone) {
		reflectionPromise.catch((err) => {
			logger.warn("YOLO reflection loop cleanup failed", { err: String(err) });
		});
	}
	return decision;
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

	// Permission checks must be serialized even when tools themselves are parallel-safe.
	// This prevents concurrent permission prompts / YOLO pauses from racing each other.
	const originalPermissionHandler = config.permissionHandler;
	let permissionTail: Promise<void> = Promise.resolve();
	config.permissionHandler = async (toolName, input, toolUseId) => {
		const run = permissionTail.then(() => originalPermissionHandler(toolName, input, toolUseId));
		permissionTail = run.then(
			async (result) => {
				// A YOLO pause returns immediately with a deferred decision. Keep subsequent
				// permission checks queued until that pause is confirmed/cancelled, otherwise
				// later tool calls can open new prompts while the original call is still pending.
				if (result.behavior === "yoloPause") {
					await result.decision.catch(() => undefined);
				}
			},
			() => undefined,
		);
		return run;
	};

	let allTools: ResolvedToolDefinition[] = toolRegistry
		.all()
		.filter((t) => t.name && (!t.isAvailable || t.isAvailable()))
		.map((t) => ({
			...t,
			description: typeof t.description === "function" ? t.description(config) : t.description,
		}));

	if (config.yoloReflection) {
		allTools = allTools.filter((tool) => YOLO_REFLECTION_TOOLS.has(tool.name));
	} else {
		allTools = allTools.filter((tool) => !YOLO_REFLECTION_TOOLS.has(tool.name));
	}

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
		/** Provider-native content block index for the text block (for interleaved ordering). */
		let textOutputIndex: number | undefined;
		/**
		 * Reasoning blocks accumulated during streaming, keyed by itemId.
		 * Supports multiple reasoning items per turn (e.g. interleaved with tool calls).
		 * Falls back to a synthetic key "__default" for providers that don't supply itemId.
		 */
		const reasoningBlockMap = new Map<string, ReasoningBlockEntry>();
		const redactedThinkingBlocks: Array<{ data: string; outputIndex?: number }> = [];
		const toolUses: AgentToolUse[] = [];
		let messageId: string | undefined;
		let credentialId: string | undefined;
		// Map of tool executions started during streaming (toolUseId → Promise)
		const earlyExecMap = new Map<string, Promise<ToolExecResult>>();
		// Synchronously queryable map of settled early-exec results (populated via .then())
		const settledResults = new Map<string, ToolExecResult>();
		// Once a strict-serial tool appears, no later tool may start eager execution.
		// This mirrors the final group execution order and preserves serial side effects.
		let eagerExecutionBlocked = false;
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
				/** Name of the large field currently being streamed */
				activeStreamingField?: string;
				/** How many raw chars of the active field have been yielded so far */
				streamingFieldYielded: number;
				lastYieldedAt: number;
				/** Provider-native content block index for interleaved ordering. */
				outputIndex?: number;
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
		// Accumulator for native image generation calls (Codex image_generation tool)
		const imageGenAccum = new Map<
			string,
			{
				revisedPrompt?: string;
				result?: string;
				emitted: boolean;
				outputIndex?: number;
			}
		>();
		// Track whether the provider reported usage data during this turn
		let receivedUsage = false;

		// API request tracking variables (moved outside retry loop)
		let requestId = "";
		let requestStartTime = 0;
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
		/** Tracks the most recent error message from a retried attempt.  When a
		 *  transient error (e.g. 429) triggers a retry and the subsequent attempt
		 *  returns an empty response, we surface this stored message instead of the
		 *  misleading "Provider returned an empty response" text.  Reset to
		 *  undefined only when a retry produces meaningful content. */
		let lastRetryErrorMessage: string | undefined;
		/** Set to true when the current attempt already yielded a terminal
		 *  error/invalid_state event.  Prevents the empty-response check from
		 *  running on the same iteration. */
		let sawErrorEvent = false;
		let requestDump: ApiRequestDumpCollector | undefined;
		let requestStarted = false;
		let requestStartPending = false;

		const markRequestStarted = (info?: { credentialId?: string }) => {
			if (info?.credentialId) {
				credentialId = info.credentialId;
			}
			if (requestStarted) return;
			requestStarted = true;
			requestStartPending = true;
			requestStartTime = Date.now();
		};

		function* flushRequestStart(): Generator<AgentEvent> {
			if (!requestStartPending) return;
			requestStartPending = false;
			yield {
				type: "api_request_start",
				requestId,
				provider: effectiveProvider,
				model: effectiveModel,
				credentialId,
			};
		}

		function* finishRequest(errorMessage?: string): Generator<AgentEvent> {
			if (!requestStarted) return;
			yield* flushRequestStart();
			yield {
				type: "api_request_end",
				requestId,
				credentialId,
				usage: requestUsage,
				ttftMs: requestTtftMs,
				durationMs: Date.now() - requestStartTime,
				contextPercent: requestContextPercent,
				meterUsage: requestMeterUsage,
				meterUnit: requestMeterUnit,
				rawDump: requestDump?.snapshot(),
				errorMessage,
			};
		}

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
		/** Set when a mimo model returns "..." as reasoning — triggers a retry. */
		let mimoEllipsisRetry = false;

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
			textOutputIndex = undefined;
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
			imageGenAccum.clear();
			receivedUsage = false;
			sawMeaningfulResponse = false;
			sawErrorEvent = false;
			mimoEllipsisRetry = false;
			// NOTE: lastRetryErrorMessage is intentionally NOT reset here.
			// It persists across retries so that if a retry produces an empty
			// response, we can surface the original error instead of the
			// misleading "empty response" message.  It is cleared below when
			// the attempt produces meaningful content.

			// Generate unique request ID for this provider attempt (reset on each retry).
			// The actual request start time is set by markRequestStarted() after the
			// provider has assembled a concrete request and is about to send it.
			requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
			requestStartTime = 0;
			requestStarted = false;
			requestStartPending = false;
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
					onRequestStart: markRequestStarted,
					...(isFirstTurn && images?.length ? { images } : {}),
				});

				for await (const parsed of stream) {
					yield* flushRequestStart();
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
						parsed.webSearch ||
						parsed.imageGeneration
					) {
						sawMeaningfulResponse = true;
						// A successful response clears any prior retry error so the
						// empty-response guard won't resurface a stale message.
						lastRetryErrorMessage = undefined;
					}

					if (parsed.text) {
						assistantText += parsed.text;
						if (parsed.textOutputIndex != null) {
							textOutputIndex = parsed.textOutputIndex;
						}
						yield { type: "stream_text", text: parsed.text, outputIndex: parsed.textOutputIndex };
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

							// Start eager execution (same as the streaming stop path).
							// Skip after a strict-serial barrier — those tools must execute
							// in final group order after preceding tools complete.
							if (
								!earlyExecMap.has(tu.toolUseId) &&
								!isStrictSerial(tu) &&
								!eagerExecutionBlocked
							) {
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
							if (isStrictSerial(tu)) eagerExecutionBlocked = true;

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
										streamingFieldYielded: 0,
										startedAt: Date.now(),
										lastYieldedAt: Date.now(),
										outputIndex: parsed.toolUseChunk.outputIndex,
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
								const shortInput = isShortInputTool(acc.name);
								if (typeof input === "string") {
									acc.inputChunks.push(input);
									acc.totalChars += input.length;

									// Short-input tools: skip field extraction, just throttle the chunk event
									if (shortInput) {
										const now = Date.now();
										if (now - acc.lastYieldedAt >= 50) {
											acc.lastYieldedAt = now;
											yield {
												type: "tool_use_chunk",
												toolUseId: id,
												toolName: acc.name,
												inputCharsTotal: acc.totalChars,
											};
										}
									} else {
										// Extract structured fields from the incomplete JSON
										const raw = acc.inputChunks.join("");
										const wantedKeys = getToolWantedKeys(acc.name);
										let fieldsChanged = false;

										if (wantedKeys.size > 0) {
											const result = extractJsonFields(raw, wantedKeys);

											// Update completed short fields
											for (const [key, value] of Object.entries(result.fields)) {
												if (!acc.extractedFields) acc.extractedFields = {};
												if (acc.extractedFields[key] !== value) {
													acc.extractedFields[key] = value;
													fieldsChanged = true;
												}
											}

											// Update file_path shortcut (used by header summary)
											if (result.fields.file_path && !acc.extractedFilePath) {
												acc.extractedFilePath = result.fields.file_path;
												fieldsChanged = true;
											}

											// Track the active streaming field
											if (result.activeField) {
												acc.activeStreamingField = result.activeField.name;
											}
										}

										// Throttle: yield at most once per 50ms per tool.
										// Bypass throttle when fields change so the frontend
										// can display them immediately.
										const now = Date.now();
										if (fieldsChanged || now - acc.lastYieldedAt >= 50) {
											acc.lastYieldedAt = now;

											// Calculate content chars (total minus file_path JSON overhead)
											let contentChars = acc.totalChars;
											if (acc.extractedFilePath) {
												const filePathFieldSize = `"file_path":"${acc.extractedFilePath}",`.length;
												contentChars = Math.max(0, acc.totalChars - filePathFieldSize);
											}

											// Compute streaming field delta
											let streamingField: { name: string; delta: string } | undefined;
											if (acc.activeStreamingField && wantedKeys.size > 0) {
												const sfResult = extractJsonFields(raw, wantedKeys);
												if (
													sfResult.activeField &&
													sfResult.activeField.name === acc.activeStreamingField
												) {
													const fullRaw = raw.slice(sfResult.activeField.rawStart);
													if (fullRaw.length > acc.streamingFieldYielded) {
														const delta = unescapeJsonString(
															fullRaw.slice(acc.streamingFieldYielded),
														);
														if (delta) {
															streamingField = {
																name: acc.activeStreamingField,
																delta,
															};
															acc.streamingFieldYielded = fullRaw.length;
														}
													}
												}
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
												...(streamingField && { streamingField }),
											};
										}
									}
								}
								if (stop) {
									const stopRaw = acc.inputChunks.join("");

									// Short-input tools: skip field extraction on stop too
									if (shortInput) {
										yield {
											type: "tool_use_chunk",
											toolUseId: id,
											toolName: acc.name,
											inputCharsTotal: acc.totalChars,
										};
									} else {
										// Final yield: flush any remaining streaming field delta
										const stopWantedKeys = getToolWantedKeys(acc.name);
										let streamingField: { name: string; delta: string } | undefined;
										if (acc.activeStreamingField && stopWantedKeys.size > 0) {
											const sfResult = extractJsonFields(stopRaw, stopWantedKeys);
											if (
												sfResult.activeField &&
												sfResult.activeField.name === acc.activeStreamingField
											) {
												const fullRaw = stopRaw.slice(sfResult.activeField.rawStart);
												if (fullRaw.length > acc.streamingFieldYielded) {
													const delta = unescapeJsonString(
														fullRaw.slice(acc.streamingFieldYielded),
													);
													if (delta) {
														streamingField = {
															name: acc.activeStreamingField,
															delta,
														};
													}
												}
											}
										}

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
											...(streamingField && { streamingField }),
										};
									}

									let parsedInput: Record<string, unknown> = {};
									if (stopRaw) {
										try {
											parsedInput = JSON.parse(stopRaw);
										} catch {
											parsedInput = { _raw: stopRaw };
										}
									}
									const tu: AgentToolUse = {
										toolUseId: id,
										name: acc.name,
										input: parsedInput,
										streamStartedAt: acc.startedAt,
										outputIndex: acc.outputIndex,
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
											outputIndex: acc.outputIndex,
										} satisfies ContentBlock,
									};

									// Start tool execution eagerly (don't await — collect later).
									// Wrap with .catch() so a rejected permissionHandler doesn't
									// create an unhandled rejection; the error surfaces as isError.
									// The .then() populates settledResults synchronously so the
									// streaming loop can drain completed results without awaiting.
									// Skip after a strict-serial barrier — those tools must execute
									// in final group order after preceding tools complete.
									if (!isStrictSerial(tu) && !eagerExecutionBlocked) {
										const execPromise = executeTool(tu, config).catch(
											(err): ToolExecResult => ({
												output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
												isError: true,
												durationMs: 0,
											}),
										);
										execPromise.then((r) => settledResults.set(id, r));
										earlyExecMap.set(id, execPromise);
									}
									if (isStrictSerial(tu)) eagerExecutionBlocked = true;

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
										// YOLO pause is not a real result for the original tool call.
										// Keep the original call pending until the reflection loop or user resolves it.
										if (sr.yoloPause) continue;
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
											permissionStartedAt: sr.permissionStartedAt,
											executionStartedAt: sr.executionStartedAt,
											completedAt: sr.completedAt,
											brokenInputOverride: brokenOverride,
											updatedInput: brokenOverride ?? sr.updatedInput,
											metadata: sr.metadata,
										};
										if (sr.fatal) {
											yield* finishRequest(sr.output);
											yield { type: "error", message: sr.output };
											return;
										}
									}
								}
							}
						}
					}

					if (parsed.silentDisconnect) {
						yield* finishRequest("Silent disconnect");
						yield { type: "silent_disconnect" };
						return;
					}
					if (parsed.messageId) messageId = parsed.messageId;

					if (parsed.credentialId) credentialId = parsed.credentialId;

					if (parsed.reasoning) {
						const itemKey = reasoningBlockKey(parsed);
						const existing = reasoningBlockMap.get(itemKey);
						// Separator prefix for multiple delimited reasoning segments that share a provider item.
						let prefix = "";
						if (existing) {
							if (existing._needsSeparator && existing.text) {
								prefix = "\n\n";
								existing._needsSeparator = false;
							}
							existing.text += prefix + parsed.reasoning;
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
							text: prefix + parsed.reasoning,
							providerMetadata: parsed.reasoningMetadata,
							outputIndex: parsed.reasoningOutputIndex,
						};
					} else if (parsed.reasoningMetadata) {
						// Metadata-only event (e.g. final encrypted_content from output_item.done
						// or Anthropic thinking block stop with signature).
						// Update the stored metadata without emitting a streaming event.
						// Mark the entry so the next reasoning delta inserts a separator.
						const itemKey = reasoningBlockKey(parsed);
						const existing = reasoningBlockMap.get(itemKey);
						if (existing) {
							existing.providerMetadata = parsed.reasoningMetadata;
							if (parsed.reasoningOutputIndex != null) {
								existing.outputIndex = parsed.reasoningOutputIndex;
							}
							// Mark for separator so the next reasoning delta from a
							// new thinking block gets a visual break from the previous one.
							if (existing.text) {
								existing._needsSeparator = true;
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

					// ── Mimo ellipsis reasoning detection ──
					// Some mimo models (via Anthropic protocol) emit "..." as the
					// entire reasoning content, which is a degenerate response.
					// When detected, discard the reasoning block and retry the request.
					if (parsed.reasoningMetadata && effectiveModel.toLowerCase().includes("mimo")) {
						const itemKey = reasoningBlockKey(parsed);
						const entry = reasoningBlockMap.get(itemKey);
						if (entry && entry.text.trim() === "...") {
							logger.warn("Mimo model returned ellipsis-only reasoning, discarding and retrying", {
								narratorId: config.narratorId,
								model: effectiveModel,
								provider: effectiveProvider,
							});
							reasoningBlockMap.delete(itemKey);
							mimoEllipsisRetry = true;
							break; // break out of for-await stream loop to trigger retry
						}
					}

					if (parsed.redactedThinking) {
						redactedThinkingBlocks.push({
							data: parsed.redactedThinking.data,
							outputIndex: parsed.redactedThinking.outputIndex,
						});
						yield {
							type: "block_complete",
							block: {
								type: "redacted_thinking",
								data: parsed.redactedThinking.data,
								outputIndex: parsed.redactedThinking.outputIndex,
							},
						};
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
						const contextWindow =
							parsed.usage.contextWindow ??
							getModelContextWindow(effectiveModel, effectiveProvider);
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
					if (parsed.imageGeneration) {
						const ig = parsed.imageGeneration;
						if (!imageGenAccum.has(ig.id)) {
							imageGenAccum.set(ig.id, { emitted: false, outputIndex: ig.outputIndex });
						}
						// biome-ignore lint/style/noNonNullAssertion: just set above
						const acc = imageGenAccum.get(ig.id)!;
						if (ig.revisedPrompt) acc.revisedPrompt = ig.revisedPrompt;
						if (ig.result) acc.result = ig.result;
						if (ig.outputIndex != null) acc.outputIndex = ig.outputIndex;
						if (ig.final && !acc.emitted) {
							acc.emitted = true;
							yield {
								type: "block_complete",
								block: {
									type: "image_generation",
									id: ig.id,
									revisedPrompt: acc.revisedPrompt,
									result: acc.result,
									outputIndex: acc.outputIndex,
								},
							};
						}
						yield {
							type: "image_generation",
							id: ig.id,
							status: ig.status,
							revisedPrompt: ig.revisedPrompt,
							result: ig.result,
							outputIndex: acc.outputIndex,
						};
					}
					if (parsed.invalidState) {
						const reason = String(parsed.invalidState.reason ?? "api_error");
						const message = String(parsed.invalidState.message ?? "Unknown provider error");
						if (isContextOverflowReason(reason) || isContextOverflowMessage(message)) {
							yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
							yield* finishRequest(message);
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
								lastRetryErrorMessage = message;
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
								yield* finishRequest(message);
								await abortableSleep(delayMs, config.signal);
								if (config.signal.aborted) {
									yield { type: "error", message: "Aborted" };
									return;
								}
								continue; // retry provider.chat()
							}
							// Exhausted retries — yield block_complete for partial content
							// then signal retryable_error to the caller.
							yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
							yield* finishRequest(message);
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
							// Non-retryable, non-truncation invalidState — treat as a
							// terminal error.  Flush any partial content and return
							// immediately so the original error surfaces to the user
							// instead of being masked by the downstream empty-response
							// check (which would retry and eventually report a misleading
							// "Provider returned an empty response" message).
							sawErrorEvent = true;
							yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
							yield* finishRequest(message);
							yield {
								type: "invalid_state",
								reason,
								message,
							};
							return;
						}
					}
				}
				yield* flushRequestStart();
			} catch (err) {
				if (config.signal.aborted) {
					// Even on abort, yield block_complete for accumulated content so it can be persisted
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest("Aborted");
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
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest(msg);
					yield { type: "context_length_exceeded", message: msg };
					return;
				}
				// Detect context overflow errors from OpenAI/Codex-compatible providers.
				// Treat as context_length_exceeded so caller can prune/compact+retry.
				if (isContextWindowExceededError(err)) {
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest(msg);
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
						lastRetryErrorMessage = msg;
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
						yield* finishRequest(msg);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					// Exhausted retries — persist partial content and signal caller
					yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
					yield* finishRequest(msg);
					yield { type: "retryable_error", message: msg };
					return;
				}
				// Non-retryable error — persist partial content and signal caller
				yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);
				yield* finishRequest(msg);
				yield { type: "error", message: msg };
				return;
			}

			// ── Mimo ellipsis retry ──
			// If a mimo model returned "..." as reasoning, discard and retry.
			if (mimoEllipsisRetry) {
				chatRetryCount++;
				const delayMs = Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1), backoffCeil);
				yield {
					type: "retrying",
					message: "Mimo model returned ellipsis-only reasoning, retrying",
					attempt: chatRetryCount,
					maxRetries: maxChatRetries,
					delayMs,
				};
				yield* finishRequest("mimo ellipsis reasoning");
				await abortableSleep(delayMs, config.signal);
				if (config.signal.aborted) {
					yield { type: "error", message: "Aborted" };
					return;
				}
				continue; // retry provider.chat()
			}

			// Empty response check — request succeeded but returned no content.
			// IMPORTANT: Skip this check if we already yielded an error/invalid_state event
			// during this attempt — otherwise the empty-response message masks the real error.
			if (!sawErrorEvent && !sawMeaningfulResponse && !assistantText && toolUses.length === 0) {
				if (!requestStarted) {
					const message =
						`${effectiveProvider}: Provider finished without starting an API request. ` +
						"This indicates the request was not assembled or dispatched; check provider setup and local request-building errors.";
					logger.warn("Provider produced no events before starting a request", {
						narratorId: config.narratorId,
						provider: effectiveProvider,
						model: effectiveModel,
						requestId,
					});
					yield { type: "error", message };
					return;
				}

				// When a previous retry recorded a real error (e.g. 429) treat
				// the empty response as a continuation of that transient failure
				// and feed it back into the *chat* retry counter (not the
				// separate empty-response counter).  This keeps infinite-retry
				// mode working and avoids surfacing the misleading "empty
				// response" message.
				if (lastRetryErrorMessage) {
					if (
						(maxChatRetries === -1 || chatRetryCount < maxChatRetries) &&
						!config.signal.aborted
					) {
						chatRetryCount++;
						const delayMs = Math.min(
							TRANSIENT_RETRY_BASE_MS * 2 ** (chatRetryCount - 1),
							backoffCeil,
						);
						logger.warn(
							"Provider returned empty response after prior error, retrying with original error",
							{
								narratorId: config.narratorId,
								provider: effectiveProvider,
								model: effectiveModel,
								requestId,
								originalError: lastRetryErrorMessage,
								attempt: chatRetryCount,
								maxRetries: maxChatRetries,
							},
						);
						yield {
							type: "retrying",
							message: lastRetryErrorMessage,
							attempt: chatRetryCount,
							maxRetries: maxChatRetries,
							delayMs,
						};
						yield* finishRequest(lastRetryErrorMessage);
						await abortableSleep(delayMs, config.signal);
						if (config.signal.aborted) {
							yield { type: "error", message: "Aborted" };
							return;
						}
						continue; // retry provider.chat()
					}
					// Chat retries exhausted — surface the original error
					yield* finishRequest(lastRetryErrorMessage);
					yield { type: "retryable_error", message: lastRetryErrorMessage };
					return;
				}

				// Genuine empty response (no prior error).  Use a dedicated
				// counter (max 3 retries) separate from transient error retries.
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
					yield* finishRequest(message);
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
				yield* finishRequest(`${effectiveProvider}: ${EMPTY_RESPONSE_MESSAGE}`);
				yield {
					type: "invalid_state",
					reason: "empty_response",
					message: `${effectiveProvider}: ${EMPTY_RESPONSE_MESSAGE}`,
				};
				return;
			}

			// Safety net: if an error was already yielded during this attempt but
			// execution somehow continued (e.g. future code changes removed a return),
			// stop here instead of proceeding with normal post-chat logic.
			if (sawErrorEvent) {
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
		yield* finishRequest();

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
			yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);

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
					permissionStartedAt: sr.permissionStartedAt,
					executionStartedAt: sr.executionStartedAt,
					completedAt: sr.completedAt,
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
					undefined,
					collectCompletedImageGenerations(imageGenAccum),
					textOutputIndex,
					redactedThinkingBlocks,
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
			yield* flushPartialContent(reasoningBlockMap, assistantText, textOutputIndex);

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
					permissionStartedAt: sr.permissionStartedAt,
					executionStartedAt: sr.executionStartedAt,
					completedAt: sr.completedAt,
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
		// strict-serial tools always form their own group.
		const groups: AgentToolUse[][] = [];
		for (const tu of toolUses) {
			const isParallel = PARALLEL_TOOLS.has(tu.name) && !isStrictSerial(tu);
			const lastGroup = groups[groups.length - 1];
			if (
				isParallel &&
				lastGroup &&
				PARALLEL_TOOLS.has(lastGroup[0].name) &&
				!isStrictSerial(lastGroup[0])
			) {
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
				let result = earlyPromise ? await earlyPromise : await executeTool(tu, config);
				if (result.yoloPause) {
					const yoloDecision = await resolveYoloPauseDecision(
						config,
						history,
						result.yoloPause,
						tu,
					);
					if (yoloDecision.behavior === "allow") {
						result = await executeTool(tu, config, { preGrantedPermission: yoloDecision });
					} else {
						result = {
							output: formatYoloDeniedForModel(yoloDecision, locale),
							isError: true,
							durationMs: 0,
							completedAt: Date.now(),
						};
					}
				}
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
					let effectiveResult = result;
					if (effectiveResult.yoloPause) {
						const yoloDecision = await resolveYoloPauseDecision(
							config,
							history,
							effectiveResult.yoloPause,
							tu,
						);
						if (yoloDecision.behavior === "allow") {
							effectiveResult = await executeTool(tu, config, {
								preGrantedPermission: yoloDecision,
							});
						} else {
							effectiveResult = {
								output: formatYoloDeniedForModel(yoloDecision, locale),
								isError: true,
								durationMs: 0,
								completedAt: Date.now(),
							};
						}
						settled[i] = effectiveResult;
					}
					if (effectiveResult.broken) brokenToolUseIds.add(tu.toolUseId);
					if (effectiveResult.updatedInput) tu.input = effectiveResult.updatedInput;
					const isLastTool = toolIndex === toolUses.length - 1 && remaining.size === 0;
					const outputForModel =
						isLastTool && shouldNudge ? effectiveResult.output + nudgeText : effectiveResult.output;

					pendingToolResults.push(
						provider.formatToolResult(
							tu.toolUseId,
							outputForModel,
							effectiveResult.isError ?? false,
							effectiveResult.images,
						),
					);

					if (!yieldedToolResults.has(tu.toolUseId)) {
						const brokenInputOverride = effectiveResult.broken
							? sanitizeBrokenInput(tu.name, tu.input, locale)
							: undefined;
						const displayOutput = effectiveResult.broken
							? getToolMessage("brokenToolCallResult", locale)
							: effectiveResult.output;

						yield {
							type: "tool_result",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							output: displayOutput,
							isError: effectiveResult.isError ?? false,
							durationMs: effectiveResult.durationMs,
							permissionStartedAt: effectiveResult.permissionStartedAt,
							executionStartedAt: effectiveResult.executionStartedAt,
							completedAt: effectiveResult.completedAt,
							brokenInputOverride,
							updatedInput: brokenInputOverride ?? effectiveResult.updatedInput,
							metadata: effectiveResult.metadata,
						};
					}
					toolIndex++;
					if (effectiveResult.durationMs > maxParallelMs)
						maxParallelMs = effectiveResult.durationMs;

					if (effectiveResult.fatal) hasFatal = true;
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
				collectCompletedImageGenerations(imageGenAccum),
				textOutputIndex,
				redactedThinkingBlocks,
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
				collectCompletedImageGenerations(imageGenAccum),
				textOutputIndex,
				redactedThinkingBlocks,
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
				collectCompletedImageGenerations(imageGenAccum),
				textOutputIndex,
				redactedThinkingBlocks,
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
