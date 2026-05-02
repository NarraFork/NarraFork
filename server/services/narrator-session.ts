import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { formatFileSize } from "@shared/text-file-types";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	overseers,
	projects,
} from "../db/schema";
import { buildHistory, resolveProviderAndModel } from "../lib/agent";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { OPTIONAL_TOOLS, OVERSEER_TOOLS, REVIEW_TOOLS } from "../lib/agent/tools/index";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { NotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	isReadOnlySubagentVariant,
	isSubagentVariant,
	parseSubstatus,
} from "../lib/narrator-utils";
import { getHome } from "../lib/platform";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import {
	getContextThresholds,
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	usesCodexApiMode,
	usesStatefulApi,
} from "../lib/settings";
import type { ImageRef, TextFileRef } from "../lib/uploads";
import { getImagePath, imageToBase64, saveTextFileToWorktree } from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { drainCompletedBackgroundSubagents } from "./bg-completion-queue";
import { gitService } from "./git-service";
import {
	clearStreamingSnapshot,
	type EventHandlerContext,
	type EventHooks,
	processEvent,
} from "./narrator-event-handler";
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
import { clearAliasRegistry, clearTeamFileChanges } from "./narrator-subagent";
import { generateAndSetTitle, generateQuickTitle } from "./narrator-title";
import { reviewService } from "./review-service";
import {
	deleteConclusionFileId,
	getConclusionEntry,
	setConclusionFileId,
} from "./subagent-conclusion";
import {
	getConclusionWatcher,
	getManualOverrideMap,
	registerConclusionWatcher,
	removeConclusionWatcher,
	resolveManualOverride,
} from "./subagent-manual-override";
import { isMcpToolAllowedForNarrator } from "./subagent-tools";
import { worktreeWatcher } from "./worktree-watcher";

// === In-memory state (imported from narrator-session-state) ===

import type {
	ActiveNarrator,
	BufferCreator,
	BufferedMessage,
	NarratorEvent,
	OverseerQueuedMessage,
	SavedBufferedFile,
} from "./narrator-session-state";
import {
	activeNarrators,
	bufferedMessages,
	compactLocks,
	narratorCreationLocks,
	pendingFeedback,
	pendingOverseerMessages,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
	pruneLocks,
} from "./narrator-session-state";

// === Imported from extracted modules ===

import {
	dbClearAllBuffered,
	dbConsumeBuffered,
	getBufferedMessages,
	loadBufferedTextFiles,
	toBufferSummary,
} from "./narrator-buffer";
import {
	COMPACT_PRUNE_THRESHOLD_PCT,
	pruneToolCalls,
	runCustomCompact,
	runPlanCompact,
	shouldFinalizeAbortBeforeRecovery,
	triggerMidTurnCompact,
} from "./narrator-compact";
import { handlePermission } from "./narrator-permission";

// Tools that may modify files on disk — git status is tracked after these complete
const FILE_MUTATING_TOOLS = new Set(["Write", "Edit", SHELL_TOOL_NAME]);

/** Parse `git status --porcelain` output into a set of file paths. */
function parsePorcelainFiles(output: string): Set<string> {
	const files = new Set<string>();
	for (const line of output.split("\n")) {
		if (line.length < 4) continue;
		// Porcelain format: XY filename  (or XY orig -> renamed)
		const filePart = line.slice(3);
		// Handle renames: "old -> new"
		const arrowIdx = filePart.indexOf(" -> ");
		files.add(arrowIdx >= 0 ? filePart.slice(arrowIdx + 4) : filePart);
	}
	return files;
}

// === Narrator lifecycle ===

/**
 * Ensure an active narrator exists for this narrator ID.
 * If one is already alive, return it. Otherwise create a new one.
 */
export async function ensureNarrator(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveNarrator> {
	const existing = activeNarrators.get(narratorId);
	if (existing?.alive && !existing.abortController.signal.aborted) return existing;

	const pending = narratorCreationLocks.get(narratorId);
	if (pending) return pending;

	const creation = createNarrator(narratorId, locale, replyInUserLanguage);
	narratorCreationLocks.set(narratorId, creation);
	try {
		return await creation;
	} finally {
		narratorCreationLocks.delete(narratorId);
	}
}

/**
 * Build the effective system prompt dynamically.
 * Reads AGENT.md (fallback CLAUDE.md) from disk each time so changes are picked up mid-conversation.
 */
async function buildSystemPrompt(
	narrator: { systemPrompt: string | null; contextSummary: string | null; todosJson?: unknown },
	cwd: string,
	locale: Locale,
	replyInUserLanguage: boolean,
	planMode = false,
	planFileId?: string,
	defaultSystemPrompt?: string | null,
): Promise<{ prompt: string | null; usedCompactSummary: boolean }> {
	return buildEffectiveSystemPrompt({
		basePrompt: narrator.systemPrompt,
		cwd,
		locale,
		contextSummary: narrator.contextSummary,
		todosJson: narrator.todosJson,
		planMode,
		planFileId,
		replyInUserLanguage,
		defaultSystemPrompt,
	});
}

async function createNarrator(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveNarrator> {
	const existing = activeNarrators.get(narratorId);
	if (existing) {
		existing.abortController.abort();
		activeNarrators.delete(narratorId);
		planModeAskedOnce.delete(narratorId);
		clearStreamingSnapshot(narratorId);
	}

	const narrator = await narratorService.getById(narratorId);

	// Use narrator-level state directly
	const effectiveConversationId = narrator.apiConversationId;
	const effectiveContextSummary = narrator.contextSummary;

	// Resolve CWD and cache chapter info for git tracking
	let narratorCwd: string;
	let narratorChapterId: string | undefined;
	let narratorProjectId: string | undefined;
	let narratorChapterRole: string | undefined;
	let narratorWorktreePath: string | undefined;
	let narratorBaseBranch: string | undefined;
	let projectGitPath: string | null = null;
	if (narrator.chapterId) {
		const ch = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		if (!ch) throw new NotFoundError("Chapter", narrator.chapterId);
		// Always try to resolve project gitPath for skill loading
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, ch.projectId),
		});
		projectGitPath = project?.gitPath ?? null;
		narratorProjectId = ch.projectId;
		if (ch.worktreePath) {
			narratorCwd = ch.worktreePath;
			narratorChapterId = ch.id;
			narratorChapterRole = ch.role;
			narratorWorktreePath = ch.worktreePath;
			narratorBaseBranch = ch.baseBranch;
		} else {
			// Chapter is dormant — fall back to project gitPath or narrator cwd
			narratorCwd = narrator.cwd || project?.gitPath || getHome();
			logger.info("Chapter dormant, using fallback CWD", {
				chapterId: narrator.chapterId,
				narratorCwd,
			});
		}
	} else {
		narratorCwd = narrator.cwd || getHome();
	}

	// Generate planFileId if narrator is already in plan mode (e.g. server restart recovery).
	// A new ID is generated each time — any previously written plan file from a prior session
	// becomes orphaned, but the model will use the new file path from the refreshed system prompt.
	const isPlanMode = narrator.permissionMode === "plan";
	const planFileId = isPlanMode ? generateWordSlug() : undefined;

	const { prompt: effectiveSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
		{
			systemPrompt: narrator.systemPrompt,
			contextSummary: effectiveContextSummary,
			todosJson: narrator.todosJson,
		},
		narratorCwd,
		locale,
		replyInUserLanguage,
		isPlanMode,
		planFileId,
		settings.agent.defaultSystemPrompt,
	);

	// Resolve skill root for the Skill tool (projectGitPath or git root from cwd)
	let skillRoot: string | null = null;
	try {
		const { resolveSkillRoot } = await import("./skill-service");
		skillRoot = await resolveSkillRoot(projectGitPath, narratorCwd);
		if (skillRoot) {
			// Pre-populate skill cache so the tool description includes the skill list
			const { warmSkillCache } = await import("../lib/agent/tools/skill");
			await warmSkillCache(skillRoot);
		}
	} catch {
		// Skill root resolution failure is non-fatal
	}

	// For standalone narrators, only enable Bash git-status-based file tracking
	// if cwd is inside a git repo. This prevents running `git status` on non-repo dirs.
	let narratorIsInGitRepo = !!narratorChapterId;
	if (!narratorChapterId) {
		try {
			narratorIsInGitRepo = await gitService.isGitRepo(narratorCwd);
		} catch {
			// Non-fatal — Bash file tracking just won't be enabled
		}
	}

	const abortController = new AbortController();
	const events = new EventEmitter();
	events.setMaxListeners(20);

	const narratorModel = resolveEffectiveModel(narrator.model);

	const active: ActiveNarrator = {
		abortController,
		narratorId,
		conversationId: effectiveConversationId ?? randomUUID(),
		cwd: narratorCwd,
		model: narratorModel,
		provider: resolveProvider(narratorModel),
		systemPrompt: effectiveSystemPrompt,
		events,
		alive: true,
		locale,
		_usedCompactSummary: usedCompactSummary,
		_replyInUserLanguage: replyInUserLanguage,
		_chapterId: narratorChapterId,
		_projectId: narratorProjectId,
		_chapterRole: narratorChapterRole,
		_worktreePath: narratorWorktreePath,
		_baseBranch: narratorBaseBranch,
		_isInGitRepo: narratorIsInGitRepo,
		_planFileId: planFileId,
		_projectGitPath: projectGitPath,
		_skillRoot: skillRoot,
		_enabledOptionalTools: new Set(),
		_isOverseer: false,
		_interruptCleanupDone: false,
		_substatus: new Set(),
	};

	// Check if this narrator is bound to an overseer
	{
		const overseerRecord = await db.query.overseers.findFirst({
			where: eq(overseers.narratorId, narratorId),
			columns: { id: true },
		});
		if (overseerRecord) {
			active._isOverseer = true;
		}
	}

	// Auto-load optional tools whose routines are globally enabled
	const disabledRoutines = new Set(settings.routines?.disabledRoutines ?? []);
	const enabledRoutines = new Set(settings.routines?.enabledRoutines ?? []);
	for (const routine of getBuiltinToolRoutines()) {
		if (!routine.tool) continue;
		const on = routine.defaultEnabled
			? !disabledRoutines.has(routine.id)
			: enabledRoutines.has(routine.id);
		if (on) {
			active._enabledOptionalTools.add(routine.tool.toolName);
		}
	}
	// Merge tools explicitly enabled on this narrator (via /load)
	if (Array.isArray(narrator.enabledTools)) {
		for (const toolName of narrator.enabledTools) {
			if (OPTIONAL_TOOLS.has(toolName)) {
				active._enabledOptionalTools.add(toolName);
			}
		}
	}

	activeNarrators.set(narratorId, active);

	// Start file watcher for the worktree (covers terminal/editor changes)
	if (narratorWorktreePath && narratorChapterId) {
		worktreeWatcher.watch(narratorWorktreePath, narratorChapterId, narratorId, locale);
	}

	return active;
}

async function finalizeInterruptedRun(
	active: ActiveNarrator,
	narratorId: string,
	partialId?: string,
): Promise<void> {
	if (active._interruptCleanupDone) {
		return;
	}
	active._interruptCleanupDone = true;

	logger.info("Agent loop aborted (interrupted)", { narratorId });
	active.events.emit("event", {
		type: "interrupted",
		data: { message: "Narrator interrupted" },
	});

	const cleanupTasks = [cleanupOrphanedToolCalls(narratorId, active.locale)];
	const current = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { status: true, substatus: true },
	});
	const currentSubstatus = parseSubstatus(current?.substatus);
	if (!(current?.status === "idle" && currentSubstatus.includes("error"))) {
		cleanupTasks.push(
			narratorService.updateStatus(narratorId, "idle", { substatus: ["interrupted"] }),
		);
	}
	if (partialId) {
		cleanupTasks.push(finalizeOrCleanupPartialMessage(partialId, narratorId).then(() => {}));
	}
	await Promise.all(cleanupTasks).catch((err) => {
		logger.warn("Post-interrupt cleanup failed", {
			narratorId,
			error: String(err),
		});
	});
}

// === Agent loop execution ===

/** Append pending todos to the user message text so the model has context. */
function appendTodosContext(text: string, todosJson: unknown): string {
	if (!Array.isArray(todosJson) || todosJson.length === 0) return text;
	const pending = todosJson.filter((t: { status?: string }) => t.status !== "completed");
	if (pending.length === 0) return text;
	const statusIcon: Record<string, string> = {
		in_progress: "→",
		pending: "○",
	};
	const lines = pending.map(
		(t: { id?: string; content?: string; status?: string; priority?: string }) => {
			const icon = statusIcon[t.status ?? "pending"] ?? "○";
			const pri = t.priority && t.priority !== "medium" ? ` [${t.priority}]` : "";
			return `${icon} [${t.id}] ${t.content ?? ""}${pri}`;
		},
	);
	return `${text}\n\n<current_todos>\n${lines.join("\n")}\n</current_todos>`;
}

interface ContinuableTopLevelMessage {
	role: string;
	parentToolUseId?: string | null;
	contentJson?: unknown;
	toolCalls?: Array<{ toolUseId?: string | null; toolName?: string | null }>;
}

function getLastContinuableTopLevelMessage<T extends ContinuableTopLevelMessage>(
	messages: T[],
): T | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.parentToolUseId) continue;
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		return msg;
	}
	return undefined;
}

function shouldReplayToolResultPacket(msg: ContinuableTopLevelMessage | undefined): boolean {
	if (!msg || msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	if (blocks.some((block: { type?: string }) => block?.type === "tool_use")) return true;
	return (
		Array.isArray(msg.toolCalls) &&
		msg.toolCalls.some((tc) => Boolean(tc?.toolUseId) && Boolean(tc?.toolName))
	);
}

async function getLatestSubagentParentToolUseId(narratorId: string): Promise<string | undefined> {
	const latestSubMsg = await db.query.narratorMessages.findFirst({
		where: and(
			eq(narratorMessages.narratorId, narratorId),
			eq(narratorMessages.role, "user"),
			isNotNull(narratorMessages.parentToolUseId),
		),
		columns: { parentToolUseId: true },
		orderBy: [desc(narratorMessages.createdAt)],
	});
	return latestSubMsg?.parentToolUseId ?? undefined;
}

// === Shared context management hooks ===

export interface ContextManagementOptions {
	narratorId: string;
	locale: Locale;
	/** Dynamic getter for the current model (supports mid-loop model switching) */
	getModel: () => string;
	/** Dynamic getter for the current provider (supports mid-loop model switching) */
	getProvider: () => string;
	/** Whether this narrator is a subagent (all messages have parentToolUseId) */
	isSubagent?: boolean;
	/** Mutable getter/setter for the cached prune boundary */
	getPruneBoundary: () => string | null;
	setPruneBoundary: (id: string | null) => void;
	/** Called after compact completes (e.g. reset conversationId, set restart flag) */
	onCompactDone?: () => void;
	/** Check whether a compact just finished and the next turn needs a full rebuild */
	isCompactDone?: () => boolean;
	/** Clear the compact-done flag after the rebuild has been applied */
	clearCompactDone?: () => void;
	/** Rebuild the system prompt with the latest contextSummary from DB */
	rebuildSystemPrompt?: () => Promise<string | null>;
}

/**
 * Build reusable context management hooks (prune + compact) for both
 * main narrators and subagents.
 *
 * Returns an `onContextUsage` EventHook and an `onBeforeTurn` AgentConfig callback.
 */
export function buildContextManagementHooks(opts: ContextManagementOptions): {
	onContextUsage: NonNullable<EventHooks["onContextUsage"]>;
	onBeforeTurn: NonNullable<import("../lib/agent").AgentConfig["onBeforeTurn"]>;
} {
	const {
		narratorId,
		locale,
		getModel,
		getProvider,
		isSubagent: isSubagentNarrator,
		getPruneBoundary,
		setPruneBoundary,
		onCompactDone,
		isCompactDone,
		clearCompactDone,
		rebuildSystemPrompt,
	} = opts;

	const onContextUsage = (percentage: number) => {
		const thresholds = getContextThresholds(getModel(), getProvider());

		// Dynamic pruning: pruneStart – (compactStart - 1)%
		if (
			percentage >= thresholds.pruneStart &&
			percentage < thresholds.compactStart &&
			!pruneLocks.has(narratorId)
		) {
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage, thresholds)
				.then((result) => {
					broadcastToNarrator(narratorId, {
						type: "prune_boundary",
						narratorId,
						boundaryMessageId: result?.boundaryMessageId ?? null,
						prunedPercent: result?.prunedPercent ?? null,
					});
				})
				.catch((err) => {
					logger.error("Failed to update prune boundary", {
						narratorId,
						contextPct: percentage,
						error: String(err),
					});
				})
				.finally(() => {
					pruneLocks.delete(narratorId);
				});
		}

		// ≥ compactStart%: check prunedPercent before deciding compact vs continued prune.
		// If prunedPercent < 80%, there's still room to prune further — skip compact.
		// Exception: when pruning is disabled for this narrator, skip the prune gate
		// and compact immediately (otherwise compact would never trigger).
		if (
			percentage >= thresholds.compactStart &&
			!pruneLocks.has(narratorId) &&
			!compactLocks.has(narratorId)
		) {
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage, thresholds)
				.then(async (result) => {
					broadcastToNarrator(narratorId, {
						type: "prune_boundary",
						narratorId,
						boundaryMessageId: result?.boundaryMessageId ?? null,
						prunedPercent: result?.prunedPercent ?? null,
					});

					// If prune returned null (e.g. pruning disabled), check the DB flag
					// to decide whether to skip the prune gate entirely.
					if (result == null) {
						const row = await db.query.narrators.findFirst({
							where: eq(narrators.id, narratorId),
							columns: { pruneEnabled: true },
						});
						if (row && !row.pruneEnabled) {
							// Pruning disabled — go straight to compact
							triggerMidTurnCompact(narratorId, locale, onCompactDone);
							return;
						}
					}

					const prunedPct = result?.prunedPercent ?? 0;
					if (prunedPct < COMPACT_PRUNE_THRESHOLD_PCT) {
						logger.info(
							"Context above compactStart but prunedPercent below threshold, continuing prune",
							{
								narratorId,
								contextPct: percentage,
								prunedPercent: prunedPct,
								threshold: COMPACT_PRUNE_THRESHOLD_PCT,
							},
						);
						return; // stay in prune mode — don't compact yet
					}
					// prunedPercent ≥ 80%: prune is exhausted, proceed to compact
					triggerMidTurnCompact(narratorId, locale, onCompactDone);
				})
				.catch((err) => {
					logger.error("Failed to update prune boundary (pre-compact check)", {
						narratorId,
						contextPct: percentage,
						error: String(err),
					});
				})
				.finally(() => {
					pruneLocks.delete(narratorId);
				});
		}
	};

	const onBeforeTurn = async () => {
		// Check if a compact just finished — if so, force a full rebuild
		// (history + system prompt) so the next API call uses compacted data.
		// This takes priority over the prune-boundary check below because compact
		// already clears the prune boundary and returns a fresh message set.
		const compactJustDone = isCompactDone?.() ?? false;
		if (compactJustDone) {
			clearCompactDone?.();
			// After compact, pruneBoundary is cleared — sync local cache
			setPruneBoundary(null);
			const rawMsgs = await narratorService.getMessagesSinceLastCompact(narratorId);
			const msgs = isSubagentNarrator
				? rawMsgs.map((m) => ({ ...m, parentToolUseId: null }))
				: rawMsgs;
			const result = await buildHistory(msgs, getModel(), getProvider(), narratorId);
			const systemPrompt = (await rebuildSystemPrompt?.()) ?? undefined;
			return {
				history: result.history,
				pendingToolResults: result.trailingToolResults,
				systemPrompt,
			};
		}

		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { pruneBoundaryMessageId: true },
		});
		const newBoundary = row?.pruneBoundaryMessageId ?? null;
		if (newBoundary === getPruneBoundary()) return null;
		setPruneBoundary(newBoundary);
		const rawMsgs = await narratorService.getMessagesSinceLastCompact(narratorId);
		// Subagent messages all have parentToolUseId set — clear it so
		// buildHistory treats them as top-level (same as loadSubagentHistory).
		const msgs = isSubagentNarrator
			? rawMsgs.map((m) => ({ ...m, parentToolUseId: null }))
			: rawMsgs;
		if (newBoundary) pruneToolCalls(msgs, newBoundary);
		const result = await buildHistory(msgs, getModel(), getProvider(), narratorId);
		return { history: result.history, pendingToolResults: result.trailingToolResults };
	};

	return { onContextUsage, onBeforeTurn };
}

/**
 * Build AgentConfig, start the agent loop via executeAgentLoop(), and handle chained messages.
 * Runs in the background — kicked off by feedMessage().
 */
export async function runAgentLoop(
	active: ActiveNarrator,
	text: string,
	images?: ImageRef[],
): Promise<void> {
	const { narratorId, locale } = active;
	active._loopRunning = true;
	let shouldUpdateTitle = false;
	let currentText = text;
	let currentImages = images;
	let loopHadError = false;
	/** Whether the loop was interrupted by the user (abort signal). */
	let loopWasInterrupted = false;
	/** How many times we've retried after emergency compact in this runAgentLoop call. */
	let contextOverflowRetries = 0;

	/** How many consecutive transient-error retries in this runAgentLoop call. */
	let transientRetries = 0;

	/** How many consecutive smart-interruption auto-continues in this runAgentLoop call. */
	let interruptionRetries = 0;
	const MAX_INTERRUPTION_RETRIES = 3;

	// --- Subagent dual-broadcast setup ---
	// When runAgentLoop runs for a taken-over subagent, we need to broadcast
	// events to the parent narrator so the SubagentCard updates in real time.
	// Resolve parentNarratorId + parentToolUseId once before the loop.
	let saParentNarratorId: string | undefined;
	let saParentToolUseId: string | undefined;
	{
		const initNarrator = await narratorService.getById(narratorId);
		if (isSubagentVariant(initNarrator.variant) && initNarrator.parentNarratorId) {
			const watcher = getConclusionWatcher(narratorId);
			const parentToolUseId =
				watcher?.toolUseId ?? (await getLatestSubagentParentToolUseId(narratorId));
			if (parentToolUseId) {
				saParentNarratorId = watcher?.parentNarratorId ?? initNarrator.parentNarratorId;
				saParentToolUseId = parentToolUseId;
			}
		}
	}

	try {
		while (active.alive) {
			// Always use getMessagesSinceLastCompact: if no compact marker exists it
			// returns all messages; after a compact it only returns post-compact messages
			// (old context is already in the summary injected via system prompt).
			const rawMessages = await narratorService.getMessagesSinceLastCompact(narratorId);

			// Rebuild system prompt each iteration so AGENT.md/CLAUDE.md changes are picked up
			const freshNarrator = await narratorService.getById(narratorId);

			// Subagent messages all have parentToolUseId set — clear it so
			// buildHistory treats them as top-level (same as loadSubagentHistory).
			const isSubagentNarrator = isSubagentVariant(freshNarrator.variant);
			const dbMessages = isSubagentNarrator
				? rawMessages.map((m) => ({ ...m, parentToolUseId: null }))
				: rawMessages;

			// Apply dynamic pruning — strip tool calls from messages at or
			// before the persisted boundary so the context stays within budget.
			active._pruneBoundaryMessageId = freshNarrator.pruneBoundaryMessageId ?? null;
			if (freshNarrator.pruneBoundaryMessageId) {
				pruneToolCalls(dbMessages, freshNarrator.pruneBoundaryMessageId);
			}

			const resolved = resolveProviderAndModel(active.model, active.provider);
			active.provider = resolved.provider;
			const { history, trailingToolResults } = await buildHistory(
				dbMessages,
				resolved.model,
				resolved.provider,
				narratorId,
			);

			const { prompt: freshSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
				{
					systemPrompt: freshNarrator.systemPrompt,
					contextSummary: freshNarrator.contextSummary,
					todosJson: freshNarrator.todosJson,
				},
				active.cwd,
				locale,
				active._replyInUserLanguage ?? false,
				freshNarrator.permissionMode === "plan",
				active._planFileId,
			);
			active.systemPrompt = freshSystemPrompt;
			active._usedCompactSummary = usedCompactSummary;

			const eventContext: EventHandlerContext = {
				narratorId,
				broadcastTargetId: saParentNarratorId ?? narratorId,
				sseEmitter: active.events,
				conversationId: active.conversationId,
				locale: active.locale,
				providerPrefix: resolved.provider,
				provider: resolved.provider,
				model: resolved.model,
				// Subagent dual-broadcast fields — when set, dualBroadcast sends
				// events to both the parent narrator and the subagent's own page.
				parentToolUseId: saParentToolUseId,
				subagentModel: saParentNarratorId ? resolved.model : undefined,
				getContextUsagePct: () => active._contextUsagePct,
				getMeterUsage: () => active._lastMeterUsage,
				getMeterUnit: () => active._lastMeterUnit,
				getPartialMessageId: () => active._partialMessageId,
				getTokenUsage: () => active._lastTokenUsage,
				getTurnStartedAt: () => active._turnStartedAt,
				getTtftMs: () => active._ttftMs,
				setPartialMessageId: (id) => {
					active._partialMessageId = id;
				},
				setContextUsagePct: (pct) => {
					active._contextUsagePct = pct;
				},
				setMeterData: (usage, unit) => {
					active._lastMeterUsage = usage;
					active._lastMeterUnit = unit;
				},
				setTokenUsage: (usage) => {
					active._lastTokenUsage = usage;
				},
				setTtftMs: (ttftMs) => {
					active._ttftMs = ttftMs;
				},
				getSubstatus: () => active._substatus,
				addSubstatus: async (tag) => {
					if (active._substatus.has(tag)) return;
					active._substatus.add(tag);
					await narratorService.updateSubstatus(narratorId, [...active._substatus]);
				},
				removeSubstatus: async (tag) => {
					if (!active._substatus.has(tag)) return;
					active._substatus.delete(tag);
					await narratorService.updateSubstatus(narratorId, [...active._substatus]);
				},
			};

			// Build shared context management hooks (prune + compact)
			let compactDoneFlag = false;
			const ctxMgmt = buildContextManagementHooks({
				narratorId,
				locale,
				isSubagent: isSubagentNarrator,
				getModel: () => resolveProviderAndModel(active.model, active.provider).model,
				getProvider: () => resolveProviderAndModel(active.model, active.provider).provider,
				getPruneBoundary: () => active._pruneBoundaryMessageId ?? null,
				setPruneBoundary: (id) => {
					active._pruneBoundaryMessageId = id;
				},
				onCompactDone: () => {
					const s = activeNarrators.get(narratorId);
					if (s?.alive) {
						s.conversationId = randomUUID();
					}
					compactDoneFlag = true;
				},
				isCompactDone: () => compactDoneFlag,
				clearCompactDone: () => {
					compactDoneFlag = false;
				},
				rebuildSystemPrompt: async () => {
					const freshNarrator = await narratorService.getById(narratorId);
					const { prompt } = await buildSystemPrompt(
						{
							systemPrompt: freshNarrator.systemPrompt,
							contextSummary: freshNarrator.contextSummary,
							todosJson: freshNarrator.todosJson,
						},
						active.cwd,
						locale,
						active._replyInUserLanguage ?? false,
						freshNarrator.permissionMode === "plan",
						active._planFileId,
						settings.agent.defaultSystemPrompt,
					);
					// NOTE: Do NOT set active.systemPrompt here — the returned value
					// flows through onBeforeTurn → loop.ts which updates config.systemPrompt.
					// Setting active.systemPrompt would create a second source of truth.
					return prompt;
				},
			});

			const hooks: EventHooks = {
				onTitleCheck: async (_savedId) => {
					const n = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { messageCount: true, title: true },
					});
					const titleUpdate = !!(n && (n.messageCount ?? 0) <= 1 && !n.title);
					return { titleUpdate };
				},
				onTodoWrite: async (todos, toolUseId) => {
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					await narratorService.updateTodos(narratorId, todos as any[], toolUseId);
					broadcastToNarrator(narratorId, {
						type: "todos_updated",
						narratorId,
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
						todos: todos as any[],
						toolUseId,
					});
				},
				onEnterPlanMode: async () => {
					active._planFileId = generateWordSlug();
					// Save current permission mode and switch to plan
					const current = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { permissionMode: true },
					});
					const prevMode = current?.permissionMode ?? "default";
					// Guard: if already in plan mode, don't overwrite previousPermissionMode
					if (prevMode === "plan") return;
					active._previousPermissionMode = prevMode;
					const now = new Date().toISOString();
					await db
						.update(narrators)
						.set({
							permissionMode: "plan",
							previousPermissionMode: prevMode,
							updatedAt: now,
						})
						.where(eq(narrators.id, narratorId));
					broadcastToNarrator(narratorId, {
						type: "permission_mode_changed",
						narratorId,
						permissionMode: "plan",
					});
				},
				onExitPlanMode: async (toolUseId) => {
					active._planFileId = undefined;
					planModeAskedOnce.delete(narratorId);
					// Guard: if not currently in plan mode, the model called ExitPlanMode
					// without a matching EnterPlanMode — skip permission mode restoration
					// and plan-continuation logic to avoid accidentally resetting the
					// user's chosen mode or aborting the agent loop.
					const currentRow = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { permissionMode: true, previousPermissionMode: true },
					});
					if (currentRow?.permissionMode !== "plan") {
						active._previousPermissionMode = undefined;
						return;
					}
					// Restore previous permission mode — check in-memory first, then DB
					let restoreMode = active._previousPermissionMode;
					if (!restoreMode) {
						restoreMode = currentRow.previousPermissionMode ?? undefined;
					}
					// If the previous mode would block plan execution, fall back to default
					const BLOCKED_MODES = new Set(["readOnly", "plan", "dontAsk"]);
					const resolved = restoreMode && !BLOCKED_MODES.has(restoreMode) ? restoreMode : "default";
					const finalMode = resolved as
						| "default"
						| "acceptEdits"
						| "bypassPermissions"
						| "readOnly"
						| "plan"
						| "dontAsk";
					active._previousPermissionMode = undefined;
					const now = new Date().toISOString();
					await db
						.update(narrators)
						.set({
							permissionMode: finalMode,
							previousPermissionMode: null,
							updatedAt: now,
						})
						.where(eq(narrators.id, narratorId));
					broadcastToNarrator(narratorId, {
						type: "permission_mode_changed",
						narratorId,
						permissionMode: finalMode,
					});
					// Plan compact logic — retrieve plan text from the tool call's inputJson
					if (pendingPlanCompact.has(narratorId)) {
						pendingPlanCompact.delete(narratorId);
						const planText = await narratorService.getToolCallPlanText(toolUseId);
						if (planText) {
							await runPlanCompact(narratorId, planText);
							active.conversationId = randomUUID();
							broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
							active._planApprovedContinue = "compact";
							active.abortController.abort();
						}
					} else {
						// Non-compact: abort the current agent loop and persist a user
						// message so the next iteration starts with an explicit
						// "plan approved, begin execution" prompt — this prevents the
						// model from ignoring the tool result and asking the user again.
						active._planApprovedContinue = "continue";
						active.abortController.abort();
					}
				},
				onClearCompactSummary: async () => {
					if (!active._usedCompactSummary) return;
					await db
						.update(narrators)
						.set({ contextSummary: null, updatedAt: new Date().toISOString() })
						.where(eq(narrators.id, narratorId));
					active._usedCompactSummary = false;
				},
				onGitTrack:
					active._worktreePath && active._chapterId
						? (toolName, toolUseId) => {
								if (!FILE_MUTATING_TOOLS.has(toolName)) return;
								const chapterId = active._chapterId as string;
								const worktreePath = active._worktreePath as string;
								const baseBranch = active._baseBranch as string | undefined;

								// Throttle: collapse rapid successive calls into one trailing query.
								// Store the latest toolUseId so the broadcast references the most
								// recent tool, and clear any pending timer.
								if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
								active._gitTrackTimer = setTimeout(() => {
									active._gitTrackTimer = undefined;
									Promise.all([
										gitService.getStatusSummary(worktreePath),
										baseBranch
											? gitService.getCommitsAhead(worktreePath, baseBranch)
											: Promise.resolve({ count: 0, baseBranch: "" }),
									]).then(
										([gitStatus, ahead]) => {
											// Strip files array from WS broadcast to avoid
											// sending huge payloads when many files are changed.
											// The Git panel fetches the full list via API.
											const { files: _files, ...statusWithoutFiles } = gitStatus;
											broadcastToNarrator(narratorId, {
												type: "git_status",
												narratorId,
												chapterId,
												toolUseId,
												status: statusWithoutFiles as typeof gitStatus,
												commitsAhead: ahead.count,
												baseBranch: ahead.baseBranch,
												linesAdded: gitStatus.linesAdded,
												linesRemoved: gitStatus.linesRemoved,
											});
										},
										(err) => {
											logger.debug("Git status tracking failed", {
												narratorId,
												error: String(err),
											});
										},
									);
								}, 800);
							}
						: undefined,
				onSnapshotBefore: active._isInGitRepo
					? (toolUseId, toolName) => {
							// Only Bash needs before/after git status diff.
							// Write/Edit record snapshots directly in their execute().
							if (toolName !== SHELL_TOOL_NAME) return;

							if (!active._bashBeforeStatus) {
								active._bashBeforeStatus = new Map();
							}

							const statusPromise = gitService
								.getStatus(active.cwd)
								.then((output) => parsePorcelainFiles(output));

							active._bashBeforeStatus.set(toolUseId, statusPromise);

							// Swallow errors so the unhandled-rejection handler stays quiet
							statusPromise.catch((err) =>
								logger.debug("Bash before-status failed", {
									narratorId,
									toolUseId,
									error: String(err),
								}),
							);
						}
					: undefined,
				onSnapshotAfter: active._isInGitRepo
					? (toolUseId, toolName) => {
							// Only Bash needs before/after git status diff
							if (toolName !== SHELL_TOOL_NAME) return;

							const beforePromise = active._bashBeforeStatus?.get(toolUseId);
							if (!beforePromise) return;
							active._bashBeforeStatus?.delete(toolUseId);

							// Fire-and-forget: diff before/after status, snapshot new/changed files
							beforePromise
								.then(async (beforeFiles) => {
									const afterOutput = await gitService.getStatus(active.cwd);
									const afterFiles = parsePorcelainFiles(afterOutput);

									// Find files that are new or changed (in after but not in before)
									const changedFiles: string[] = [];
									for (const f of afterFiles) {
										if (!beforeFiles.has(f)) {
											changedFiles.push(f);
										}
									}
									if (changedFiles.length === 0) return;

									// Record snapshots for changed files.
									// For Bash, we use `git show HEAD:<path>` to recover the last
									// committed version as the "original" content. This covers the
									// common case of Bash modifying tracked files. For untracked
									// files (truly new), originalContent will be null.
									const { ensureFileSnapshot } = await import("./file-snapshot-service");
									const cwd = active.cwd;
									for (const filePath of changedFiles) {
										await ensureFileSnapshot(narratorId, filePath, async () => {
											// Try to get the last committed version of this file
											try {
												return await gitService.getFileAtHead(cwd, filePath);
											} catch {
												return null;
											}
										});
									}
								})
								.catch((err) =>
									logger.debug("Bash after-status snapshot failed", {
										narratorId,
										toolUseId,
										error: String(err),
									}),
								);
						}
					: undefined,
				onContextUsage: ctxMgmt.onContextUsage,
				onErrorCleanup: async (message) => {
					// Clean up partial message
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (message === "Aborted") {
						if (
							active._planApprovedContinue === "compact" ||
							active._planApprovedContinue === "continue"
						) {
							logger.info("Agent loop aborted for plan approval", {
								narratorId,
								mode: active._planApprovedContinue,
							});
							// Mark any orphaned tool calls (e.g. ExitPlanMode) as success
							// since the abort was intentional after approval.
							completeOrphanedToolCalls(narratorId).catch((err) => {
								logger.warn("Failed to complete orphaned tool calls after plan approval", {
									narratorId,
									error: String(err),
								});
							});
							if (partialId) {
								cleanupPartialMessage(partialId, narratorId);
							}
							return;
						}
						await finalizeInterruptedRun(active, narratorId, partialId);
						return;
					}
					if (partialId) {
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					logger.error("Agent loop error", { narratorId, error: message });
					await narratorService.updateStatus(narratorId, "idle", {
						substatus: ["error"],
						errorMessage: message,
					});
					loopHadError = true;
					active.events.emit("event", { type: "error", data: { message } });
				},
			};

			const resolvedReasoningEffort =
				freshNarrator.reasoningEffort || resolveDefaultReasoningEffort(resolved.provider);

			const resolvedServiceTier =
				freshNarrator.fastMode && usesCodexApiMode(resolved.provider) ? "priority" : undefined;

			const config: import("../lib/agent").AgentConfig = {
				narratorId,
				conversationId: active.conversationId,
				model: resolved.model,
				provider: resolved.provider,
				cwd: active.cwd,
				systemPrompt: active.systemPrompt ?? undefined,
				locale,
				signal: active.abortController.signal,
				chapterId: active._chapterId,
				planMode: freshNarrator.permissionMode === "plan",
				relaxedPlan: !!freshNarrator.relaxedPlan,
				planFileId: active._planFileId,
				skillRoot: active._skillRoot ?? undefined,
				reasoningEffort: resolvedReasoningEffort,
				serviceTier: resolvedServiceTier,
				maxTransientRetries: getMaxTransientRetries(),
				retryBackoffCeilMs: getRetryBackoffCeilMs(),
				metadata: isAnthropicProvider(resolved.provider)
					? { user_id: `user_${narratorId}_account__session_${active.conversationId}` }
					: undefined,
				// Exclude optional tools that haven't been loaded for this session
				toolFilter: (tool) => {
					if (OPTIONAL_TOOLS.has(tool.name)) {
						return active._enabledOptionalTools.has(tool.name);
					}
					// Overseer tools: only available if this narrator is an overseer
					if (OVERSEER_TOOLS.has(tool.name)) {
						return active._isOverseer;
					}
					// Review tools: only available for review chapter narrators
					if (REVIEW_TOOLS.has(tool.name)) {
						return active._chapterRole === "review";
					}
					// MCP tools: exclude tools with "deny" behavior
					if (tool.name.startsWith("mcp__")) {
						return isMcpToolAllowedForNarrator(tool);
					}
					return true;
				},
				permissionHandler: (toolName, input, toolUseId) =>
					handlePermission(
						narratorId,
						active.abortController.signal,
						toolName,
						input,
						toolUseId,
						active.cwd,
						locale,
					),
				onBeforeTurn: ctxMgmt.onBeforeTurn,
				getInjectedUserText: () => {
					let text: string | null = null;

					// Drain completed background subagent tasks (existing mechanism)
					const subDone = drainCompletedBackgroundSubagents(narratorId);
					if (subDone.length > 0) {
						const lines = subDone.map(
							(t) =>
								`[System] Background agent "${t.title}" (ID: ${t.id}) ${t.status}.\nResult preview: ${t.resultPreview || "(empty)"}\nUse Await({ type: "agent", id: "${t.id}" }) to see the full result, or Send({ id: "${t.id}", message }) to continue.`,
						);
						text = text ? `${text}\n\n${lines.join("\n\n")}` : lines.join("\n\n");
					}

					// Drain completed background bash tasks from unified service
					const bashDone = backgroundTaskService.drainBashNotificationsSync(narratorId);
					if (bashDone.length > 0) {
						const lines = bashDone.map(
							(t) =>
								`[System] Background bash "${t.title || t.id}" (ID: ${t.alias ?? t.id}) ${t.status}.` +
								`\nResult preview: ${t.outputPreview || "(empty)"}`,
						);
						text = text ? `${text}\n\n${lines.join("\n\n")}` : lines.join("\n\n");
					}

					return text;
				},
				getModelOverride: () => {
					// active.model is updated in real-time by updateNarratorModel()
					if (active.model !== config.model) {
						return active.model;
					}
					return null;
				},
				hookHandler: async (event, payload) => {
					const { hookService } = await import("./hook-service");
					return hookService.runHooks(
						event as import("./hook-service").HookEvent,
						{
							hook_event_name: event as import("./hook-service").HookEvent,
							narrator_id: narratorId,
							chapter_id: active._chapterId,
							project_id: active._projectId,
							cwd: active.cwd,
							...payload,
						},
						active._projectId,
						typeof payload.tool_name === "string" ? payload.tool_name : undefined,
					);
				},
				shouldStop: () => {
					if (active._feedbackSoftStop) {
						active._feedbackSoftStop = false;
						return true;
					}
					return false;
				},
				// onEvent receives only side-channel events (tool_output, tool_progress)
				// from executeTool — NOT yielded events like tool_result or assistant_message.
				onEvent: (event) => {
					processEvent(event, eventContext, hooks).catch((err) => {
						logger.error("Side-channel event processing error", {
							narratorId,
							eventType: event.type,
							error: String(err),
						});
					});
				},
			};

			// Convert images to base64 for the agent loop (first iteration only)
			let loopImages: Array<{ format: string; base64: string }> | undefined;
			if (currentImages?.length) {
				const resolved: Array<{ format: string; base64: string }> = [];
				for (const img of currentImages) {
					const filePath = getImagePath(narratorId, img.imageId);
					if (filePath) {
						try {
							const result = await imageToBase64(filePath);
							const mimeToFormat: Record<string, string> = {
								"image/png": "png",
								"image/jpeg": "jpeg",
								"image/gif": "gif",
								"image/webp": "webp",
							};
							// Prefer detected real format over stored mediaType
							const effectiveMime = result.detectedMediaType ?? img.mediaType;
							resolved.push({
								format: mimeToFormat[effectiveMime] ?? "png",
								base64: result.base64,
							});
						} catch {
							// Image file may have been deleted — skip silently
						}
					}
				}
				if (resolved.length > 0) loopImages = resolved;
				currentImages = undefined; // only attach images on the first iteration
			}

			// Run one agent loop pass

			// When replaying a pure tool-result turn, preserve the original packet shape:
			// no synthetic user text, no auto-added todos wrapper.
			const isPureToolResultReplay = !currentText.trim() && trailingToolResults.length > 0;
			const effectiveText = isPureToolResultReplay
				? ""
				: appendTodosContext(currentText, freshNarrator.todosJson);

			active._interruptCleanupDone = false;
			const result = await executeAgentLoop({
				config,
				userText: effectiveText,
				history,
				trailingToolResults,
				images: loopImages,
				eventContext,
				hooks,
			});

			if (
				shouldFinalizeAbortBeforeRecovery(
					result.aborted,
					active.abortController.signal.aborted,
					active._planApprovedContinue,
				)
			) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				await finalizeInterruptedRun(active, narratorId, partialId);
				loopWasInterrupted = true;
				break;
			}

			// --- Context length exceeded: aggressive prune (Codex) then compact/retry ---
			if (result.contextLengthExceeded && active.alive) {
				// Finalize or clean up the partial message from the failed turn.
				// If tools were already executed, the message is kept so the
				// retry's rebuilt history includes them.
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}

				const overflow = await handleContextOverflow({
					narratorId,
					locale,
					provider: active.provider,
					model: active.model,
					overflowRetries: contextOverflowRetries,
					maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
					onBroadcast(event) {
						broadcastToNarrator(narratorId, event as Parameters<typeof broadcastToNarrator>[1]);
					},
				});
				contextOverflowRetries = overflow.overflowRetries;

				if (overflow.action === "retry_pruned") {
					active._pruneBoundaryMessageId = overflow.boundaryMessageId;
					transientRetries = 0;
					continue;
				}
				if (overflow.action === "retry_compacted") {
					active.conversationId = overflow.newConversationId;
					transientRetries = 0;
					continue;
				}

				// All attempts failed
				logger.error("Context length exceeded after max retries", { narratorId });
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: "Context too long, compact failed",
					errorCode: "context_too_long_compact_failed",
				});
				active.events.emit("event", {
					type: "error",
					data: { message: "Context too long, compact failed" },
				});
				loopHadError = true;
				break;
			}

			// --- Transient API error: warn frontend and retry with backoff ---
			// For stateless providers, the agentLoop already retried internally with
			// identical history/content — reaching here means all in-loop retries
			// were exhausted.  Only stateful providers (responses/codex) benefit from
			// an outer retry that rebuilds history from DB.
			if (result.retryableError && active.alive) {
				if (!usesStatefulApi(resolved.provider)) {
					// Stateless provider: in-loop retries exhausted — give up.
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (partialId) {
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					await narratorService.updateStatus(narratorId, "idle", {
						substatus: ["error"],
						errorMessage: result.retryableError,
					});
					active.events.emit("event", {
						type: "error",
						data: { message: result.retryableError },
					});
					loopHadError = true;
					break;
				}
				// Stateful provider: outer retry with rebuilt history
				transientRetries++;
				const { shouldRetry } = await handleTransientError({
					narratorId,
					error: result.retryableError,
					retryCount: transientRetries,
					maxRetries: getMaxTransientRetries(),
					signal: active.abortController.signal,
				});
				if (shouldRetry) {
					// Finalize or clean up the partial message from the failed turn.
					// If tools were already executed (side effects occurred), the message
					// is kept so buildHistory includes them and the model won't repeat them.
					// Otherwise the partial is deleted so the retry starts fresh.
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (partialId) {
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					continue;
				}
				// If aborted during backoff sleep, don't mark as error — the
				// interrupt handler will set the correct status.
				if (!active.alive) {
					break;
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: result.retryableError,
				});
				active.events.emit("event", {
					type: "error",
					data: { message: result.retryableError },
				});
				loopHadError = true;
				break;
			}

			if (result.hasError && active.alive && !loopHadError) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: result.finalText,
					errorCode: result.errorCode,
				});
				active.events.emit("event", {
					type: "error",
					data: { message: result.finalText },
				});
				loopHadError = true;
				break;
			}

			// Reset transient retry counter on success
			transientRetries = 0;

			if (result.shouldUpdateTitle) {
				shouldUpdateTitle = true;
			}

			if (result.silentDisconnect) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}
			}

			// Smart interruption check — auto-continue if output was truncated.
			// When the last completed assistant turn was a tool-call turn, we must
			// replay the tool-result request packet instead of appending a textual
			// "continue" user message.
			if (result.interrupted && active.alive) {
				interruptionRetries++;
				if (interruptionRetries > MAX_INTERRUPTION_RETRIES) {
					logger.warn("Smart interruption check: max retries reached, stopping", {
						narratorId,
						retries: interruptionRetries,
					});
				} else if (result.shouldReplayInterruptedToolResultTurn) {
					logger.info("Smart interruption check: replaying interrupted tool-result turn", {
						narratorId,
						retries: interruptionRetries,
					});
					currentText = "";
					currentImages = undefined;
					continue;
				} else {
					const continueText = getToolMessage("interruptionContinue", locale);
					const userMsg = await narratorService.persistUserMessage(narratorId, continueText, [
						{ type: "text", text: continueText },
					]);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "working");
					currentText = continueText;
					currentImages = undefined;
					continue;
				}
			} else {
				// Reset counter on successful non-interrupted output
				interruptionRetries = 0;
			}

			// Plan approved — abort was triggered by onExitPlanMode so we persist
			// a user message and restart the loop to drive plan execution.
			if (
				active._planApprovedContinue === "compact" ||
				active._planApprovedContinue === "continue"
			) {
				const isCompact = active._planApprovedContinue === "compact";
				active._planApprovedContinue = undefined;
				active.abortController = new AbortController();

				if (isCompact) {
					await narratorService.updateStats(narratorId, 0);
				}

				const continuePrompt = getToolMessage(
					isCompact ? "planCompactContinue" : "exitPlanModeApproved",
					locale,
				);

				// If the user edited the plan, append the diff to the prompt
				// (only for non-compact — compact already has the edited plan in system prompt)
				const planDiff = pendingPlanDiff.get(narratorId);
				if (planDiff) pendingPlanDiff.delete(narratorId);
				const basePrompt =
					!isCompact && planDiff
						? getToolMessageWithParams("exitPlanModeApprovedWithDiff", locale, {
								diff: planDiff,
							})
						: continuePrompt;

				// Check for chained feedback — merge with diff if both exist
				const fb = pendingFeedback.get(narratorId);
				if (fb) pendingFeedback.delete(narratorId);
				const promptText = fb
					? basePrompt !== continuePrompt
						? `${basePrompt}\n\n${fb.feedbackText}`
						: fb.feedbackText
					: basePrompt;

				// Retrieve the approver userId so the message shows their avatar
				const approverId = pendingPlanApprover.get(narratorId);
				if (approverId) pendingPlanApprover.delete(narratorId);

				const userMsg = await narratorService.persistUserMessage(
					narratorId,
					promptText,
					[{ type: "text", text: promptText }],
					undefined,
					approverId,
				);
				broadcastToNarrator(narratorId, {
					type: "user_message",
					narratorId,
					message: userMsg,
				});
				active.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "working");
				currentText = promptText;
				currentImages = undefined;
				continue;
			}

			// User interrupt: stop the outer loop here. Without this guard, a post-abort
			// tool_result can make executeAgentLoop return before narrator-session notices
			// the interrupted state, causing pending-permission aborts to incorrectly
			// continue into buffered-message / done handling.
			if (result.aborted || active.abortController.signal.aborted) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				await finalizeInterruptedRun(active, narratorId, partialId);
				loopWasInterrupted = true;
				break;
			}

			// Check for chained feedback BEFORE marking idle/unread — when the user
			// approves a permission with attached text, the loop is aborted right
			// after the tool completes so the feedback is injected immediately
			// instead of waiting for the entire turn to finish.
			const fb = pendingFeedback.get(narratorId);
			if (fb) {
				pendingFeedback.delete(narratorId);
				const userMsg = await narratorService.persistUserMessage(narratorId, fb.feedbackText, [
					{ type: "text", text: fb.feedbackText },
				]);
				broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
				active.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "working");
				currentText = fb.feedbackText;
				continue;
			}

			// Review git state check — if the review narrator modified files,
			// reset and re-inject a message to continue the loop.
			if (active._chapterRole === "review" && active._chapterId && active.alive) {
				const gitCheck = await reviewService.checkAndResetGitState(active._chapterId);
				if (!gitCheck.clean && gitCheck.message) {
					const userMsg = await narratorService.persistUserMessage(narratorId, gitCheck.message, [
						{ type: "text", text: gitCheck.message },
					]);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "working");
					currentText = gitCheck.message;
					continue;
				}
				// Git is clean and loop ended normally — conclude the review
				if (!result.hasError) {
					await reviewService.concludeReview(active._chapterId);
				}
			}

			// Agent loop done — update stats (always, even if we continue with buffered messages)
			await narratorService.updateStats(narratorId, 0);

			// Compact if context usage is high (checked after a complete turn).
			// This is a fallback — the mid-turn compact in the context_usage handler
			// may have already started a background compact.
			// Before compacting, check prunedPercent: if < 80%, continue pruning instead.
			const { model: postModel, provider: postProvider } = resolveProviderAndModel(
				active.model,
				active.provider,
			);
			const postTurnThresholds = getContextThresholds(postModel, postProvider);
			if (
				active._contextUsagePct != null &&
				active._contextUsagePct >= postTurnThresholds.compactStart &&
				!compactLocks.has(narratorId)
			) {
				active._contextUsagePct = undefined;

				// Check current prunedPercent — if below threshold, prune further instead of compacting.
				// Exception: when pruning is disabled, skip the prune gate and compact directly.
				const narrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { prunedPercent: true, pruneEnabled: true },
				});
				const currentPrunedPct = narrator?.prunedPercent ?? 0;
				const pruneDisabled = narrator != null && !narrator.pruneEnabled;

				if (!pruneDisabled && currentPrunedPct < COMPACT_PRUNE_THRESHOLD_PCT) {
					logger.info(
						"Context above compactStart post-turn but prunedPercent below threshold, skipping compact",
						{
							narratorId,
							prunedPercent: currentPrunedPct,
							threshold: COMPACT_PRUNE_THRESHOLD_PCT,
						},
					);
				} else {
					const boundaryMessageId = await narratorService.getCompactBoundaryMessage(narratorId);

					if (boundaryMessageId) {
						logger.info("Context usage high, triggering background compact (post-turn)", {
							narratorId,
							boundaryMessageId,
						});

						// Fire-and-forget: compact runs in the background.
						// On completion it resets the narrator's conversationId so the next
						// agent loop iteration starts a fresh API conversation.
						runCustomCompact(narratorId, locale, boundaryMessageId)
							.then(() => {
								const current = activeNarrators.get(narratorId);
								if (current?.alive) {
									current.conversationId = randomUUID();
								}
							})
							.catch((compactErr) => {
								logger.error("Auto-compact failed", {
									narratorId,
									error: String(compactErr),
								});
							});
					} else {
						logger.info("Context usage high but not enough messages to compact", {
							narratorId,
						});
					}
				}
			}

			// Check for buffered messages BEFORE transitioning to idle/unread —
			// this prevents spurious notifications when there are queued messages.
			// When the loop had an error, skip consumption entirely so queued
			// messages are preserved for the user to retry or dismiss.
			if (!loopHadError) {
				const queue = bufferedMessages.get(narratorId);
				const buffered = queue?.[0];
				if (buffered) {
					queue?.shift();
					if (queue?.length === 0) bufferedMessages.delete(narratorId);
					// Remove consumed message from DB + cleanup persisted text files
					dbConsumeBuffered(buffered.id);
					// Broadcast which message was consumed + remaining queue snapshot
					const remaining = toBufferSummary(getBufferedMessages(narratorId));
					broadcastToNarrator(narratorId, {
						type: "buffer_consumed",
						narratorId,
						messageId: buffered.id,
						remaining,
					});
					// Save buffered text files to worktree
					const savedBufferedTextFiles: TextFileRef[] = [];
					if (buffered.textFiles?.length) {
						for (const file of buffered.textFiles) {
							savedBufferedTextFiles.push(await saveTextFileToWorktree(active.cwd, file));
						}
					}
					const persistBlocks: Array<
						| { type: "text"; text: string }
						| { type: "image"; imageId: string; filename: string; mediaType: string }
						| {
								type: "text_file";
								filename: string;
								size: number;
								filePath: string;
						  }
					> = [];
					if (buffered.images?.length) {
						for (const img of buffered.images) {
							persistBlocks.push({
								type: "image",
								imageId: img.imageId,
								filename: img.filename,
								mediaType: img.mediaType,
							});
						}
					}
					if (savedBufferedTextFiles.length > 0) {
						for (const tf of savedBufferedTextFiles) {
							persistBlocks.push({
								type: "text_file",
								filename: tf.filename,
								size: tf.size,
								filePath: tf.filePath,
							});
						}
					}
					const effectiveBufferedText =
						buffered.text + buildAttachedFilesHint(savedBufferedTextFiles);
					// contentJson blocks store raw user text; contentText stores effectiveBufferedText (see feedMessage)
					persistBlocks.push({ type: "text", text: buffered.text });
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						effectiveBufferedText,
						persistBlocks,
						buffered.commandText,
						buffered.createdBy,
					);
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "working");
					currentText = effectiveBufferedText;
					currentImages = buffered.images;
					continue;
				}
			}

			// Check for queued overseer permission requests before transitioning to done.
			// This only applies to overseer narrators — regular narrators have no entries.
			if (!loopHadError) {
				const overseerQueue = pendingOverseerMessages.get(narratorId);
				let nextValid: OverseerQueuedMessage | undefined;
				while (overseerQueue && overseerQueue.length > 0) {
					const candidate = overseerQueue.shift();
					if (!candidate) break;
					if (overseerQueue.length === 0) pendingOverseerMessages.delete(narratorId);
					if (pendingPermissions.has(candidate.requestId)) {
						nextValid = candidate;
						break;
					}
					// Permission was already resolved — skip to next
					logger.debug("Overseer queue: skipping already-resolved request", {
						narratorId,
						requestId: candidate.requestId,
					});
				}
				if (nextValid) {
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						nextValid.textForModel,
						nextValid.contentBlocks,
					);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					// Notify the source narrator that the overseer is now actively reviewing
					broadcastToNarrator(nextValid.broadcastTargetId, {
						type: "overseer_reviewing",
						narratorId: nextValid.broadcastTargetId,
						requestId: nextValid.requestId,
						toolUseId: nextValid.toolUseId,
						status: "reviewing",
					});
					await narratorService.updateStatus(narratorId, "working");
					currentText = nextValid.textForModel;
					currentImages = undefined;
					continue;
				}
			}

			// No buffered messages — now transition to idle/unread (triggers notifications)
			if (!loopHadError) {
				// Atomically transition working/waiting → idle with unread substatus.
				// If status has already moved (e.g. another loop took over after
				// hot reload, or user interrupted), the CAS is a no-op.
				await narratorService.compareAndSetStatus(narratorId, ["working", "waiting"], "idle", {
					substatus: ["unread"],
				});
			}

			active.events.emit("event", { type: "done", data: null });
			break;
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Narrator loop error", { narratorId, error: errorMsg });
		await narratorService.updateStatus(narratorId, "idle", {
			substatus: ["error"],
			errorMessage: errorMsg,
		});
		loopHadError = true;
		active.events.emit("event", { type: "error", data: { message: errorMsg } });
	} finally {
		active._loopRunning = false;
		active.alive = false;

		// --- Resolve conclusion watcher ---
		// When a subagent narrator completes (from the subagent page), check if
		// there's a conclusion watcher registered for post-completion updates.
		try {
			const narr = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { variant: true, parentNarratorId: true },
			});
			if (narr && isSubagentVariant(narr.variant)) {
				// For explore/plan subagents with a conclusion file, prefer reading
				// the file content over extracting from the last assistant message.
				let lastFinalText: string | undefined;
				const concEntry = getConclusionEntry(narratorId);
				if (concEntry) {
					try {
						if (existsSync(concEntry.absPath)) {
							const content = readFileSync(concEntry.absPath, "utf-8").trim();
							if (content && !loopHadError) {
								lastFinalText = content;
							}
							rmSync(concEntry.absPath, { force: true });
						}
					} catch (err) {
						logger.warn("Failed to read/cleanup takeover conclusion file", {
							narratorId,
							path: concEntry.absPath,
							error: err instanceof Error ? err.message : String(err),
						});
					}
					deleteConclusionFileId(narratorId);
				}
				if (!lastFinalText) {
					lastFinalText = await getSubagentFinalText(narratorId);
				}

				const watcher = getConclusionWatcher(narratorId);
				if (watcher) {
					removeConclusionWatcher(narratorId);
					// Resolve the last assistant message ID for result binding
					const resultMsgId = await getSubagentResultMessageId(narratorId);
					await updateToolCallConclusion({
						subagentId: narratorId,
						parentNarratorId: watcher.parentNarratorId,
						toolUseId: watcher.toolUseId,
						finalText: lastFinalText,
						hasError: loopHadError,
						resultMessageId: resultMsgId,
					});
				}
			}
		} catch (err) {
			logger.error("Failed to resolve suspended subagent / conclusion watcher", {
				narratorId,
				error: String(err),
			});
		}

		// Restore model after temporary override (slash command with modelOverride.mode="temporary")
		// Read from DB so this survives server restarts.
		try {
			const fresh = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { pendingModelRestore: true },
			});
			if (fresh?.pendingModelRestore) {
				const restoreModel = fresh.pendingModelRestore;
				await db
					.update(narrators)
					.set({
						model: restoreModel,
						pendingModelRestore: null,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, narratorId));
				broadcastToNarrator(narratorId, {
					type: "model_changed",
					narratorId,
					model: restoreModel,
				});
			}
		} catch (err) {
			logger.error("Failed to restore model after temporary override", {
				narratorId,
				error: String(err),
			});
		}

		if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
		// Stop file watcher for this narrator
		if (active._worktreePath) {
			worktreeWatcher.unwatch(active._worktreePath, narratorId);
		}
		// Persist conversationId so the next activation can resume the API session
		// (avoids cache miss from generating a new random UUID every time).
		narratorService.updateConversationId(narratorId, active.conversationId).catch((err) => {
			logger.error("Failed to persist conversationId", {
				narratorId,
				error: String(err),
			});
		});
		activeNarrators.delete(narratorId);
		planModeAskedOnce.delete(narratorId);
		clearStreamingSnapshot(narratorId);
		active.abortController.abort();
		active.events.emit("event", { type: "done", data: null });
		active.events.removeAllListeners();

		// --- Clean up per-narrator entries in global containers to prevent memory leaks ---
		// These containers are module-level (hotSafe) and persist across narrator sessions.
		// Without cleanup, entries accumulate on every interrupt/retry/error cycle.

		// 1. pendingPermissions: key = toolCallId, value.narratorId identifies the owner
		for (const [key, perm] of pendingPermissions) {
			if (perm.narratorId === narratorId) {
				try {
					perm.cleanup();
				} catch (e) {
					logger.debug("Failed to cleanup pending permission", {
						toolCallId: key,
						error: String(e),
					});
				}
				pendingPermissions.delete(key);
			}
		}

		// 2-5. Containers keyed directly by narratorId
		pendingFeedback.delete(narratorId);
		pendingPlanCompact.delete(narratorId);
		pendingPlanApprover.delete(narratorId);
		pendingPlanDiff.delete(narratorId);
		// 6. Subagent team tracking — alias registry and file change records
		clearAliasRegistry(narratorId);
		clearTeamFileChanges(narratorId);
		// When the loop ended with an error or was interrupted while buffered
		// messages exist, preserve those messages so the user can retry / the
		// next activation consumes them automatically.  Notify the frontend so
		// it keeps showing the queued messages.
		// DB rows are kept in sync:
		// - error/interrupted-with-queue: rows stay (recovered on next startup or consumed on retry)
		// - normal: rows are deleted (queue fully consumed)
		const hasBuffered = (bufferedMessages.get(narratorId)?.length ?? 0) > 0;
		if (loopHadError || (loopWasInterrupted && hasBuffered)) {
			// Only broadcast buffer_preserved on error — when interrupted the
			// auto-resume below will immediately consume the first message, so
			// showing a "preserved" notification would be misleading.
			if (loopHadError) {
				const preserved = bufferedMessages.get(narratorId);
				if (preserved?.length) {
					broadcastToNarrator(narratorId, {
						type: "buffer_preserved",
						narratorId,
						messages: toBufferSummary(preserved),
					});
				}
			}
		} else {
			bufferedMessages.delete(narratorId);
			dbClearAllBuffered(narratorId);
		}

		// Drain any remaining overseer queue items — notify source narrators
		// that the overseer is no longer reviewing so the UI clears the
		// "queued for overseer" badge.
		const remainingOverseerQueue = pendingOverseerMessages.get(narratorId);
		if (remainingOverseerQueue && remainingOverseerQueue.length > 0) {
			for (const queued of remainingOverseerQueue) {
				broadcastToNarrator(queued.broadcastTargetId, {
					type: "overseer_reviewing",
					narratorId: queued.broadcastTargetId,
					requestId: queued.requestId,
					toolUseId: queued.toolUseId,
					status: "cleared",
				});
			}
			logger.debug("Overseer loop ended with queued items, cleared UI state", {
				narratorId,
				droppedCount: remainingOverseerQueue.length,
			});
		}
		pendingOverseerMessages.delete(narratorId);

		// 6. Per-narrator git status Promise cache (Bash before-status snapshots)
		active._bashBeforeStatus?.clear();

		if (shouldUpdateTitle) {
			generateAndSetTitle(narratorId, locale).catch(() => {});
		}

		// Auto-resume: when the loop was interrupted and buffered messages remain,
		// schedule a new agent loop to consume them.  This makes "long-press cut in
		// line" work end-to-end — the priority message is preserved in the buffer
		// and a fresh loop picks it up immediately instead of waiting for the user
		// to manually send another message.
		if (
			loopWasInterrupted &&
			!loopHadError &&
			(bufferedMessages.get(narratorId)?.length ?? 0) > 0
		) {
			const queue = bufferedMessages.get(narratorId);
			const first = queue?.shift();
			if (queue && first) {
				if (queue.length === 0) bufferedMessages.delete(narratorId);
				dbConsumeBuffered(first.id);
				broadcastToNarrator(narratorId, {
					type: "buffer_consumed",
					narratorId,
					messageId: first.id,
					remaining: toBufferSummary(getBufferedMessages(narratorId)),
				});

				// Fire-and-forget: start a new session with the first buffered message.
				// feedMessage handles ensureNarrator + persistUserMessage + runAgentLoop.
				feedMessage(
					narratorId,
					first.text,
					first.images,
					locale,
					active._replyInUserLanguage ?? false,
					first.commandText,
					first.createdBy,
					first.textFiles,
				)
					.then(({ userMsg }) => {
						broadcastToNarrator(narratorId, {
							type: "user_message",
							narratorId,
							message: userMsg,
						});
					})
					.catch(async (err) => {
						logger.error("Auto-resume after interrupt failed", {
							narratorId,
							error: String(err),
						});
						await narratorService
							.updateStatus(narratorId, "idle", { substatus: ["error"], errorMessage: String(err) })
							.catch(() => {});
						broadcastToNarrator(narratorId, {
							type: "narrator_error",
							narratorId,
							error: String(err),
						});
					});
			}
		}
	}
}

// === Message feeding ===

/** Build the attached_files hint appended to the user prompt when text files are present. */
function buildAttachedFilesHint(textFiles: TextFileRef[]): string {
	if (textFiles.length === 0) return "";
	const lines = textFiles.map((f) => {
		return `- ${f.filePath} (${f.filename}, ${formatFileSize(f.size)})`;
	});
	return (
		"\n\n<attached_files>\n" +
		"The user has attached the following files for your reference. " +
		"Use the Read tool to access their contents when needed.\n" +
		`${lines.join("\n")}\n` +
		"</attached_files>"
	);
}

/**
 * Persist a user message and kick off the agent loop in the background.
 * Returns the active narrator and persisted message for SSE subscription.
 */
async function feedMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
	commandText?: string | null,
	userId?: string | null,
	rawTextFiles?: File[],
): Promise<{ active: ActiveNarrator; userMsg: typeof narratorMessages.$inferSelect }> {
	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);

	// Save text files to worktree (now that we have active.cwd)
	const savedTextFiles: TextFileRef[] = [];
	if (rawTextFiles?.length) {
		for (const file of rawTextFiles) {
			savedTextFiles.push(await saveTextFileToWorktree(active.cwd, file));
		}
	}

	const persistBlocks: Array<
		| { type: "text"; text: string }
		| { type: "image"; imageId: string; filename: string; mediaType: string }
		| { type: "text_file"; filename: string; size: number; filePath: string }
	> = [];
	if (images?.length) {
		for (const img of images) {
			persistBlocks.push({
				type: "image",
				imageId: img.imageId,
				filename: img.filename,
				mediaType: img.mediaType,
			});
		}
	}
	if (savedTextFiles.length > 0) {
		for (const tf of savedTextFiles) {
			persistBlocks.push({
				type: "text_file",
				filename: tf.filename,
				size: tf.size,
				filePath: tf.filePath,
			});
		}
	}
	// NOTE: persistBlocks stores the raw user text (without attached_files hint) so that
	// contentJson reflects what the user actually typed. The effectivePrompt (with hint)
	// is stored in contentText and sent to the AI. This intentional split means:
	//   - contentJson (blocks) → frontend display, shows original user input
	//   - contentText → FTS search index + AI prompt, includes file references
	persistBlocks.push({ type: "text", text: prompt });

	// When the user sends images without text, inject a placeholder so that
	// providers that gate on non-empty content still include the image blocks.
	const effectiveText = !prompt.trim() && images?.length ? "[user sent image(s)]" : prompt;

	// Build the effective prompt with attached file hints
	const effectivePrompt = effectiveText + buildAttachedFilesHint(savedTextFiles);

	const userMsg = await narratorService.persistUserMessage(
		narratorId,
		effectivePrompt,
		persistBlocks,
		commandText,
		userId,
	);

	active._lastTokenUsage = undefined;
	active._ttftMs = undefined;
	active._turnStartedAt = new Date().toISOString();

	// --- Resolve manual_override if active ---
	// When the user sends a message directly on a subagent page while the parent
	// narrator is blocked in waitForManualOverride, we must resolve that Promise
	// first. Otherwise the parent stays blocked forever while the subagent runs
	// independently via narrator-session. We also register a ConclusionWatcher so
	// the parent's tool_call result is updated when this independent run finishes.
	const narrator = await narratorService.getById(narratorId);
	if (isSubagentVariant(narrator.variant) && narrator.parentNarratorId) {
		const currentSubstatus = parseSubstatus(narrator.substatus);
		if (currentSubstatus.includes("manual_override")) {
			const overrideEntry = getManualOverrideMap().get(narratorId);
			if (overrideEntry) {
				const currentFinalText = await getSubagentFinalText(narratorId);

				// Set up conclusion file for explore/plan subagents so that
				// Write/Edit are properly redirected during the takeover run.
				if (isReadOnlySubagentVariant(narrator.variant)) {
					setConclusionFileId(narratorId, generateWordSlug(), active.cwd);
				}

				registerConclusionWatcher(
					narratorId,
					overrideEntry.parentNarratorId,
					overrideEntry.toolUseId,
				);
				resolveManualOverride(narratorId, currentFinalText, false);
			}
		}
	}

	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });
	if ((narrator.messageCount ?? 0) <= 1 && !narrator.title) {
		generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	// Start agent loop in background
	runAgentLoop(active, effectivePrompt, images).catch(async (err) => {
		logger.error("runAgentLoop unhandled error", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "idle", {
			substatus: ["error"],
			errorMessage: String(err),
		});
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { active, userMsg };
}

// === Subagent conclusion helpers ===

/**
 * Extract the final text from a subagent's last assistant message.
 * Used when resolving suspended subagents or updating conclusions.
 */
export async function getSubagentFinalText(narratorId: string): Promise<string> {
	const messages = await narratorService.getMessagesSinceLastCompact(narratorId);
	// Walk backwards to find the last assistant message with text content
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const blocks = msg.contentJson as Array<{ type: string; text?: string }>;
		if (!blocks || !Array.isArray(blocks)) continue;
		const textParts = blocks
			.filter((b) => b.type === "text" && b.text)
			.map((b) => b.text ?? "")
			.join("\n");
		if (textParts.trim()) return textParts;
	}
	return "(no output)";
}

/**
 * Get the ID of the subagent's last assistant message.
 * Used to bind tool call results to a specific subagent message.
 */
export async function getSubagentResultMessageId(narratorId: string): Promise<string | undefined> {
	const messages = await narratorService.getMessagesSinceLastCompact(narratorId);
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i].id;
	}
	return undefined;
}

/**
 * Update the parent narrator's tool_call outputJson with a new conclusion.
 * Used for scenario 2 (conclusion watcher) and the update-conclusion API.
 */
export async function updateToolCallConclusion(opts: {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	finalText: string;
	hasError: boolean;
	/** Pass after copy-on-write to scope the update to the private message copy. */
	messageId?: string;
	/** The subagent assistant message that produced this result. */
	resultMessageId?: string;
}): Promise<void> {
	const {
		subagentId,
		parentNarratorId,
		toolUseId,
		finalText,
		hasError,
		messageId,
		resultMessageId,
	} = opts;
	const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
	const output = resultPrefix + (finalText || "(no output)");

	await narratorService.updateToolCallResult(
		toolUseId,
		{
			output,
			status: hasError ? "fail" : "success",
			errorMessage: hasError ? finalText : undefined,
			resultMessageId,
		},
		messageId,
	);

	// Broadcast to parent narrator so the frontend can update the SubagentCard
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_conclusion_updated",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		output,
		hasError,
	});
}

// === Public API ===

/**
 * Send a message to a narrator (fire-and-forget).
 * Persists the user message, broadcasts it via WS, kicks off the agent loop
 * in the background, and returns the persisted user message.
 * All streaming events are delivered exclusively via WebSocket.
 */
export async function sendMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
	commandText?: string | null,
	userId?: string | null,
	textFiles?: File[],
): Promise<typeof narratorMessages.$inferSelect> {
	const { userMsg } = await feedMessage(
		narratorId,
		prompt,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
		textFiles,
	);
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: userMsg,
	});
	return userMsg;
}

/**
 * Retry the last user message without creating a new message record.
 * Deletes any assistant/error response that followed the last user message,
 * then re-runs the agent loop with the existing user message text.
 */
export async function retryLastMessage(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ ok: boolean }> {
	// Check if this is a subagent — subagent messages all have parentToolUseId
	// set, so we must not filter on isNull(parentToolUseId) for them.
	const narrator = await narratorService.getById(narratorId);
	const isSubagent = isSubagentVariant(narrator.variant);

	// Find the last top-level message via refs
	const lastRef = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				isSubagent ? undefined : isNull(narratorMessages.parentToolUseId),
				inArray(narratorMessages.role, ["user", "assistant"]),
			),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1);

	if (!lastRef.length) {
		throw new NotFoundError("No messages to retry", narratorId);
	}

	const lastMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, lastRef[0].messageId),
	});
	if (!lastMsg || lastMsg.role !== "user") {
		throw new NotFoundError("Last message is not a user message", narratorId);
	}

	const prompt = lastMsg.contentText ?? "";
	if (!prompt.trim()) {
		throw new NotFoundError("Last user message has no text", narratorId);
	}

	// Delete any messages after the last user message (old assistant responses)
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, lastMsg.id);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	const imageRefs = extractImageRefs(lastMsg.contentJson);

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	runAgentLoop(active, prompt, imageRefs.length > 0 ? imageRefs : undefined).catch(async (err) => {
		logger.error("runAgentLoop unhandled error (retry)", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "idle", {
			substatus: ["error"],
			errorMessage: String(err),
		});
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { ok: true };
}

/**
 * Continue the agent loop.
 *
 * If the last top-level message is a tool-call assistant turn, resumes by
 * reconstructing the tool-result upload packet (buildHistory produces
 * trailingToolResults).
 *
 * Otherwise (e.g. the assistant's text reply was truncated), sends a
 * locale-aware "please continue" user message via feedMessage so the
 * model receives a properly localised prompt.
 */
export async function continueNarrator(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ ok: boolean }> {
	// If the last top-level message is a tool-call assistant turn, replay the
	// tool-result request packet instead of appending a textual "continue".
	const rawMsgs = await narratorService.getMessagesSinceLastCompact(narratorId);

	// Subagent messages all have parentToolUseId set — clear it so
	// getLastContinuableTopLevelMessage can find them (same as runAgentLoop).
	const narrator = await narratorService.getById(narratorId);
	const msgs = isSubagentVariant(narrator.variant)
		? rawMsgs.map((m) => ({ ...m, parentToolUseId: null }))
		: rawMsgs;

	const lastTopLevelMessage = getLastContinuableTopLevelMessage(msgs);
	const shouldReplayToolResults = shouldReplayToolResultPacket(lastTopLevelMessage);

	if (!shouldReplayToolResults) {
		// No pending tool calls — send a simple "continue" user message.
		const continueText = getToolMessage("userContinue", locale);
		const { userMsg } = await feedMessage(
			narratorId,
			continueText,
			undefined,
			locale,
			replyInUserLanguage,
		);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
		return { ok: true };
	}

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	active._lastTokenUsage = undefined;
	active._ttftMs = undefined;
	active._turnStartedAt = new Date().toISOString();
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	// Pass empty text — buildHistory will reconstruct the trailing tool-result
	// packet so the provider sees the same follow-up turn again.
	runAgentLoop(active, "", undefined).catch(async (err) => {
		logger.error("runAgentLoop unhandled error (continue)", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "idle", {
			substatus: ["error"],
			errorMessage: String(err),
		});
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { ok: true };
}

/**
 * Rollback to a specific block within a message.
 * Deletes all blocks after the given blockIndex in the target message,
 * plus all subsequent messages. Does NOT re-run the agent loop.
 * File changes are automatically reverted via snapshot system.
 */
export async function rollbackToBlock(
	narratorId: string,
	messageId: string,
	blockIndex: number,
): Promise<{ ok: boolean }> {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);

	const blocks = Array.isArray(targetMsg.contentJson)
		? (targetMsg.contentJson as { type: string; id?: string }[])
		: [];

	if (blockIndex < 0 || blockIndex >= blocks.length) {
		throw new NotFoundError(
			`Block index ${blockIndex} out of range (0..${blocks.length - 1})`,
			messageId,
		);
	}

	// Step 1: Delete all messages after the target message (includes file revert)
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, messageId);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	// Step 2: Delete blocks after blockIndex in the target message
	const blocksToDelete: Array<{ messageId: string; blockIndex: number }> = [];
	for (let i = blocks.length - 1; i > blockIndex; i--) {
		blocksToDelete.push({ messageId, blockIndex: i });
	}

	if (blocksToDelete.length > 0) {
		await narratorService.deleteMessageBlocks(narratorId, blocksToDelete);

		// Broadcast the updated message
		const updatedMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
		});
		if (updatedMsg) {
			broadcastToNarrator(narratorId, {
				type: "message_updated",
				narratorId,
				message: updatedMsg,
			});
		}
	}

	return { ok: true };
}

/** Extract image refs from a message's contentJson. */
function extractImageRefs(contentJson: unknown): ImageRef[] {
	const imageRefs: ImageRef[] = [];
	if (Array.isArray(contentJson)) {
		for (const block of contentJson as Array<Record<string, unknown>>) {
			if (
				block.type === "image" &&
				typeof block.imageId === "string" &&
				typeof block.filename === "string" &&
				typeof block.mediaType === "string"
			) {
				imageRefs.push({
					imageId: block.imageId as string,
					filename: block.filename as string,
					mediaType: block.mediaType as string,
				});
			}
		}
	}
	return imageRefs;
}

/**
 * Edit a user message and regenerate the response.
 * Updates the message content, deletes everything after it, and re-runs the agent loop.
 * If rollback is true and the narrator is bound to a chapter, resets git to the state
 * before the original message was sent.
 */
export async function editAndRegenerate(
	narratorId: string,
	messageId: string,
	newContent: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	rollback = false,
): Promise<{ ok: boolean }> {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);
	if (targetMsg.role !== "user") {
		throw new NotFoundError("Can only edit user messages", messageId);
	}

	// File rollback is now handled automatically by deleteMessagesAfter via snapshot revert.
	// The `rollback` parameter is kept for API compatibility but is no longer needed —
	// snapshot-based revert is always applied when messages with file changes are deleted.
	if (rollback) {
		logger.debug("editAndRegenerate: rollback param is now a no-op (auto-revert via snapshot)", {
			narratorId,
		});
	}

	// Update the message content
	const newContentJson: Array<Record<string, string | undefined>> = [
		{ type: "text", text: newContent },
	];

	// Preserve existing images in contentJson
	const existingImages = extractImageRefs(targetMsg.contentJson);
	for (const img of existingImages) {
		newContentJson.push({
			type: "image",
			imageId: img.imageId,
			filename: img.filename,
			mediaType: img.mediaType,
		});
	}

	const privateMessageId = await narratorService.copyOnWriteMessage(narratorId, messageId, {
		contentText: newContent,
		contentJson: newContentJson,
	});

	// Broadcast the updated message.  If copy-on-write changed the message ID,
	// force a reload so the client replaces the old shared row with the private copy.
	const updatedMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, privateMessageId),
	});
	if (updatedMsg) {
		broadcastToNarrator(narratorId, {
			type: "message_updated",
			narratorId,
			message: updatedMsg,
		});
		if (privateMessageId !== messageId) {
			broadcastToNarrator(narratorId, { type: "full_reload", narratorId });
		}
	}

	// Delete everything after this message
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(
		narratorId,
		privateMessageId,
	);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	const imageRefs = existingImages;

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	active._lastTokenUsage = undefined;
	active._ttftMs = undefined;
	active._turnStartedAt = new Date().toISOString();
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	runAgentLoop(active, newContent, imageRefs.length > 0 ? imageRefs : undefined).catch(
		async (err) => {
			logger.error("runAgentLoop unhandled error (editAndRegenerate)", {
				narratorId,
				error: String(err),
			});
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
			});
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
			});
		},
	);

	return { ok: true };
}

/**
 * Start or feed a message into a narrator.
 * Yields NarratorEvent objects for consumption (used by chapter-merge).
 */
export async function* startSession(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
): AsyncGenerator<NarratorEvent> {
	let active: ActiveNarrator;
	let userMsg: typeof narratorMessages.$inferSelect;
	try {
		({ active, userMsg } = await feedMessage(
			narratorId,
			prompt,
			images,
			locale,
			replyInUserLanguage,
		));
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		yield { type: "error", data: { message: errorMsg } };
		yield { type: "done", data: null };
		return;
	}

	// Subscribe to narrator events and yield them
	const eventQueue: NarratorEvent[] = [];
	let resolve: (() => void) | null = null;
	let done = false;

	const onEvent = (event: NarratorEvent) => {
		eventQueue.push(event);
		if (resolve) {
			const r = resolve;
			resolve = null;
			r();
		}
	};

	active.events.on("event", onEvent);

	// Emit user_message AFTER subscribing so it's not lost
	// Broadcast to all WS subscribers so other clients see the user message in real-time
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: userMsg,
	});
	yield { type: "user_message", data: userMsg };

	try {
		while (!done) {
			while (eventQueue.length > 0) {
				const event = eventQueue.shift();
				if (!event) break;
				if (event.type === "done") {
					yield event;
					done = true;
					break;
				}
				yield event;
			}
			if (!done) {
				await new Promise<void>((r) => {
					resolve = r;
				});
			}
		}
	} finally {
		active.events.off("event", onEvent);
	}
}

// === Narrator control ===

/**
 * Clean up a partial (incomplete) assistant message and its related records.
 * Deletes children first to satisfy FK constraints.
 */
export async function cleanupPartialMessage(partialId: string, narratorId: string): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, partialId));
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, partialId));
			await tx.delete(narratorMessages).where(eq(narratorMessages.id, partialId));
		});
	} catch (err) {
		logger.warn("Failed to clean up partial message on error", {
			narratorId,
			partialId,
			error: String(err),
		});
	}
}

/**
 * Finalize or clean up a partial message before retry.
 *
 * Three-way decision:
 * 1. **No executed tools AND no meaningful content** — the entire partial
 *    message is deleted via {@link cleanupPartialMessage}.
 * 2. **No executed tools BUT has streamed text/reasoning** — the message is
 *    preserved; any unexecuted tool_call records and their tool_use blocks
 *    are stripped from contentJson.
 * 3. **Some tools executed** — the message is kept. Unexecuted tool_calls
 *    (initializing / pending) are removed, running ones are marked as fail
 *    (interrupted), and contentJson is trimmed to match.
 *
 * @returns `true` if the message was kept (finalized), `false` if deleted.
 */
export async function finalizeOrCleanupPartialMessage(
	partialId: string,
	narratorId: string,
): Promise<boolean> {
	try {
		const toolCalls = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.messageId, partialId),
			columns: { id: true, toolUseId: true, status: true },
		});

		// Statuses that indicate the tool was actually executed (side effects occurred)
		const executedStatuses = new Set(["success", "fail", "running"]);
		const executed = toolCalls.filter((tc) => executedStatuses.has(tc.status));

		if (executed.length === 0) {
			// No tool was actually executed — but check if the message has
			// meaningful text/reasoning content that should be preserved
			// (e.g. user interrupted while the model was streaming a long text block).
			const hasContent = await db.transaction(async (tx) => {
				const msg = await tx.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, partialId),
					columns: { contentJson: true },
				});
				const blocks = Array.isArray(msg?.contentJson)
					? (msg.contentJson as Array<Record<string, unknown>>)
					: [];
				const meaningful = blocks.some(
					(b) =>
						(b.type === "text" && typeof b.text === "string" && b.text.length > 0) ||
						(b.type === "reasoning" && typeof b.text === "string" && b.text.length > 0),
				);

				if (!meaningful) return false;

				// Has streamed content worth keeping — remove any unexecuted tool_call
				// records and their corresponding tool_use blocks from contentJson,
				// but preserve the message itself.
				// Note: since executed.length === 0, toolCalls here are all unexecuted.
				if (toolCalls.length > 0) {
					const toolUseIds = new Set(toolCalls.map((tc) => tc.toolUseId));
					await tx.delete(narratorToolCalls).where(
						inArray(
							narratorToolCalls.id,
							toolCalls.map((tc) => tc.id),
						),
					);
					const filtered = blocks.filter(
						(block) => block.type !== "tool_use" || !toolUseIds.has(block.id as string),
					);
					await tx
						.update(narratorMessages)
						.set({ contentJson: filtered })
						.where(eq(narratorMessages.id, partialId));
				}

				logger.info("Preserved partial message with streamed content (no tool execution)", {
					narratorId,
					partialId,
					blockCount: blocks.length,
					removedToolCalls: toolCalls.length,
				});
				return true;
			});

			if (!hasContent) {
				// Truly empty — safe to delete
				await cleanupPartialMessage(partialId, narratorId);
				return false;
			}
			return true;
		}

		// Some tools were executed — keep the message, clean up the rest
		const unexecuted = toolCalls.filter((tc) => !executedStatuses.has(tc.status));
		const unexecutedToolUseIds = new Set(unexecuted.map((tc) => tc.toolUseId));

		await db.transaction(async (tx) => {
			// Delete unexecuted tool_call records
			if (unexecuted.length > 0) {
				await tx.delete(narratorToolCalls).where(
					inArray(
						narratorToolCalls.id,
						unexecuted.map((tc) => tc.id),
					),
				);
			}

			// Mark running tool_calls as fail (interrupted by retry)
			const running = executed.filter((tc) => tc.status === "running");
			if (running.length > 0) {
				await tx
					.update(narratorToolCalls)
					.set({
						status: "fail",
						errorMessage: "Interrupted by API error during retry",
					})
					.where(
						inArray(
							narratorToolCalls.id,
							running.map((tc) => tc.id),
						),
					);
			}

			// Remove unexecuted tool_use blocks from contentJson
			if (unexecutedToolUseIds.size > 0) {
				const msg = await tx.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, partialId),
					columns: { contentJson: true },
				});
				if (msg && Array.isArray(msg.contentJson)) {
					const filtered = (msg.contentJson as Array<Record<string, unknown>>).filter(
						(block) => block.type !== "tool_use" || !unexecutedToolUseIds.has(block.id as string),
					);
					await tx
						.update(narratorMessages)
						.set({ contentJson: filtered })
						.where(eq(narratorMessages.id, partialId));
				}
			}
		});

		logger.info("Finalized partial message with executed tool calls", {
			narratorId,
			partialId,
			executedCount: executed.length,
			removedCount: unexecuted.length,
		});
		return true;
	} catch (err) {
		logger.warn("Failed to finalize partial message, falling back to cleanup", {
			narratorId,
			partialId,
			error: String(err),
		});
		await cleanupPartialMessage(partialId, narratorId);
		return false;
	}
}

/**
 * Mark any in-flight tool calls for this narrator as failed.
 * Without this, an interrupt leaves orphaned tool call records in
 * "initializing" / "pending" / "running" state, which breaks the
 */
async function cleanupOrphanedToolCalls(narratorId: string, locale: Locale = "en"): Promise<void> {
	const staleStatuses = ["initializing", "pending", "running"] as const;
	await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: "Narrator interrupted by user",
			outputJson: getToolMessage("interruptedByUser", locale),
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...staleStatuses]),
			),
		);
}

/**
 * Mark orphaned tool calls as success — used when the agent loop is
 * intentionally aborted after plan approval (the tool did complete
 * successfully but the result event was never yielded).
 */
async function completeOrphanedToolCalls(narratorId: string): Promise<void> {
	const staleStatuses = ["initializing", "pending", "running"] as const;
	await db
		.update(narratorToolCalls)
		.set({ status: "success" })
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...staleStatuses]),
			),
		);
}

export function interruptNarrator(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active) return false;
	active.abortController.abort();
	// Cleanup is handled by the agent loop's onErrorCleanup callback
	// when it detects the "Aborted" error — no need to duplicate here.
	logger.info("Narrator interrupted", { narratorId });
	return true;
}

/** Gracefully close a narrator. */
export function closeNarrator(narratorId: string): void {
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	active.alive = false;
	if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
	active.abortController.abort();
	clearStreamingSnapshot(narratorId);
	cleanupOrphanedToolCalls(narratorId, active.locale).catch((err) => {
		logger.error("Failed to clean up orphaned tool calls on close", {
			narratorId,
			error: String(err),
		});
	});
	// Clean up any browser sessions owned by this narrator
	import("../lib/browser/session")
		.then(({ cleanupNarrator }) => {
			cleanupNarrator(narratorId).catch((err) => {
				logger.warn("Failed to cleanup browser sessions", { narratorId, error: String(err) });
			});
		})
		.catch((err) => {
			logger.warn("Failed to load browser session module", { narratorId, error: String(err) });
		});
	logger.info("Narrator closed", { narratorId });
}

export function isNarratorActive(narratorId: string): boolean {
	return activeNarrators.has(narratorId);
}

// === Dynamic narrator controls ===

export function updateNarratorModel(narratorId: string, model: string): void {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		const effectiveModel = resolveEffectiveModel(model);
		active.model = effectiveModel;
		active.provider = resolveProvider(effectiveModel);
		broadcastToNarrator(narratorId, {
			type: "model_changed",
			narratorId,
			model,
		});
	}
}

/**
 * Set a temporary model override for the current agent loop.
 * Persists the original model to DB so it survives server restarts.
 * After the loop finishes, the model will be restored automatically.
 */
export async function setTemporaryModelRestore(
	narratorId: string,
	originalModel: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ pendingModelRestore: originalModel, updatedAt: now })
		.where(eq(narrators.id, narratorId));
}

/**
 * Restore models for all narrators that have a pending temporary model override.
 * Called once at server startup to recover from unclean shutdowns.
 */
export async function restorePendingModelOverrides(): Promise<void> {
	const pending = await db.query.narrators.findMany({
		where: isNotNull(narrators.pendingModelRestore),
		columns: { id: true, pendingModelRestore: true },
	});
	if (pending.length === 0) return;

	const now = new Date().toISOString();
	for (const n of pending) {
		await db
			.update(narrators)
			.set({
				model: n.pendingModelRestore,
				pendingModelRestore: null,
				updatedAt: now,
			})
			.where(eq(narrators.id, n.id));
		logger.info("Restored model from pending temporary override on startup", {
			narratorId: n.id,
			restoreModel: n.pendingModelRestore,
		});
	}
}

/** Update the cached chapter role for a live narrator (e.g. after promote). */
export function updateNarratorChapterRole(narratorId: string, role: string): void {
	const active = activeNarrators.get(narratorId);
	if (active) {
		active._chapterRole = role;
	}
}

export async function updateNarratorPermissionMode(
	narratorId: string,
	mode: string,
): Promise<void> {
	// Permission mode is read from DB in real-time by handlePermission.
	// When switching to/from plan mode, manage the plan file ID on the active narrator.
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	if (mode === "plan") {
		if (!active._planFileId) {
			active._planFileId = generateWordSlug();
		}
		// _previousPermissionMode is also persisted in DB by narratorService.updatePermissionMode,
		// so onExitPlanMode will read it from DB if the in-memory value is missing.
	} else {
		active._planFileId = undefined;
		active._previousPermissionMode = undefined;
		planModeAskedOnce.delete(narratorId);
	}
}

// === Startup recovery ===

/**
 * Guard against running recovery during Bun --hot reloads.
 * In --hot mode the process stays alive but modules are re-evaluated,
 * so activeNarrators is reset to an empty Map while agent loops are
 * still running in the background.  Running recovery in that state
 * would incorrectly mark in-flight tool calls as "server restart".
 *
 * We use a globalThis flag that survives module re-evaluation (the
 * process is the same) to detect hot reloads vs. cold starts.
 */
const HOT_RELOAD_GUARD = Symbol.for("narrafork.narrator.initialized");

/** Clean up stale in-progress states left by a previous server run. */
export async function recoverOnStartup(): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	if ((globalThis as any)[HOT_RELOAD_GUARD]) {
		logger.info("Skipping narrator recovery (hot reload detected)");
		return;
	}
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	(globalThis as any)[HOT_RELOAD_GUARD] = true;

	// Clean up any residual worktree watchers from a previous server run.
	// On restart (or hot reload), old fs.watch handles may leak if the previous
	// process didn't shut down cleanly, causing phantom CPU usage from inotify.
	worktreeWatcher.shutdown();

	const now = new Date().toISOString();
	// Legacy status migrations (from older DB versions).
	// Note: "thinking" is already migrated to "working" by db/index.ts at startup,
	// so it is not included here. These handle even older status values.
	const legacyMigrations = [
		["active", "idle", "[]"],
		["paused", "idle", "[]"],
		["completed", "archived", "[]"],
	] as const;
	const legacyStmt = sqlite.prepare(
		"UPDATE narrators SET status = ?, substatus = ?, updated_at = ? WHERE status = ?",
	);
	for (const [from, to, sub] of legacyMigrations) {
		const result = legacyStmt.run(to, sub, now, from);
		if (result.changes > 0) {
			logger.info(`Narrator status migrated: ${from} → ${to}`, { count: result.changes });
		}
	}
	// Active narrators interrupted by server restart — mark with interrupted substatus
	// so users can see which narrators were mid-run.
	const interruptStmt = sqlite.prepare(
		"UPDATE narrators SET status = ?, substatus = ?, updated_at = ? WHERE status = ?",
	);
	for (const activeStatus of ["working", "waiting"] as const) {
		const result = interruptStmt.run("idle", '["interrupted"]', now, activeStatus);
		if (result.changes > 0) {
			logger.info(`Narrator status migrated: ${activeStatus} → idle [interrupted]`, {
				count: result.changes,
			});
		}
	}

	const stalePermissions = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "pending"),
	});
	if (stalePermissions.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				permissionDecidedBy: "server_restart",
				permissionDecidedAt: now,
			})
			.where(eq(narratorToolCalls.status, "pending"));
		logger.info("Stale pending tool calls auto-denied on startup", {
			count: stalePermissions.length,
		});
	}

	const staleToolCalls = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "running"),
	});
	if (staleToolCalls.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				outputJson: getToolMessage("interruptedByServerRestart"),
			})
			.where(eq(narratorToolCalls.status, "running"));
		logger.info("Stale running tool calls marked as failed on startup", {
			count: staleToolCalls.length,
		});
	}

	// Also recover tool calls stuck in "initializing" (permission check never started)
	const staleInitializing = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "initializing"),
	});
	if (staleInitializing.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				outputJson: getToolMessage("interruptedByServerRestart"),
			})
			.where(eq(narratorToolCalls.status, "initializing"));
		logger.info("Stale initializing tool calls marked as failed on startup", {
			count: staleInitializing.length,
		});
	}

	// Clean up stale "compacting" marker messages left by a previous crash.
	// These are compact operations that started but never finalized.
	const staleCompacting = await db.query.narratorMessages.findMany({
		where: and(
			eq(narratorMessages.role, "system"),
			eq(narratorMessages.contentText, "[Compacting]"),
		),
	});
	for (const msg of staleCompacting) {
		await narratorService.removeCompactingMessage(msg.narratorId, msg.id).catch((e) => {
			logger.error("Failed to clean up stale compacting message", {
				messageId: msg.id,
				narratorId: msg.narratorId,
				error: String(e),
			});
		});
	}
	if (staleCompacting.length > 0) {
		logger.info("Stale compacting messages cleaned up on startup", {
			count: staleCompacting.length,
		});
	}

	// Recover persisted buffered messages into the in-memory Map.
	// These survive server restarts so users don't lose queued messages.
	const bufferedRows = db
		.select()
		.from(narratorBufferedMessages)
		.orderBy(narratorBufferedMessages.narratorId, narratorBufferedMessages.seq)
		.all();
	if (bufferedRows.length > 0) {
		const grouped = new Map<string, BufferedMessage[]>();
		for (const row of bufferedRows) {
			const images: ImageRef[] | undefined = row.imagesJson
				? JSON.parse(row.imagesJson)
				: undefined;
			const creator: BufferCreator | null = row.creatorJson ? JSON.parse(row.creatorJson) : null;
			const savedFiles: SavedBufferedFile[] | undefined = row.textFilePathsJson
				? JSON.parse(row.textFilePathsJson)
				: undefined;
			const textFiles = savedFiles?.length ? loadBufferedTextFiles(savedFiles) : undefined;
			const entry: BufferedMessage = {
				id: row.id,
				text: row.text,
				images,
				textFiles: textFiles?.length ? textFiles : undefined,
				bufferedAt: row.bufferedAt,
				commandText: row.commandText,
				createdBy: row.createdBy,
				creator,
				_savedFiles: savedFiles,
			};
			const list = grouped.get(row.narratorId) ?? [];
			list.push(entry);
			grouped.set(row.narratorId, list);
		}
		for (const [nid, msgs] of grouped) {
			bufferedMessages.set(nid, msgs);
		}
		logger.info("Recovered buffered messages from DB on startup", {
			narrators: grouped.size,
			messages: bufferedRows.length,
		});
	}
}

// ---------------------------------------------------------------------------
// Optional tool management
// ---------------------------------------------------------------------------

/**
 * Enable an optional tool for a narrator.
 * Persists to DB and updates the in-memory session if active.
 */
export async function loadOptionalTool(
	narratorId: string,
	toolName: string,
): Promise<"loaded" | "already_loaded" | "unknown_tool"> {
	if (!OPTIONAL_TOOLS.has(toolName)) return "unknown_tool";

	// Read current enabled tools from DB
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { enabledTools: true },
	});
	const current: string[] = (narrator?.enabledTools as string[] | null) ?? [];
	if (current.includes(toolName)) return "already_loaded";

	// Persist
	await db
		.update(narrators)
		.set({ enabledTools: [...current, toolName] })
		.where(eq(narrators.id, narratorId));

	// Also update in-memory session if active
	const active = activeNarrators.get(narratorId);
	if (active) {
		active._enabledOptionalTools.add(toolName);
	}

	logger.info("Optional tool loaded", { narratorId, toolName });
	return "loaded";
}

/** Get the set of enabled optional tool names for a narrator session. */
export function getEnabledOptionalTools(narratorId: string): Set<string> {
	const active = activeNarrators.get(narratorId);
	return active?._enabledOptionalTools ?? new Set();
}

// === Re-exports from extracted modules ===
// These maintain backward compatibility for external imports.

export {
	clearBufferedMessages,
	getBufferedMessages,
	pushBufferedMessage,
	removeBufferedMessage,
	reorderBufferedMessages,
	toBufferSummary,
	updateBufferedMessage,
} from "./narrator-buffer";
export {
	compactLocks,
	isCompactInProgress,
	pruneLocks,
	pruneToolCalls,
	runCustomCompact,
	runSegmentCompact,
	shouldFinalizeAbortBeforeRecovery,
} from "./narrator-compact";
export type {
	BlacklistDir,
	CommandBlacklistEntry,
	CommandWhitelistEntry,
	PermissionDecisionMeta,
	PermissionDecisionOpts,
	ResolvePermissionOpts,
	WhitelistDir,
} from "./narrator-permission";
export {
	extractToolPaths,
	handlePermission,
	isInsideWorktree,
	resolveAllPendingPermissions,
	resolvePermission,
	resolvePermissionDecision,
} from "./narrator-permission";

export type { BufferCreator, NarratorEvent } from "./narrator-session-state";
