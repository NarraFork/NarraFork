import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { type AgentConfig, buildHistory } from "../lib/agent";
import { eventBus } from "../lib/event-bus";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import {
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveProvider,
	usesCodexApiMode,
} from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { CustomSubagentDef } from "./custom-subagent-service";
import type { EventHandlerContext, EventHooks } from "./narrator-event-handler";
import { executeAgentLoop } from "./narrator-executor";
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
	handlePermission,
	pruneToolCalls,
	toBufferSummary,
} from "./narrator-session";
import {
	deleteConclusionFileId,
	resolveConclusionFilePath,
	setConclusionFileId,
} from "./subagent-conclusion";
import { clearTeamInbox, drainTeamInbox } from "./subagent-team";
import { resolveToolFilter } from "./subagent-tools";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SubagentBufferedMessage {
	id: string;
	text: string;
	images?: ImageRef[];
	bufferedAt: string;
}

export interface SubagentExecOptions {
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
	/** Rebuild system prompt callback — called after compact to regenerate with new contextSummary */
	rebuildSystemPrompt?: (contextSummary?: string | null) => Promise<string>;
}

// ---------------------------------------------------------------------------
// In-memory state: buffered messages
// ---------------------------------------------------------------------------

// Use `let` + lazy getter to avoid TDZ issues under Bun --hot reload,
// where a stale dynamic-import resolution can reference the module binding
// before the const initializer has executed.

let _subagentBufferedMessages: Map<string, SubagentBufferedMessage[]> | undefined;
export function getSubagentBufferedMessagesMap() {
	if (!_subagentBufferedMessages) _subagentBufferedMessages = new Map();
	return _subagentBufferedMessages;
}

const MAX_BUFFERED_MESSAGES = 10;

/**
 * Push a user message onto the subagent buffer queue.
 * Returns false if the queue is full.
 */
export function pushSubagentBufferedMessage(
	subagentId: string,
	text: string,
	images?: ImageRef[],
	position: "front" | "back" = "back",
): { ok: boolean; bufferedAt: string; id: string; full?: boolean } {
	const queue = getSubagentBufferedMessagesMap().get(subagentId) ?? [];
	const bufferedAt = new Date().toISOString();
	const id = generateShortId();
	if (queue.length >= MAX_BUFFERED_MESSAGES) {
		return { ok: false, bufferedAt, id, full: true };
	}
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

// ---------------------------------------------------------------------------
// buildSubagentEventContext
// ---------------------------------------------------------------------------

/** Build an EventHandlerContext for a subagent. */
export function buildSubagentEventContext(
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

// ---------------------------------------------------------------------------
// finalizeSubagent
// ---------------------------------------------------------------------------

/** Mark subagent as done/error and broadcast completion. */
export async function finalizeSubagent(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	errorText: string | null,
): Promise<void> {
	// Clean up any remaining buffered messages and team inbox
	getSubagentBufferedMessagesMap().delete(subagentId);
	clearTeamInbox(subagentId);

	// NOTE: file change records are intentionally NOT cleared here.
	// They remain available for sibling subagents to query via TeamStatus.file_changes
	// until the parent narrator session ends (clearTeamFileChanges is called then).

	await narratorService.updateStatus(subagentId, "idle", {
		substatus: hasError ? ["error"] : ["unread"],
		errorMessage: hasError ? (errorText ?? undefined) : undefined,
		skipErrorMessage: true,
	});

	eventBus.emit({
		type: "narrator:subagent_completed",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
	});
}

// ---------------------------------------------------------------------------
// loadSubagentHistory
// ---------------------------------------------------------------------------

/**
 * Load subagent messages and build history.
 * Clears parentToolUseId so buildHistory includes subagent messages.
 */
export async function loadSubagentHistory(
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

// ---------------------------------------------------------------------------
// consumeNextBufferedSubagentMessage
// ---------------------------------------------------------------------------

export async function consumeNextBufferedSubagentMessage(opts: {
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

// ---------------------------------------------------------------------------
// executeSubagent
// ---------------------------------------------------------------------------

/**
 * Execute a subagent with optional compact/prune support.
 *
 * For general subagents: wraps executeAgentLoop in a while-loop that
 * restarts after compact, with prune boundary tracking and onBeforeTurn.
 *
 * For explore/plan subagents: single-pass execution (no compact/prune).
 */
export async function executeSubagent(opts: SubagentExecOptions): Promise<{
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
		setConclusionFileId(narratorId, conclusionFileId, cwd);
	}

	// Compact-done flag: set by onCompactDone, consumed by onBeforeTurn to
	// rebuild history/systemPrompt within the same agent loop (inner path).
	// The outer needsRestart flag is a fallback for when compact finishes
	// after the agent loop has already returned.
	let compactDoneFlag = false;
	let compactConsumedInLoop = false;

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
			compactDoneFlag = true;
		},
		isCompactDone: () => compactDoneFlag,
		clearCompactDone: () => {
			compactDoneFlag = false;
			compactConsumedInLoop = true;
		},
		rebuildSystemPrompt: async () => {
			const freshNarrator = await narratorService.getById(narratorId);
			if (opts.rebuildSystemPrompt) {
				return opts.rebuildSystemPrompt(freshNarrator.contextSummary);
			}
			return null;
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
			parentNarratorId,
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
				// 1. Check for buffered user messages
				const queue = getSubagentBufferedMessagesMap().get(narratorId);
				const buf = queue?.[0];
				let userText: string | null = null;
				if (buf) {
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
					userText = buf.text;
				}

				// 2. Drain team inbox and append as notifications
				const teamMessages = drainTeamInbox(narratorId);
				if (teamMessages.length > 0) {
					const teamBlock = teamMessages
						.map(
							(m) =>
								`[Team ${m.isBroadcast ? "broadcast" : "message"} from ${m.fromTitle ?? m.fromId} (${m.fromType})]: ${m.text}`,
						)
						.join("\n");
					userText = userText ? `${userText}\n\n${teamBlock}` : teamBlock;
				}

				return userText;
			},
		};

		needsRestart = false;
		compactConsumedInLoop = false;

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

		// If onBeforeTurn already handled the compact (inner path), the flag
		// was cleared and needsRestart is stale. Skip the outer restart.
		// Do not key this on finalText: explore/plan subagents may write their
		// actual result to the conclusion file, which is read after the loop.
		if (compactConsumedInLoop && !compactDoneFlag && !result.contextLengthExceeded) {
			logger.info("Subagent compact already handled by onBeforeTurn, skipping outer restart", {
				narratorId,
				parentNarratorId,
				finalTextLength: finalText.length,
			});
			needsRestart = false;
			break;
		}
		compactDoneFlag = false;

		// Compact completed mid-turn — restart with fresh history
		logger.info("Subagent restarting after compact", { narratorId, parentNarratorId });

		// Reload fresh state — compact clears prune boundary
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
		narratorReasoningEffort = freshNarrator.reasoningEffort ?? undefined;
		narratorFastMode = freshNarrator.fastMode ?? false;

		// Rebuild system prompt with new contextSummary
		if (opts.rebuildSystemPrompt) {
			systemPrompt = await opts.rebuildSystemPrompt(freshNarrator.contextSummary);
		}

		// Reload history from post-compact messages (no prune after compact)
		const rebuilt = await loadSubagentHistory(narratorId, model, resolvedProvider, null);
		history = rebuilt.history;
		trailingToolResults = rebuilt.trailingToolResults;
	}

	// Read conclusion file for explore/plan subagents.
	// If the subagent wrote to the designated conclusion file, use its content as finalText.
	if (conclusionFileId) {
		const conclusionPath = resolveConclusionFilePath(cwd, conclusionFileId);
		deleteConclusionFileId(narratorId);
		try {
			if (existsSync(conclusionPath)) {
				const content = readFileSync(conclusionPath, "utf-8").trim();
				if (content && !hasError) {
					finalText = content;
				}
				// Clean up the temporary conclusion file
				rmSync(conclusionPath, { force: true });
			}
		} catch (err) {
			logger.warn("Failed to read/cleanup conclusion file", {
				narratorId,
				conclusionPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { finalText, hasError, contextLengthExceeded };
}
