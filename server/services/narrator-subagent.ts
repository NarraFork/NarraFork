import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import { type AgentConfig, buildHistory, type ToolDefinition } from "../lib/agent";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	getSubagentType,
	hasTrait,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
} from "../lib/narrator-utils";
import { getSubagentPrompt, type Locale, type SubagentType } from "../lib/prompt-i18n";
import {
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	usesCodexApiMode,
} from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { type CustomSubagentDef, customSubagentService } from "./custom-subagent-service";
import type { EventHandlerContext, EventHooks } from "./narrator-event-handler";
import { executeAgentLoop } from "./narrator-executor";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import {
	getMaxTransientRetries,
	getRetryBackoffCeilMs,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
} from "./narrator-recovery";
import { narratorService } from "./narrator-service";
import {
	buildContextManagementHooks,
	finalizeOrCleanupPartialMessage,
	getSubagentResultMessageId,
	handlePermission,
	pruneToolCalls,
	toBufferSummary,
} from "./narrator-session";
import {
	deleteConclusionFileId,
	resolveConclusionFilePath,
	setConclusionFileId,
} from "./subagent-conclusion";

// === In-memory state ===
// Use `let` + lazy getter to avoid TDZ issues under Bun --hot reload,
// where a stale dynamic-import resolution can reference the module binding
// before the const initializer has executed.

let _backgroundTaskAbortControllers: Map<string, AbortController> | undefined;
function getBackgroundAbortControllers() {
	if (!_backgroundTaskAbortControllers) _backgroundTaskAbortControllers = new Map();
	return _backgroundTaskAbortControllers;
}

let _foregroundSubagentAbortControllers: Map<string, AbortController> | undefined;
function getForegroundAbortControllers() {
	if (!_foregroundSubagentAbortControllers) _foregroundSubagentAbortControllers = new Map();
	return _foregroundSubagentAbortControllers;
}

interface SubagentBufferedMessage {
	id: string;
	text: string;
	images?: ImageRef[];
	bufferedAt: string;
}

let _subagentBufferedMessages: Map<string, SubagentBufferedMessage[]> | undefined;
function getSubagentBufferedMessagesMap() {
	if (!_subagentBufferedMessages) _subagentBufferedMessages = new Map();
	return _subagentBufferedMessages;
}

// === Manual override state ===
// When a foreground subagent is interrupted, the parent narrator blocks until
// the user explicitly clicks "Update Conclusion" from the subagent page.
// This map is ONLY resolved by the update-conclusion API endpoint, giving
// the user full control over when to return results.

interface ManualOverrideEntry {
	resolve: (result: { finalText: string; hasError: boolean }) => void;
	parentSignal: AbortSignal;
	parentNarratorId: string;
	toolUseId: string;
	/** The subagent ID that was active when manual override started. */
	subagentId: string;
}

let _manualOverrides: Map<string, ManualOverrideEntry> | undefined;
function getManualOverrideMap() {
	if (!_manualOverrides) _manualOverrides = new Map();
	return _manualOverrides;
}

/** Maximum time to wait for manual override before timing out (2 hours). */
const MANUAL_OVERRIDE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Conclusion watchers: for subagents that have already completed (done/error)
 * and whose result was already returned to the parent narrator. When the user
 * later continues operating the subagent and clicks "Update Conclusion",
 * we register a watcher that will update the parent's tool_call outputJson
 * when the subagent next completes.
 */
interface ConclusionWatcher {
	parentNarratorId: string;
	toolUseId: string;
}

let _conclusionWatchers: Map<string, ConclusionWatcher> | undefined;
function getConclusionWatchersMap() {
	if (!_conclusionWatchers) _conclusionWatchers = new Map();
	return _conclusionWatchers;
}

// === Subagent type definitions ===

/** Tools available to explore/plan subagents (read + search + shell + conclusion file write + todos) */
const EXPLORE_PLAN_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	SHELL_TOOL_NAME,
	"Write",
	"Edit",
	"TaskCreate",
]);

/**
 * Per-subagent conclusion file ID map is managed in subagent-conclusion.ts
 * to avoid circular imports with narrator-session.ts.
 */

/** Tools available to general subagents (EXPLORE_PLAN_TOOLS + interactive tools, no nesting/plan/forking) */
const GENERAL_TOOLS = new Set([...EXPLORE_PLAN_TOOLS, "AskUserQuestion", "Skill"]);

/** Tool filter factories per built-in subagent type */
const BUILTIN_TOOL_FILTERS: Record<string, (tool: ToolDefinition) => boolean> = {
	explore: (tool) => EXPLORE_PLAN_TOOLS.has(tool.name),
	plan: (tool) => EXPLORE_PLAN_TOOLS.has(tool.name),
	general: (tool) => GENERAL_TOOLS.has(tool.name),
};

/**
 * Resolve the tool filter for a subagent type.
 * For built-in types, returns the static filter.
 * For custom types, builds a filter based on the custom definition's toolAccess.
 * Accepts an optional pre-loaded customDef to avoid redundant I/O.
 */
function resolveToolFilter(
	subagentType: string,
	customDef?: CustomSubagentDef | null,
): ((tool: ToolDefinition) => boolean) | undefined {
	const builtin = BUILTIN_TOOL_FILTERS[subagentType];
	if (builtin) return builtin;

	if (!customDef) return BUILTIN_TOOL_FILTERS.explore; // fallback: deny write access when definition is missing

	switch (customDef.toolAccess) {
		case "readOnly":
			return BUILTIN_TOOL_FILTERS.explore;
		case "general":
			return BUILTIN_TOOL_FILTERS.general;
		case "custom": {
			const allowed = new Set(customDef.customTools);
			return (tool) => allowed.has(tool.name);
		}
		default:
			return BUILTIN_TOOL_FILTERS.explore;
	}
}

// === Shared helpers ===

/**
 * Build the effective system prompt for a subagent.
 * Optionally injects contextSummary (after compact).
 * Accepts an optional pre-loaded customPrompt to avoid redundant I/O.
 */
async function buildSubagentSystemPrompt(
	subagentType: SubagentType,
	cwd: string,
	locale: Locale,
	contextSummary?: string | null,
	customPrompt?: string | null,
): Promise<string> {
	// Try built-in prompt first
	let basePrompt = getSubagentPrompt(subagentType, locale);

	// If not a built-in type, use the pre-loaded custom prompt or load it
	if (!basePrompt) {
		if (customPrompt !== undefined) {
			basePrompt = customPrompt;
		} else {
			const customDef = await customSubagentService.loadByName(subagentType);
			basePrompt = customDef?.prompt ?? null;
		}
	}

	// Fallback to a generic prompt if nothing found
	if (!basePrompt) {
		basePrompt =
			locale === "zh-CN"
				? "你是一个执行委派任务的子代理。完成任务并简洁地报告结果。"
				: "You are a subagent executing a delegated task. Complete the task and report your results concisely.";
	}

	const { prompt } = await buildEffectiveSystemPrompt({
		basePrompt,
		cwd,
		locale,
		contextSummary,
	});
	return prompt ?? basePrompt;
}

/** Build an EventHandlerContext for a subagent. */
function buildSubagentEventContext(
	subagentId: string,
	parentNarratorId: string,
	parentToolUseId: string,
	conversationId: string,
	subagentModel: string,
): EventHandlerContext {
	let contextUsagePct: number | undefined;
	let meterUsage: number | undefined;
	let meterUnit: string | undefined;
	let partialMessageId: string | undefined;
	let tokenUsage: import("./narrator-event-handler").TokenUsageSnapshot | undefined;

	return {
		narratorId: subagentId,
		broadcastTargetId: parentNarratorId,
		conversationId,
		parentToolUseId,
		subagentModel,
		getContextUsagePct: () => contextUsagePct,
		getMeterUsage: () => meterUsage,
		getMeterUnit: () => meterUnit,
		getPartialMessageId: () => partialMessageId,
		getTokenUsage: () => tokenUsage,
		setPartialMessageId: (id) => {
			partialMessageId = id;
		},
		setContextUsagePct: (pct) => {
			contextUsagePct = pct;
		},
		setMeterData: (u, un) => {
			meterUsage = u;
			meterUnit = un;
		},
		setTokenUsage: (u) => {
			tokenUsage = u;
		},
	};
}

/** Mark subagent as done/error and broadcast completion. */
async function finalizeSubagent(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	errorText: string | null,
): Promise<void> {
	// Clean up any remaining buffered messages
	getSubagentBufferedMessagesMap().delete(subagentId);

	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			status: "idle",
			substatus: JSON.stringify(hasError ? ["error"] : ["unread"]),
			errorMessage: hasError ? errorText : null,
			updatedAt: now,
		})
		.where(eq(narrators.id, subagentId));

	eventBus.emit({
		type: "narrator:subagent_completed",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
	});
}

/** Broadcast subagent_started event. */
function broadcastSubagentStarted(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	subagentType: string,
	model?: string,
): void {
	eventBus.emit({
		type: "narrator:subagent_started",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_started",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		subagentType,
		...(model && { model }),
	});
}

/**
 * Load subagent messages and build history.
 * Clears parentToolUseId so buildHistory includes subagent messages.
 */
async function loadSubagentHistory(
	narratorId: string,
	model: string,
	provider: string,
	pruneBoundaryId?: string | null,
) {
	const rawMessages = await narratorService.getMessagesSinceLastCompact(narratorId);
	const dbMessages = rawMessages.map((msg) => ({ ...msg, parentToolUseId: null }));
	if (pruneBoundaryId) {
		pruneToolCalls(dbMessages, pruneBoundaryId);
	}
	return buildHistory(dbMessages, model, provider, narratorId);
}

async function consumeNextBufferedSubagentMessage(opts: {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	model: string;
	provider: string;
	pruneBoundaryId?: string | null;
}): Promise<{
	prompt: string;
	history: unknown[];
	trailingToolResults: unknown[];
} | null> {
	const { narratorId, parentNarratorId, toolUseId, model, provider } = opts;
	let { pruneBoundaryId } = opts;
	const bufQueue = getSubagentBufferedMessagesMap().get(narratorId);
	const buffered = bufQueue?.[0];
	if (!buffered) return null;
	bufQueue?.shift();
	if (bufQueue?.length === 0) getSubagentBufferedMessagesMap().delete(narratorId);
	const userMsg = await narratorService.persistSubagentUserMessage(
		narratorId,
		buffered.text,
		toolUseId,
		buffered.images,
	);
	broadcastToNarrator(parentNarratorId, {
		type: "user_message",
		narratorId: parentNarratorId,
		message: userMsg,
	});
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: { ...userMsg, parentToolUseId: null },
	});
	const remaining = toBufferSummary(getSubagentBufferedMessagesMap().get(narratorId) ?? []);
	broadcastToNarrator(parentNarratorId, {
		type: "buffer_consumed",
		narratorId: parentNarratorId,
		messageId: buffered.id,
		remaining,
	});
	broadcastToNarrator(narratorId, {
		type: "buffer_consumed",
		narratorId,
		messageId: buffered.id,
		remaining,
	});
	if (pruneBoundaryId === undefined) {
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
	}
	const rebuilt = await loadSubagentHistory(narratorId, model, provider, pruneBoundaryId);
	return {
		prompt: buffered.text,
		history: rebuilt.history,
		trailingToolResults: rebuilt.trailingToolResults,
	};
}

// === Core subagent execution with compact/prune support ===

interface SubagentExecOptions {
	narratorId: string;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	model: string;
	provider: string;
	locale: string;
	signal: AbortSignal;
	systemPrompt: string;
	/** Initial history (empty for new subagents, pre-loaded for continued) */
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	/** Pre-loaded custom subagent definition (avoids redundant I/O) */
	customDef?: CustomSubagentDef | null;
}

/**
 * Execute a subagent with optional compact/prune support.
 *
 * For general subagents: wraps executeAgentLoop in a while-loop that
 * restarts after compact, with prune boundary tracking and onBeforeTurn.
 *
 * For explore/plan subagents: single-pass execution (no compact/prune).
 */
async function executeSubagent(opts: SubagentExecOptions): Promise<{
	finalText: string;
	hasError: boolean;
	contextLengthExceeded?: boolean;
}> {
	let {
		narratorId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
	} = opts;

	let {
		systemPrompt,
		initialHistory: history,
		initialTrailingToolResults: trailingToolResults,
	} = opts;

	// Mutable state for compact/prune
	let pruneBoundaryId: string | null = null;
	let needsRestart = false;
	let currentConversationId = randomUUID();
	let contextLengthExceeded = false;
	let overflowRetries = 0;

	// Transient error retry state
	let transientRetries = 0;

	// Conclusion file for explore/plan subagents — Write/Edit are restricted to this file.
	// The file content is read after the loop finishes and used as finalText.
	const isReadOnlySubagent = subagentType === "explore" || subagentType === "plan";
	const conclusionFileId = isReadOnlySubagent ? generateWordSlug() : undefined;
	if (conclusionFileId) {
		setConclusionFileId(narratorId, conclusionFileId);
	}

	// Build context management hooks (prune + compact) for all subagent types
	const ctxMgmt = buildContextManagementHooks({
		narratorId,
		locale: locale as Locale,
		getModel: () => model,
		getProvider: () => provider,
		isSubagent: true,
		getPruneBoundary: () => pruneBoundaryId,
		setPruneBoundary: (id) => {
			pruneBoundaryId = id;
		},
		onCompactDone: () => {
			needsRestart = true;
			currentConversationId = randomUUID();
		},
	});

	let finalText = "";
	let hasError = false;
	const initialNarrator = await narratorService.getById(narratorId);
	let narratorReasoningEffort = initialNarrator.reasoningEffort ?? undefined;
	let narratorFastMode = initialNarrator.fastMode ?? false;

	// Resolve tool filter for this subagent type using pre-loaded customDef
	const toolFilter = resolveToolFilter(subagentType, opts.customDef);

	while (true) {
		const eventContext = buildSubagentEventContext(
			narratorId,
			parentNarratorId,
			toolUseId,
			currentConversationId,
			model,
		);

		const hooks: EventHooks = {
			onContextUsage: ctxMgmt.onContextUsage,
			onTodoWrite: async (todos, todoToolUseId) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				await narratorService.updateTodos(narratorId, todos as any[], todoToolUseId);
				// Broadcast to subagent's own subscribers
				broadcastToNarrator(narratorId, {
					type: "todos_updated",
					narratorId,
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					todos: todos as any[],
					toolUseId: todoToolUseId,
				});
				// Also notify parent narrator so SubagentCard can update
				broadcastToNarrator(parentNarratorId, {
					type: "subagent_todos_updated",
					narratorId: parentNarratorId,
					subagentNarratorId: narratorId,
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					todos: todos as any[],
					toolUseId: todoToolUseId,
				});
			},
		};

		const resolvedProvider = resolveProvider(model);
		const resolvedServiceTier =
			narratorFastMode && usesCodexApiMode(resolvedProvider) ? "priority" : undefined;
		const config: AgentConfig = {
			narratorId,
			conversationId: currentConversationId,
			model,
			provider: resolvedProvider,
			cwd,
			systemPrompt,
			locale,
			signal,
			reasoningEffort: narratorReasoningEffort ?? resolveDefaultReasoningEffort(resolvedProvider),
			serviceTier: resolvedServiceTier,
			maxTransientRetries: getMaxTransientRetries(),
			retryBackoffCeilMs: getRetryBackoffCeilMs(),
			metadata: isAnthropicProvider(resolvedProvider)
				? { user_id: `user_${narratorId}_account__session_${currentConversationId}` }
				: undefined,
			toolFilter,
			permissionHandler: (toolName, permInput, permToolUseId) =>
				handlePermission(
					narratorId,
					signal,
					toolName,
					permInput,
					permToolUseId,
					cwd,
					locale as Locale,
					parentNarratorId,
				),
			onBeforeTurn: ctxMgmt.onBeforeTurn,
			getInjectedUserText: () => {
				const queue = getSubagentBufferedMessagesMap().get(narratorId);
				const buf = queue?.[0];
				if (!buf) return null;
				queue?.shift();
				if (queue?.length === 0) getSubagentBufferedMessagesMap().delete(narratorId);
				// Persist user message in the background (fire-and-forget).
				// The text is injected into the next turn immediately.
				narratorService
					.persistSubagentUserMessage(narratorId, buf.text, toolUseId, buf.images)
					.then((userMsg) => {
						broadcastToNarrator(parentNarratorId, {
							type: "user_message",
							narratorId: parentNarratorId,
							message: userMsg,
						});
						broadcastToNarrator(narratorId, {
							type: "user_message",
							narratorId,
							message: { ...userMsg, parentToolUseId: null },
						});
					})
					.catch((err) => {
						logger.error("Failed to persist injected subagent user message", {
							narratorId,
							error: String(err),
						});
					});
				const remaining = toBufferSummary(getSubagentBufferedMessagesMap().get(narratorId) ?? []);
				broadcastToNarrator(parentNarratorId, {
					type: "buffer_consumed",
					narratorId: parentNarratorId,
					messageId: buf.id,
					remaining,
				});
				broadcastToNarrator(narratorId, {
					type: "buffer_consumed",
					narratorId,
					messageId: buf.id,
					remaining,
				});
				return buf.text;
			},
		};

		needsRestart = false;

		const result = await executeAgentLoop({
			config,
			userText: prompt,
			history,
			trailingToolResults,
			eventContext,
			hooks,
		});

		finalText = result.contextLengthExceeded ? "Error: context length exceeded" : result.finalText;
		hasError = result.hasError;
		if (result.retryableError && !result.hasError) {
			// Don't mark as error yet — try transient retry below
		}

		// --- Context length exceeded: aggressive prune (Codex) then compact/retry ---
		if (result.contextLengthExceeded) {
			if (signal.aborted) {
				hasError = true;
				contextLengthExceeded = true;
				finalText = "Error: context length exceeded";
				break;
			}

			// Finalize or clean up partial message from the failed turn before retry.
			// If tools were already executed, the message is kept so the retry
			// includes them in history.
			const partialId = eventContext.getPartialMessageId();
			if (partialId) {
				await finalizeOrCleanupPartialMessage(partialId, narratorId);
				eventContext.setPartialMessageId(undefined);
			}

			const overflow = await handleContextOverflow({
				narratorId,
				locale: locale as Locale,
				provider: resolvedProvider,
				model,
				overflowRetries,
				maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
			});
			overflowRetries = overflow.overflowRetries;

			if (overflow.action === "retry_pruned") {
				pruneBoundaryId = overflow.boundaryMessageId;
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;
				transientRetries = 0;
				continue;
			}
			if (overflow.action === "retry_compacted") {
				needsRestart = true;
				currentConversationId = overflow.newConversationId;
				transientRetries = 0;
				// Continue to the restart-after-compact flow below
			} else {
				hasError = true;
				contextLengthExceeded = true;
				finalText = "Error: context length exceeded and compact failed";
				break;
			}
		}

		// --- Transient API error: retry with exponential backoff ---
		if (result.retryableError && !signal.aborted) {
			transientRetries++;
			const { shouldRetry } = await handleTransientError({
				narratorId,
				error: result.retryableError,
				retryCount: transientRetries,
				maxRetries: getMaxTransientRetries(),
				signal,
			});
			if (shouldRetry) {
				// Finalize or clean up partial message from the failed turn.
				// If tools were already executed, the message is kept so the
				// rebuilt history includes them.
				const partialId = eventContext.getPartialMessageId();
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
					eventContext.setPartialMessageId(undefined);
				}
				// Rebuild history from DB so the retry includes any tool calls
				// that were persisted before the API error occurred. Without this,
				// the retry would use stale history and the model would repeat
				// the same tool calls it already executed.
				const rebuilt = await loadSubagentHistory(
					narratorId,
					model,
					resolvedProvider,
					pruneBoundaryId,
				);
				history = rebuilt.history;
				trailingToolResults = rebuilt.trailingToolResults;
				currentConversationId = randomUUID();
				continue;
			}
			// If aborted during backoff sleep, don't mark as error — the
			// caller will handle the abort status.
			if (signal.aborted) {
				break;
			}
			hasError = true;
			finalText = `Error: ${result.retryableError}`;
			break;
		}

		// Reset transient retry counter on success
		transientRetries = 0;

		if (result.silentDisconnect) {
			const partialId = eventContext.getPartialMessageId();
			eventContext.setPartialMessageId(undefined);
			if (partialId) {
				await finalizeOrCleanupPartialMessage(partialId, narratorId);
			}
		}

		// --- Check for buffered user message (sent from subagent page) ---
		if (!signal.aborted && !hasError) {
			const consumedBuffered = await consumeNextBufferedSubagentMessage({
				narratorId,
				parentNarratorId,
				toolUseId,
				model,
				provider: resolveProvider(model),
				pruneBoundaryId,
			});
			if (consumedBuffered) {
				prompt = consumedBuffered.prompt;
				history = consumedBuffered.history;
				trailingToolResults = consumedBuffered.trailingToolResults;
				currentConversationId = randomUUID();
				continue;
			}
		}

		if (!needsRestart || signal.aborted || hasError) break;

		// Compact completed mid-turn — restart with fresh history
		logger.info("Subagent restarting after compact", { narratorId, parentNarratorId });

		// Reload fresh state — compact clears prune boundary
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
		narratorReasoningEffort = freshNarrator.reasoningEffort ?? undefined;
		narratorFastMode = freshNarrator.fastMode ?? false;

		// Rebuild system prompt with new contextSummary
		systemPrompt = await buildSubagentSystemPrompt(
			subagentType,
			cwd,
			locale as Locale,
			freshNarrator.contextSummary,
		);

		// Reload history from post-compact messages (no prune after compact)
		const rebuilt = await loadSubagentHistory(narratorId, model, resolvedProvider, null);
		history = rebuilt.history;
		trailingToolResults = rebuilt.trailingToolResults;
	}

	// Read conclusion file for explore/plan subagents.
	// If the subagent wrote to the designated conclusion file, use its content as finalText.
	if (conclusionFileId) {
		deleteConclusionFileId(narratorId);
		const conclusionPath = resolveConclusionFilePath(cwd, conclusionFileId);
		try {
			if (existsSync(conclusionPath)) {
				const content = readFileSync(conclusionPath, "utf-8").trim();
				if (content && !hasError) {
					finalText = content;
				}
				// Clean up the temporary conclusion file
				rmSync(conclusionPath, { force: true });
			}
		} catch {
			// Ignore read/cleanup errors
		}
	}

	return { finalText, hasError, contextLengthExceeded };
}

// === Background task management ===

/**
 * Push a user message onto the subagent buffer queue.
 * Returns false if the subagent is not currently running or the queue is full.
 */
export function pushSubagentBufferedMessage(
	subagentId: string,
	text: string,
	images?: ImageRef[],
	position: "front" | "back" = "back",
): { ok: boolean; bufferedAt: string; id: string; full?: boolean } {
	if (!getForegroundAbortControllers().has(subagentId)) {
		return { ok: false, bufferedAt: "", id: "" };
	}
	const queue = getSubagentBufferedMessagesMap().get(subagentId) ?? [];
	if (queue.length >= 50) {
		return { ok: false, bufferedAt: "", id: "", full: true };
	}
	const id = generateShortId();
	const bufferedAt = new Date().toISOString();
	const entry = { id, text, images, bufferedAt };
	if (position === "front") {
		queue.unshift(entry);
	} else {
		queue.push(entry);
	}
	getSubagentBufferedMessagesMap().set(subagentId, queue);
	return { ok: true, bufferedAt, id };
}

/** Clear the entire subagent buffer queue. */
export function clearSubagentBufferedMessages(subagentId: string): void {
	getSubagentBufferedMessagesMap().delete(subagentId);
}

/** Get the full subagent buffer queue (for REST hydration). */
export function getSubagentBufferedMessages(subagentId: string): SubagentBufferedMessage[] {
	return getSubagentBufferedMessagesMap().get(subagentId) ?? [];
}

/**
 * Interrupt a running foreground subagent.
 * Returns true if the subagent was found and aborted.
 */
export function interruptForegroundSubagent(subagentId: string): boolean {
	const ctrl = getForegroundAbortControllers().get(subagentId);
	if (!ctrl) return false;
	ctrl.abort("Interrupted by user");
	return true;
}

// === Conclusion watcher public API ===

/** Register a watcher for an already-completed subagent's next conclusion. */
export function registerConclusionWatcher(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
): void {
	getConclusionWatchersMap().set(subagentId, { parentNarratorId, toolUseId });
}

/** Remove a conclusion watcher. */
export function removeConclusionWatcher(subagentId: string): boolean {
	return getConclusionWatchersMap().delete(subagentId);
}

/** Get the conclusion watcher for a subagent (if any). */
export function getConclusionWatcher(subagentId: string): ConclusionWatcher | undefined {
	return getConclusionWatchersMap().get(subagentId);
}

// === Manual override public API ===

/** Check if a subagent is in manual override (parent blocked, waiting for update-conclusion). */
export function isManualOverride(subagentId: string): boolean {
	return getManualOverrideMap().has(subagentId);
}

/**
 * Resolve a manual-override subagent's blocked Promise.
 * Called from the update-conclusion API when the user clicks "Update Conclusion".
 */
export function resolveManualOverride(
	subagentId: string,
	finalText: string,
	hasError: boolean,
): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return false;
	getManualOverrideMap().delete(subagentId);
	entry.resolve({ finalText, hasError });
	return true;
}

/** Abandon a manual-override subagent (e.g. parent interrupted). */
export function abandonManualOverride(subagentId: string): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return false;
	getManualOverrideMap().delete(subagentId);
	entry.resolve({ finalText: "Manual override abandoned", hasError: true });
	return true;
}

/** Maximum background task execution time (30 minutes). */
const BACKGROUND_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Block until the user clicks "Update Conclusion" (or parent is interrupted / timeout).
 * Used by both runSubagent and continueSubagent when the subagent is interrupted.
 */
function waitForManualOverride(
	subagentId: string,
	parentSignal: AbortSignal,
	parentNarratorId: string,
	toolUseId: string,
): Promise<{ finalText: string; hasError: boolean }> {
	return new Promise<{ finalText: string; hasError: boolean }>((resolve) => {
		// Shared cleanup: clear timeout and remove the abort listener to avoid leaks.
		const cleanup = () => {
			clearTimeout(timeoutId);
			parentSignal.removeEventListener("abort", onParentAbort);
		};

		const timeoutId = setTimeout(() => {
			const entry = getManualOverrideMap().get(subagentId);
			if (entry) {
				getManualOverrideMap().delete(subagentId);
				cleanup();
				resolve({
					finalText: "Manual override timed out after 2 hours",
					hasError: true,
				});
			}
		}, MANUAL_OVERRIDE_TIMEOUT_MS);

		getManualOverrideMap().set(subagentId, {
			resolve: (result) => {
				cleanup();
				resolve(result);
			},
			parentSignal,
			parentNarratorId,
			toolUseId,
			subagentId,
		});

		// If parent narrator is interrupted, abandon the manual override
		const onParentAbort = () => {
			const entry = getManualOverrideMap().get(subagentId);
			if (entry) {
				getManualOverrideMap().delete(subagentId);
				cleanup();
				resolve({
					finalText: "Parent narrator interrupted",
					hasError: true,
				});
			}
		};
		if (parentSignal.aborted) {
			onParentAbort();
		} else {
			parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}
	});
}

/**
 * Execute a background task (fire-and-forget).
 * Updates narrator status and broadcasts events on completion/failure.
 */
async function executeBackgroundTask(opts: SubagentExecOptions): Promise<void> {
	const { narratorId, parentNarratorId, toolUseId } = opts;

	// Set a maximum execution timeout
	const timeoutId = setTimeout(() => {
		const ctrl = getBackgroundAbortControllers().get(narratorId);
		if (ctrl) ctrl.abort("Background task timeout");
	}, BACKGROUND_TASK_TIMEOUT_MS);

	try {
		const result = await executeSubagent(opts);

		const finalText = result.contextLengthExceeded
			? "Error: context length exceeded"
			: result.finalText;
		const hasError = result.hasError || !!result.contextLengthExceeded;

		// Finalize the subagent narrator status
		await finalizeSubagent(
			narratorId,
			parentNarratorId,
			toolUseId,
			hasError,
			hasError ? finalText : null,
		);

		// Update background-specific fields
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				backgroundStatus: hasError ? "failed" : "completed",
				backgroundResult: finalText || "(no output)",
				backgroundCompletedAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));

		if (hasError) {
			eventBus.emit({
				type: "narrator:background_task_failed",
				narratorId: parentNarratorId,
				parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				error: finalText,
			});
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_failed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				error: finalText,
			});
		} else {
			eventBus.emit({
				type: "narrator:background_task_completed",
				narratorId: parentNarratorId,
				parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				resultPreview: (finalText || "").slice(0, 500),
			});
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_completed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				resultPreview: (finalText || "").slice(0, 500),
			});
		}
	} catch (err) {
		const errorText = err instanceof Error ? err.message : String(err);
		logger.error("Background task execution failed", { narratorId, error: errorText });

		await finalizeSubagent(narratorId, parentNarratorId, toolUseId, true, errorText);

		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				backgroundStatus: "failed",
				backgroundResult: errorText,
				backgroundCompletedAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));

		eventBus.emit({
			type: "narrator:background_task_failed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: errorText,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_failed",
			narratorId: parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: errorText,
		});
	} finally {
		clearTimeout(timeoutId);
		getBackgroundAbortControllers().delete(narratorId);
	}
}

/**
 * Cancel a running background task.
 * Returns true if the task was found and cancelled.
 */
export async function cancelBackgroundTask(taskNarratorId: string): Promise<boolean> {
	const ctrl = getBackgroundAbortControllers().get(taskNarratorId);
	if (!ctrl) return false;

	ctrl.abort("Cancelled by user");

	const narrator = await narratorService.getById(taskNarratorId);
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			backgroundStatus: "cancelled",
			backgroundCompletedAt: now,
			status: "idle",
			substatus: JSON.stringify(["interrupted"]),
			updatedAt: now,
		})
		.where(eq(narrators.id, taskNarratorId));

	const parentNarratorId = narrator.parentNarratorId;
	if (parentNarratorId) {
		eventBus.emit({
			type: "narrator:background_task_cancelled",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_cancelled",
			narratorId: parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
	}

	getBackgroundAbortControllers().delete(taskNarratorId);
	return true;
}

/**
 * Get the status of a background task.
 */
export async function getBackgroundTaskStatus(taskNarratorId: string): Promise<{
	status: string;
	result: string | null;
	completedAt: string | null;
	isRunning: boolean;
} | null> {
	const narrator = await narratorService.getById(taskNarratorId);
	if (!hasTrait(parseTraits(narrator.traits), "background")) return null;

	return {
		status: narrator.backgroundStatus ?? "unknown",
		result: narrator.backgroundResult ?? null,
		completedAt: narrator.backgroundCompletedAt ?? null,
		isRunning: getBackgroundAbortControllers().has(taskNarratorId),
	};
}

/**
 * Wait for a background task to complete (with timeout).
 * Returns the task status when done or when timeout expires.
 */
export function waitForBackgroundTask(
	taskNarratorId: string,
	timeoutMs = 30000,
): Promise<{ status: string; result: string | null }> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve({ status: "running", result: null });
		}, timeoutMs);

		const WATCHED_EVENTS = new Set([
			"narrator:background_task_completed",
			"narrator:background_task_failed",
			"narrator:background_task_cancelled",
		]);

		const handler = (event: import("../lib/event-bus").NarraForkEvent) => {
			if (!WATCHED_EVENTS.has(event.type)) return;
			if (!("taskNarratorId" in event) || event.taskNarratorId !== taskNarratorId) return;
			cleanup();
			getBackgroundTaskStatus(taskNarratorId).then((s) => {
				resolve({ status: s?.status ?? "unknown", result: s?.result ?? null });
			});
		};

		const cleanup = () => {
			clearTimeout(timeout);
			eventBus.offAny(handler);
		};

		// Check if already completed
		getBackgroundTaskStatus(taskNarratorId).then((s) => {
			if (s && s.status !== "running") {
				cleanup();
				resolve({ status: s.status, result: s.result });
				return;
			}
			eventBus.onAny(handler);
		});
	});
}

// === Foreground subagent execution loop ===

interface ForegroundLoopInput {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	model: string;
	provider: string;
	locale: string;
	signal: AbortSignal;
	systemPrompt: string;
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	customDef: Awaited<ReturnType<typeof customSubagentService.loadByName>> | null;
}

/**
 * Shared foreground execution loop for both runSubagent and continueSubagent.
 * Handles the while-loop, buffered message consumption, and manual override.
 * Returns the subagent_id-prefixed result string.
 */
async function runForegroundLoop(input: ForegroundLoopInput): Promise<string> {
	const {
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt,
		customDef,
	} = input;

	let finalText = "";
	let hasError = false;
	let currentPrompt = input.prompt;
	let currentHistory: unknown[] = input.initialHistory;
	let currentTrailingToolResults: unknown[] | undefined = input.initialTrailingToolResults;

	try {
		while (true) {
			const fgAbort = new AbortController();
			getForegroundAbortControllers().set(subagentId, fgAbort);
			const combinedSignal = AbortSignal.any([signal, fgAbort.signal]);
			const result = await executeSubagent({
				narratorId: subagentId,
				parentNarratorId,
				toolUseId,
				subagentType,
				prompt: currentPrompt,
				cwd,
				model,
				provider,
				locale,
				signal: combinedSignal,
				systemPrompt,
				initialHistory: currentHistory,
				initialTrailingToolResults: currentTrailingToolResults,
				customDef,
			});
			finalText = result.contextLengthExceeded
				? "Error: context length exceeded"
				: result.finalText;
			hasError = result.hasError || !!result.contextLengthExceeded;
			getForegroundAbortControllers().delete(subagentId);
			const continueAfterInterrupt =
				!hasError &&
				fgAbort.signal.aborted &&
				!signal.aborted &&
				(await consumeNextBufferedSubagentMessage({
					narratorId: subagentId,
					parentNarratorId,
					toolUseId,
					model,
					provider: resolveProvider(model),
				}));
			if (continueAfterInterrupt) {
				currentPrompt = continueAfterInterrupt.prompt;
				currentHistory = continueAfterInterrupt.history;
				currentTrailingToolResults = continueAfterInterrupt.trailingToolResults;
				finalText = "";
				continue;
			}
			// Detect subagent-only interrupt (not parent abort)
			if (!hasError && fgAbort.signal.aborted && !signal.aborted) {
				// --- Manual override: block until user clicks "Update Conclusion" ---
				await narratorService.updateStatus(subagentId, "idle", {
					substatus: ["manual_override"],
				});
				broadcastToNarrator(parentNarratorId, {
					type: "subagent_suspended",
					narratorId: parentNarratorId,
					subagentNarratorId: subagentId,
					toolUseId,
				});
				broadcastToNarrator(subagentId, {
					type: "status_change",
					narratorId: subagentId,
					status: "idle",
					substatus: ["manual_override"],
				});

				const overrideResult = await waitForManualOverride(
					subagentId,
					signal,
					parentNarratorId,
					toolUseId,
				);

				finalText = overrideResult.finalText;
				hasError = overrideResult.hasError;
			}
			break;
		}
	} finally {
		getManualOverrideMap().delete(subagentId);
		getForegroundAbortControllers().delete(subagentId);
		await finalizeSubagent(
			subagentId,
			parentNarratorId,
			toolUseId,
			hasError,
			hasError ? finalText : null,
		);

		// Bind the result to the subagent's last assistant message
		try {
			const resultMsgId = await getSubagentResultMessageId(subagentId);
			if (resultMsgId) {
				await db
					.update(narratorToolCalls)
					.set({ resultMessageId: resultMsgId })
					.where(eq(narratorToolCalls.toolUseId, toolUseId));
			}
		} catch {
			// Non-critical — don't fail the whole flow
		}
	}

	const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
	return resultPrefix + (finalText || "(no output)");
}

// === Subagent runner ===

export interface RunSubagentInput {
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	title?: string;
	signal: AbortSignal;
	locale: string;
	model?: string;
	background?: boolean;
}

/**
 * Run a subagent synchronously (from the parent narrator's perspective),
 * or in background mode (fire-and-forget, returns immediately with a task ID).
 *
 * Creates a subagent narrator, runs the agent loop, persists all messages,
 * and returns the final text result.
 */
export async function runSubagent(input: RunSubagentInput): Promise<string> {
	const {
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		title,
		signal,
		locale,
		model: explicitModel,
		background,
	} = input;

	// Load custom subagent definition once for non-builtin types
	const isBuiltin =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltin ? null : await customSubagentService.loadByName(subagentType);

	const systemPrompt = await buildSubagentSystemPrompt(
		subagentType,
		cwd,
		locale as Locale,
		undefined,
		customDef?.prompt,
	);

	// Resolve model: explicit param > per-type setting / custom default > parent model > global default
	let subagentPref: string | undefined;
	if (subagentType === "explore" || subagentType === "plan") {
		subagentPref = settings.agent.subagentModels?.[subagentType] || undefined;
	} else if (customDef) {
		subagentPref = customDef.defaultModel || undefined;
	}

	// Apply per-type subagent allowed-model pool restriction.
	// When the pool is non-empty, only models in the pool may be used.
	// Walk the priority chain and pick the first allowed candidate.
	// Note: "review" and custom subagent types fall back to the "general" pool
	// since they don't have dedicated pool configurations.
	const poolKey =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general"
			? subagentType
			: "general";
	const allowedPool = settings.agent.subagentAllowedModels?.[poolKey] ?? [];
	let resolvedModelInput: string | undefined;
	if (allowedPool.length > 0) {
		// Resolve sentinel values in the pool (e.g. "__default__" or bare "default")
		// to the actual default model so they can match real candidate model IDs.
		const poolSet = new Set(
			allowedPool.map((m) => resolveEffectiveModel(m === "default" ? null : m)),
		);
		const parent = await narratorService.getById(parentNarratorId);
		// Resolve __default__ sentinel to the actual default model so it can match the pool.
		const parentModel = parent.model ? resolveEffectiveModel(parent.model) : undefined;
		const candidates = [
			explicitModel,
			subagentPref,
			parentModel,
			settings.agent.defaultModel,
		].filter((m): m is string => !!m);
		resolvedModelInput = candidates.find((m) => poolSet.has(m));
		if (!resolvedModelInput) {
			throw new ValidationError(
				`No candidate model is in the allowed pool for "${poolKey}" subagents. ` +
					`Allowed models: ${[...poolSet].join(", ")}. ` +
					`Please specify one of these models explicitly.`,
			);
		}
	} else {
		resolvedModelInput = explicitModel || subagentPref || undefined;
	}

	// 1. Create subagent narrator
	const subagent = await narratorService.createSubagent({
		parentNarratorId,
		subagentType,
		title,
		cwd,
		systemPrompt,
		model: resolvedModelInput,
	});

	const subagentId = subagent.id;
	const model = subagent.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);

	// 2. Persist subagent's user message (linked to parent's tool_use)
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

	// Broadcast subagent_started after persist so the frontend only sees it
	// when the subagent record is fully consistent (narrator + user message).
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	if (background) {
		// --- Background mode: fire-and-forget ---

		// Mark narrator and tool_call as background
		const now = new Date().toISOString();
		const subNarrator = await narratorService.getById(subagentId);
		const updatedTraits = [...new Set([...parseTraits(subNarrator.traits), "background"])];
		await db
			.update(narrators)
			.set({
				isBackground: true,
				backgroundStatus: "running",
				traits: updatedTraits,
				updatedAt: now,
			})
			.where(eq(narrators.id, subagentId));
		eventBus.emit({
			type: "narrator:background_task_started",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: subagentId,
			toolUseId,
			subagentType,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_started",
			narratorId: parentNarratorId,
			taskNarratorId: subagentId,
			toolUseId,
			subagentType,
		});

		// Create an independent AbortController for the background task
		// (parent's signal should not cancel background tasks)
		const bgAbort = new AbortController();

		// Store the abort controller for later cancellation
		getBackgroundAbortControllers().set(subagentId, bgAbort);

		// Fire-and-forget execution
		executeBackgroundTask({
			narratorId: subagentId,
			parentNarratorId,
			toolUseId,
			subagentType,
			prompt,
			cwd,
			model,
			provider,
			locale,
			signal: bgAbort.signal,
			systemPrompt,
			initialHistory: [],
			customDef,
		}).catch((err) => {
			logger.error("Background task unexpected error", {
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		const resultPrefix = `<background_task_id>${subagentId}</background_task_id>\n\n`;
		return (
			resultPrefix +
			"Background task started. Use TaskOutput with this ID to check status or get results."
		);
	}

	// --- Foreground mode ---

	return runForegroundLoop({
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt,
		initialHistory: [],
		customDef,
	});
}

// === Continue subagent ===

export interface ContinueSubagentInput {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	prompt: string;
	signal: AbortSignal;
	locale: string;
}

/**
 * Continue a previously completed/errored subagent in-place.
 *
 * Instead of forking, we directly resume the original subagent narrator:
 * persist a new user message (with the ContinueTask's toolUseId as
 * parentToolUseId), reload the full history, and run the agent loop.
 * The subagent keeps its single narrator record and accumulates a
 * continuous conversation visible on the subagent page.
 */
export async function continueSubagent(input: ContinueSubagentInput): Promise<string> {
	const { subagentId, parentNarratorId, toolUseId, prompt, signal, locale } = input;

	// 1. Validate original subagent
	const original = await narratorService.getById(subagentId);
	if (!isSubagentVariant(original.variant)) {
		throw new ValidationError("Target narrator is not a subagent");
	}
	if (original.parentNarratorId !== parentNarratorId) {
		throw new ValidationError("Subagent does not belong to the calling narrator");
	}
	const origSubstatus = parseSubstatus(original.substatus);
	if (
		!(
			original.status === "idle" &&
			(origSubstatus.includes("unread") || origSubstatus.includes("error"))
		)
	) {
		throw new ValidationError(`Cannot continue subagent in status "${original.status}"`);
	}

	const subagentType = getSubagentType(original.variant) ?? original.subagentType ?? "general";
	const model = original.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);
	const cwd = original.cwd ?? ".";

	// Load custom subagent definition once for non-builtin types
	const isBuiltinContinue =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltinContinue ? null : await customSubagentService.loadByName(subagentType);

	// 2. Mark subagent as working (in-place, no fork)
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ status: "working", substatus: "[]", errorMessage: null, updatedAt: now })
		.where(eq(narrators.id, subagentId));

	// 3. Broadcast subagent_started (same subagentId)
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	// 4. Persist new user message with ContinueTask's toolUseId
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

	// 5. Load full subagent history (all previous rounds included)
	const { history, trailingToolResults } = await loadSubagentHistory(subagentId, model, provider);

	// 6. Run via shared foreground loop (same subagentId)
	return runForegroundLoop({
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt: original.systemPrompt ?? "",
		initialHistory: history,
		initialTrailingToolResults: trailingToolResults,
		customDef,
	});
}
