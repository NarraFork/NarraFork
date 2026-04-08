import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { type AgentConfig, buildHistory, type ToolDefinition } from "../lib/agent";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateShortId } from "../lib/id";
import { generateWordSlug } from "../lib/words";
import { logger } from "../lib/logger";
import { getSubagentPrompt, type Locale, type SubagentType } from "../lib/prompt-i18n";
import {
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveProvider,
	settings,
	usesCodexApiMode,
} from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { type CustomSubagentDef, customSubagentService } from "./custom-subagent-service";
import type { EventHandlerContext, EventHooks } from "./narrator-event-handler";
import { executeAgentLoop } from "./narrator-executor";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import {
	getMaxTransientRetries,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
} from "./narrator-recovery";
import { narratorService } from "./narrator-service";
import {
	buildContextManagementHooks,
	finalizeOrCleanupPartialMessage,
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

// === Subagent type definitions ===

/** Tools available to explore/plan subagents (read-only + Shell/Bash + Write/Edit for conclusion file) */
const READONLY_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	SHELL_TOOL_NAME,
	"Write",
	"Edit",
]);

/**
 * Per-subagent conclusion file ID map is managed in subagent-conclusion.ts
 * to avoid circular imports with narrator-session.ts.
 */

/** Tools excluded from general subagents (no nesting, no plan mode, no forking) */
const GENERAL_EXCLUDED = new Set([
	"Agent",
	"ContinueTask",
	"TaskOutput",
	"TaskStop",
	"EnterPlanMode",
	"ExitPlanMode",
	"TaskCreate",
	"ForkNarrator",
]);

/** Tool filter factories per built-in subagent type */
const BUILTIN_TOOL_FILTERS: Record<string, (tool: ToolDefinition) => boolean> = {
	explore: (tool) => READONLY_TOOLS.has(tool.name),
	plan: (tool) => READONLY_TOOLS.has(tool.name),
	general: (tool) => !GENERAL_EXCLUDED.has(tool.name),
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
			status: hasError ? "error" : "done",
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

		const hooks: EventHooks = { onContextUsage: ctxMgmt.onContextUsage };

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

		// --- Check for buffered user message (sent from subagent page) ---
		const bufQueue = getSubagentBufferedMessagesMap().get(narratorId);
		const buffered = bufQueue?.[0];
		if (buffered && !signal.aborted && !hasError) {
			bufQueue?.shift();
			if (bufQueue?.length === 0) getSubagentBufferedMessagesMap().delete(narratorId);
			// Persist and broadcast the user message
			const userMsg = await narratorService.persistSubagentUserMessage(
				narratorId,
				buffered.text,
				toolUseId,
				buffered.images,
			);
			// Broadcast to parent (as child message) and to subagent's own page
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
			// Reload history with the new user message and continue the loop
			prompt = buffered.text;
			const rebuilt = await loadSubagentHistory(
				narratorId,
				model,
				resolveProvider(model),
				pruneBoundaryId,
			);
			history = rebuilt.history;
			trailingToolResults = rebuilt.trailingToolResults;
			currentConversationId = randomUUID();
			continue;
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
 * Returns false if the subagent is not currently running.
 */
export function pushSubagentBufferedMessage(
	subagentId: string,
	text: string,
	images?: ImageRef[],
): { ok: boolean; bufferedAt: string; id: string } {
	if (!getForegroundAbortControllers().has(subagentId)) {
		return { ok: false, bufferedAt: "", id: "" };
	}
	const id = generateShortId();
	const bufferedAt = new Date().toISOString();
	const queue = getSubagentBufferedMessagesMap().get(subagentId) ?? [];
	queue.push({ id, text, images, bufferedAt });
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

/** Maximum background task execution time (30 minutes). */
const BACKGROUND_TASK_TIMEOUT_MS = 30 * 60 * 1000;

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
			status: "interrupted",
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
	if (!narrator.isBackground) return null;

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
		const poolSet = new Set(allowedPool);
		const parent = await narratorService.getById(parentNarratorId);
		const candidates = [
			explicitModel,
			subagentPref,
			parent.model ?? undefined,
			settings.agent.defaultModel,
		].filter((m): m is string => !!m);
		resolvedModelInput = candidates.find((m) => poolSet.has(m));
		if (!resolvedModelInput) {
			throw new ValidationError(
				`No candidate model is in the allowed pool for "${poolKey}" subagents. ` +
					`Allowed models: ${allowedPool.join(", ")}. ` +
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
		await db
			.update(narrators)
			.set({ isBackground: true, backgroundStatus: "running", updatedAt: now })
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

	// --- Foreground mode (existing behavior) ---

	// Create an independent AbortController so the subagent can be interrupted
	// from its own page without aborting the parent narrator.
	const fgAbort = new AbortController();
	getForegroundAbortControllers().set(subagentId, fgAbort);
	const combinedSignal = AbortSignal.any([signal, fgAbort.signal]);

	// 4. Run via unified executor (with compact/prune for general)
	let finalText = "";
	let hasError = false;

	try {
		const result = await executeSubagent({
			narratorId: subagentId,
			parentNarratorId,
			toolUseId,
			subagentType,
			prompt,
			cwd,
			model,
			provider,
			locale,
			signal: combinedSignal,
			systemPrompt,
			initialHistory: [],
			customDef,
		});
		finalText = result.contextLengthExceeded ? "Error: context length exceeded" : result.finalText;
		hasError = result.hasError || !!result.contextLengthExceeded;
		// Detect subagent-only interrupt (not parent abort)
		if (!hasError && fgAbort.signal.aborted && !signal.aborted) {
			hasError = true;
			finalText = "Subagent interrupted by user";
		}
	} finally {
		getForegroundAbortControllers().delete(subagentId);
		await finalizeSubagent(
			subagentId,
			parentNarratorId,
			toolUseId,
			hasError,
			hasError ? finalText : null,
		);
	}

	const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
	return resultPrefix + (finalText || "(no output)");
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
 * Continue a previously completed/errored subagent by forking it.
 *
 * Instead of mutating the original subagent, we create a new subagent narrator
 * that shares the original's message history (via narrator_message_refs) and
 * then runs a fresh agent loop with the follow-up prompt. This keeps the
 * original subagent's message tree intact for fork-from-middle support and
 * avoids parentToolUseId complications.
 */
export async function continueSubagent(input: ContinueSubagentInput): Promise<string> {
	const { subagentId, parentNarratorId, toolUseId, prompt, signal, locale } = input;

	// 1. Validate original subagent
	const original = await narratorService.getById(subagentId);
	if (original.type !== "subagent") {
		throw new ValidationError("Target narrator is not a subagent");
	}
	if (original.parentNarratorId !== parentNarratorId) {
		throw new ValidationError("Subagent does not belong to the calling narrator");
	}
	if (original.status !== "done" && original.status !== "error") {
		throw new ValidationError(`Cannot continue subagent in status "${original.status}"`);
	}

	const subagentType = original.subagentType ?? "general";
	const model = original.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);
	const cwd = original.cwd ?? ".";

	// Load custom subagent definition once for non-builtin types
	const isBuiltinContinue =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltinContinue ? null : await customSubagentService.loadByName(subagentType);

	// 2. Fork: create new subagent narrator and copy message refs from original
	const forked = await narratorService.forkSubagent({
		originalSubagentId: subagentId,
		parentNarratorId,
		subagentType,
		cwd,
		systemPrompt: original.systemPrompt ?? undefined,
		model,
		permissionMode: original.permissionMode ?? undefined,
		_original: original,
	});
	const forkedId = forked.id;

	// 3. Broadcast subagent_started
	broadcastSubagentStarted(forkedId, parentNarratorId, toolUseId, subagentType, model);

	// 4. Persist new user message under the forked subagent
	await narratorService.persistSubagentUserMessage(forkedId, prompt, toolUseId);

	// 5. Load forked subagent's history
	const { history, trailingToolResults } = await loadSubagentHistory(forkedId, model, provider);

	// Create an independent AbortController for interrupt support
	const fgAbort = new AbortController();
	getForegroundAbortControllers().set(forkedId, fgAbort);
	const combinedSignal = AbortSignal.any([signal, fgAbort.signal]);

	// 6. Run via unified executor (with compact/prune for general)
	let finalText = "";
	let hasError = false;

	try {
		const result = await executeSubagent({
			narratorId: forkedId,
			parentNarratorId,
			toolUseId,
			subagentType,
			prompt,
			cwd,
			model,
			provider,
			locale,
			signal: combinedSignal,
			systemPrompt: original.systemPrompt ?? "",
			initialHistory: history,
			initialTrailingToolResults: trailingToolResults,
			customDef,
		});
		finalText = result.contextLengthExceeded ? "Error: context length exceeded" : result.finalText;
		hasError = result.hasError || !!result.contextLengthExceeded;
		// Detect subagent-only interrupt (not parent abort)
		if (!hasError && fgAbort.signal.aborted && !signal.aborted) {
			hasError = true;
			finalText = "Subagent interrupted by user";
		}
	} finally {
		getForegroundAbortControllers().delete(forkedId);
		await finalizeSubagent(
			forkedId,
			parentNarratorId,
			toolUseId,
			hasError,
			hasError ? finalText : null,
		);
	}

	const resultPrefix = `<subagent_id>${forkedId}</subagent_id>\n\n`;
	return resultPrefix + (finalText || "(no output)");
}
