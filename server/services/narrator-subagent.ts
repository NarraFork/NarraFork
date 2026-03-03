import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { type AgentConfig, buildHistory, type ToolDefinition } from "../lib/agent";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { getSubagentPrompt, type Locale, type SubagentType } from "../lib/prompt-i18n";
import { resolveProvider, settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { EventHandlerContext, EventHooks } from "./narrator-event-handler";
import { executeAgentLoop } from "./narrator-executor";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import { narratorService } from "./narrator-service";
import {
	buildContextManagementHooks,
	COMPACT_CONTEXT_USAGE_PCT,
	handlePermission,
	pruneToolCalls,
	runCustomCompact,
} from "./narrator-session";

// === Subagent type definitions ===

/** Tools available to explore/plan subagents (read-only + Bash for shell inspection) */
const READONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "Bash"]);

/** Tools excluded from general subagents (no nesting, no plan mode) */
const GENERAL_EXCLUDED = new Set([
	"Task",
	"ContinueTask",
	"EnterPlanMode",
	"ExitPlanMode",
	"TodoWrite",
]);

/** Tool filter factories per subagent type */
const TOOL_FILTERS: Record<string, (tool: ToolDefinition) => boolean> = {
	explore: (tool) => READONLY_TOOLS.has(tool.name),
	plan: (tool) => READONLY_TOOLS.has(tool.name),
	general: (tool) => !GENERAL_EXCLUDED.has(tool.name),
};

// === Shared helpers ===

/**
 * Build the effective system prompt for a subagent.
 * Optionally injects contextSummary (after compact).
 */
async function buildSubagentSystemPrompt(
	subagentType: SubagentType,
	cwd: string,
	locale: Locale,
	contextSummary?: string | null,
): Promise<string> {
	const basePrompt = getSubagentPrompt(subagentType, locale);
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
	subagentType: "explore" | "plan" | "general";
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
	const {
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

	const isGeneral = subagentType === "general";

	// Mutable state for compact/prune
	let pruneBoundaryId: string | null = null;
	let needsRestart = false;
	let currentConversationId = randomUUID();
	let contextLengthExceeded = false;
	let overflowRetries = 0;
	const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

	// Build context management hooks for general subagents
	const ctxMgmt = isGeneral
		? buildContextManagementHooks({
				narratorId,
				locale: locale as Locale,
				model,
				provider,
				getPruneBoundary: () => pruneBoundaryId,
				setPruneBoundary: (id) => {
					pruneBoundaryId = id;
				},
				onCompactDone: () => {
					needsRestart = true;
					currentConversationId = randomUUID();
				},
			})
		: null;

	let finalText = "";
	let hasError = false;
	let narratorReasoningEffort =
		(await narratorService.getById(narratorId)).reasoningEffort ?? undefined;

	while (true) {
		const eventContext = buildSubagentEventContext(
			narratorId,
			parentNarratorId,
			toolUseId,
			currentConversationId,
			model,
		);

		const hooks: EventHooks | undefined = ctxMgmt
			? { onContextUsage: ctxMgmt.onContextUsage }
			: undefined;

		const resolvedProvider = resolveProvider(model);
		const config: AgentConfig = {
			narratorId,
			conversationId: currentConversationId,
			model,
			provider: resolvedProvider,
			cwd,
			systemPrompt,
			locale,
			signal,
			reasoningEffort:
				narratorReasoningEffort ??
				(resolveProvider(model) === "codex" ? settings.codex?.defaultReasoningEffort : undefined),
			toolFilter: TOOL_FILTERS[subagentType],
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
			onBeforeTurn: ctxMgmt?.onBeforeTurn,
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
		hasError = result.hasError || !!result.retryableError;
		if (result.retryableError) finalText = `Error: ${result.retryableError}`;

		if (result.contextLengthExceeded) {
			if (!isGeneral || signal.aborted) {
				hasError = true;
				contextLengthExceeded = true;
				finalText = "Error: context length exceeded";
				break;
			}

			overflowRetries++;

			if (overflowRetries > MAX_CONTEXT_OVERFLOW_RETRIES) {
				hasError = true;
				contextLengthExceeded = true;
				finalText = "Error: context length exceeded after compact retries";
				break;
			}

			logger.warn("Subagent context length exceeded, attempting emergency recovery", {
				narratorId,
				parentNarratorId,
				attempt: overflowRetries,
				provider: resolvedProvider,
				subagentType,
			});

			if (resolvedProvider === "codex" && overflowRetries === 1) {
				try {
					const before = await narratorService.getById(narratorId);
					const pruneResult = await narratorService.computeAndUpdatePruneBoundary(
						narratorId,
						COMPACT_CONTEXT_USAGE_PCT,
					);
					if (pruneResult?.boundaryMessageId) {
						const boundaryAdvanced =
							pruneResult.boundaryMessageId !== before.pruneBoundaryMessageId;
						if (boundaryAdvanced) {
							pruneBoundaryId = pruneResult.boundaryMessageId;
							const rebuilt = await loadSubagentHistory(
								narratorId,
								model,
								resolvedProvider,
								pruneBoundaryId,
							);
							history = rebuilt.history;
							trailingToolResults = rebuilt.trailingToolResults;
							logger.warn("Subagent applied aggressive prune, retrying before compact", {
								narratorId,
								boundaryMessageId: pruneResult.boundaryMessageId,
								prunedPercent: pruneResult.prunedPercent,
							});
							continue;
						}
					}
				} catch (pruneErr) {
					logger.error("Subagent aggressive prune failed", {
						narratorId,
						error: String(pruneErr),
					});
				}
			}

			let compacted = false;
			const maxKeepPairs = 8;
			for (let keepPairs = 2; keepPairs <= maxKeepPairs; keepPairs++) {
				const boundaryMessageId = await narratorService.getCompactBoundaryMessage(
					narratorId,
					keepPairs,
				);
				if (!boundaryMessageId) break;
				try {
					await runCustomCompact(narratorId, locale as Locale, boundaryMessageId);
					needsRestart = true;
					currentConversationId = randomUUID();
					compacted = true;
					logger.info("Subagent emergency compact succeeded", {
						narratorId,
						keepPairs,
						parentNarratorId,
					});
					break;
				} catch (compactErr) {
					logger.error("Subagent emergency compact attempt failed", {
						narratorId,
						keepPairs,
						error: String(compactErr),
					});
				}
			}

			if (compacted) {
				// Keep hasError=false and continue restart flow below.
			} else {
				hasError = true;
				finalText = "Error: context length exceeded and compact failed";
				break;
			}
		}

		if (!needsRestart || !isGeneral || signal.aborted || hasError) break;

		// Compact completed mid-turn — restart with fresh history
		logger.info("Subagent restarting after compact", { narratorId, parentNarratorId });

		// Reload fresh state — compact clears prune boundary
		const freshNarrator = await narratorService.getById(narratorId);
		pruneBoundaryId = freshNarrator.pruneBoundaryMessageId ?? null;
		narratorReasoningEffort = freshNarrator.reasoningEffort ?? undefined;

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

	return { finalText, hasError, contextLengthExceeded };
}

// === Subagent runner ===

export interface RunSubagentInput {
	parentNarratorId: string;
	toolUseId: string;
	subagentType: "explore" | "plan" | "general";
	prompt: string;
	cwd: string;
	signal: AbortSignal;
	locale: string;
	model?: string;
}

/**
 * Run a subagent synchronously (from the parent narrator's perspective).
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
		signal,
		locale,
		model: explicitModel,
	} = input;

	const systemPrompt = await buildSubagentSystemPrompt(subagentType, cwd, locale as Locale);

	// Resolve model: explicit param > per-type setting > parent model > global default
	const subagentPref =
		subagentType !== "general" ? settings.agent.subagentModels?.[subagentType] : undefined;

	// 1. Create subagent narrator
	const subagent = await narratorService.createSubagent({
		parentNarratorId,
		subagentType,
		cwd,
		systemPrompt,
		model: explicitModel || subagentPref || undefined,
	});

	const subagentId = subagent.id;
	const model = subagent.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);

	// 2. Broadcast subagent_started
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType);

	// 3. Persist subagent's user message (linked to parent's tool_use)
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

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
			signal,
			systemPrompt,
			initialHistory: [],
		});
		finalText = result.contextLengthExceeded ? "Error: context length exceeded" : result.finalText;
		hasError = result.hasError || !!result.contextLengthExceeded;
	} finally {
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

	const subagentType = (original.subagentType ?? "general") as "explore" | "plan" | "general";
	const model = original.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);
	const cwd = original.cwd ?? ".";

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
	broadcastSubagentStarted(forkedId, parentNarratorId, toolUseId, subagentType);

	// 4. Persist new user message under the forked subagent
	await narratorService.persistSubagentUserMessage(forkedId, prompt, toolUseId);

	// 5. Load forked subagent's history
	const { history, trailingToolResults } = await loadSubagentHistory(forkedId, model, provider);

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
			signal,
			systemPrompt: original.systemPrompt ?? "",
			initialHistory: history,
			initialTrailingToolResults: trailingToolResults,
		});
		finalText = result.contextLengthExceeded ? "Error: context length exceeded" : result.finalText;
		hasError = result.hasError || !!result.contextLengthExceeded;
	} finally {
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
