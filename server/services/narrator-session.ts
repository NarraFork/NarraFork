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
	projects,
} from "../db/schema";
import { buildHistory, type ReasoningEffort, resolveProviderAndModel } from "../lib/agent";
import { clearPipelineStateIfActive } from "../lib/agent/pipeline-state";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import {
	clearBehaviorFenceEditGrant,
	grantBehaviorFenceEdit,
} from "../lib/agent/tools/behavior-fence-grant";
import { KNOWLEDGE_KIND_DENY_CORE, OPTIONAL_TOOLS, REVIEW_TOOLS } from "../lib/agent/tools/index";
import { AsyncMutex } from "../lib/async-mutex";
import {
	type BooleanOverride,
	type DangerReflectionOverride,
	normalizeAutoContinuationMode,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
	resolveAutoContinuationMode,
	resolveBooleanOverride,
} from "../lib/boolean-override";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { withDbRetry } from "../lib/db-resilience";
import { NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	formatSubagentModelRestrictionDescription,
	getDisabledToolSet,
} from "../lib/narrator-custom-traits";
import {
	addTrait,
	isKnowledgeStewardNarrator,
	isPlanModeTrait,
	isReadOnlySubagentVariant,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
	redactDraftTraits,
} from "../lib/narrator-utils";
import { normalizeLegacyPlanPreviousPermissionMode } from "../lib/permission-modes";
import { getHome } from "../lib/platform";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import {
	FOLLOW_DEFAULT_MODEL,
	getAutoCompactKeepPairs,
	getAutoCompactPruneThreshold,
	getContextThresholds,
	getSettingsRevision,
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	usesCodexModel,
	usesStatefulModel,
} from "../lib/settings";
import type { ImageRef, TextFileRef } from "../lib/uploads";
import { getImagePath, imageToBase64, saveTextFileToWorktree } from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import {
	type CompletedBgSubagentNotification,
	drainCompletedBackgroundSubagents,
	formatBackgroundCompletionNotifications,
} from "./bg-completion-queue";
import { drainGroupMessagesForNarrator, formatGroupMessages } from "./chat-group-queue";
import { gitService } from "./git-service";
import { getStatusSummaryCached, invalidateStatus } from "./git-status-cache";
import { knowledgeInjection } from "./knowledge-injection";
import { knowledgeService } from "./knowledge-service";
import {
	clearStreamingSnapshot,
	type EventHandlerContext,
	type EventHooks,
	processEvent,
	type TokenUsageSnapshot,
} from "./narrator-event-handler";
import { executeAgentLoop } from "./narrator-executor";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import {
	getContextOverflowFailureError,
	getFirstTokenTimeoutMs,
	getMaxTransientRetries,
	getRetryBackoffCeilMs,
	getSilentToolCallThreshold,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
} from "./narrator-recovery";
import {
	enrichToolUseBlocks,
	handleBashCommand,
	narratorService,
	truncateToolIO,
} from "./narrator-service";
import { clearAliasRegistry, clearTeamFileChanges } from "./narrator-subagent";
import {
	generateAndSetTitle,
	generateQuickTitle,
	setProvisionalTitleFromUserMessage,
} from "./narrator-title";
import {
	drainParentInboundMessages,
	formatParentInboundMessages,
	type ParentInboundMessage,
} from "./parent-inbound-queue";
import { reviewService } from "./review-service";
import { broadcastSpecChanged } from "./spec-broadcast";
import { buildBehaviorFenceReminder, buildSpecToolResultReminder } from "./spec-reminder";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { drainSpecUpdatesForNarrator, formatSpecUpdateSideCars } from "./spec-update-queue";
import { specVfsService } from "./spec-vfs-service";
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
import {
	clearTakenOver,
	consumePendingBackgroundFinalize,
	consumePendingStopTakeover,
	isTakenOver,
} from "./subagent-takeover";
import { isMcpToolAllowedForNarrator } from "./subagent-tools";
import { worktreeWatcher } from "./worktree-watcher";

// === In-memory state (imported from narrator-session-state) ===

import type {
	ActiveNarrator,
	BufferCreator,
	BufferedMessage,
	NarratorEvent,
	SavedBufferedFile,
} from "./narrator-session-state";
import {
	activeNarrators,
	activeSubagentSettings,
	bufferedMessages,
	clearActiveHistoryCompactPending,
	compactLocks,
	hasPendingHistoryCompact,
	knowledgeInjectionCycleStates,
	narratorCreationLocks,
	pendingFeedback,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
	pruneLocks,
	resetActiveUpstreamSession,
	updateActiveSubagentModel,
	updateActiveSubagentReasoningEffort,
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
	pruneToolCalls,
	runCustomCompact,
	runPlanCompact,
	shouldFinalizeAbortBeforeRecovery,
	triggerMidTurnCompact,
} from "./narrator-compact";
import { handlePermission } from "./narrator-permission";
import {
	ensureNarratorPlanFileId,
	enterNarratorPlanMode,
	exitNarratorPlanMode,
} from "./narrator-plan-mode";

// Tools that may modify files on disk — git status is tracked after these complete
const FILE_MUTATING_TOOLS = new Set(["Write", "Edit", SHELL_TOOL_NAME]);
const MAX_CONTINUATION_NO_TOOL_TURNS = 3;

function parseQueuedNewCommand(message: string, commandText?: string | null) {
	const raw = commandText?.trim().startsWith("/new") ? commandText.trim() : message.trim();
	const match = raw.match(/^\/new(?:\s+([\s\S]*))?$/);
	if (!match) return null;
	return { rawCommand: raw, initialMessage: match[1]?.trim() ?? "" };
}

/**
 * Recognize a buffered `/goal <objective>` command. When the narrator was busy,
 * the route queues the raw command instead of appending the protected task
 * immediately; on consumption we parse it here and run executeQueuedGoalCommand.
 * Returns null (fall through to a normal model turn) when there is no objective.
 */
export function parseQueuedGoalCommand(message: string, commandText?: string | null) {
	const raw = commandText?.trim().startsWith("/goal") ? commandText.trim() : message.trim();
	const match = raw.match(/^\/goal(?:\s+([\s\S]*))?$/);
	if (!match) return null;
	const objective = match[1]?.trim() ?? "";
	if (!objective) return null;
	return { rawCommand: raw, objective };
}

function normalizeOptionalBooleanOverride(value: unknown): BooleanOverride | undefined {
	return value == null ? undefined : normalizeBooleanOverride(value);
}

function normalizeOptionalDangerReflectionOverride(
	value: unknown,
): DangerReflectionOverride | undefined {
	return value == null ? undefined : normalizeDangerReflectionOverride(value);
}

/**
 * Resolve the remote devices this session may route to. Best-effort: any error
 * (e.g. the device layer being unavailable) yields an empty list so the agent
 * loop simply runs local-only and never exposes device parameters.
 */
async function resolveSessionDevices(
	projectId: string | null,
): Promise<import("../lib/agent").AgentConfig["availableDevices"]> {
	try {
		const { getSessionDevices } = await import("./device-connection-service");
		return await getSessionDevices(projectId);
	} catch {
		return [];
	}
}

/**
 * Apply a SwitchDevice request: persist the new default on the narrator record
 * and update the live session so subsequent tool calls route accordingly.
 */
async function applySessionDefaultDevice(
	narratorId: string,
	active: ActiveNarrator,
	deviceId: string | null,
): Promise<boolean> {
	try {
		active._defaultDeviceId = deviceId;
		await db
			.update(narrators)
			.set({ defaultDeviceId: deviceId, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId));
		return true;
	} catch (err) {
		logger.warn("Failed to persist session default device", {
			narratorId,
			deviceId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

async function executeQueuedNewCommand(
	active: ActiveNarrator,
	buffered: BufferedMessage,
	initialMessage: string,
): Promise<string> {
	const sourceNarrator = await narratorService.getById(active.narratorId);
	const newNarrator = await narratorService.create({
		chapterId: null,
		model: sourceNarrator.model ?? undefined,
		systemPrompt: sourceNarrator.systemPrompt ?? undefined,
		permissionMode: sourceNarrator.permissionMode ?? undefined,
		reasoningEffort: sourceNarrator.reasoningEffort ?? undefined,
		fastMode: sourceNarrator.fastMode ?? undefined,
		relaxedPlan: sourceNarrator.relaxedPlan ?? undefined,
		planReflectionAutoApproveOverride: normalizeOptionalBooleanOverride(
			sourceNarrator.planReflectionAutoApproveOverride,
		),
		dangerReflectionOverride: normalizeOptionalDangerReflectionOverride(
			sourceNarrator.dangerReflectionOverride,
		),
		cwd: active.cwd,
	});

	if (initialMessage) {
		await sendMessage(
			newNarrator.id,
			initialMessage,
			buffered.images,
			active.locale,
			active._replyInUserLanguage ?? false,
			undefined,
			buffered.createdBy,
			buffered.textFiles,
		);
	}

	return newNarrator.id;
}

/**
 * Persist and broadcast a `spec_goal_added` display card so the /goal command
 * leaves a durable, self-explanatory record in the conversation (rather than
 * only a transient toast). `added` is false when an identical task already
 * existed. Uses the `disp` role so this UI-only notice never enters the model
 * history (unlike spec_continuation, which is an instruction to the model).
 * Shared by the idle route path and the busy buffer-consumption path.
 */
export async function persistGoalAddedNotice(
	narratorId: string,
	objective: string,
	added: boolean,
): Promise<void> {
	const text = added
		? `Dynamic Spec: protected task added — ${objective}`
		: `Dynamic Spec: protected task already exists — ${objective}`;
	// persistDisplayMessage broadcasts a `message` event itself.
	await narratorService.persistDisplayMessage(narratorId, text, [
		{ type: "spec_goal_added", task: objective, added, protected: true },
	]);
}

/**
 * Execute a buffered `/goal` command: persist it as the canonical user message
 * (so it stays visible in the conversation) and append the protected task to
 * spec://tasks.json. Runs when a queued /goal is consumed after the turn that
 * was busy at submit time. Does not start a model turn.
 */
async function executeQueuedGoalCommand(
	narratorId: string,
	buffered: BufferedMessage,
	objective: string,
): Promise<void> {
	const rawCommand = buffered.commandText?.trim() || buffered.text;
	const userMsg = await narratorService.persistUserMessage(
		narratorId,
		rawCommand,
		[{ type: "text", text: rawCommand }],
		rawCommand,
		buffered.createdBy,
	);
	broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
	const { added, written } = await specVfsService.appendProtectedSpecTask(narratorId, objective);
	if (added) {
		broadcastSpecChanged(
			narratorId,
			{ uri: written.uri, path: written.path, revisionId: written.revisionId },
			"ui",
			"user",
		);
	}
	// The task mutation is the command's durable effect. A display-only confirmation
	// card is best-effort so a transient message persistence failure cannot mark the
	// narrator errored or prevent later buffered messages from draining.
	await persistGoalAddedNotice(narratorId, objective, added).catch((err) => {
		logger.warn("Failed to persist queued /goal confirmation notice", {
			narratorId,
			error: String(err),
		});
	});
}

/**
 * Consume the next buffered message after an interrupted loop and dispatch it.
 * `/new` and `/goal` are terminal (no model turn), so after handling them we
 * recurse to keep draining any messages queued behind them — otherwise a plain
 * message queued after a `/goal` would sit in the buffer until the user sends
 * again. A normal message goes through feedMessage, whose own loop drains the
 * rest at its next safe boundary. Returns after scheduling the first message.
 */
function resumeNextBufferedMessage(active: ActiveNarrator, locale: Locale): void {
	const narratorId = active.narratorId;
	if ((bufferedMessages.get(narratorId)?.length ?? 0) === 0) return;
	const queue = bufferedMessages.get(narratorId);
	const first = queue?.shift();
	if (!queue || !first) return;
	if (queue.length === 0) bufferedMessages.delete(narratorId);
	dbConsumeBuffered(first.id);
	broadcastToNarrator(narratorId, {
		type: "buffer_consumed",
		narratorId,
		messageId: first.id,
		remaining: toBufferSummary(getBufferedMessages(narratorId)),
	});

	const settleAfterTerminalCommand = async () => {
		// More queued behind this terminal command → keep draining; else settle idle.
		if ((bufferedMessages.get(narratorId)?.length ?? 0) > 0) {
			resumeNextBufferedMessage(active, locale);
			return;
		}
		await narratorService
			.compareAndSetStatus(narratorId, ["working", "waiting"], "idle", { substatus: ["unread"] })
			.catch(() => {});
	};
	const handleTerminalCommandError = async (label: string, err: unknown) => {
		logger.error(`Queued ${label} execution after interrupt failed`, {
			narratorId,
			error: String(err),
		});
		await narratorService
			.updateStatus(narratorId, "idle", { substatus: ["error"], errorMessage: String(err) })
			.catch(() => {});
		broadcastToNarrator(narratorId, { type: "narrator_error", narratorId, error: String(err) });
	};

	const newCommand = parseQueuedNewCommand(first.text, first.commandText);
	const goalCommand = parseQueuedGoalCommand(first.text, first.commandText);
	if (newCommand) {
		executeQueuedNewCommand(active, first, newCommand.initialMessage)
			.then(async (newNarratorId) => {
				broadcastToNarrator(narratorId, {
					type: "queued_new_narrator_created",
					narratorId,
					messageId: first.id,
					newNarratorId,
				});
				await settleAfterTerminalCommand();
			})
			.catch((err) => handleTerminalCommandError("/new", err));
	} else if (goalCommand) {
		// Queued /goal: append the protected task now (no model turn), then drain/settle.
		executeQueuedGoalCommand(narratorId, first, goalCommand.objective)
			.then(() => settleAfterTerminalCommand())
			.catch((err) => handleTerminalCommandError("/goal", err));
	} else {
		feedMessage(
			narratorId,
			first.text,
			first.images,
			locale,
			active._replyInUserLanguage ?? false,
			first.commandText,
			first.createdBy,
			first.textFiles,
			first.bashCommand,
		)
			.then(({ userMsg, userBroadcasted }) => {
				if (!userBroadcasted) {
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
				}
			})
			.catch((err) => handleTerminalCommandError("auto-resume message", err));
	}
}

const backgroundCompletionStartLock = new AsyncMutex();

function isDynamicPruningWindowEnabled(thresholds: {
	pruneStart: number;
	compactStart: number;
}): boolean {
	return thresholds.compactStart > thresholds.pruneStart;
}

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
	narrator: { systemPrompt: string | null; contextSummary: string | null },
	cwd: string,
	locale: Locale,
	replyInUserLanguage: boolean,
	planMode = false,
	planFileId?: string,
	defaultSystemPrompt?: string | null,
	deviceContext?: {
		devices?: import("./narrator-prompt").BuildPromptOptions["devices"];
		defaultDeviceId?: string | null;
	},
): Promise<{ prompt: string | null; usedCompactSummary: boolean }> {
	return buildEffectiveSystemPrompt({
		basePrompt: narrator.systemPrompt,
		cwd,
		locale,
		contextSummary: narrator.contextSummary,
		planMode,
		planFileId,
		planAllowInlinePlan: settings.agent.planModeAllowInlinePlan,
		replyInUserLanguage,
		defaultSystemPrompt,
		devices: deviceContext?.devices,
		defaultDeviceId: deviceContext?.defaultDeviceId,
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

	// Restore or create the persistent plan file ID if the narrator is already in plan mode
	// (e.g. server restart recovery). Keeping this stable prevents file-based plans from
	// becoming orphaned when the active narrator is recreated.
	const isPlanMode = isPlanModeTrait(narrator.traits);
	const planFileId = isPlanMode
		? await ensureNarratorPlanFileId(narratorId, narrator.planFileId)
		: undefined;

	// Resolve remote execution devices for the Execution Devices prompt section.
	const sessionDevices = await resolveSessionDevices(narratorProjectId ?? null);

	const { prompt: effectiveSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
		{
			systemPrompt: narrator.systemPrompt,
			contextSummary: effectiveContextSummary,
		},
		narratorCwd,
		locale,
		replyInUserLanguage,
		isPlanMode,
		planFileId,
		settings.agent.defaultSystemPrompt,
		{ devices: sessionDevices, defaultDeviceId: narrator.defaultDeviceId ?? null },
	);

	// Resolve and warm skill summaries for the Skill tool. This is context-based:
	// global + project git path + current working directory/workspace.
	let skillRoot: string | null = projectGitPath;
	let skillScopeKey: string | null = null;
	try {
		const { resolveSkillRoot } = await import("./skill-service");
		skillRoot = await resolveSkillRoot(projectGitPath, narratorCwd);
		const { warmSkillCacheForContext } = await import("../lib/agent/tools/skill");
		skillScopeKey = await warmSkillCacheForContext({ projectGitPath, cwd: narratorCwd });
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

	const narratorModelRef = narrator.model ?? FOLLOW_DEFAULT_MODEL;
	const narratorModel = resolveEffectiveModel(narratorModelRef);
	const narratorProvider = resolveProvider(narratorModel);

	const active: ActiveNarrator = {
		abortController,
		narratorId,
		conversationId: effectiveConversationId ?? randomUUID(),
		_resetUpstreamSessionOnNextRequest: effectiveConversationId == null,
		cwd: narratorCwd,
		_modelRef: narratorModelRef,
		_settingsRevision: getSettingsRevision(),
		model: narratorModel,
		provider: narratorProvider,
		_reasoningEffortRef: narrator.reasoningEffort ?? null,
		reasoningEffort:
			narrator.reasoningEffort ??
			resolveDefaultReasoningEffort(narratorProvider, narratorModel) ??
			null,
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
		_skillScopeKey: skillScopeKey,
		_enabledOptionalTools: new Set(),
		_disabledTools: getDisabledToolSet(narrator.traits),
		_narratorKind: isKnowledgeStewardNarrator(narrator.traits) ? "knowledge" : undefined,
		_interruptCleanupDone: false,
		_substatus: new Set(),
		// Explicitly null so a rebuilt active never carries a stale/undefined user.
		// Set per-trigger by feedMessage / continue / retry / re-execute paths.
		_currentUserId: null,
		// Session default execution device (null → local). Restored from the
		// narrator record; mutated by the SwitchDevice tool.
		_defaultDeviceId: narrator.defaultDeviceId ?? null,
	};

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

/**
 * Broadcast a kept partial assistant message after an interrupt so the
 * frontend can replace its optimistic streaming text with the persisted
 * message in the same render. Without this, the frontend's `onStatusChange`
 * (interrupted) clears the streaming blocks but never receives the real
 * message, so the already-streamed text disappears until the next catch-up.
 *
 * Mirrors the `assistant_message` broadcast in narrator-event-handler so the
 * WS payload is shaped identically to the normal completion path.
 */
async function broadcastInterruptedPartialMessage(
	narratorId: string,
	partialId: string,
): Promise<void> {
	try {
		const fullMessage = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, partialId),
			with: { toolCalls: true, sideCars: true },
		});
		if (!fullMessage) return;

		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, partialId),
			),
			columns: { seq: true },
		});

		const processed = enrichToolUseBlocks(truncateToolIO([{ ...fullMessage, seq: ref?.seq }]))[0];

		// Subagent dual-broadcast: also surface this message on the parent
		// narrator's page (as a child of the spawning tool_use) so the
		// SubagentCard's transcript stays consistent with the subagent page.
		// Mirror the eventContext resolution: prefer the takeover watcher, then
		// fall back to the narrator record's parentNarratorId.
		const parentToolUseId = fullMessage.parentToolUseId ?? undefined;
		if (parentToolUseId) {
			const watcher = getConclusionWatcher(narratorId);
			let parentNarratorId = watcher?.parentNarratorId;
			if (!parentNarratorId) {
				const self = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { parentNarratorId: true },
				});
				parentNarratorId = self?.parentNarratorId ?? undefined;
			}
			if (parentNarratorId && parentNarratorId !== narratorId) {
				broadcastToNarrator(parentNarratorId, {
					type: "message",
					narratorId: parentNarratorId,
					message: processed,
				});
			}
		}

		// Primary broadcast to this narrator's own subscribers. Strip
		// parentToolUseId so the subagent page treats it as a top-level message.
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: { ...processed, parentToolUseId: null },
		});
	} catch (err) {
		logger.warn("Failed to broadcast interrupted partial message", {
			narratorId,
			partialId,
			error: String(err),
		});
	}
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

	if (partialId) {
		try {
			// Preserve the partial assistant message before any deletion decision runs.
			// `finalizeOrCleanupPartialMessage` keeps messages that contain executed
			// tool calls, so first convert in-flight calls on this partial message into
			// explicit interrupted failures.  Running this sequentially avoids a race
			// where the finalizer sees only "initializing" tool calls and deletes the
			// whole message, making already-visible tool calls disappear from history.
			await markInterruptedToolCallsForMessage(narratorId, partialId, active.locale);
			const kept = await finalizeOrCleanupPartialMessage(partialId, narratorId);
			// Broadcast the kept message so the frontend swaps its optimistic
			// streaming text for the persisted message immediately, instead of
			// dropping it until the next catch-up reload.
			if (kept) {
				await broadcastInterruptedPartialMessage(narratorId, partialId);
			}
		} catch (err) {
			logger.warn("Failed to finalize interrupted partial message", {
				narratorId,
				partialId,
				error: String(err),
			});
		}
	}

	try {
		await cleanupOrphanedToolCalls(narratorId, active.locale);
	} catch (err) {
		logger.warn("Failed to clean up orphaned tool calls after interrupt", {
			narratorId,
			error: String(err),
		});
	}

	try {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { status: true, substatus: true },
		});
		const currentSubstatus = parseSubstatus(current?.substatus);
		if (!(current?.status === "idle" && currentSubstatus.includes("error"))) {
			await narratorService.updateStatus(narratorId, "idle", { substatus: ["interrupted"] });
		}
	} catch (err) {
		logger.warn("Failed to update narrator status after interrupt", {
			narratorId,
			error: String(err),
		});
	}
}

// === Agent loop execution ===

/** Sum non-cached input + output tokens from a usage snapshot (for round token totals). */
function tokenUsageValue(usage?: TokenUsageSnapshot): number {
	if (!usage) return 0;
	const nonCachedInput = Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0));
	if (usage.inputTokens != null || usage.completionTokens != null) {
		return nonCachedInput + Math.max(0, usage.completionTokens ?? 0);
	}
	return Math.max(0, usage.promptTokens ?? 0) + Math.max(0, usage.completionTokens ?? 0);
}

async function ensureSkillCacheFreshForActiveNarrator(active: ActiveNarrator): Promise<void> {
	try {
		const { warmSkillCacheForContext } = await import("../lib/agent/tools/skill");
		active._skillScopeKey = await warmSkillCacheForContext({
			projectGitPath: active._projectGitPath ?? null,
			cwd: active.cwd,
		});
	} catch (err) {
		logger.debug("Failed to refresh skill cache for active narrator", {
			narratorId: active.narratorId,
			error: String(err),
		});
	}
}

export async function updateActiveNarratorCwdAndSkillContext(
	narratorId: string,
	cwd: string,
): Promise<void> {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return;
	active.cwd = cwd;
	try {
		const { resolveSkillRoot } = await import("./skill-service");
		active._skillRoot = await resolveSkillRoot(active._projectGitPath, cwd);
	} catch {
		active._skillRoot = active._projectGitPath ?? null;
	}
	if (!active._chapterId) {
		try {
			active._isInGitRepo = await gitService.isGitRepo(cwd);
		} catch {
			active._isInGitRepo = false;
		}
	}
	await ensureSkillCacheFreshForActiveNarrator(active);
}

/**
 * Compute the most recent pass's token delta (non-cached input + output) and
 * reset the per-pass baseline. Callers sum the returned value across passes to
 * obtain a round-level token total for the Stop hook.
 */
function accountTokenUsageForTurn(active: ActiveNarrator): number {
	const tokenDelta = Math.max(
		0,
		tokenUsageValue(active._lastTokenUsage) - tokenUsageValue(active._tokenUsageBaseline),
	);
	active._tokenUsageBaseline = active._lastTokenUsage;
	return tokenDelta;
}

async function loadCompiledSpecForContinuation(narratorId: string) {
	const file = await specVfsService.readTasksFileForNarrator(narratorId);
	let document = parseSpecTasksDocument(file.content);
	let compiled = compileSpecTasks(document);
	if (!compiled.currentTask && compiled.nextTask) {
		let promoted = false;
		document = {
			tasks: document.tasks.map((task) => {
				if (!promoted && task.status === "todo") {
					promoted = true;
					return { ...task, status: "doing" as const };
				}
				return task;
			}),
		};
		const content = `${JSON.stringify(document, null, "\t")}\n`;
		await specVfsService.writeSpecFile(narratorId, "spec://tasks.json", content, {
			createdBy: "system",
			allowProtectedTaskMutation: true,
		});
		compiled = compileSpecTasks(document);
	}
	return compiled;
}

async function maybeStartSpecContinuation(
	active: ActiveNarrator,
	freshNarrator: {
		permissionMode?: string | null;
		traits?: unknown;
		autoContinuationOverride?: string | null;
	},
	loopHadError: boolean,
): Promise<string | null> {
	if (loopHadError || isPlanModeTrait(freshNarrator.traits) || active._continuationSuppressed) {
		return null;
	}
	// Resolve the effective auto-continuation mode (narrator override → global default)
	const globalMode = normalizeAutoContinuationMode(settings.agent.autoContinuationMode);
	const effectiveMode = resolveAutoContinuationMode(
		freshNarrator.autoContinuationOverride,
		globalMode,
	);
	if (effectiveMode === "off") return null;

	let compiled: ReturnType<typeof compileSpecTasks>;
	try {
		compiled = await loadCompiledSpecForContinuation(active.narratorId);
	} catch (err) {
		logger.debug("Spec continuation skipped", {
			narratorId: active.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	// "protectedOnly": only continue if there are protected tasks still open
	if (effectiveMode === "protectedOnly" && compiled.protectedOpenCount === 0) {
		return null;
	}

	const current = compiled.currentTask;
	if (!current) {
		// Only blocked tasks remain
		if (effectiveMode === "blockStop") return null;
		const blocked = compiled.tasks.find((task) => task.status === "blocked");
		if (!blocked) return null;
		const prompt =
			active.locale === "zh-CN"
				? `Dynamic Spec 阻塞提醒：当前有 blocked 任务仍处于活跃状态，不能视为完成。\n\n阻塞任务：${blocked.text}${blocked.protected ? " [protected]" : ""}\n\n请说明阻塞原因；如果需要用户决策或补充信息，请使用 AskUserQuestion 请求指导。收到指导后，再更新 spec://tasks.json。`
				: `Dynamic Spec blocked reminder: a blocked task is still active and must not be treated as complete.\n\nBlocked task: ${blocked.text}${blocked.protected ? " [protected]" : ""}\n\nExplain the blocker. If user guidance or missing information is needed, use AskUserQuestion to request guidance. After guidance arrives, update spec://tasks.json.`;
		const msg = await narratorService.persistSystemMessage(active.narratorId, prompt, [
			{
				type: "spec_blocked_continuation",
				task: blocked.text,
				protected: blocked.protected === true,
			},
		]);
		broadcastToNarrator(active.narratorId, {
			type: "message",
			narratorId: active.narratorId,
			message: {
				id: msg.id,
				narratorId: active.narratorId,
				role: msg.role,
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				seq: msg.seq,
				children: [],
			},
		});
		active._continuationTurn = true;
		return prompt;
	}
	const protectedNote = current.protected
		? "\nThis task is protected. Only mark it done after concrete completion evidence; protected completion requires taskReflection."
		: "";
	const prompt =
		active.locale === "zh-CN"
			? `Dynamic Spec 自动续跑：继续当前 doing 任务。\n\n当前任务：${current.text}${current.protected ? " [protected]" : ""}\n\n请继续执行这个任务。完成或受阻时，更新 spec://tasks.json；如果没有 doing 任务但还有 todo，系统会自动切换到下一个 todo。不要要求用户再次确认是否继续。${current.protected ? "\n该任务是 protected task。只有在有具体验收证据时才能标记 done；完成 protected task 会触发 taskReflection。" : ""}`
			: `Dynamic Spec auto-continuation: continue the current doing task.\n\nCurrent task: ${current.text}${current.protected ? " [protected]" : ""}\n\nContinue working on this task. When it is done or blocked, update spec://tasks.json. If there is no doing task but todo tasks remain, the system will automatically switch to the next todo. Do not ask the user whether to continue.${protectedNote}`;
	const msg = await narratorService.persistSystemMessage(active.narratorId, prompt, [
		{ type: "spec_continuation", task: current.text, protected: current.protected === true },
	]);
	broadcastToNarrator(active.narratorId, {
		type: "message",
		narratorId: active.narratorId,
		message: {
			id: msg.id,
			narratorId: active.narratorId,
			role: msg.role,
			contentJson: msg.contentJson,
			contentText: msg.contentText,
			createdAt: msg.createdAt,
			seq: msg.seq,
			children: [],
		},
	});
	active._continuationTurn = true;
	return prompt;
}

/**
 * Start an auto-continuation turn if the Dynamic Spec has an active/blocked
 * task that warrants continuing. Returns the injected prompt, or null when there
 * is nothing to continue.
 */
async function maybeStartContinuation(
	active: ActiveNarrator,
	freshNarrator: { permissionMode?: string | null; traits?: unknown },
	loopHadError: boolean,
): Promise<string | null> {
	const prompt = await maybeStartSpecContinuation(active, freshNarrator, loopHadError);
	// A continuation turn is not the user's turn — never let it write the behavior fence,
	// even if the preceding user turn ran zero tools and left the grant open.
	if (prompt) clearBehaviorFenceEditGrant(active.narratorId);
	return prompt;
}

async function persistAndBroadcastSystemMessage(
	narratorId: string,
	text: string,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	contentBlocks?: any[],
): Promise<typeof narratorMessages.$inferSelect & { seq: number }> {
	const msg = await narratorService.persistSystemMessage(narratorId, text, contentBlocks);
	broadcastToNarrator(narratorId, {
		type: "message",
		narratorId,
		message: {
			id: msg.id,
			narratorId,
			role: msg.role,
			contentJson: msg.contentJson,
			contentText: msg.contentText,
			createdAt: msg.createdAt,
			seq: msg.seq,
			children: [],
		},
	});
	return msg;
}

async function drainAndPersistBackgroundCompletionNotice(
	active: ActiveNarrator,
): Promise<string | null> {
	const completed = drainCompletedBackgroundSubagents(active.narratorId);
	if (completed.length === 0) return null;
	const prompt = formatBackgroundCompletionNotifications(completed, { includeResult: true });
	await persistAndBroadcastSystemMessage(active.narratorId, prompt, [
		{
			type: "background_agents_completed",
			tasks: completed.map((task: CompletedBgSubagentNotification) => ({
				id: task.id,
				title: task.title,
				status: task.status,
				resultPreview: task.resultPreview,
				resultTruncated: task.resultTruncated ?? false,
			})),
		},
	]);
	return prompt;
}

async function drainAndPersistParentInboundNotice(active: ActiveNarrator): Promise<string | null> {
	const inbound = drainParentInboundMessages(active.narratorId);
	if (inbound.length === 0) return null;
	const prompt = formatParentInboundMessages(inbound, active.locale);
	await persistAndBroadcastSystemMessage(active.narratorId, prompt, [
		{
			type: "subagent_messages",
			messages: inbound.map((message: ParentInboundMessage) => ({
				fromId: message.fromId,
				fromTitle: message.fromTitle,
				fromType: message.fromType,
				timestamp: message.timestamp,
			})),
		},
	]);
	return prompt;
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
		// If a history compact has completed but the active loop has not yet
		// rebuilt its in-memory history from the new summary, this percentage is
		// still measured against the stale (pre-compact) context. Acting on it
		// would trigger a second compact on context that is about to shrink,
		// dropping a large chunk of conversation. Skip until the rebuild lands.
		if (hasPendingHistoryCompact(narratorId)) {
			const active = activeNarrators.get(narratorId);
			if (active) active._contextUsagePct = undefined;
			logger.debug("Skipping context-usage compact trigger: prior compact not yet applied", {
				narratorId,
				contextPct: percentage,
			});
			return;
		}
		const thresholds = getContextThresholds(getModel(), getProvider());
		const pruningWindowEnabled = isDynamicPruningWindowEnabled(thresholds);

		// Dynamic pruning: pruneStart – (compactStart - 1)%. Once pruning reaches
		// the configured ratio, start background compact immediately instead of
		// waiting for compactStart. If compactStart <= pruneStart, the pruning window
		// is disabled and compactStart acts as the direct compact trigger.
		if (
			pruningWindowEnabled &&
			percentage >= thresholds.pruneStart &&
			percentage < thresholds.compactStart &&
			!pruneLocks.has(narratorId)
		) {
			const compactPruneThreshold = getAutoCompactPruneThreshold();
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

					const prunedPct = result?.prunedPercent ?? 0;
					if (prunedPct >= compactPruneThreshold) {
						logger.info("Pruned percent reached threshold, triggering background compact", {
							narratorId,
							contextPct: percentage,
							prunedPercent: prunedPct,
							threshold: compactPruneThreshold,
						});
						triggerMidTurnCompact(narratorId, locale, onCompactDone);
					}
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

		// ≥ compactStart%: force compact only after pruning reaches the configured
		// ratio; otherwise keep advancing the prune boundary. Exceptions: when the
		// pruning window is disabled (compactStart <= pruneStart), or pruning is
		// disabled for this narrator, skip the prune gate and compact immediately.
		if (
			percentage >= thresholds.compactStart &&
			!pruneLocks.has(narratorId) &&
			!compactLocks.has(narratorId)
		) {
			if (!pruningWindowEnabled) {
				logger.info("Pruning window disabled, triggering background compact", {
					narratorId,
					contextPct: percentage,
					pruneStart: thresholds.pruneStart,
					compactStart: thresholds.compactStart,
				});
				triggerMidTurnCompact(narratorId, locale, onCompactDone);
				return;
			}

			const compactPruneThreshold = getAutoCompactPruneThreshold();
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
					if (prunedPct < compactPruneThreshold) {
						logger.info(
							"Context above compactStart but prunedPercent below threshold, continuing prune",
							{
								narratorId,
								contextPct: percentage,
								prunedPercent: prunedPct,
								threshold: compactPruneThreshold,
							},
						);
						return; // stay in prune mode — don't compact yet
					}
					logger.info("Pruned percent reached threshold, triggering background compact", {
						narratorId,
						contextPct: percentage,
						prunedPercent: prunedPct,
						threshold: compactPruneThreshold,
					});
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

	const rebuildHistoryForCurrentContext = async (
		boundary: string | null,
		includeSystemPrompt: boolean,
	) => {
		setPruneBoundary(boundary);
		const rawMsgs = await narratorService.getMessagesSinceLastCompact(narratorId);
		// The in-memory history is now rebuilt from the latest (post-compact)
		// messages, so any pending-compact guard can be released.
		clearActiveHistoryCompactPending(narratorId);
		// Subagent messages all have parentToolUseId set — clear it so
		// buildHistory treats them as top-level (same as loadSubagentHistory).
		const msgs = isSubagentNarrator
			? rawMsgs.map((m) => ({ ...m, parentToolUseId: null }))
			: rawMsgs;
		if (boundary) pruneToolCalls(msgs, boundary);
		const result = await buildHistory(msgs, getModel(), getProvider(), narratorId);
		const systemPrompt = includeSystemPrompt
			? ((await rebuildSystemPrompt?.()) ?? undefined)
			: undefined;
		return {
			history: result.history,
			pendingToolResults: result.trailingToolResults,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
		};
	};

	const onBeforeTurn: NonNullable<import("../lib/agent").AgentConfig["onBeforeTurn"]> = async (
		_turnIndex,
		reason,
	) => {
		// Check if a compact just finished — if so, force a full rebuild
		// (history + system prompt) so the next API call uses compacted data.
		// This takes priority over the prune-boundary check below because compact
		// already clears the prune boundary and returns a fresh message set.
		const compactJustDone = isCompactDone?.() ?? false;
		if (compactJustDone) {
			clearCompactDone?.();
			// After compact, pruneBoundary is cleared — sync local cache
			return rebuildHistoryForCurrentContext(null, true);
		}

		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { pruneBoundaryMessageId: true },
		});
		const thresholds = getContextThresholds(getModel(), getProvider());
		let newBoundary = row?.pruneBoundaryMessageId ?? null;
		if (!isDynamicPruningWindowEnabled(thresholds) && newBoundary) {
			await narratorService.clearPruneBoundary(narratorId);
			broadcastToNarrator(narratorId, {
				type: "prune_boundary",
				narratorId,
				boundaryMessageId: null,
				prunedPercent: null,
			});
			newBoundary = null;
		}
		if (!reason?.force && newBoundary === getPruneBoundary()) return null;
		return rebuildHistoryForCurrentContext(newBoundary, reason?.force === true);
	};

	return { onContextUsage, onBeforeTurn };
}

/**
 * Build AgentConfig, start the agent loop via executeAgentLoop(), and handle chained messages.
 * Runs in the background — kicked off by feedMessage().
 *
 * Returns `{ started: false }` when a loop is already running for this narrator.
 * This is the single authoritative gate against concurrent loops: in JS's
 * single-threaded model the test-and-set on `_loopRunning` is atomic, so it
 * blocks any second loop that slips past the route-level admission check (e.g.
 * when the DB `status` went stale to idle while the loop was still draining).
 */
export async function runAgentLoop(
	active: ActiveNarrator,
	text: string,
	images?: ImageRef[],
): Promise<{ started: boolean }> {
	const { narratorId, locale } = active;
	// Final guard against concurrent loops on the same ActiveNarrator. ensureNarrator
	// reuses the same `active` object while it is alive, so a second runAgentLoop call
	// here would otherwise drive a second `while (active.alive)` loop over shared state
	// (abortController, history, _substatus) and corrupt the session.
	if (active._loopRunning) {
		logger.warn("runAgentLoop blocked: loop already running", { narratorId });
		return { started: false };
	}
	active._loopRunning = true;
	let shouldUpdateTitle = false;
	let currentText = text;
	// Knowledge entries already injected in the CURRENT COMPACT CYCLE (de-dup across runAgentLoop
	// calls, loop passes, and tool outputs). This is narratorId-scoped hotSafe state rather than
	// ActiveNarrator state because ActiveNarrator is recreated between idle user turns.
	let knowledgeCycleState = knowledgeInjectionCycleStates.get(narratorId);
	if (!knowledgeCycleState) {
		knowledgeCycleState = { seq: Number.NaN, ids: new Set<string>() };
		knowledgeInjectionCycleStates.set(narratorId, knowledgeCycleState);
	}
	const knowledgeInjectedIds = knowledgeCycleState.ids;
	let currentImages = images;
	let loopHadError = false;
	/** Wall-clock start of this response turn, for the Stop hook `duration_ms` field. */
	const loopStartedAt = Date.now();
	/**
	 * Tokens consumed across every pass of this response turn (non-cached input +
	 * output), for the Stop hook `total_tokens` field. Accumulated per pass using
	 * the same delta the goal-usage accounting charges.
	 */
	let loopTotalTokens = 0;
	/** Whether the loop was interrupted by the user (abort signal). */
	let loopWasInterrupted = false;
	/** Final assistant text (or error message) from the most recent agent-loop pass, for Stop hooks. */
	let stopHookFinalText = "";
	/** Whether the most recent agent-loop pass ended by exceeding the max-turns limit (for Stop hooks). */
	let loopHitMaxTurns = false;
	/** How many times we've retried after emergency compact in this runAgentLoop call. */
	let contextOverflowRetries = 0;

	/** How many consecutive transient-error retries in this runAgentLoop call. */
	let transientRetries = 0;

	/** How many consecutive completion-limit auto-continues in this runAgentLoop call. */
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
			const baselineCompactSeq = await narratorService.getLatestCompactSeq(narratorId);
			// Knowledge-injection de-dup is scoped to a compact cycle: when the latest compact
			// seq changes (a compact happened), the prior injections were summarized/dropped from
			// context, so clear the set to allow re-injecting relevant entries into the new cycle.
			const cycleSeq = baselineCompactSeq ?? -1;
			if (cycleSeq !== knowledgeCycleState.seq) {
				knowledgeCycleState.seq = cycleSeq;
				knowledgeInjectedIds.clear();
				for (const id of knowledgeService.listInjectedEntryIds(narratorId, cycleSeq)) {
					knowledgeInjectedIds.add(id);
				}
			}
			// Always use getMessagesSinceLastCompact: if no compact marker exists it
			// returns all messages; after a compact it only returns post-compact messages
			// (old context is already in the summary injected via system prompt).
			const rawMessages = await narratorService.getMessagesSinceLastCompact(narratorId);
			// History below is rebuilt from the latest post-compact messages, so any
			// pending-compact guard set by a background compact can be released here.
			clearActiveHistoryCompactPending(narratorId);

			// Rebuild system prompt each iteration so AGENT.md/CLAUDE.md changes are picked up
			const freshNarrator = await narratorService.getById(narratorId);

			// Subagent messages all have parentToolUseId set — clear it so
			// buildHistory treats them as top-level (same as loadSubagentHistory).
			const isSubagentNarrator = isSubagentVariant(freshNarrator.variant);
			const dbMessages = isSubagentNarrator
				? rawMessages.map((m) => ({ ...m, parentToolUseId: null }))
				: rawMessages;

			active._modelRef = freshNarrator.model ?? FOLLOW_DEFAULT_MODEL;
			active._settingsRevision = getSettingsRevision();
			active.model = resolveEffectiveModel(active._modelRef, active.provider);
			active.provider = resolveProvider(active.model);
			active._reasoningEffortRef = freshNarrator.reasoningEffort ?? null;
			active.reasoningEffort = resolveRuntimeReasoningEffort(
				active.provider,
				active.model,
				active._reasoningEffortRef,
			);
			const resolved = resolveProviderAndModel(active.model, active.provider);
			active.provider = resolved.provider;

			// Resolve behavior-fence injection settings for this turn (narrator override → global default).
			const fenceIntervalOverride = freshNarrator.behaviorFenceIntervalOverride;
			active._fenceInterval =
				fenceIntervalOverride == null
					? settings.agent.behaviorFenceInterval
					: fenceIntervalOverride;
			active._fenceAttach = resolveBooleanOverride(
				freshNarrator.behaviorFenceAttachOverride,
				settings.agent.behaviorFenceAttachTasks,
			);

			// Resolve tasks.json reminder injection settings for this turn (narrator override → global default).
			const tasksReminderIntervalOverride = freshNarrator.tasksReminderIntervalOverride;
			active._tasksReminderInterval =
				tasksReminderIntervalOverride == null
					? settings.agent.tasksReminderInterval
					: tasksReminderIntervalOverride;

			// Apply dynamic pruning — strip tool calls from messages at or before the
			// persisted boundary so the context stays within budget. When compactStart
			// is <= pruneStart, dynamic pruning is explicitly disabled; clear any stale
			// boundary left over from an earlier threshold configuration.
			const loopThresholds = getContextThresholds(resolved.model, resolved.provider);
			const pruningWindowEnabled = isDynamicPruningWindowEnabled(loopThresholds);
			active._pruneBoundaryMessageId = pruningWindowEnabled
				? (freshNarrator.pruneBoundaryMessageId ?? null)
				: null;
			if (!pruningWindowEnabled && freshNarrator.pruneBoundaryMessageId) {
				await narratorService.clearPruneBoundary(narratorId);
				broadcastToNarrator(narratorId, {
					type: "prune_boundary",
					narratorId,
					boundaryMessageId: null,
					prunedPercent: null,
				});
			} else if (active._pruneBoundaryMessageId) {
				pruneToolCalls(dbMessages, active._pruneBoundaryMessageId);
			}

			const { history, trailingToolResults, trailingUserText } = await buildHistory(
				dbMessages,
				resolved.model,
				resolved.provider,
				narratorId,
			);

			const { prompt: freshSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
				{
					systemPrompt: freshNarrator.systemPrompt,
					contextSummary: freshNarrator.contextSummary,
				},
				active.cwd,
				locale,
				active._replyInUserLanguage ?? false,
				isPlanModeTrait(freshNarrator.traits),
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
						},
						active.cwd,
						locale,
						active._replyInUserLanguage ?? false,
						isPlanModeTrait(freshNarrator.traits),
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
					const hasOnlyInitialUserMessage = (n?.messageCount ?? 0) <= 1;
					const titleUpdate = !!(
						n &&
						hasOnlyInitialUserMessage &&
						(!n.title || (active._provisionalTitle && n.title === active._provisionalTitle))
					);
					return { titleUpdate };
				},
				onEnterPlanMode: async () => {
					const planState = await enterNarratorPlanMode(narratorId);
					active._planFileId = planState.planFileId;
					active._previousPermissionMode = planState.previousPermissionMode;
					if (!planState.wasPlanMode) {
						broadcastToNarrator(narratorId, {
							type: "plan_mode_changed",
							narratorId,
							planMode: true,
							traits: redactDraftTraits(planState.traits),
						});
					}
					if (planState.relaxedPlanChanged) {
						broadcastToNarrator(narratorId, {
							type: "relaxed_plan_changed",
							narratorId,
							relaxedPlan: true,
						});
					}
				},
				onExitPlanMode: async (toolUseId) => {
					active._planFileId = undefined;
					active._previousPermissionMode = undefined;
					planModeAskedOnce.delete(narratorId);
					// Plan mode is a trait overlay. Exiting it must not silently change the
					// user's current permission policy. Still continue approval handling even
					// if another path already cleared the trait, so successful ExitPlanMode is idempotent.
					const planState = await exitNarratorPlanMode(narratorId);
					if (planState.wasPlanMode) {
						broadcastToNarrator(narratorId, {
							type: "plan_mode_changed",
							narratorId,
							planMode: false,
							traits: redactDraftTraits(planState.traits),
						});
					}
					// Plan compact logic — retrieve plan text from the tool call's inputJson
					if (pendingPlanCompact.has(narratorId)) {
						pendingPlanCompact.delete(narratorId);
						const planText = await narratorService.getToolCallPlanText(toolUseId);
						if (planText) {
							await runPlanCompact(narratorId, planText);
							resetActiveUpstreamSession(narratorId);
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
									// File changes just happened → invalidate then read through
									// the shared cache so co-located narrators reuse one query.
									invalidateStatus(worktreePath);
									Promise.all([
										getStatusSummaryCached(worktreePath, { ttlMs: 0 }),
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

									// Attribute Bash-driven changes to this narrator.
									try {
										const { recordAttributions } = await import("./file-attribution-service");
										await recordAttributions(
											{
												workspacePath: cwd,
												narratorId,
												action: "bash",
												toolName: SHELL_TOOL_NAME,
												toolUseId,
											},
											changedFiles,
										);
									} catch (err) {
										logger.debug("Bash attribution failed", {
											narratorId,
											toolUseId,
											error: String(err),
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
				freshNarrator.reasoningEffort ||
				resolveDefaultReasoningEffort(resolved.provider, resolved.model);

			const resolvedServiceTier =
				freshNarrator.fastMode && usesCodexModel(resolved.provider, resolved.model)
					? "priority"
					: undefined;

			const resetUpstreamSessionForThisLoop = active._resetUpstreamSessionOnNextRequest === true;
			active._resetUpstreamSessionOnNextRequest = false;
			await ensureSkillCacheFreshForActiveNarrator(active);

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
				planMode: isPlanModeTrait(freshNarrator.traits),
				permissionMode: freshNarrator.permissionMode ?? "default",
				previousPermissionMode:
					active._previousPermissionMode ?? freshNarrator.previousPermissionMode ?? undefined,
				relaxedPlan: !!freshNarrator.relaxedPlan,
				planAllowInlinePlan: settings.agent.planModeAllowInlinePlan,
				planReflectionAutoApproveOverride: normalizeBooleanOverride(
					freshNarrator.planReflectionAutoApproveOverride,
				),
				planFileId: active._planFileId,
				skillRoot: active._skillRoot ?? undefined,
				projectGitPath: active._projectGitPath ?? undefined,
				skillScopeKey: active._skillScopeKey ?? undefined,
				userId: active._currentUserId ?? null,
				projectId: active._projectId ?? null,
				defaultDeviceId: active._defaultDeviceId ?? null,
				availableDevices: await resolveSessionDevices(active._projectId ?? null),
				setDefaultDevice: (deviceId) => applySessionDefaultDevice(narratorId, active, deviceId),
				// Share the compact-cycle de-dup set so the loop's tool-output scan (point B)
				// de-dups against the user-message injections (point A) and vice versa.
				knowledgeInjectedEntryIds: knowledgeInjectedIds,
				knowledgeInjectionCompactSeq: cycleSeq,
				reasoningEffort: resolvedReasoningEffort,
				serviceTier: resolvedServiceTier,
				maxTransientRetries: getMaxTransientRetries(),
				silentToolCallThreshold: getSilentToolCallThreshold(),
				retryBackoffCeilMs: getRetryBackoffCeilMs(),
				firstTokenTimeoutMs: getFirstTokenTimeoutMs(),
				metadata: isAnthropicProvider(resolved.provider)
					? { user_id: `user_${narratorId}_account__session_${active.conversationId}` }
					: undefined,
				resetUpstreamSessionOnFirstRequest: resetUpstreamSessionForThisLoop,
				disabledTools: active._disabledTools,
				subagentModelRestrictionDescription: formatSubagentModelRestrictionDescription(
					freshNarrator.traits,
				),
				// Exclude optional tools that haven't been loaded for this session
				toolFilter: (tool) => {
					if (active._disabledTools.has(tool.name)) return false;
					if (OPTIONAL_TOOLS.has(tool.name)) {
						return active._enabledOptionalTools.has(tool.name);
					}
					// Review tools: only available for review chapter narrators
					if (REVIEW_TOOLS.has(tool.name)) {
						return active._chapterRole === "review";
					}
					// MCP tools: exclude tools with "deny" behavior
					if (tool.name.startsWith("mcp__")) {
						return isMcpToolAllowedForNarrator(tool);
					}
					// Knowledge Steward: drop a few unrelated core tools (e.g. web search/fetch).
					// Deny-list only — never touches planning/reflection/goal control tools.
					if (active._narratorKind === "knowledge" && KNOWLEDGE_KIND_DENY_CORE.has(tool.name)) {
						return false;
					}
					return true;
				},
				permissionHandler: (toolName, input, toolUseId, options) =>
					handlePermission(
						narratorId,
						active.abortController.signal,
						toolName,
						input,
						toolUseId,
						active.cwd,
						locale,
						undefined,
						options,
					),
				onBeforeTurn: ctxMgmt.onBeforeTurn,
				sideCarInitialCompletedToolCount: active._todoReminderCompletedToolCount ?? 0,
				onSideCarCompletedToolCount: (count) => {
					active._todoReminderCompletedToolCount = count;
					// The behavior-fence edit window only covers the first tool call of a user
					// turn. Once any tool completes (counter advances past its initial value),
					// close the window so later tool calls in the same turn cannot write the fence.
					clearBehaviorFenceEditGrant(narratorId);
				},
				getSideCars: async (request) => {
					if (request.phase === "tool_result") {
						const sideCars: import("../lib/agent/types").AgentSideCar[] = [];
						const count = request.completedToolCount ?? 0;
						const tasksInterval = active._tasksReminderInterval ?? 15;
						let lastTasksCount = active._lastTasksReminderCompletedToolCount;
						if (lastTasksCount === undefined) {
							lastTasksCount = active._todoReminderCompletedToolCount ?? 0;
							active._lastTasksReminderCompletedToolCount = lastTasksCount;
						}
						const atTasksCadence = tasksInterval > 0 && count - lastTasksCount >= tasksInterval;

						const fenceInterval = active._fenceInterval ?? -1;
						let lastFenceCount = active._lastFenceCompletedToolCount;
						if (lastFenceCount === undefined) {
							lastFenceCount = active._todoReminderCompletedToolCount ?? 0;
							active._lastFenceCompletedToolCount = lastFenceCount;
						}
						const atFenceCadence = fenceInterval > 0 && count - lastFenceCount >= fenceInterval;
						// Advance the cadence markers whenever the cadence is hit, regardless of
						// whether a reminder is actually produced. Otherwise, when there are no
						// open tasks (reminder === null) the cadence would stay "due" and re-read
						// the spec file from SQLite on every subsequent tool result.
						if (atTasksCadence) active._lastTasksReminderCompletedToolCount = count;
						const tasksReminder = atTasksCadence
							? await buildSpecToolResultReminder(narratorId, locale)
							: null;
						if (tasksReminder) {
							sideCars.push({
								target: "tool_result",
								source: "living_work_spec",
								content: tasksReminder,
								toolUseId: request.toolUseId,
							});
						}
						// Inject the behavior fence when its own cadence hits, or when it is
						// attached to a tasks reminder that is being injected this cycle.
						const wantFence = atFenceCadence || (!!active._fenceAttach && !!tasksReminder);
						if (wantFence) {
							// Same rationale as tasks: advance on cadence hit even if the fence is
							// empty, so an empty fence does not re-read the spec file every tool call.
							if (atFenceCadence) active._lastFenceCompletedToolCount = count;
							const fenceReminder = await buildBehaviorFenceReminder(narratorId, locale);
							if (fenceReminder) {
								sideCars.push({
									target: "tool_result",
									source: "behavior_fence",
									content: fenceReminder,
									orderIndex: 16,
									toolUseId: request.toolUseId,
								});
							}
						}
						return sideCars;
					}
					// phase === "after_tools"
					const sideCars: import("../lib/agent/types").AgentSideCar[] = [];

					// Drain completed background subagent tasks
					const subDone = drainCompletedBackgroundSubagents(narratorId);
					if (subDone.length > 0) {
						sideCars.push({
							target: "user_message",
							source: "bg_agent",
							content: formatBackgroundCompletionNotifications(subDone),
						});
					}

					// Drain completed background bash tasks
					const bashDone = backgroundTaskService.drainBashNotificationsSync(narratorId);
					if (bashDone.length > 0) {
						const lines = bashDone.map(
							(t) =>
								`[System] Background bash "${t.title || t.id}" (ID: ${t.alias ?? t.id}) ${t.status}.` +
								`\nResult preview: ${t.outputPreview || "(empty)"}`,
						);
						sideCars.push({
							target: "user_message",
							source: "bg_bash",
							content: lines.join("\n\n"),
						});
					}

					// Drain queued chat-group messages (delivered to a working narrator)
					const groupMsgs = drainGroupMessagesForNarrator(narratorId);
					if (groupMsgs.length > 0) {
						sideCars.push({
							target: "user_message",
							source: "group_message",
							content: formatGroupMessages(groupMsgs),
						});
					}

					// Drain progress reports sent by child subagents via Send({ id: "parent" }).
					const parentInbound = drainParentInboundMessages(narratorId);
					if (parentInbound.length > 0) {
						sideCars.push({
							target: "user_message",
							source: "subagent_message",
							content: formatParentInboundMessages(parentInbound, locale),
						});
					}

					// Drain pending spec updates from UI edits.
					const specUpdates = drainSpecUpdatesForNarrator(narratorId);
					if (specUpdates.length > 0) {
						sideCars.push({
							target: "user_message",
							source: "spec_update",
							content: formatSpecUpdateSideCars(specUpdates, locale),
						});
					}

					return sideCars;
				},
				getRuntimeSettingsOverride: () => {
					// active.model/reasoningEffort are updated in real time by narrator routes.
					// For raw refs that follow settings (__default__ / __agg__), also re-resolve
					// when global settings change so the next API request picks up default-model
					// or aggregation membership/routing updates, including retry attempts.
					const revision = getSettingsRevision();
					if (active._settingsRevision !== revision) {
						active._settingsRevision = revision;
						const modelRef = active._modelRef ?? FOLLOW_DEFAULT_MODEL;
						const resolvedModel = resolveEffectiveModel(modelRef, active.provider);
						active.model = resolvedModel;
						active.provider = resolveProvider(resolvedModel);
						active.reasoningEffort = resolveRuntimeReasoningEffort(
							active.provider,
							active.model,
							active._reasoningEffortRef,
						);
					}

					const next: import("../lib/agent").RuntimeSettingsOverride = {};
					if (active.model !== config.model) {
						next.model = active.model;
					}

					const runtimeReasoningEffort =
						active.reasoningEffort ??
						resolveDefaultReasoningEffort(active.provider, active.model) ??
						null;
					const currentReasoningEffort = config.reasoningEffort ?? null;
					if (runtimeReasoningEffort !== currentReasoningEffort) {
						next.reasoningEffort = runtimeReasoningEffort;
					}

					return Object.keys(next).length > 0 ? next : null;
				},
				getModelOverride: () => {
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
					if (active._bufferSoftStop) {
						active._bufferSoftStop = false;
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
					const uploadNarratorId = img.uploadNarratorId ?? narratorId;
					const filePath = getImagePath(uploadNarratorId, img.imageId);
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

			// When the provider history builder has fresh trailing user-like context
			// as the current turn instead of leaving the model with an empty/dot prompt.
			const currentTurnText = trailingUserText?.trim()
				? currentText.trim()
					? `${trailingUserText}\n\n${currentText}`
					: trailingUserText
				: currentText;

			// When replaying a pure tool-result turn, preserve the original packet shape:
			// no synthetic user text.
			const isPureToolResultReplay = !currentTurnText.trim() && trailingToolResults.length > 0;
			let effectiveText = isPureToolResultReplay ? "" : currentTurnText;

			// Passive knowledge injection (point A): when this turn carries real user text,
			// surface relevant knowledge-base entries the triggering user may read.
			// ACL is resolved by the loop-triggering user (active._currentUserId), not the narrator.
			if (effectiveText.trim()) {
				try {
					const hits = await knowledgeInjection.resolveInjections(
						active._currentUserId,
						effectiveText,
						{ already: knowledgeInjectedIds, projectId: active._projectId ?? undefined },
					);
					if (hits.length > 0) {
						const block = knowledgeInjection.formatInjections(
							hits,
							"Relevant knowledge-base entries were found for this request:",
						);
						if (block) {
							await narratorService.persistSystemMessage(narratorId, block, [
								knowledgeInjection.createKnowledgeHintBlock(hits, "user_message", cycleSeq),
							]);
							knowledgeService.recordInjectionEvents({
								narratorId,
								compactSeq: cycleSeq,
								source: "user_message",
								hits,
							});
							for (const h of hits) knowledgeInjectedIds.add(h.entryId);
							effectiveText = `${effectiveText}\n\n${block}`;
						}
					}
				} catch (err) {
					logger.warn("Knowledge injection (user message) failed", {
						narratorId,
						error: String(err),
					});
				}
			}

			active._tokenUsageBaseline = active._lastTokenUsage;
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

			// Track the latest pass's final text for the Stop hook (set on every pass,
			// so the most recent assistant text / error message wins regardless of how
			// the loop ultimately terminates).
			if (result.finalText) {
				stopHookFinalText = result.finalText;
			}

			// Track whether the latest pass ended by hitting the max-turns limit.
			// Refreshed every pass (unconditionally) so that if the loop continues
			// afterwards — e.g. goal continuation or a buffered message — and ends
			// normally, this is cleared back to false before the Stop hook fires.
			loopHitMaxTurns = result.maxTurnsExceeded === true;

			loopTotalTokens += accountTokenUsageForTurn(active);

			// Track no-tool continuation turns to suppress runaway auto-continuation
			// when the model stops making progress (no tool calls) on a continuation pass.
			if (active._continuationTurn) {
				if (result.hadToolUses) {
					active._continuationNoToolCount = 0;
					active._continuationSuppressed = false;
				} else {
					active._continuationNoToolCount = (active._continuationNoToolCount ?? 0) + 1;
					active._continuationSuppressed =
						active._continuationNoToolCount >= MAX_CONTINUATION_NO_TOOL_TURNS;
				}
				active._continuationTurn = false;
			} else {
				active._continuationNoToolCount = 0;
				active._continuationSuppressed = false;
			}

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

			if (result.paymentRequired && active.alive) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["payment_required"],
					errorCode: "payment_required",
					errorMessage: JSON.stringify({ type: "payment_required", ...result.paymentRequired }),
				});
				active.events.emit("event", {
					type: "payment_required",
					data: result.paymentRequired,
				});
				loopHadError = true;
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
					baselineCompactSeq,
					onBroadcast: (event) =>
						broadcastToNarrator(narratorId, event as Parameters<typeof broadcastToNarrator>[1]),
				});

				contextOverflowRetries = overflow.overflowRetries;

				if (overflow.action === "retry_pruned") {
					active._pruneBoundaryMessageId = overflow.boundaryMessageId;
					active._resetUpstreamSessionOnNextRequest = true;
					transientRetries = 0;
					continue;
				}
				if (overflow.action === "retry_compacted") {
					active.conversationId = overflow.newConversationId;
					active._resetUpstreamSessionOnNextRequest = true;
					transientRetries = 0;
					continue;
				}

				// All attempts failed
				const failure = getContextOverflowFailureError(overflow.reason);
				logger.error("Context length exceeded after recovery failed", {
					narratorId,
					reason: overflow.reason,
				});
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: failure.message,
					errorCode: failure.errorCode,
				});
				active.events.emit("event", {
					type: "error",
					data: { message: failure.message, errorCode: failure.errorCode },
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
				if (!usesStatefulModel(resolved.provider, resolved.model)) {
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
					maxRetries: result.bypassRetryLimit ? -1 : getMaxTransientRetries(),
					signal: active.abortController.signal,
				});
				if (active.abortController.signal.aborted) {
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					await finalizeInterruptedRun(active, narratorId, partialId);
					loopWasInterrupted = true;
					break;
				}
				if (shouldRetry) {
					// Finalize or clean up the partial message from the failed turn.
					// If tools were already executed (side effects occurred), the message
					// is kept so buildHistory includes them and the model won't repeat them.
					// Otherwise the partial is deleted so the retry starts fresh.
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					let keptPartial = false;
					if (partialId) {
						keptPartial = await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					if (keptPartial) {
						currentText = "";
						currentImages = undefined;
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

			if (result.silentDisconnect && active.alive) {
				const message = "Codex WebSocket silent disconnect";
				transientRetries++;
				const { shouldRetry } = await handleTransientError({
					narratorId,
					error: message,
					retryCount: transientRetries,
					maxRetries: getMaxTransientRetries(),
					signal: active.abortController.signal,
				});

				if (active.abortController.signal.aborted) {
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					await finalizeInterruptedRun(active, narratorId, partialId);
					loopWasInterrupted = true;
					break;
				}

				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}

				if (shouldRetry) {
					continue;
				}
				if (!active.alive) {
					break;
				}
			}

			if (result.maxTurnsExceeded && active.alive && !loopHadError) {
				const continuationPrompt = await maybeStartContinuation(active, freshNarrator, false);
				if (continuationPrompt) {
					await narratorService.updateStatus(narratorId, "working");
					currentText = "";
					currentImages = undefined;
					continue;
				}
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

			// Reset transient retry counter on success or after a non-retried silent disconnect.
			transientRetries = 0;

			if (result.interrupted && active.alive) {
				interruptionRetries++;
				if (interruptionRetries > MAX_INTERRUPTION_RETRIES) {
					logger.warn("Completion-limit continuation: max retries reached, stopping", {
						narratorId,
						retries: interruptionRetries,
					});
				} else if (result.shouldReplayInterruptedToolResultTurn) {
					logger.info("Completion-limit continuation: replaying interrupted tool-result turn", {
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
				interruptionRetries = 0;
			}

			if (result.shouldUpdateTitle) {
				shouldUpdateTitle = true;
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

			// Compact after a complete turn when either:
			// 1. context usage is above compactStart and the prune gate allows compact, or
			// 2. the pruned message ratio itself has reached the configured force-compact threshold.
			// This is a fallback — the mid-turn context_usage handler may have already started
			// a background compact.
			const { model: postModel, provider: postProvider } = resolveProviderAndModel(
				active.model,
				active.provider,
			);
			const postTurnThresholds = getContextThresholds(postModel, postProvider);
			if (active._contextUsagePct != null && hasPendingHistoryCompact(narratorId)) {
				logger.debug("Dropping stale post-turn context usage: prior compact not yet applied", {
					narratorId,
					contextPct: active._contextUsagePct,
				});
				active._contextUsagePct = undefined;
			}
			if (active._contextUsagePct != null && !compactLocks.has(narratorId)) {
				const postTurnContextPct = active._contextUsagePct;
				active._contextUsagePct = undefined;

				const compactPruneThreshold = getAutoCompactPruneThreshold();
				const contextReachedCompactStart = postTurnContextPct >= postTurnThresholds.compactStart;
				const pruningWindowEnabled = isDynamicPruningWindowEnabled(postTurnThresholds);
				let currentPrunedPct = 0;
				let shouldCompact = false;
				let compactReason: "context_threshold" | "prune_threshold" | "pruning_window_disabled" =
					"context_threshold";

				if (contextReachedCompactStart && !pruningWindowEnabled) {
					logger.info("Pruning window disabled, triggering background compact (post-turn)", {
						narratorId,
						contextPct: postTurnContextPct,
						pruneStart: postTurnThresholds.pruneStart,
						compactStart: postTurnThresholds.compactStart,
					});
					shouldCompact = true;
					compactReason = "pruning_window_disabled";
				} else {
					const narrator = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { prunedPercent: true, pruneEnabled: true },
					});
					currentPrunedPct = narrator?.prunedPercent ?? 0;
					const pruneDisabled = narrator != null && !narrator.pruneEnabled;
					const pruneReachedForceCompact =
						!pruneDisabled && currentPrunedPct >= compactPruneThreshold;

					if (contextReachedCompactStart && !pruneDisabled && !pruneReachedForceCompact) {
						logger.info(
							"Context above compactStart post-turn but prunedPercent below threshold, skipping compact",
							{
								narratorId,
								contextPct: postTurnContextPct,
								prunedPercent: currentPrunedPct,
								threshold: compactPruneThreshold,
							},
						);
					} else if (contextReachedCompactStart || pruneReachedForceCompact) {
						shouldCompact = true;
						compactReason = pruneReachedForceCompact ? "prune_threshold" : "context_threshold";
					}
				}

				if (shouldCompact) {
					const boundaryMessageId = await narratorService.getCompactBoundaryMessage(
						narratorId,
						getAutoCompactKeepPairs(),
					);

					if (boundaryMessageId) {
						logger.info("Triggering background compact (post-turn)", {
							narratorId,
							boundaryMessageId,
							contextPct: postTurnContextPct,
							prunedPercent: currentPrunedPct,
							threshold: compactPruneThreshold,
							reason: compactReason,
						});

						// Fire-and-forget: compact runs in the background.
						// On completion it resets the narrator's conversationId so the next
						// agent loop iteration starts a fresh API conversation.
						runCustomCompact(narratorId, locale, boundaryMessageId, { mode: "background" }).catch(
							(compactErr) => {
								logger.error("Auto-compact failed", {
									narratorId,
									error: String(compactErr),
								});
							},
						);
					} else {
						logger.info("Compact requested but not enough messages to compact", {
							narratorId,
							contextPct: postTurnContextPct,
							prunedPercent: currentPrunedPct,
						});
					}
				}
			}

			const bgCompletionPrompt = await drainAndPersistBackgroundCompletionNotice(active);
			if (bgCompletionPrompt) {
				await narratorService.updateStatus(narratorId, "working");
				currentText = "";
				currentImages = undefined;
				continue;
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
					const newCommand = parseQueuedNewCommand(buffered.text, buffered.commandText);
					if (newCommand) {
						const newNarratorId = await executeQueuedNewCommand(
							active,
							buffered,
							newCommand.initialMessage,
						);
						broadcastToNarrator(narratorId, {
							type: "queued_new_narrator_created",
							narratorId,
							messageId: buffered.id,
							newNarratorId,
						});
						if ((bufferedMessages.get(narratorId)?.length ?? 0) > 0) {
							loopWasInterrupted = true;
						} else {
							await narratorService.compareAndSetStatus(
								narratorId,
								["working", "waiting"],
								"idle",
								{
									substatus: ["unread"],
								},
							);
						}
						break;
					}
					// A queued /goal appends its protected task now (no model turn). Keep
					// draining the buffer if more messages remain, else settle to idle.
					const goalCommand = parseQueuedGoalCommand(buffered.text, buffered.commandText);
					if (goalCommand) {
						await executeQueuedGoalCommand(narratorId, buffered, goalCommand.objective);
						if ((bufferedMessages.get(narratorId)?.length ?? 0) > 0) {
							loopWasInterrupted = true;
						} else {
							await narratorService.compareAndSetStatus(
								narratorId,
								["working", "waiting"],
								"idle",
								{ substatus: ["unread"] },
							);
						}
						break;
					}
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
					// runBashFirst flow: run the Bash command as an assistant tool card after the
					// user message, then replay it as the current turn (empty text) so the model
					// sees: user prompt → Bash tool call/result → reply.
					if (buffered.bashCommand) {
						await handleBashCommand(
							narratorId,
							buffered.bashCommand,
							`/bash ${buffered.bashCommand}`,
							buffered.createdBy ?? undefined,
							{ skipUserMessage: true, signal: active.abortController.signal },
						);
						currentText = "";
						currentImages = undefined;
						continue;
					}
					currentText = effectiveBufferedText;
					currentImages = buffered.images;
					continue;
				}
			}

			const continuationPrompt = await maybeStartContinuation(active, freshNarrator, loopHadError);
			if (continuationPrompt) {
				await narratorService.updateStatus(narratorId, "working");
				// The continuation prompt was persisted as a system message; the next
				// provider call only needs an empty turn to advance the conversation.
				currentText = "";
				currentImages = undefined;
				continue;
			}

			// No buffered messages — now transition to idle/unread (triggers notifications)
			if (!loopHadError) {
				// Drain any background-subagent completion notice FIRST, before flipping
				// the DB status to idle. This closes the window where status is already
				// idle (visible to clients / route admission) while this loop is still
				// running and about to pick up more work. If a notice is queued, keep the
				// status working and continue this loop instead of going idle at all.
				const bgCompletionAfterIdle = await drainAndPersistBackgroundCompletionNotice(active);
				if (bgCompletionAfterIdle) {
					await narratorService.updateStatus(narratorId, "working");
					currentText = "";
					currentImages = undefined;
					continue;
				}

				// Nothing left to do — atomically transition working/waiting → idle with
				// unread substatus. No awaited work runs between this and the break below,
				// so the "DB idle but loop still running" window is minimal. If status has
				// already moved (e.g. another loop took over after hot reload, or user
				// interrupted), the CAS is a no-op.
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
		try {
			await withDbRetry(
				() =>
					narratorService.updateStatus(narratorId, "idle", {
						substatus: ["error"],
						errorMessage: errorMsg,
					}),
				{ label: "runAgentLoop.updateErrorStatus", maxRetries: 5 },
			);
		} catch (statusErr) {
			logger.error("Failed to persist narrator error status", {
				narratorId,
				error: String(statusErr),
			});
		}
		loopHadError = true;
		active.events.emit("event", { type: "error", data: { message: errorMsg } });
	} finally {
		active._loopRunning = false;
		active.alive = false;

		try {
			const cleared = await clearPipelineStateIfActive(narratorId);
			if (cleared) {
				logger.info("Cleared stale pipeline state after narrator loop", { narratorId });
			}
		} catch (err) {
			logger.warn("Failed to clear stale pipeline state after narrator loop", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// --- Stop hooks ---
		// Fire once per completed response turn for the MAIN narrator only (not
		// subagents). Covers every termination path: normal done, error, and
		// user interrupt. Non-blocking and fire-and-forget — hook failures never
		// affect narrator state.
		if (saParentNarratorId === undefined) {
			void (async () => {
				try {
					const narr = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { variant: true },
					});
					if (narr && isSubagentVariant(narr.variant)) return;

					const stopReason = loopHadError
						? "error"
						: loopWasInterrupted
							? "aborted"
							: loopHitMaxTurns
								? "max_turns"
								: "done";
					const { hookService } = await import("./hook-service");
					await hookService.runHooks(
						"Stop",
						{
							hook_event_name: "Stop",
							narrator_id: narratorId,
							chapter_id: active._chapterId,
							project_id: active._projectId,
							cwd: active.cwd,
							stop_reason: stopReason,
							stop_error: loopHadError,
							last_assistant_text: stopHookFinalText.slice(0, 2000),
							duration_ms: Date.now() - loopStartedAt,
							total_tokens: loopTotalTokens,
						},
						active._projectId,
					);
				} catch (err) {
					logger.warn("Stop hook execution failed", {
						narratorId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			})();
		}

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

				// --- Takeover handoff ---
				// While the subagent is taken over, the parent stays blocked in
				// waitForManualOverride (foreground) or holds a background_task_id
				// (background). When an intermediate loop finishes but the user has
				// NOT stopped takeover, do nothing (keep the takeover active; the
				// subagent waits idle[taken_over] for the next user action).
				if (consumePendingBackgroundFinalize(narratorId)) {
					// Background takeover stopped while still working — finalize as a
					// background completion so the parent learns the result.
					const { finalizeTakenOverBackgroundSubagent } = await import("./subagent-runner");
					const watcher = getConclusionWatcher(narratorId);
					const parentId = saParentNarratorId ?? narr.parentNarratorId ?? "";
					const tuid = watcher?.toolUseId ?? saParentToolUseId ?? "";
					clearTakenOver(narratorId);
					if (parentId) {
						await finalizeTakenOverBackgroundSubagent(
							narratorId,
							parentId,
							tuid,
							loopHadError,
							lastFinalText,
							locale,
						);
					}
				} else if (consumePendingStopTakeover(narratorId)) {
					// Foreground takeover stopped while still working — resolve the
					// parent's blocked Promise exactly once so the parent's
					// runForegroundLoop finalizer returns the result (no double-write).
					clearTakenOver(narratorId);
					if (getManualOverrideMap().has(narratorId)) {
						resolveManualOverride(narratorId, lastFinalText, loopHadError);
					} else {
						// Session-engine takeover stopped while still working — the
						// parent was already unblocked when the user continued the
						// subagent, so hand the result back via the conclusion watcher
						// and clear the lingering taken_over tag.
						const watcher = getConclusionWatcher(narratorId);
						if (watcher) {
							removeConclusionWatcher(narratorId);
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
						await narratorService.removeSubstatus(narratorId, "taken_over").catch(() => {});
					}
				} else if (isTakenOver(narratorId)) {
					// Still taken over — keep blocked/held, no handoff.
				} else {
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

		// 6. Per-narrator git status Promise cache (Bash before-status snapshots)
		active._bashBeforeStatus?.clear();

		if (shouldUpdateTitle) {
			generateAndSetTitle(narratorId, locale).catch(() => {});
		}
		active._provisionalTitle = undefined;

		// Auto-resume: when the loop was interrupted and buffered messages remain,
		// consume them. This makes priority messages run at the next safe boundary
		// without waiting for manual input. Terminal commands (/new, /goal) run no
		// model turn, so resumeNextBufferedMessage keeps draining behind them.
		if (loopWasInterrupted && !loopHadError) {
			resumeNextBufferedMessage(active, locale);
		}
	}

	return { started: true };
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
	preBashCommand?: string | null,
): Promise<{
	active: ActiveNarrator;
	userMsg: typeof narratorMessages.$inferSelect;
	userBroadcasted?: boolean;
}> {
	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Final guard against a concurrent loop slipping past the route-level admission
	// check (which should have buffered this message). ensureNarrator reuses the live
	// `active`, so starting a second runAgentLoop here would corrupt the shared session.
	// Throw BEFORE persisting the user message so we never leave a half-applied turn.
	if (active._loopRunning) {
		logger.warn("feedMessage blocked: loop already running", { narratorId });
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		throw new ValidationError("Narrator is already running");
	}
	active._continuationSuppressed = false;
	active._continuationNoToolCount = 0;
	// Record the user who triggered this turn → flows into ToolContext.userId for knowledge ACL.
	active._currentUserId = userId ?? null;
	// Open the one-shot behavior-fence edit window for this user turn. It is consumed by the
	// first behavior_fence write and cleared once the first tool call completes, so the agent
	// can only record a fence on its first tool call and only when the user asked for it.
	grantBehaviorFenceEdit(narratorId);

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

	// --- Resolve manual_override if active (legacy implicit path) ---
	// When the user sends a message directly on a subagent page while the parent
	// narrator is blocked in waitForManualOverride, we must resolve that Promise
	// first. Otherwise the parent stays blocked forever while the subagent runs
	// independently via narrator-session. We also register a ConclusionWatcher so
	// the parent's tool_call result is updated when this independent run finishes.
	//
	// EXCEPTION — explicit takeover: while taken over, the parent intentionally
	// stays blocked for the entire takeover. The user can send/interrupt/continue
	// freely; the result is only handed back when the user stops takeover. So we
	// do NOT resolve the override or register a watcher here. We still set up the
	// conclusion file for explore/plan subagents so Write/Edit redirect works.
	const narrator = await narratorService.getById(narratorId);
	if (isSubagentVariant(narrator.variant) && narrator.parentNarratorId) {
		const currentSubstatus = parseSubstatus(narrator.substatus);
		const takenOver = isTakenOver(narratorId);
		if (takenOver) {
			if (isReadOnlySubagentVariant(narrator.variant)) {
				setConclusionFileId(narratorId, generateWordSlug(), active.cwd);
			}
			// Parent stays blocked — do not resolve, do not register a watcher.
		} else if (currentSubstatus.includes("manual_override")) {
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
		active._provisionalTitle =
			(await setProvisionalTitleFromUserMessage(narratorId, prompt)) ?? undefined;
		generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	// runBashFirst flow: after persisting the user message, run the Bash command as
	// an assistant tool card, then start the loop with empty text. buildHistory
	// reconstructs the Bash tool_result as the current user turn, so the model sees
	// the order: user prompt → Bash tool call/result → model reply.
	if (preBashCommand) {
		// Broadcast the persisted user message before Bash starts. In chunk mode the
		// frontend renders directly from WS events (not the query optimistic cache),
		// so delaying this until sendMessage() returns would show the Bash card first.
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
		await handleBashCommand(
			narratorId,
			preBashCommand,
			`/bash ${preBashCommand}`,
			userId ?? undefined,
			{
				skipUserMessage: true,
				signal: active.abortController.signal,
			},
		);
		runAgentLoop(active, "", undefined).catch(async (err) => {
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
		return { active, userMsg, userBroadcasted: true };
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
	preBashCommand?: string | null,
): Promise<typeof narratorMessages.$inferSelect> {
	const { userMsg, userBroadcasted } = await feedMessage(
		narratorId,
		prompt,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
		textFiles,
		preBashCommand,
	);
	if (!userBroadcasted) {
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
	}
	return userMsg;
}

export async function startBackgroundCompletionContinuationIfPossible(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ started: boolean }> {
	return backgroundCompletionStartLock.acquire(narratorId, async () => {
		const activeExisting = activeNarrators.get(narratorId);
		if (activeExisting?.alive && activeExisting._loopRunning) return { started: false };

		const narrator = await narratorService.getById(narratorId);
		if (narrator.status !== "idle") return { started: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { started: false };

		const prompt = await drainAndPersistBackgroundCompletionNotice(active);
		if (!prompt) return { started: false };

		active._continuationSuppressed = false;
		active._continuationNoToolCount = 0;
		active._lastTokenUsage = undefined;
		active._ttftMs = undefined;
		active._turnStartedAt = new Date().toISOString();

		await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });
		runAgentLoop(active, "").catch(async (err) => {
			logger.error("runAgentLoop unhandled error (background completion)", {
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
		});
		return { started: true };
	});
}

/**
 * Wake an idle parent narrator to consume progress reports sent by its child
 * subagents via Send({ id: "parent" }). A working/waiting parent drains the
 * queue at its next after_tools sidecar boundary, so this only acts on idle
 * narrators. Plan-mode narrators are not auto-woken (mirrors goal continuation
 * and chat-group delivery) — the message stays queued until their next activity.
 *
 * Reuses backgroundCompletionStartLock so it cannot race the background-task
 * completion continuation into starting two concurrent loops.
 */
export async function startParentInboundContinuationIfPossible(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ started: boolean }> {
	return backgroundCompletionStartLock.acquire(narratorId, async () => {
		const activeExisting = activeNarrators.get(narratorId);
		if (activeExisting?.alive && activeExisting._loopRunning) return { started: false };

		const narrator = await narratorService.getById(narratorId);
		if (narrator.status !== "idle") return { started: false };
		// Plan-mode narrators are not auto-woken; leave the report queued.
		if (isPlanModeTrait(narrator.traits)) return { started: false };

		const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
		if (active._loopRunning) return { started: false };

		const prompt = await drainAndPersistParentInboundNotice(active);
		if (!prompt) return { started: false };

		active._continuationSuppressed = false;
		active._continuationNoToolCount = 0;
		active._lastTokenUsage = undefined;
		active._ttftMs = undefined;
		active._turnStartedAt = new Date().toISOString();

		await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });
		runAgentLoop(active, "").catch(async (err) => {
			logger.error("runAgentLoop unhandled error (subagent message)", {
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
		});
		return { started: true };
	});
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
	userId?: string | null,
): Promise<{ ok: boolean }> {
	// Check if this is a subagent — subagent messages all have parentToolUseId
	// set, so we must not filter on isNull(parentToolUseId) for them.
	const narrator = await narratorService.getById(narratorId);
	// Guard before any destructive work (deleteMessagesAfter below): if a loop is
	// already running, refuse rather than mutate history under a live session.
	if (isLoopRunning(narratorId)) {
		logger.warn("retryLastMessage blocked: loop already running", { narratorId });
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}
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

	const imageRefs = extractImageRefs(lastMsg.contentJson, lastMsg.narratorId);

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Restore the triggering user so knowledge-base ACL works after a rebuild.
	active._currentUserId = userId ?? active._currentUserId ?? null;
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
	userId?: string | null,
): Promise<{ ok: boolean }> {
	// If the last top-level message is a tool-call assistant turn, replay the
	// tool-result request packet instead of appending a textual "continue".
	const rawMsgs = await narratorService.getMessagesSinceLastCompact(narratorId);

	// Subagent messages all have parentToolUseId set — clear it so
	// getLastContinuableTopLevelMessage can find them (same as runAgentLoop).
	const narrator = await narratorService.getById(narratorId);
	// Guard: refuse to continue while a loop is already running (authoritative
	// in-memory check, independent of a possibly-stale DB status).
	if (isLoopRunning(narratorId)) {
		logger.warn("continueNarrator blocked: loop already running", { narratorId });
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}
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
			null,
			userId,
		);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
		return { ok: true };
	}

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Restore the triggering user so knowledge-base ACL works after a rebuild
	// (interrupt may have destroyed the prior active, leaving _currentUserId unset).
	active._currentUserId = userId ?? active._currentUserId ?? null;
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
 * Tool calls that are not real executable tools (control / UI tools) and must
 * never be re-executed via the "allow and execute" path. ExitPlanMode and
 * AskUserQuestion are interactive control tools handled inside the loop; the
 * rest carry no file/side effects worth replaying.
 */
const NON_RERUNNABLE_TOOL_NAMES = new Set([
	"ExitPlanMode",
	"EnterPlanMode",
	"AskUserQuestion",
	"StartPipeline",
	"EndPipeline",
]);

/** permissionDecidedBy values that mark a tool call as "stopped at the permission gate". */
const RERUNNABLE_DECIDED_BY = new Set(["user", "aborted"]);

export type ReExecuteDeniedReason =
	| "not_found"
	| "not_denied"
	| "not_latest_turn"
	| "not_rerunnable_tool"
	| "narrator_busy";

export type ReExecuteDeniedResult = { ok: true } | { ok: false; reason: ReExecuteDeniedReason };

/**
 * Pure precondition check for re-executing a denied tool call. Returns null when
 * the tool call may be re-run, or a failure reason otherwise. Kept separate from
 * the DB/execution side effects so the decision logic is unit-testable.
 */
export function evaluateRerunnableToolCall(
	toolCall: {
		toolName: string;
		status: string;
		permissionDecidedBy?: string | null;
		messageId: string;
	} | null,
	latestAssistantMessageId: string | null,
): ReExecuteDeniedReason | null {
	if (!toolCall) return "not_found";
	if (NON_RERUNNABLE_TOOL_NAMES.has(toolCall.toolName)) return "not_rerunnable_tool";
	// Only tool calls stopped at the permission gate (user deny or interrupt-
	// cancelled) are safe to re-run: they never executed, so there is no partial
	// side effect to worry about.
	if (
		toolCall.status !== "fail" ||
		!toolCall.permissionDecidedBy ||
		!RERUNNABLE_DECIDED_BY.has(toolCall.permissionDecidedBy)
	) {
		return "not_denied";
	}
	// The tool call must belong to the latest top-level assistant message so
	// re-running it does not reorder history relative to later turns.
	if (!latestAssistantMessageId || latestAssistantMessageId !== toolCall.messageId) {
		return "not_latest_turn";
	}
	return null;
}

/**
 * Re-execute a tool call that was denied by the user (or whose pending
 * permission was cancelled by an interrupt) in the latest assistant turn.
 *
 * The denied tool_use block is still present in the assistant message's
 * contentJson, and its tool_result is reconstructed from the narrator_tool_calls
 * row at history-build time. So "un-denying" a tool only requires:
 *   1. reset the tool call row (fail → pending, clear deny/output fields),
 *   2. execute the tool directly with a pre-granted permission (the in-memory
 *      pendingPermissions entry is gone after the interrupt, so resolvePermission
 *      cannot be used),
 *   3. write the fresh result back into the row,
 *   4. continue the loop so the model sees the new result and resumes.
 */
export async function reExecuteDeniedToolCall(
	narratorId: string,
	toolUseId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	userId?: string | null,
): Promise<ReExecuteDeniedResult> {
	const narrator = await narratorService.getById(narratorId);
	if (narrator.status === "working" || narrator.status === "waiting") {
		return { ok: false, reason: "narrator_busy" };
	}
	if (isNarratorActive(narratorId)) {
		// A live agent loop is still running for this narrator — refuse to avoid
		// racing the loop's own tool execution / history rebuild.
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		return { ok: false, reason: "narrator_busy" };
	}

	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
	});

	// The tool call must belong to the latest top-level assistant message so
	// re-running it does not reorder history relative to later turns.
	const isSubagent = isSubagentVariant(narrator.variant);
	const lastRef = await db
		.select({ messageId: narratorMessageRefs.messageId })
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
	const latestAssistantMessageId = lastRef.length ? lastRef[0].messageId : null;

	const rejectReason = evaluateRerunnableToolCall(toolCall ?? null, latestAssistantMessageId);
	if (rejectReason) {
		return { ok: false, reason: rejectReason };
	}
	// evaluateRerunnableToolCall guarantees toolCall is non-null past this point.
	if (!toolCall) return { ok: false, reason: "not_found" };

	const toolInput =
		toolCall.inputJson &&
		typeof toolCall.inputJson === "object" &&
		!Array.isArray(toolCall.inputJson)
			? (toolCall.inputJson as Record<string, unknown>)
			: {};

	// Reset the row so buildHistory no longer treats it as a completed failure.
	await db
		.update(narratorToolCalls)
		.set({
			status: "pending",
			outputJson: null,
			errorMessage: null,
			permissionDenyMessage: null,
			permissionDecidedBy: null,
			permissionDecidedAt: null,
			permissionDecisionReason: null,
			permissionSuggestions: null,
			completedAt: null,
			durationMs: null,
			executionStartedAt: null,
		})
		.where(eq(narratorToolCalls.id, toolCall.id));

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	// Restore the triggering user so knowledge-base ACL works after a rebuild.
	// The active may have been freshly recreated (interrupt destroyed the old one),
	// in which case _currentUserId would otherwise be undefined → null.
	active._currentUserId = userId ?? active._currentUserId ?? null;
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	broadcastToNarrator(narratorId, {
		type: "tool_started",
		narratorId,
		toolUseId,
		toolName: toolCall.toolName,
		input: toolInput,
	});

	const { executeTool } = await import("../lib/agent/tool-executor");
	const toolName = toolCall.toolName;

	// Minimal AgentConfig sufficient for executeTool. Nested permission requests
	// (e.g. narrafork-admin) still flow through the normal handler; the top-level
	// call is pre-granted because the user just explicitly allowed it.
	const config: import("../lib/agent").AgentConfig = {
		narratorId,
		conversationId: active.conversationId,
		model: active.model,
		provider: active.provider,
		cwd: active.cwd,
		locale,
		signal: active.abortController.signal,
		chapterId: active._chapterId,
		planFileId: active._planFileId,
		skillRoot: active._skillRoot ?? undefined,
		projectGitPath: active._projectGitPath ?? undefined,
		skillScopeKey: active._skillScopeKey ?? undefined,
		userId: active._currentUserId ?? null,
		projectId: active._projectId ?? null,
		defaultDeviceId: active._defaultDeviceId ?? null,
		availableDevices: await resolveSessionDevices(active._projectId ?? null),
		setDefaultDevice: (deviceId) => applySessionDefaultDevice(narratorId, active, deviceId),
		disabledTools: active._disabledTools,
		permissionHandler: (tName, input, tUseId, options) =>
			handlePermission(
				narratorId,
				active.abortController.signal,
				tName,
				input,
				tUseId,
				active.cwd,
				locale,
				undefined,
				options,
			),
		onEvent: (event) => {
			if (event.type === "tool_output") {
				broadcastToNarrator(narratorId, {
					type: "tool_output",
					narratorId,
					toolUseId: event.toolUseId,
					output: event.output,
				});
			} else if (event.type === "tool_progress") {
				broadcastToNarrator(narratorId, {
					type: "tool_progress",
					narratorId,
					toolUseId: event.toolUseId,
					elapsed: event.elapsed,
				});
			} else if (event.type === "tool_long_running") {
				broadcastToNarrator(narratorId, {
					type: "tool_long_running",
					narratorId,
					toolUseId: event.toolUseId,
					elapsed: event.elapsed,
				});
			}
		},
	};

	// Bash mutates tracked files directly, so capture a before-status snapshot to
	// mirror the loop's onSnapshotBefore/After hooks (Write/Edit snapshot inside
	// their own execute()).
	const isShellTool = toolName === SHELL_TOOL_NAME;
	let bashBeforeFiles: Set<string> | undefined;
	if (isShellTool && active._isInGitRepo) {
		try {
			bashBeforeFiles = parsePorcelainFiles(await gitService.getStatus(active.cwd));
		} catch (err) {
			logger.debug("Bash rerun before-status failed", {
				narratorId,
				toolUseId,
				error: String(err),
			});
		}
	}

	try {
		const result = await executeTool({ name: toolName, input: toolInput, toolUseId }, config, {
			preGrantedPermission: { behavior: "allow" },
		});

		await narratorService.updateToolCallResult(toolUseId, {
			output: result.metadata
				? { _text: result.output, _metadata: result.metadata }
				: result.output,
			status: result.isError ? "fail" : "success",
			errorMessage: result.isError ? result.output : undefined,
			durationMs: result.durationMs,
			permissionStartedAt: result.permissionStartedAt,
			executionStartedAt: result.executionStartedAt,
			completedAt: result.completedAt,
		});
		if (result.updatedInput) {
			await narratorService.overwriteToolCallInput(toolUseId, result.updatedInput);
		}

		broadcastToNarrator(narratorId, {
			type: "tool_completed",
			narratorId,
			toolUseId,
			toolName,
			status: result.isError ? "fail" : "success",
			output: result.metadata
				? { _text: result.output, _metadata: result.metadata }
				: result.output,
			durationMs: result.durationMs,
			...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
			...(result.metadata ? { metadata: result.metadata } : {}),
		});

		// Capture file snapshots for Bash-modified tracked files so later rollback
		// can restore the pre-rerun content.
		if (isShellTool && active._isInGitRepo && bashBeforeFiles) {
			try {
				const afterFiles = parsePorcelainFiles(await gitService.getStatus(active.cwd));
				const changedFiles = [...afterFiles].filter((f) => !bashBeforeFiles?.has(f));
				if (changedFiles.length > 0) {
					const { ensureFileSnapshot } = await import("./file-snapshot-service");
					const cwd = active.cwd;
					for (const filePath of changedFiles) {
						await ensureFileSnapshot(narratorId, filePath, async () => {
							try {
								return await gitService.getFileAtHead(cwd, filePath);
							} catch {
								return null;
							}
						});
					}
				}
			} catch (err) {
				logger.debug("Bash rerun after-snapshot failed", {
					narratorId,
					toolUseId,
					error: String(err),
				});
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error("Failed to re-execute denied tool call", {
			narratorId,
			toolUseId,
			error: message,
		});
		await narratorService
			.updateToolCallResult(toolUseId, {
				output: `Re-execution failed: ${message}`,
				status: "fail",
				errorMessage: `Re-execution failed: ${message}`,
				completedAt: Date.now(),
			})
			.catch(() => {});
		broadcastToNarrator(narratorId, {
			type: "tool_completed",
			narratorId,
			toolUseId,
			toolName,
			status: "fail",
			output: `Re-execution failed: ${message}`,
		});
		await narratorService.updateStatus(narratorId, "idle", { substatus: ["error"] });
		return { ok: true };
	}

	// Auto-continue: replay the freshly produced tool result so the model resumes
	// from where it was interrupted. Forward the triggering user so knowledge ACL
	// keeps working through the continued loop.
	await continueNarrator(narratorId, locale, replyInUserLanguage, userId);
	return { ok: true };
}

export function normalizeRollbackBlockIndexForMessage(
	role: string | null | undefined,
	blockIndex: number,
	blockCount: number,
): number {
	// User messages must remain atomic. Multimodal user messages are persisted as
	// attachments first and text after them, so truncating at an image block would
	// leave an image-only turn that providers can reject. Rolling back "to" a user
	// message should preserve the complete user input and only remove later turns.
	if (role === "user") return blockCount - 1;
	return blockIndex;
}

/**
 * Rollback to a specific block within a message.
 * Deletes all blocks after the effective blockIndex in the target message,
 * plus all subsequent messages. User messages are preserved as whole turns.
 * Does NOT re-run the agent loop.
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

	const effectiveBlockIndex = normalizeRollbackBlockIndexForMessage(
		targetMsg.role,
		blockIndex,
		blocks.length,
	);

	// Step 1: Delete all messages after the target message (includes file revert)
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, messageId, {
		preserveConversationId: true,
	});
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	// Step 2: Delete blocks after the effective rollback boundary in the target message
	const blocksToDelete: Array<{ messageId: string; blockIndex: number }> = [];
	for (let i = blocks.length - 1; i > effectiveBlockIndex; i--) {
		blocksToDelete.push({ messageId, blockIndex: i });
	}

	if (blocksToDelete.length > 0) {
		const blockDeleteResult = await narratorService.deleteMessageBlocks(
			narratorId,
			blocksToDelete,
			{
				preserveConversationId: true,
			},
		);

		const targetMessageDeleted = blockDeleteResult.results.some(
			(r) => r.messageId === messageId && r.messageDeleted,
		);
		if (targetMessageDeleted) {
			broadcastToNarrator(narratorId, {
				type: "messages_deleted",
				narratorId,
				deletedMessageIds: [messageId],
			});
		} else {
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
	}

	return { ok: true };
}

/** Extract image refs from a message's contentJson. */
function extractImageRefs(
	contentJson: unknown,
	fallbackUploadNarratorId?: string | null,
): ImageRef[] {
	const imageRefs: ImageRef[] = [];
	if (Array.isArray(contentJson)) {
		for (const block of contentJson as Array<Record<string, unknown>>) {
			if (
				block.type === "image" &&
				typeof block.imageId === "string" &&
				typeof block.filename === "string" &&
				typeof block.mediaType === "string"
			) {
				const uploadNarratorId =
					typeof block.uploadNarratorId === "string"
						? block.uploadNarratorId
						: fallbackUploadNarratorId;
				imageRefs.push({
					imageId: block.imageId as string,
					filename: block.filename as string,
					mediaType: block.mediaType as string,
					...(uploadNarratorId ? { uploadNarratorId } : {}),
				});
			}
		}
	}
	return imageRefs;
}

type EditableUserContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			imageId: string;
			filename: string;
			mediaType: string;
			uploadNarratorId?: string;
	  }
	| { type: "text_file"; filename: string; size: number; filePath: string };

/**
 * Extract persisted text-file attachment blocks as TextFileRefs so the edited
 * prompt can re-inject the <attached_files> hint. The underlying files already
 * live in the worktree, so we only need their metadata.
 */
function extractTextFileRefs(contentJson: unknown): TextFileRef[] {
	const refs: TextFileRef[] = [];
	if (!Array.isArray(contentJson)) return refs;
	for (const block of contentJson as Array<Record<string, unknown>>) {
		if (
			block.type === "text_file" &&
			typeof block.filename === "string" &&
			typeof block.filePath === "string" &&
			typeof block.size === "number"
		) {
			refs.push({
				filename: block.filename,
				filePath: block.filePath,
				size: block.size,
			});
		}
	}
	return refs;
}

/**
 * Replace editable text while preserving the persisted attachment block order.
 * New user messages are stored as images/text_files first, then text; editing
 * must not move or drop those attachment blocks or history replay/front-end
 * fetches can target the wrong shape (and attachments would silently vanish).
 *
 * Image handling:
 *   - `opts.keepImageIds === undefined` → keep ALL existing images (legacy
 *     behaviour: callers that don't manage images never lose them).
 *   - `opts.keepImageIds` provided → keep only existing images whose imageId is
 *     in the set (images the user removed during editing are dropped).
 *   - `opts.newImages` → appended as fresh image blocks (uploaded during editing).
 */
function buildEditedUserContentJson(
	contentJson: unknown,
	newContent: string,
	fallbackUploadNarratorId?: string | null,
	opts?: { keepImageIds?: string[]; newImages?: ImageRef[] },
): EditableUserContentBlock[] {
	const blocks = Array.isArray(contentJson) ? (contentJson as Array<Record<string, unknown>>) : [];
	const keepSet = opts?.keepImageIds ? new Set(opts.keepImageIds) : null;
	const imageBlocks: EditableUserContentBlock[] = [];
	const textFileBlocks: EditableUserContentBlock[] = [];

	for (const block of blocks) {
		if (
			block.type === "image" &&
			typeof block.imageId === "string" &&
			typeof block.filename === "string" &&
			typeof block.mediaType === "string"
		) {
			// Drop images the user removed during editing.
			if (keepSet && !keepSet.has(block.imageId)) continue;
			const uploadNarratorId =
				typeof block.uploadNarratorId === "string"
					? block.uploadNarratorId
					: fallbackUploadNarratorId;
			imageBlocks.push({
				type: "image",
				imageId: block.imageId,
				filename: block.filename,
				mediaType: block.mediaType,
				...(uploadNarratorId ? { uploadNarratorId } : {}),
			});
			continue;
		}

		if (
			block.type === "text_file" &&
			typeof block.filename === "string" &&
			typeof block.filePath === "string" &&
			typeof block.size === "number"
		) {
			textFileBlocks.push({
				type: "text_file",
				filename: block.filename,
				size: block.size,
				filePath: block.filePath,
			});
		}
	}

	// Newly uploaded images during editing — keep them after existing ones.
	// Prefer the ref's own uploadNarratorId (the narrator the files were saved
	// under), falling back to the editing narrator.
	if (opts?.newImages?.length) {
		for (const img of opts.newImages) {
			const uploadNarratorId = img.uploadNarratorId ?? fallbackUploadNarratorId;
			imageBlocks.push({
				type: "image",
				imageId: img.imageId,
				filename: img.filename,
				mediaType: img.mediaType,
				...(uploadNarratorId ? { uploadNarratorId } : {}),
			});
		}
	}

	// Canonical order matches freshly sent messages: images, text_files, text.
	return [...imageBlocks, ...textFileBlocks, { type: "text", text: newContent }];
}

/**
 * Edit a user message and regenerate the response.
 * Updates the message content, deletes everything after it, and re-runs the agent loop.
 * If rollback is true and the narrator is bound to a chapter, resets git to the state
 * before the original message was sent.
 *
 * `opts.keepImageIds` / `opts.newImages` let the caller manage attached images during
 * editing (keep a subset of existing images, drop the rest, and/or append new uploads).
 * When `opts` is omitted, all existing images are preserved (backward compatible).
 */
export async function editAndRegenerate(
	narratorId: string,
	messageId: string,
	newContent: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	rollback = false,
	opts?: { keepImageIds?: string[]; newImages?: ImageRef[]; userId?: string | null },
): Promise<{ ok: boolean }> {
	// Guard before any destructive work (copy-on-write + deleteMessagesAfter below):
	// refuse to edit/regenerate while a loop is already running on this narrator.
	if (isLoopRunning(narratorId)) {
		logger.warn("editAndRegenerate blocked: loop already running", { narratorId });
		// Correct a stale idle status so the user regains the interrupt button.
		await reconcileRunningStatus(narratorId);
		return { ok: false };
	}
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

	// Rebuild blocks: keep the user-selected subset of existing images, drop the
	// rest, append any newly uploaded images, and replace the editable text.
	const newContentJson = buildEditedUserContentJson(
		targetMsg.contentJson,
		newContent,
		targetMsg.narratorId,
		opts,
	);
	// Derive the final image refs from the rebuilt blocks so kept + new images
	// (and only those) are sent to the model on regeneration.
	const existingImages = extractImageRefs(newContentJson, targetMsg.narratorId);
	const existingTextFiles = extractTextFileRefs(targetMsg.contentJson);

	// When the edited text is empty but images remain, inject a placeholder so
	// providers that gate on non-empty content still include the image blocks.
	const effectiveText =
		!newContent.trim() && existingImages.length > 0 ? "[user sent image(s)]" : newContent;

	// Re-inject the attached-files hint so the regenerated turn keeps access to
	// any text-file attachments (contentText feeds the AI prompt + FTS index,
	// while contentJson keeps the raw user text for display).
	const effectivePrompt = effectiveText + buildAttachedFilesHint(existingTextFiles);

	const privateMessageId = await narratorService.copyOnWriteMessage(narratorId, messageId, {
		contentText: effectivePrompt,
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

	// Delete everything after this message while preserving the API cache key.
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(
		narratorId,
		privateMessageId,
		{ preserveConversationId: true },
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
	// Restore the triggering user so knowledge-base ACL works after a rebuild.
	active._currentUserId = opts?.userId ?? active._currentUserId ?? null;
	active._lastTokenUsage = undefined;
	active._ttftMs = undefined;
	active._turnStartedAt = new Date().toISOString();
	await narratorService.updateStatus(narratorId, "working", { setTurnStart: true });

	runAgentLoop(active, effectivePrompt, imageRefs.length > 0 ? imageRefs : undefined).catch(
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
 * Replace the editable text of an assistant message while preserving all other
 * blocks (thinking / tool_use / etc.) in their original order. The new text is
 * written into the first text block; if none exists, a text block is appended.
 */
function buildEditedAssistantContentJson(
	contentJson: unknown,
	newContent: string,
): Array<Record<string, unknown>> {
	const blocks = Array.isArray(contentJson) ? (contentJson as Array<Record<string, unknown>>) : [];
	const newBlocks: Array<Record<string, unknown>> = [];
	let replacedText = false;

	for (const block of blocks) {
		if (block.type === "text") {
			if (!replacedText) {
				newBlocks.push({ ...block, text: newContent });
				replacedText = true;
			}
			// Drop any additional text blocks — the edited text is consolidated
			// into the first one (matches the single-textarea edit UI).
			continue;
		}
		newBlocks.push(block);
	}

	if (!replacedText) {
		newBlocks.push({ type: "text", text: newContent });
	}

	return newBlocks;
}

/**
 * Edit the text content of an assistant message without regenerating.
 *
 * Unlike editing a user message, this does NOT truncate following messages or
 * re-run the agent loop. The new text is persisted and used when assembling the
 * history for subsequent turns, but the "edited" metadata (editedAt / editedBy /
 * originalContentJson) lives on the message row — never inside contentJson — so
 * it is never sent to the AI provider.
 *
 * Copy-on-write protects fork sources: if the message is shared by multiple
 * narrators (ref count > 1), a private copy is created for this narrator only.
 */
export async function editAssistantMessage(
	narratorId: string,
	messageId: string,
	newContent: string,
	editedBy?: string | null,
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
	if (targetMsg.role !== "assistant") {
		throw new NotFoundError("Can only edit assistant messages", messageId);
	}

	const newContentJson = buildEditedAssistantContentJson(targetMsg.contentJson, newContent);
	const now = new Date().toISOString();

	// Preserve the original content the first time a message is edited so the
	// front-end can always reveal the unedited version.
	const overrides: Partial<typeof narratorMessages.$inferInsert> = {
		contentJson: newContentJson,
		contentText: newContent,
		editedAt: now,
		editedBy: editedBy ?? null,
	};
	if (!targetMsg.editedAt) {
		overrides.originalContentJson = targetMsg.contentJson;
	}

	const privateMessageId = await narratorService.copyOnWriteMessage(
		narratorId,
		messageId,
		overrides,
	);

	// Broadcast the updated message. If copy-on-write changed the message ID,
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

	return { ok: true };
}

/**
 * Restore an assistant message to its original (pre-edit) text.
 *
 * Reverts contentJson/contentText to the captured originalContentJson and clears
 * all edit metadata (editedAt / editedBy / originalContentJson) so the message
 * looks like it was never edited and the "edited" badge disappears.
 *
 * Copy-on-write protects fork sources, mirroring editAssistantMessage.
 */
export async function restoreAssistantMessage(
	narratorId: string,
	messageId: string,
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
	if (targetMsg.role !== "assistant") {
		throw new NotFoundError("Can only restore assistant messages", messageId);
	}

	// Nothing to restore if the message was never edited.
	if (!targetMsg.editedAt) {
		return { ok: true };
	}

	const originalContentJson = Array.isArray(targetMsg.originalContentJson)
		? (targetMsg.originalContentJson as Array<Record<string, unknown>>)
		: [];
	const originalText = originalContentJson
		.filter((b) => b?.type === "text")
		.map((b) => (typeof b.text === "string" ? b.text : ""))
		.join("\n\n");

	const overrides: Partial<typeof narratorMessages.$inferInsert> = {
		contentJson: originalContentJson,
		contentText: originalText,
		editedAt: null,
		editedBy: null,
		originalContentJson: null,
	};

	const privateMessageId = await narratorService.copyOnWriteMessage(
		narratorId,
		messageId,
		overrides,
	);

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
		db.transaction((tx) => {
			tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, partialId)).run();
			tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, partialId)).run();
			tx.delete(narratorMessages).where(eq(narratorMessages.id, partialId)).run();
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
			const hasContent = db.transaction((tx) => {
				const msg = tx.query.narratorMessages
					.findFirst({
						where: eq(narratorMessages.id, partialId),
						columns: { contentJson: true },
					})
					.sync();
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
					tx.delete(narratorToolCalls)
						.where(
							inArray(
								narratorToolCalls.id,
								toolCalls.map((tc) => tc.id),
							),
						)
						.run();
					const filtered = blocks.filter(
						(block) => block.type !== "tool_use" || !toolUseIds.has(block.id as string),
					);
					tx.update(narratorMessages)
						.set({ contentJson: filtered })
						.where(eq(narratorMessages.id, partialId))
						.run();
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

		db.transaction((tx) => {
			// Delete unexecuted tool_call records
			if (unexecuted.length > 0) {
				tx.delete(narratorToolCalls)
					.where(
						inArray(
							narratorToolCalls.id,
							unexecuted.map((tc) => tc.id),
						),
					)
					.run();
			}

			// Mark running tool_calls as fail (interrupted by retry)
			const running = executed.filter((tc) => tc.status === "running");
			if (running.length > 0) {
				tx.update(narratorToolCalls)
					.set({
						status: "fail",
						errorMessage: "Interrupted by API error during retry",
					})
					.where(
						inArray(
							narratorToolCalls.id,
							running.map((tc) => tc.id),
						),
					)
					.run();
			}

			// Remove unexecuted tool_use blocks from contentJson
			if (unexecutedToolUseIds.size > 0) {
				const msg = tx.query.narratorMessages
					.findFirst({
						where: eq(narratorMessages.id, partialId),
						columns: { contentJson: true },
					})
					.sync();
				if (msg && Array.isArray(msg.contentJson)) {
					const filtered = (msg.contentJson as Array<Record<string, unknown>>).filter(
						(block) => block.type !== "tool_use" || !unexecutedToolUseIds.has(block.id as string),
					);
					tx.update(narratorMessages)
						.set({ contentJson: filtered })
						.where(eq(narratorMessages.id, partialId))
						.run();
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

const INTERRUPTABLE_TOOL_CALL_STATUSES = ["initializing", "pending", "running"] as const;

/**
 * Mark in-flight tool calls for one assistant message as interrupted.
 *
 * This is intentionally message-scoped so the interrupt finalizer can first
 * protect the current partial assistant message before deciding whether that
 * partial should be kept or deleted.
 */
export async function markInterruptedToolCallsForMessage(
	narratorId: string,
	messageId: string,
	locale: Locale = "en",
): Promise<void> {
	await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: "Narrator interrupted by user",
			outputJson: getToolMessage("interruptedByUser", locale),
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.messageId, messageId),
				inArray(narratorToolCalls.status, [...INTERRUPTABLE_TOOL_CALL_STATUSES]),
			),
		);
}

/**
 * Mark any in-flight tool calls for this narrator as failed.
 * Without this, an interrupt leaves orphaned tool call records in
 * "initializing" / "pending" / "running" state, which breaks the
 */
async function cleanupOrphanedToolCalls(narratorId: string, locale: Locale = "en"): Promise<void> {
	await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: "Narrator interrupted by user",
			outputJson: getToolMessage("interruptedByUser", locale),
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...INTERRUPTABLE_TOOL_CALL_STATUSES]),
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
	// Also fan out to foreground subagents owned by this primary narrator. The
	// parent abort signal normally propagates into the child loop, but doing this
	// explicitly prevents child DB/UI state from staying stuck as working if the
	// parent loop exits before the child finalizer broadcasts.
	import("./narrator-subagent")
		.then(({ interruptForegroundSubagentsForParent }) =>
			interruptForegroundSubagentsForParent(narratorId),
		)
		.catch((err) => {
			logger.warn("Failed to interrupt foreground subagents", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
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

/**
 * Whether an agent loop is actually executing for this narrator right now.
 *
 * This reads the authoritative in-memory `_loopRunning` flag rather than the DB
 * `status` snapshot, which can lag behind reality (e.g. a turn that was set idle
 * during post-turn drain, or an interrupt whose async abort has not yet finished
 * cleanup). Route-level admission checks use this so that a stale idle status
 * cannot let a second concurrent loop start.
 */
export function isLoopRunning(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	return active?.alive === true && active._loopRunning === true;
}

/**
 * Reconcile a stale narrator status: when a loop is actually running in memory
 * but the DB status wrongly shows a non-running state (idle/archived), flip it
 * back to "working" and broadcast.
 *
 * This is called from every path that buffers or rejects a user action because
 * a loop is already running. Without it, a stale idle status would leave the
 * user stuck — the frontend hides the interrupt button when status is idle, so
 * the user could neither continue (blocked) nor stop (no button).
 *
 * CAS only matches ["idle", "archived"]: it never overwrites a legitimate
 * waiting/reflecting state, and is a no-op when status is already working. The
 * transition clears stale substatus tags (unread/error) by design — the
 * narrator is in fact running, so those tags no longer apply.
 *
 * Returns true only when an actual correction was made.
 */
export async function reconcileRunningStatus(narratorId: string): Promise<boolean> {
	if (!isLoopRunning(narratorId)) return false;
	const changed = await narratorService.compareAndSetStatus(
		narratorId,
		["idle", "archived"],
		"working",
	);
	if (changed) {
		logger.warn("Reconciled stale narrator status → working (loop was actually running)", {
			narratorId,
		});
	}
	return changed;
}

export function requestBufferedMessageSoftStop(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return false;
	active._bufferSoftStop = true;
	return true;
}

// === Dynamic narrator controls ===

function resolveRuntimeReasoningEffort(
	provider: string,
	model: string,
	reasoningEffort: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
	return reasoningEffort ?? resolveDefaultReasoningEffort(provider, model) ?? null;
}

export function updateNarratorModel(narratorId: string, model: string): void {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		active._modelRef = model || FOLLOW_DEFAULT_MODEL;
		active._settingsRevision = getSettingsRevision();
		const effectiveModel = resolveEffectiveModel(active._modelRef, active.provider);
		active.model = effectiveModel;
		active.provider = resolveProvider(effectiveModel);
		active.reasoningEffort = resolveRuntimeReasoningEffort(
			active.provider,
			active.model,
			active._reasoningEffortRef,
		);
		broadcastToNarrator(narratorId, {
			type: "model_changed",
			narratorId,
			model,
		});
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: effectiveModel,
			reasoningEffort: active.reasoningEffort ?? null,
			status: active._loopRunning ? "pending" : "updated",
			applyAt: active._loopRunning ? "next_model_request" : "next_request",
		});
	} else if (updateActiveSubagentModel(narratorId, resolveEffectiveModel(model))) {
		// Subagent: update lightweight settings map; loop picks it up via getRuntimeSettingsOverride
		const effectiveModel = resolveEffectiveModel(model);
		const sa = activeSubagentSettings.get(narratorId);
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: effectiveModel,
			reasoningEffort: sa?.reasoningEffort ?? null,
			status: "pending",
			applyAt: "next_model_request",
		});
	}
}

export function updateNarratorReasoningEffort(
	narratorId: string,
	reasoningEffort: ReasoningEffort | null,
): void {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		active._reasoningEffortRef = reasoningEffort;
		active.reasoningEffort = resolveRuntimeReasoningEffort(
			active.provider,
			active.model,
			active._reasoningEffortRef,
		);
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: active.model,
			reasoningEffort: active.reasoningEffort,
			status: active._loopRunning ? "pending" : "updated",
			applyAt: active._loopRunning ? "next_model_request" : "next_request",
		});
	} else if (updateActiveSubagentReasoningEffort(narratorId, reasoningEffort)) {
		// Subagent: update lightweight settings map; loop picks it up via getRuntimeSettingsOverride
		const sa = activeSubagentSettings.get(narratorId);
		broadcastToNarrator(narratorId, {
			type: "model_settings_changed",
			narratorId,
			model: sa?.model ?? "",
			reasoningEffort,
			status: "pending",
			applyAt: "next_model_request",
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
	_narratorId: string,
	_mode: string,
): Promise<void> {
	// Permission mode is read from DB in real-time by handlePermission.
	// Plan mode is now a narrator trait and is managed by Enter/ExitPlanMode handlers.
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

const REFLECTION_SUGGESTION_TYPES = new Set([
	"danger_reflection",
	"plan_reflection",
	"task_reflection",
	"question_reflection",
]);
const ACTIVE_REFLECTION_SUGGESTION_STATUSES = new Set(["running", "awaiting_user"]);

function abortActiveReflectionSuggestions(
	suggestions: unknown,
	reason: string,
	resolvedAt: string,
): unknown[] | undefined {
	if (!Array.isArray(suggestions)) return undefined;
	let changed = false;
	const next = suggestions.map((suggestion) => {
		if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) {
			return suggestion;
		}
		const record = suggestion as Record<string, unknown>;
		const type = typeof record.type === "string" ? record.type : "";
		if (!REFLECTION_SUGGESTION_TYPES.has(type)) return suggestion;

		const status = typeof record.status === "string" ? record.status : "running";
		if (!ACTIVE_REFLECTION_SUGGESTION_STATUSES.has(status)) return suggestion;

		changed = true;
		return {
			...record,
			status: "aborted",
			reason,
			resolvedAt,
		};
	});
	return changed ? next : undefined;
}

function logNarratorIntegrityDiagnostics(): void {
	try {
		const fullForkEmptyRefs = sqlite
			.prepare(
				`SELECT n.id, n.parent_narrator_id AS parentNarratorId,
					(SELECT count(*) FROM narrator_message_refs pr WHERE pr.narrator_id = n.parent_narrator_id) AS parentRefCount
				 FROM narrators n
				 WHERE n.inherit_mode = 'full'
				   AND n.parent_narrator_id IS NOT NULL
				   AND NOT EXISTS (SELECT 1 FROM narrator_message_refs r WHERE r.narrator_id = n.id)
				   AND EXISTS (SELECT 1 FROM narrator_message_refs pr WHERE pr.narrator_id = n.parent_narrator_id)
				 LIMIT 20`,
			)
			.all();
		if (fullForkEmptyRefs.length > 0) {
			logger.warn("Narrator integrity diagnostic: full forks with empty local refs", {
				count: fullForkEmptyRefs.length,
				samples: fullForkEmptyRefs,
			});
		}

		const missingForkRefs = sqlite
			.prepare(
				`SELECT n.id, n.parent_narrator_id AS parentNarratorId, n.fork_message_id AS forkMessageId, n.inherit_mode AS inheritMode
				 FROM narrators n
				 WHERE n.fork_message_id IS NOT NULL
				   AND n.parent_narrator_id IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1 FROM narrator_message_refs r
				     WHERE r.narrator_id = n.parent_narrator_id
				       AND r.message_id = n.fork_message_id
				   )
				 LIMIT 20`,
			)
			.all();
		if (missingForkRefs.length > 0) {
			logger.warn("Narrator integrity diagnostic: fork messages missing from parent refs", {
				count: missingForkRefs.length,
				samples: missingForkRefs,
			});
		}
	} catch (err) {
		logger.warn("Narrator integrity diagnostics failed", { error: String(err) });
	}
}

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

	// Legacy plan permission mode migration: plan is now a narrator trait.
	const legacyPlanRows = sqlite
		.prepare(
			"SELECT id, traits, previous_permission_mode FROM narrators WHERE permission_mode = 'plan'",
		)
		.all() as Array<{ id: string; traits: string | null; previous_permission_mode: string | null }>;
	for (const row of legacyPlanRows) {
		const traits = addTrait(parseTraits(row.traits), "plan");
		const permissionMode = normalizeLegacyPlanPreviousPermissionMode(row.previous_permission_mode);
		sqlite
			.prepare(
				"UPDATE narrators SET permission_mode = ?, traits = ?, plan_mode = 1, previous_permission_mode = ?, plan_file_id = ?, updated_at = ? WHERE id = ?",
			)
			.run(permissionMode, JSON.stringify(traits), permissionMode, generateWordSlug(), now, row.id);
	}
	if (legacyPlanRows.length > 0) {
		logger.info("Legacy plan permission mode migrated to narrator trait", {
			count: legacyPlanRows.length,
		});
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

	logNarratorIntegrityDiagnostics();

	const stalePermissions = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "pending"),
	});
	if (stalePermissions.length > 0) {
		let staleReflectionCount = 0;
		const restartMessage = "Interrupted by server restart";
		for (const toolCall of stalePermissions) {
			const abortedSuggestions = abortActiveReflectionSuggestions(
				toolCall.permissionSuggestions,
				restartMessage,
				now,
			);
			if (abortedSuggestions) staleReflectionCount++;
			await db
				.update(narratorToolCalls)
				.set({
					status: "fail",
					errorMessage: restartMessage,
					permissionDecidedBy: "server_restart",
					permissionDecidedAt: now,
					...(abortedSuggestions
						? {
								permissionDecisionReason: restartMessage,
								permissionSuggestions: abortedSuggestions,
							}
						: {}),
				})
				.where(eq(narratorToolCalls.id, toolCall.id));
		}
		logger.info("Stale pending tool calls auto-denied on startup", {
			count: stalePermissions.length,
			staleReflectionCount,
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

	const transientCompactRows = await db.query.narrators.findMany({
		columns: { id: true, substatus: true },
	});
	for (const row of transientCompactRows) {
		const current = parseSubstatus(row.substatus);
		const next = current.filter((tag) => tag !== "compacting" && tag !== "background_compacting");
		if (next.length !== current.length) {
			await narratorService.updateSubstatus(row.id, next).catch((err) => {
				logger.warn("Failed to clear stale compact substatus on startup", {
					narratorId: row.id,
					error: String(err),
				});
			});
		}
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
				bashCommand: row.bashCommand,
				createdBy: row.createdBy,
				creator,
				priority: row.priority,
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

/**
 * Disable an optional tool for a narrator.
 * Removes it from DB and updates the in-memory session if active.
 */
export async function unloadOptionalTool(
	narratorId: string,
	toolName: string,
): Promise<"unloaded" | "not_loaded" | "unknown_tool"> {
	if (!OPTIONAL_TOOLS.has(toolName)) return "unknown_tool";

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { enabledTools: true },
	});
	const current: string[] = (narrator?.enabledTools as string[] | null) ?? [];
	const next = current.filter((name) => name !== toolName);
	const wasPersisted = next.length !== current.length;

	const active = activeNarrators.get(narratorId);
	const wasActive = active?._enabledOptionalTools.has(toolName) ?? false;

	if (!wasPersisted && !wasActive) return "not_loaded";

	if (wasPersisted) {
		await db.update(narrators).set({ enabledTools: next }).where(eq(narrators.id, narratorId));
	}

	if (active) {
		active._enabledOptionalTools.delete(toolName);
	}

	logger.info("Optional tool unloaded", { narratorId, toolName });
	return "unloaded";
}

/** Get the set of enabled optional tool names for a narrator session. */
export function getEnabledOptionalTools(narratorId: string): Set<string> {
	const active = activeNarrators.get(narratorId);
	return active?._enabledOptionalTools ?? new Set();
}

export function updateActiveDisabledTools(narratorId: string, tools: Iterable<string>): void {
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	active._disabledTools = new Set(tools);
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
	awaitCompactCompletion,
	cancelCompact,
	compactLocks,
	isCompactInProgress,
	markCompactAsBlocking,
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
	cancelPendingExitPlanMode,
	classifyDanger,
	createDangerFingerprint,
	extractToolPaths,
	handlePermission,
	isInsideWorktree,
	normalizeDangerReflectionLevel,
	reprocessAllPendingPermissions,
	resolveDangerReflectionLevel,
	resolvePermission,
	resolvePermissionDecision,
	resolvePermissionOrDangerReflection,
	shouldTriggerDangerReflection,
} from "./narrator-permission";

export type { BufferCreator, NarratorEvent } from "./narrator-session-state";
