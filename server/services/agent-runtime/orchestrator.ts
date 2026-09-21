import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { KIMI_QUOTA_EXHAUSTED } from "@shared/agent-protocol/quota-exhausted";
import { serializeCatalogErrorMessage } from "@shared/error-catalog";
import { type FileReferenceSnapshot, fileReferenceMessageForDisplay } from "@shared/file-reference";
import { formatOriginLabel } from "@shared/message-origin";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { resolveProviderAndModel } from "../../lib/agent";
import { analyzeShellCommand } from "../../lib/agent/bash-analyze";
import { projectFileReferenceText } from "../../lib/agent/file-reference-projection";
import {
	acknowledgePipelineExitConfirmation,
	clearPipelineStateIfActive,
} from "../../lib/agent/pipeline-state";
import { detectShell } from "../../lib/agent/shell";
import { getMissingWorkingDirectoryRecovery, SHELL_TOOL_NAME } from "../../lib/agent/tools/bash";
import { clearBehaviorFenceEditGrant } from "../../lib/agent/tools/behavior-fence-grant";
import {
	KNOWLEDGE_KIND_DENY_CORE,
	OPTIONAL_TOOLS,
	REVIEW_TOOLS,
} from "../../lib/agent/tools/index";
import { buildAttachedFilesHint } from "../../lib/attached-files";
import {
	normalizeAutoContinuationMode,
	normalizeBooleanOverride,
	resolveAutoContinuationMode,
	resolveBooleanOverride,
} from "../../lib/boolean-override";
import { withDbRetry } from "../../lib/db-resilience";
import { resolveInjectedDevices } from "../../lib/device-injection-trait";
import { resolveFastModeForUser } from "../../lib/fast-mode";
import { MAX_QUOTA_WAITS_PER_RUN, waitForKimiQuotaReset } from "../../lib/kimi-quota-wait";
import { logger } from "../../lib/logger";
import {
	formatSubagentModelRestrictionDescription,
	getBlockedSkills,
	getDisabledToolSet,
} from "../../lib/narrator-custom-traits";
import {
	isPlanModeTrait,
	isSubagentVariant,
	parseSubstatus,
	redactDraftTraits,
} from "../../lib/narrator-utils";
import { nugAvailabilityPoller } from "../../lib/nug-availability-poller";
import { resolveKnownUnavailableNugModel } from "../../lib/nug-model-availability";
import { markNugCachedModelUnavailable } from "../../lib/nug-model-cache";
import { resolveEffectiveRelaxedPlan } from "../../lib/permission-modes";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../../lib/prompt-i18n";
import {
	FOLLOW_DEFAULT_MODEL,
	getAutoCompactKeepPairs,
	getContextThresholds,
	getSettingsRevision,
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	subscribeSettingsChanges,
	usesCodexModel,
	usesStatefulModel,
} from "../../lib/settings";
import type { ImageRef, PersistedUserImageBlock, TextFileRef } from "../../lib/uploads";
import {
	getImagePath,
	imageRefToContentBlock,
	imageToBase64,
	saveTextFileToWorktree,
} from "../../lib/uploads";
import { broadcastToNarrator } from "../../websocket/narrator-ws";
import { consumeAgentMessageHistory } from "../agent-message-delivery";
import {
	claimInboxHead,
	hasInboxKind,
	persistClaimedUserInput,
	releaseInboxClaim,
} from "../agent-runtime/inbox";
import type { ExecutionOwner } from "../agent-runtime/ownership";
import { getRuntimeQueuePort } from "../agent-runtime/runtime-queue-port";
import { getAgentFileReferenceContext } from "../file-reference-context";
import { gitService } from "../git-service";
import { getStatusSummaryCached, invalidateStatus } from "../git-status-cache";
import { knowledgeInjection } from "../knowledge-injection";
import { knowledgeInjectionReads, knowledgeService } from "../knowledge-service";
import {
	cleanupBufferedTextFilesAsync,
	getBufferedMessagesAsync,
	projectMailboxUserMessage,
	restoreBufferedMessage,
	toBufferSummary,
} from "../narrator-buffer";
import { runCustomCompact, runPlanCompact } from "../narrator-compact";
import {
	clearStreamingSnapshot,
	type EventHandlerContext,
	type EventHooks,
	persistDetachedToolResult,
	processEvent,
} from "../narrator-event-handler";
import { type ExecuteLoopResult, executeAgentLoop } from "../narrator-executor";
import { deliverInjection } from "../narrator-injection";
import { isFirstUserTurn } from "../narrator-message-count";
import { handlePermission } from "../narrator-permission";
import { narratorPersistence } from "../narrator-persistence";
import {
	commitPreparedEnterPlanModeResult,
	exitNarratorPlanMode,
	prepareNarratorPlanMode,
} from "../narrator-plan-mode";
import {
	getContextOverflowFailureError,
	getFirstTokenTimeoutMs,
	getMaxTransientRetries,
	getPipelineUnusedToolCallThreshold,
	getRetryBackoffCeilMs,
	getSilentToolCallThreshold,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
	resetContextOverflowRetriesAfterProgress,
} from "../narrator-recovery";
import { handleBashCommand, narratorService } from "../narrator-service";
import {
	accountTokenUsageForTurn,
	applySessionDefaultDevice,
	buildContextManagementHooks,
	buildSystemPrompt,
	cleanupPartialMessage,
	completeOrphanedToolCalls,
	drainAndPersistPendingInjections,
	drainInjectionsIntoHistory,
	ensureSkillCacheFreshForActiveNarrator,
	evaluateSoftStopRequest,
	executeQueuedGoalCommand,
	executeQueuedNewCommand,
	filterOAuthSessionDevices,
	finalizeInterruptedRun,
	finalizeOrCleanupPartialMessage,
	getLatestSubagentParentToolUseId,
	getSubagentFinalText,
	getSubagentResultMessageId,
	hasPendingBufferedWork,
	maybeStartContinuation,
	parseQueuedGoalCommand,
	parseQueuedNewCommand,
	persistConversationIdIfUnchanged,
	prepareSubagentConclusionReference,
	rearmCutInSoftStopBeforeContinuing,
	resolveRuntimeReasoningEffort,
	resolveSessionDevices,
	setNarratorDefaultDevice,
	updateToolCallConclusion,
} from "../narrator-session";
import type { ActiveNarrator, BufferedMessage } from "../narrator-session-state";
import {
	activeNarrators,
	clearActiveHistoryCompactPending,
	clearPlanModePromptRebuild,
	compactLocks,
	hasPendingHistoryCompact,
	isNarratorRevertAdmissionBlocked,
	knowledgeInjectionCycleStates,
	pendingFeedback,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanApproverSource,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
	recordNarratorRuntimeModel,
	resetActiveUpstreamSession,
} from "../narrator-session-state";
import { clearAliasRegistry, clearTeamFileChanges } from "../narrator-subagent";
import { generateAndSetTitle } from "../narrator-title";
import { abandonSessionTreeSnapshots } from "../narrator-tree-snapshot-hooks";
import { assertOAuthNarratorRuntimeActive } from "../oauth-narrator-runtime-policy";
import { resolvePlanApprovalAttribution } from "../plan-approval-attribution";
import { reviewService } from "../review-service";
import {
	consumeNextBufferedSubagentMessage,
	readSubagentSpecContinuationState,
	shouldStopSubagentForBufferedMessageSync,
} from "../subagent-executor";
import {
	getConclusionWatcher,
	getManualOverrideMap,
	removeConclusionWatcher,
	resolveManualOverride,
} from "../subagent-manual-override";
import {
	clearTakenOver,
	consumePendingBackgroundFinalize,
	consumePendingStopTakeover,
	isTakenOver,
	markPendingStopTakeover,
} from "../subagent-takeover";
import { isMcpToolAllowedForNarrator, runtimeToolFilter } from "../subagent-tools";
import { resolveEffectiveTraits } from "../trait-layer-service";
import { buildTreeSnapshotExecutionHooks, FILE_MUTATING_TOOLS } from "../tree-snapshot-loop-hooks";
import {
	buildSubagentContinuationPrompt,
	computeContinuationStallState,
	createSubagentContinuationState,
	interruptionContinuationLabel,
	MAX_TURN_INTERRUPTION_RETRIES,
	planSubagentContinuation,
	subagentContinuationStopNote,
} from "../turn-continuation-decisions";
import { registerNarratorLoop } from "../update-coordinator";
import { worktreeWatcher } from "../worktree-watcher";
import { createRuntimeEventContext, createRuntimeMessageWriters } from "./context";
import { applyForegroundControl, resetForegroundTurn } from "./control";
import { buildRuntimeHistory } from "./history";
import { createRuntimeRunState, type RuntimeProfile, type RuntimeRunOutcome } from "./input";
import { waitForModelAvailabilityOrChange } from "./model-availability-wait";
import { resolveRuntimePolicy } from "./policy";
import type { RuntimeRecoveryState, RuntimeRecoveryTransition } from "./transition";
import { selectRuntimeInterruption, selectRuntimeRecovery } from "./transition";

/** Return whether a completed Bash input contains a parsed Git command. */
export async function isGitCommandToolResult(
	toolName: string,
	input: Record<string, unknown> | undefined,
	cwd: string,
): Promise<boolean> {
	if (toolName !== SHELL_TOOL_NAME || !input) return false;
	const command = typeof input.command === "string" ? input.command : "";
	if (!command || !/\bgit\b/.test(command)) return false;
	const analysis = await analyzeShellCommand(command, cwd, detectShell().type, true);
	return analysis.commands.some((item) => item.tokens[0] === "git");
}

export interface RetryEffectContext {
	narratorId: string;
	locale: Locale;
	signal: AbortSignal;
	/** Finalizes only this pass's partial message, returning whether tool history was retained. */
	finalizePartial(): Promise<boolean>;
}

export type RetryEffectOutcome =
	| { kind: "aborted" }
	| { kind: "failed"; error: string }
	| { kind: "replay"; keptPartial: boolean; resetUpstreamSession: true };

/**
 * Shared retry effect. No identity branch and no host retry/next-pass callback:
 * the bounded wait, cancellation precedence and replay outcome are decided here.
 * The caller applies the returned input/history invalidation to its pass context.
 */
export async function executeRuntimeRetry(
	state: RuntimeRecoveryState,
	transition: Extract<RuntimeRecoveryTransition, { kind: "backoff" | "retry-exhausted" }>,
	context: RetryEffectContext,
): Promise<RetryEffectOutcome> {
	if (context.signal.aborted) return { kind: "aborted" };
	if (transition.kind === "retry-exhausted") {
		await context.finalizePartial();
		return context.signal.aborted
			? { kind: "aborted" }
			: { kind: "failed", error: transition.error };
	}
	state.transientRetries = transition.retryCount;
	const { shouldRetry } = await handleTransientError({
		narratorId: context.narratorId,
		error: transition.error,
		retryCount: transition.retryCount,
		maxRetries: transition.maxRetries,
		signal: context.signal,
	});
	if (context.signal.aborted) return { kind: "aborted" };
	const keptPartial = await context.finalizePartial();
	if (context.signal.aborted) return { kind: "aborted" };
	return shouldRetry
		? { kind: "replay", keptPartial, resetUpstreamSession: true }
		: { kind: "failed", error: transition.error };
}

function hasPostgresRuntime(): boolean {
	// The selector is fail-closed: explicit PostgreSQL without a bound queue throws
	// instead of allowing any SQLite proxy query below to run.
	return getRuntimeQueuePort() !== undefined;
}

export async function runAgentLoopUnlocked(
	active: ActiveNarrator,
	owner: ExecutionOwner,
	text: string,
	images?: ImageRef[],
	profile: RuntimeProfile = { kind: "primary" },
): Promise<RuntimeRunOutcome> {
	const { narratorId, locale } = active;
	const runState = createRuntimeRunState({ kind: "current", text, images }, profile);
	const runtimePolicy = resolveRuntimePolicy(
		profile.kind === "primary"
			? { variant: "primary" }
			: {
					variant: "subagent",
					subagentType: profile.subagentType,
					customDefinition: profile.customDefinition,
				},
	);
	const profileToolFilter = runtimeToolFilter(runtimePolicy);
	const subagentPlacement =
		profile.kind === "subagent"
			? {
					parentNarratorId: profile.parentNarratorId,
					parentToolUseId: profile.parentToolUseId,
				}
			: undefined;
	const messageWriters = createRuntimeMessageWriters(subagentPlacement?.parentToolUseId);
	const continuationState = createSubagentContinuationState();
	let continuationStopNote: string | null = null;

	// Final guard against concurrent loops on the same ActiveNarrator. ensureNarrator
	// reuses the same `active` object while it is alive, so a second runAgentLoop call
	// here would otherwise drive a second `while (active.alive)` loop over shared state
	// (abortController, history, _substatus) and corrupt the session.
	if (active._loopRunning) {
		logger.warn("runAgentLoop blocked: loop already running", { narratorId });
		return { started: false };
	}
	active._loopRunning = true;
	let unregisterUpdateLoop: () => void = () => {};
	let shouldUpdateTitle = false;

	let pendingBufferedDelivery: BufferedMessage | undefined;
	// Knowledge entries already injected in the CURRENT COMPACT CYCLE (de-dup across runAgentLoop
	// calls, loop passes, and tool outputs). This is narratorId-scoped hotSafe state rather than
	// ActiveNarrator state because ActiveNarrator is recreated between idle user turns.
	let knowledgeCycleState = knowledgeInjectionCycleStates.get(narratorId);
	if (!knowledgeCycleState) {
		knowledgeCycleState = { seq: Number.NaN, ids: new Set<string>() };
		knowledgeInjectionCycleStates.set(narratorId, knowledgeCycleState);
	}
	const knowledgeInjectedIds = knowledgeCycleState.ids;

	let pendingWorkingDirectoryRecovery:
		| { output: string; missingCwd: string; suggestedCwd: string }
		| undefined;
	/** Wall-clock start of this response turn, for the Stop hook `duration_ms` field. */
	const loopStartedAt = Date.now();
	/**
	 * Tokens consumed across every pass of this response turn (non-cached input +
	 * output), for the Stop hook `total_tokens` field. Accumulated per pass using
	 * the same delta the goal-usage accounting charges.
	 */

	/** Whether the loop was interrupted by the user (abort signal). */

	/** Final assistant text (or error message) from the most recent agent-loop pass, for Stop hooks. */

	/** Whether the most recent agent-loop pass ended by exceeding the max-turns limit (for Stop hooks). */

	/** Consecutive overflow recoveries since the last completed assistant turn. */

	/** How many consecutive transient-error retries in this runAgentLoop call. */

	/** How many consecutive completion-limit auto-continues in this runAgentLoop call. */

	// Same bound the subagent loop uses; both now read one shared constant rather than
	// declaring the value twice.
	const MAX_INTERRUPTION_RETRIES = MAX_TURN_INTERRUPTION_RETRIES;

	// --- Subagent dual-broadcast setup ---
	// When runAgentLoop runs for a taken-over subagent, we need to broadcast
	// events to the parent narrator so the SubagentCard updates in real time.
	// Resolve parentNarratorId + parentToolUseId once before the loop.
	let saParentNarratorId = profile.kind === "subagent" ? profile.parentNarratorId : undefined;
	let saParentToolUseId = profile.kind === "subagent" ? profile.parentToolUseId : undefined;
	try {
		unregisterUpdateLoop = registerNarratorLoop(narratorId, locale, {
			userId: active._currentUserId,
			replyInUserLanguage: active._replyInUserLanguage,
		});
		const initNarrator = await narratorService.getById(narratorId);
		if (
			profile.kind === "primary" &&
			isSubagentVariant(initNarrator.variant) &&
			initNarrator.parentNarratorId
		) {
			const watcher = getConclusionWatcher(narratorId);
			const parentToolUseId =
				watcher?.toolUseId ?? (await getLatestSubagentParentToolUseId(narratorId));
			if (parentToolUseId) {
				saParentNarratorId = watcher?.parentNarratorId ?? initNarrator.parentNarratorId;
				saParentToolUseId = parentToolUseId;
			}
		}
	} catch (error) {
		if (owner.isCurrent()) {
			active._loopRunning = false;
			active.alive = false;
		}
		unregisterUpdateLoop();
		throw error;
	}

	const continueForSpec = async (cause: "spec" | "maxTurns", suppressed: boolean) => {
		if (profile.kind === "primary") return maybeStartContinuation(active, suppressed);
		const spec = await readSubagentSpecContinuationState(narratorId);
		const fresh = await narratorService.getById(narratorId);
		const plan = planSubagentContinuation({
			cause,
			suppressed,
			mode: resolveAutoContinuationMode(
				fresh.autoContinuationOverride,
				normalizeAutoContinuationMode(settings.agent.autoContinuationMode),
			),
			openTask: spec.openTask,
			protectedOpenCount: spec.protectedOpenCount,
			previous: continuationState,
			result: runState.lastPass ?? { finalText: "", hasError: false, shouldUpdateTitle: false },
		});
		continuationState.stall = plan.stall;
		continuationState.grantedKind = plan.grantedKind;
		if (plan.action === "none") return null;
		if (plan.action === "stop") {
			continuationStopNote = subagentContinuationStopNote(plan, locale);
			return null;
		}
		continuationState.passes = plan.passes;
		continuationStopNote = null;
		const content = buildSubagentContinuationPrompt({
			cause,
			task: plan.task,
			passes: plan.passes,
			locale,
		});
		await deliverInjection(narratorId, {
			content,
			source: plan.task.status === "blocked" ? "spec_blocked_continuation" : "spec_continuation",
			schedule: "none",
			locale,
			originSource: "autoContinuation",
			subagent: {
				parentNarratorId: profile.parentNarratorId,
				parentToolUseId: profile.parentToolUseId,
			},
		});
		return content;
	};

	try {
		while (active.alive && owner.isCurrent()) {
			if (runState.pendingPrePromptBashCommand && !active.abortController.signal.aborted) {
				const command = runState.pendingPrePromptBashCommand;
				runState.pendingPrePromptBashCommand = undefined;
				await handleBashCommand(
					narratorId,
					command,
					`/bash ${command}`,
					active._currentUserId ?? undefined,
					{
						skipUserMessage: true,
						signal: active.abortController.signal,
					},
				);
				runState.input.text = "";
				runState.firstPass = false;
			}
			const baselineCompactSeq = await narratorService.getLatestCompactSeq(narratorId);
			// Knowledge-injection de-dup is scoped to a compact cycle: when the latest compact
			// seq changes (a compact happened), the prior injections were summarized/dropped from
			// context, so clear the set to allow re-injecting relevant entries into the new cycle.
			const cycleSeq = baselineCompactSeq ?? -1;
			if (cycleSeq !== knowledgeCycleState.seq) {
				// Read first: a rejected PG read must leave the old cycle intact so the
				// same compact boundary is retried on the next pass.
				const persistedIds = await knowledgeInjectionReads.listInjectedEntryIds(
					narratorId,
					cycleSeq,
				);
				knowledgeInjectedIds.clear();
				for (const id of persistedIds) {
					knowledgeInjectedIds.add(id);
				}
				knowledgeCycleState.seq = cycleSeq;
			}
			// Always use getModelHistorySinceLastCompact: if no compact marker exists it
			// returns all messages; after a compact it only returns post-compact messages
			// (old context is already in the summary injected via system prompt).
			const rawMessages = await narratorService.getModelHistorySinceLastCompact(narratorId);
			// History below is rebuilt from the latest post-compact messages, so any
			// pending-compact guard set by a background compact can be released here.
			clearActiveHistoryCompactPending(narratorId);

			// Rebuild system prompt each iteration so AGENTS.md/CLAUDE.md changes are picked up.
			const freshNarrator = await narratorService.getById(narratorId);
			const oauthRuntime = await assertOAuthNarratorRuntimeActive(
				narratorId,
				active._currentUserId,
			);
			if (oauthRuntime) {
				active._projectId = oauthRuntime.projectId ?? undefined;
				active._defaultDeviceId = oauthRuntime.defaultDeviceId;
			}
			// The run entry froze execution authority. Neither a later parent-user change
			// nor the author of an async answer may replace it; null stays anonymous.
			const actingUserId = active._currentUserId ?? null;
			const resolvedTurnSessionDevices =
				(await resolveSessionDevices(active._projectId ?? null, actingUserId)) ?? [];
			let turnSessionDevices = oauthRuntime
				? filterOAuthSessionDevices(resolvedTurnSessionDevices, oauthRuntime)
				: resolvedTurnSessionDevices;

			// Subagent messages all have parentToolUseId set — clear it so
			// buildHistory treats them as top-level (same as loadSubagentHistory).
			const isSubagentNarrator = isSubagentVariant(freshNarrator.variant);
			const dbMessages = isSubagentNarrator
				? rawMessages.map((m) => ({ ...m, parentToolUseId: null }))
				: rawMessages;

			active._modelRef =
				!runState.initialSettingsApplied && profile.kind === "subagent"
					? (profile.initialModel ?? freshNarrator.model ?? FOLLOW_DEFAULT_MODEL)
					: (freshNarrator.model ?? FOLLOW_DEFAULT_MODEL);
			runState.initialSettingsApplied = true;
			active._settingsRevision = getSettingsRevision();
			active.model = resolveEffectiveModel(active._modelRef, active.provider);
			const turnModelRef = active._modelRef;
			const turnEffectiveModel = active.model;
			active.provider = resolveProvider(active.model);
			active._reasoningEffortRef = freshNarrator.reasoningEffort ?? null;
			active.reasoningEffort = resolveRuntimeReasoningEffort(
				active.provider,
				active.model,
				active._reasoningEffortRef,
			);
			const resolved = resolveProviderAndModel(active.model, active.provider);
			active.provider = resolved.provider;
			recordNarratorRuntimeModel(
				narratorId,
				active._modelRef ?? FOLLOW_DEFAULT_MODEL,
				resolved.provider,
				resolved.model,
			);

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

			// A manual plan-mode toggle only needs to override the CURRENT pass, whose
			// AgentConfig captured `freshNarrator` above. This pass just re-read the DB, so
			// any live override is now redundant — and keeping it would make one manual
			// toggle permanently shadow every other path that changes plan mode.
			active._planModeLive = undefined;
			active._relaxedPlanLive = undefined;
			// The prompt this pass is about to build already reflects the toggled state, so a
			// rebuild request raised before it is satisfied by construction.
			clearPlanModePromptRebuild(narratorId);

			const preparedHistory = await buildRuntimeHistory({
				narratorId,
				model: resolved.model,
				provider: resolved.provider,
				profile: isSubagentNarrator ? "subagent" : "primary",
				sourceMessages: dbMessages,
				currentInput: runState.input.text,
			});
			let { history, trailingToolResults } = preparedHistory;
			const usesInitialHistory = runState.firstPass && profile.kind === "subagent";
			if (usesInitialHistory && profile.kind === "subagent") {
				history = profile.initialHistory;
				trailingToolResults = profile.initialTrailingToolResults ?? [];
			}
			runState.firstPass = false;

			const { prompt: freshSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
				{
					systemPrompt: oauthRuntime
						? (oauthRuntime.systemPrompt ?? null)
						: freshNarrator.systemPrompt,
					contextSummary: freshNarrator.contextSummary,
				},
				active.cwd,
				locale,
				active._replyInUserLanguage ?? false,
				oauthRuntime ? false : isPlanModeTrait(freshNarrator.traits),
				active._planFileId,
				settings.agent.defaultSystemPrompt,
				{
					devices: turnSessionDevices,
					defaultDeviceId: oauthRuntime?.defaultDeviceId ?? active._defaultDeviceId ?? null,
					allowLocalExecution: oauthRuntime?.allowLocalExecution ?? true,
				},
				// Same reason as in rebuildSystemPrompt: a legacy plan path cannot be rebuilt
				// from the identity, and the reminder must name the file the gate allows.
				active._planFilePath,
			);
			active.systemPrompt =
				profile.kind === "subagent"
					? profile.rebuildSystemPrompt
						? await profile.rebuildSystemPrompt(freshNarrator.contextSummary)
						: profile.systemPrompt
					: freshSystemPrompt;
			active._usedCompactSummary = usedCompactSummary;

			const eventContext: EventHandlerContext = createRuntimeEventContext({
				getFileReferenceContext: () => getAgentFileReferenceContext(config),
				narratorId,
				broadcastTargetId: saParentNarratorId ?? narratorId,
				userId: active._currentUserId ?? null,
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
				toolCallIdsMap: new Map(),
			});

			// Build shared context management hooks (compact)
			let compactDoneFlag = false;
			const ctxMgmt = buildContextManagementHooks({
				narratorId,
				locale,
				isSubagent: isSubagentNarrator,
				getModel: () => resolveProviderAndModel(active.model, active.provider).model,
				getProvider: () => resolveProviderAndModel(active.model, active.provider).provider,
				onCompactDone: () => {
					compactDoneFlag = true;
				},
				isCompactDone: () => compactDoneFlag,
				clearCompactDone: () => {
					compactDoneFlag = false;
				},
				rebuildSystemPrompt: async () => {
					const freshNarrator = await narratorService.getById(narratorId);
					if (profile.kind === "subagent")
						return profile.rebuildSystemPrompt
							? profile.rebuildSystemPrompt(freshNarrator.contextSummary)
							: profile.systemPrompt;
					const freshOAuthRuntime = await assertOAuthNarratorRuntimeActive(
						narratorId,
						active._currentUserId,
					);
					const { prompt } = await buildSystemPrompt(
						{
							systemPrompt: freshOAuthRuntime
								? (freshOAuthRuntime.systemPrompt ?? null)
								: freshNarrator.systemPrompt,
							contextSummary: freshNarrator.contextSummary,
						},
						active.cwd,
						locale,
						active._replyInUserLanguage ?? false,
						freshOAuthRuntime ? false : isPlanModeTrait(freshNarrator.traits),
						active._planFileId,
						settings.agent.defaultSystemPrompt,
						undefined,
						// The reminder, the Write/Edit gate and ExitPlanMode resolution must all
						// name the SAME file. A cycle resumed from the pre-`plans/` layout keeps a
						// legacy path in `_planFilePath` that `buildPlanFileRelPath` cannot
						// reconstruct from the identity alone, so passing it is what stops the
						// model being told to write somewhere the gate then rejects.
						active._planFilePath,
					);
					// NOTE: Do NOT set active.systemPrompt here — the returned value
					// flows through onBeforeTurn → loop.ts which updates config.systemPrompt.
					// Setting active.systemPrompt would create a second source of truth.
					return prompt;
				},
			});

			let missingWorkingDirectoryRecovery:
				| { output: string; missingCwd: string; suggestedCwd: string }
				| undefined;

			const hooks: EventHooks = {
				onTitleCheck: async (_savedId) => {
					if (hasPostgresRuntime()) {
						// There is no backend-neutral title read port yet. Do not let a normal
						// PostgreSQL turn fall through to the SQLite Drizzle proxy.
						logger.warn("Skipping title check: PostgreSQL title read port is unavailable", {
							narratorId,
						});
						return { titleUpdate: false };
					}
					const n = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { title: true },
					});
					// `messageCount` is the real message count, not a turn count, so it is
					// already > 1 mid-first-turn. Ask the actual question instead.
					const titleUpdate = !!(
						n &&
						(!n.title || (active._provisionalTitle && n.title === active._provisionalTitle)) &&
						(await isFirstUserTurn(narratorId))
					);
					return { titleUpdate };
				},
				onPrepareEnterPlanMode: async (toolCallId, toolUseId, input) => {
					const existingPrepared = active._preparedPlanModes?.get(toolCallId);
					if (existingPrepared?.toolUseId === toolUseId) return;
					active._preparedPlanModes ??= new Map();
					const pendingIdentity = active._planFileId
						? undefined
						: active._preparedPlanModes.values().next().value;
					const customPlanName =
						typeof input?.plan_name === "string" && input.plan_name.trim()
							? input.plan_name.trim()
							: undefined;
					const prepared = pendingIdentity
						? { ...pendingIdentity, toolCallId, toolUseId }
						: await prepareNarratorPlanMode(narratorId, toolCallId, toolUseId, customPlanName);
					active._preparedPlanModes.set(toolCallId, prepared);
					// All EnterPlanMode calls in one response share one ephemeral identity.
					if (!active._planFileId) active._planFilePath = prepared.planFilePath;
				},
				onEnterPlanMode: async (toolCallId, toolUseId, result) => {
					const prepared = active._preparedPlanModes?.get(toolCallId);
					if (!prepared || prepared.toolUseId !== toolUseId) {
						throw new Error(`Prepared EnterPlanMode state not found for ${toolCallId}`);
					}
					const planState = await commitPreparedEnterPlanModeResult(narratorId, prepared, result);
					active._planFileId = planState.planFileId;
					active._planFilePath = planState.planFilePath;
					active._previousPermissionMode = planState.previousPermissionMode;
					// A manual toggle earlier in THIS pass may have left a live override behind.
					// The DB now says plan mode is on, so the override has nothing left to
					// correct — and a stale `false` here would keep the tool-description
					// override released for a pass the model just put into plan mode.
					active._planModeLive = undefined;
					active._relaxedPlanLive = undefined;
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
					active._preparedPlanModes?.delete(toolCallId);
				},
				onEnterPlanModeFailed: async (toolCallId, toolUseId) => {
					const prepared = active._preparedPlanModes?.get(toolCallId);
					if (!prepared || prepared.toolUseId !== toolUseId) return;
					active._preparedPlanModes?.delete(toolCallId);
					if (!active._planFileId && (active._preparedPlanModes?.size ?? 0) === 0) {
						active._planFilePath = undefined;
					}
				},
				onExitPlanMode: async (toolUseId) => {
					active._preparedPlanModes?.clear();
					active._planFileId = undefined;
					active._planFilePath = undefined;
					active._previousPermissionMode = undefined;
					// Drop any live override from a manual toggle earlier in this pass. The DB is
					// authoritative again from here, and this must not wait for the pass-start
					// clear: the non-compact branch below aborts the loop, but the compact branch
					// only aborts when there is plan text, so a stale `true` could otherwise keep
					// plan mode applied to a pass the model just exited.
					active._planModeLive = undefined;
					active._relaxedPlanLive = undefined;
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
				onToolResult: (event) => {
					if (!event.isError || event.toolName !== SHELL_TOOL_NAME) return;
					const recovery = getMissingWorkingDirectoryRecovery(event.metadata);
					if (!recovery) return;
					missingWorkingDirectoryRecovery = {
						output: event.output,
						missingCwd: recovery.missingCwd,
						suggestedCwd: recovery.suggestedCwd,
					};
				},
				onGitTrack:
					active._worktreePath && active._chapterId
						? (toolName, toolUseId, input) => {
								if (!FILE_MUTATING_TOOLS.has(toolName)) return;
								const chapterId = active._chapterId as string;
								const worktreePath = active._worktreePath as string;
								const baseBranch = active._baseBranch as string | undefined;
								const scheduleRefresh = (delayMs: number) => {
									// Collapse rapid successive calls into one trailing query. Git commands
									// use delay 0 so branch/commit-only changes are visible immediately.
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
									}, delayMs);
								};

								if (toolName !== SHELL_TOOL_NAME) {
									scheduleRefresh(800);
									return;
								}

								const shellCwd =
									typeof input?.workdir === "string"
										? resolve(active.cwd, input.workdir)
										: active.cwd;
								void isGitCommandToolResult(toolName, input, shellCwd).then(
									(hasGitCommand) => scheduleRefresh(hasGitCommand ? 0 : 800),
									(error) => {
										logger.debug("Git command detection failed; using normal status tracking", {
											narratorId,
											error: String(error),
										});
										scheduleRefresh(800);
									},
								);
							}
						: undefined,

				onContextUsage: ctxMgmt.onContextUsage,
				onErrorCleanup: async (message, diagnostics) => {
					// Execution-owned finally callbacks normally close write claims, including
					// aborts. Keep the turn-level fallback for interrupted legacy sessions and
					// errors outside execution; unclosed claims would overlap later writers.
					// Sealed first: it must not be skipped by an early return below.
					if (active._isInGitRepo) abandonSessionTreeSnapshots(active, narratorId);
					// Prepared EnterPlanMode state is ephemeral and must never survive an error/abort.
					active._preparedPlanModes?.clear();
					if (!active._planFileId) active._planFilePath = undefined;
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
						diagnostics,
					});

					const recovery = missingWorkingDirectoryRecovery;
					missingWorkingDirectoryRecovery = undefined;
					if (recovery?.output === message) {
						pendingWorkingDirectoryRecovery = recovery;
					}

					runState.hadError = true;
					active.events.emit("event", { type: "error", data: { message, diagnostics } });
				},
			};

			const resolvedReasoningEffort =
				freshNarrator.reasoningEffort ||
				resolveDefaultReasoningEffort(resolved.provider, resolved.model);

			// Resolved per turn, not frozen at creation: an "inherit" override follows
			// the acting user's fastModeDefault preference, so flipping that default
			// takes effect on existing narrators from their next turn onward.
			const resolvedFastMode = await resolveFastModeForUser(
				freshNarrator.fastModeOverride,
				actingUserId,
			);

			// Layered traits are re-resolved per turn for the same reason as fast mode:
			// the acting user is only known now, and a project/user trait edit should
			// take effect from the next turn rather than requiring a session restart.
			try {
				const turnTraits = await resolveEffectiveTraits({
					narratorTraits: freshNarrator.traits,
					projectId: active._projectId ?? null,
					actingUserId,
				});
				if (profile.kind === "subagent")
					turnSessionDevices = resolveInjectedDevices(
						turnSessionDevices,
						turnTraits.deviceInjection,
					);
				active._disabledTools = getDisabledToolSet(turnTraits.traits);
				const turnBlocked = getBlockedSkills(turnTraits.traits);
				active._blockedSkills = { all: turnBlocked.all, names: turnBlocked.names };
			} catch (error) {
				// Never fail a turn over layer resolution; the narrator-level traits
				// already loaded at creation remain in effect.
				logger.debug("Failed to refresh layered traits for turn", {
					narratorId,
					error: String(error),
				});
			}
			const resolvedServiceTier =
				resolvedFastMode && usesCodexModel(resolved.provider, resolved.model)
					? "priority"
					: undefined;

			const resetUpstreamSessionForThisLoop = active._resetUpstreamSessionOnNextRequest === true;
			active._resetUpstreamSessionOnNextRequest = false;
			await ensureSkillCacheFreshForActiveNarrator(active);
			const availableDevices = turnSessionDevices;

			const config: import("../../lib/agent").AgentConfig = {
				runtimePolicy,
				narratorId,
				conversationId: active.conversationId,
				model: resolved.model,
				provider: resolved.provider,
				cwd: active.cwd,
				systemPrompt: active.systemPrompt ?? undefined,
				locale,
				signal: active.abortController.signal,
				chapterId: active._chapterId,
				parentNarratorId: saParentNarratorId,
				parentToolUseId: saParentToolUseId,
				reviewReadOnlyBash: profile.kind === "subagent" && profile.subagentType === "review",
				// Plan mode can be toggled MANUALLY while this pass is running, so both flags
				// are read live rather than frozen here. `_planModeLive`/`_relaxedPlanLive` are
				// undefined until a toggle happens, in which case the pass-start DB snapshot
				// applies; they are cleared at the top of every pass so the DB stays the truth.
				get planMode() {
					if (oauthRuntime) return false;
					return active._planModeLive ?? isPlanModeTrait(freshNarrator.traits);
				},
				permissionMode: oauthRuntime?.permissionMode ?? freshNarrator.permissionMode ?? "default",
				previousPermissionMode: oauthRuntime
					? undefined
					: (active._previousPermissionMode ?? freshNarrator.previousPermissionMode ?? undefined),
				get relaxedPlan() {
					if (oauthRuntime) return false;
					return (
						active._relaxedPlanLive ??
						resolveEffectiveRelaxedPlan(freshNarrator.permissionMode, freshNarrator.relaxedPlan)
					);
				},
				planAllowInlinePlan: settings.agent.planModeAllowInlinePlan,
				planReflectionAutoApproveOverride: normalizeBooleanOverride(
					freshNarrator.planReflectionAutoApproveOverride,
				),
				// EnterPlanMode updates the active narrator while the current loop is paused
				// on the assistant_message event. Use getters so the subsequent tool
				// execution sees the freshly allocated plan file instead of the config
				// snapshot created before the hook ran.
				get planFileId() {
					return active._planFileId;
				},
				get planFilePath() {
					return active._planFilePath;
				},
				getPlanFilePathForTool: (toolUseId) =>
					[...(active._preparedPlanModes?.values() ?? [])].find(
						(prepared) => prepared.toolUseId === toolUseId,
					)?.planFilePath,
				skillRoot: active._skillRoot ?? undefined,
				projectGitPath: active._projectGitPath ?? undefined,
				worktreePath: active._worktreePath ?? undefined,
				skillScopeKey: active._skillScopeKey ?? undefined,
				userId: active._currentUserId ?? null,
				projectId: oauthRuntime?.projectId ?? active._projectId ?? null,
				get defaultDeviceId() {
					return active._defaultDeviceId ?? null;
				},
				availableDevices,
				setDefaultDevice: oauthRuntime
					? async (deviceId) => {
							await setNarratorDefaultDevice(narratorId, deviceId);
							return true;
						}
					: (deviceId) => applySessionDefaultDevice(narratorId, active, deviceId),
				// Both primary and subagent captures follow execution, never event delivery.
				...buildTreeSnapshotExecutionHooks({
					session: active,
					narratorId,
					isInGitRepo: active._isInGitRepo === true,
				}),
				requireToolCallBinding: true,
				onInternalReadAuthorization: async (toolUseId, binding) => {
					await narratorPersistence.validateToolCallBinding(narratorId, toolUseId, binding);
				},
				onInternalReadCreated: (toolUseId, binding, input, sequence) =>
					narratorPersistence.createInternalRead(narratorId, toolUseId, binding, input, sequence),
				onInternalReadCompleted: (toolUseId, binding, result) =>
					narratorPersistence.completeInternalRead(narratorId, toolUseId, binding, result),
				onToolExecutionStarting: (toolUseId, binding, startedAt) =>
					narratorPersistence.claimToolCallExecution(narratorId, toolUseId, binding, startedAt),
				onExecutionTargetResolved: (toolUseId, target, binding) =>
					narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, target, binding),
				onExecutionPlanResolved: (toolUseId, plan, binding) =>
					narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, plan, binding),
				// Share the compact-cycle de-dup set so the loop's tool-output scan (point B)
				// de-dups against the user-message injections (point A) and vice versa.
				knowledgeInjectedEntryIds: knowledgeInjectedIds,
				knowledgeInjectionCompactSeq: cycleSeq,
				reasoningEffort: resolvedReasoningEffort,
				serviceTier: resolvedServiceTier,
				maxTransientRetries: getMaxTransientRetries(),
				silentToolCallThreshold: getSilentToolCallThreshold(),
				pipelineUnusedToolCallThreshold: getPipelineUnusedToolCallThreshold(),
				retryBackoffCeilMs: getRetryBackoffCeilMs(),
				firstTokenTimeoutMs: getFirstTokenTimeoutMs(),
				metadata: isAnthropicProvider(resolved.provider)
					? { user_id: `user_${narratorId}_account__session_${active.conversationId}` }
					: undefined,
				resetUpstreamSessionOnFirstRequest: resetUpstreamSessionForThisLoop,
				disabledTools: active._disabledTools,
				allowedTools: oauthRuntime ? new Set(oauthRuntime.allowedTools) : undefined,
				allowLocalExecution: oauthRuntime?.allowLocalExecution ?? true,
				runtimeAuthorizationGuard: oauthRuntime
					? async () => {
							await assertOAuthNarratorRuntimeActive(narratorId, active._currentUserId);
						}
					: undefined,
				deferEagerToolsForSafeStop: profile.kind === "subagent",
				blockedSkills: {
					all: active._blockedSkills.all,
					names: [...active._blockedSkills.names],
				},
				subagentModelRestrictionDescription: formatSubagentModelRestrictionDescription(
					freshNarrator.traits,
				),
				// Exclude optional tools that haven't been loaded for this session.
				toolFilter: (tool) => {
					if (!profileToolFilter(tool)) return false;
					if (oauthRuntime && !oauthRuntime.allowedTools.has(tool.name)) return false;
					if (active._disabledTools.has(tool.name)) return false;
					// When all skills are blocked, hide the Skill tool entirely.
					if (tool.name === "Skill" && active._blockedSkills.all) return false;
					// Child custom allowlists are already narrowed by the shared policy.
					// Primary session optional-tool loading is not another child deny list.
					if (profile.kind === "subagent") return true;
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
						saParentNarratorId,
						options,
						saParentToolUseId,
						oauthRuntime
							? {
									permissionMode: oauthRuntime.permissionMode,
									allowKnowledgeWrite: oauthRuntime.allowKnowledgeWrite,
									dangerReflectionPrompt: oauthRuntime.dangerReflectionPrompt,
									useRobotDiagnosticPreset: oauthRuntime.useRobotDiagnosticPreset,
									deviceAccess: oauthRuntime.policy.deviceAccess,
									oauthClientId: oauthRuntime.clientId,
									grantId: oauthRuntime.grantId,
								}
							: undefined,
						config.reviewReadOnlyBash,
					),
				onBeforeTurn: ctxMgmt.onBeforeTurn,
				getContextUsagePercentage: () => active._contextUsagePct,
				onReasoningOnlyHighContext: ctxMgmt.onReasoningOnlyHighContext,
				initialCompletedToolCount: active._todoReminderCompletedToolCount ?? 0,
				onCompletedToolCount: (count: number) => {
					active._todoReminderCompletedToolCount = count;
					// The behavior-fence edit window only covers the first tool call of a user
					// turn. Once any tool completes (counter advances past its initial value),
					// close the window so later tool calls in the same turn cannot write the fence.
					clearBehaviorFenceEditGrant(narratorId);
				},
				onModelInputConsumed: consumeAgentMessageHistory,
				getAfterToolsInjections: () =>
					drainInjectionsIntoHistory(active, locale, subagentPlacement),
				deliverInjectionRow: async (injection) => {
					const { messageId, turnText } = await deliverInjection(narratorId, {
						subagent: subagentPlacement,
						content: injection.content,
						body: injection.body,
						source: injection.source,
						schedule: "onNextTurn",
						locale,
					});
					// Knowledge injections are recorded only AFTER the row is durable. The
					// de-dup key is `(narratorId, compactSeq, entryId)` and the in-memory set is
					// reloaded from that table after a compact, so recording a hit whose content
					// never landed would permanently suppress re-injecting that entry.
					if (messageId && injection.knowledgeInjection) {
						const record = injection.knowledgeInjection;
						try {
							knowledgeService.recordInjectionEvents({
								narratorId: record.narratorId,
								compactSeq: record.compactSeq,
								source: "tool_output",
								triggerToolCallId: record.triggerToolCallId,
								hits: record.hits,
							});
						} catch (err) {
							logger.warn("Failed to record knowledge injection events", {
								narratorId,
								error: String(err),
							});
						}
					}
					// Same "only once it is durable" rule: clearing the pending flag for a
					// warning the model never received would lose the warning entirely.
					if (messageId && injection.pipelineExitConfirmationStateId) {
						try {
							await acknowledgePipelineExitConfirmation(
								narratorId,
								injection.pipelineExitConfirmationStateId,
							);
						} catch (err) {
							logger.error("Failed to acknowledge Pipeline exit confirmation", {
								narratorId,
								pipelineStateId: injection.pipelineExitConfirmationStateId,
								error: String(err),
							});
						}
					}
					return turnText ?? "";
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

					const next: import("../../lib/agent").RuntimeSettingsOverride = {};
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
					if (!runtimePolicy.capabilities.stopHooks) return { outcome: "success" };
					const { hookService } = await import("../hook-service");
					return hookService.runHooks(
						event as import("../hook-service").HookEvent,
						{
							hook_event_name: event as import("../hook-service").HookEvent,
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
					if (profile.kind === "subagent" && shouldStopSubagentForBufferedMessageSync(narratorId)) {
						active._bufferSoftStopTaken = true;
						return true;
					}
					const decision = evaluateSoftStopRequest({
						feedbackSoftStop: active._feedbackSoftStop,
						bufferSoftStop: active._bufferSoftStop,
						hasPendingBufferedWork: hasPendingBufferedWork(narratorId),
					});
					active._feedbackSoftStop = decision.feedbackSoftStop;
					active._bufferSoftStop = decision.bufferSoftStop;
					if (decision.softStopTaken) active._bufferSoftStopTaken = true;
					return decision.stop;
				},
				// Both primary and child loops can outlive the abort drain. Never reuse
				// eventContext/hooks here: a new turn may already own their mutable state.
				onDetachedToolResult: (event) => persistDetachedToolResult(narratorId, event),
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
			if (runState.input.images?.length) {
				const resolved: Array<{ format: string; base64: string }> = [];
				for (const img of runState.input.images) {
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
				runState.input.images = undefined; // only attach images on the first iteration
			}

			// Run one agent loop pass

			// Preserve the exact prepared packet: a pure tool replay never gets synthetic text.
			let effectiveText = usesInitialHistory ? runState.input.text : preparedHistory.currentText;
			const _isPureToolResultReplay = !effectiveText.trim() && trailingToolResults.length > 0;

			// Passive knowledge injection (point A): when this turn carries real user text,
			// surface relevant knowledge-base entries the triggering user may read.
			// ACL is resolved by the loop-triggering user (active._currentUserId), not the narrator.
			if (effectiveText.trim()) {
				try {
					const hits = await knowledgeInjection.resolveInjections(actingUserId, effectiveText, {
						already: knowledgeInjectedIds,
						projectId: active._projectId ?? undefined,
					});
					if (hits.length > 0) {
						const block = knowledgeInjection.formatInjections(
							hits,
							"Relevant knowledge-base entries were found for this request:",
						);
						if (block) {
							const knowledgeMessage = await messageWriters.persistSystemMessage(
								narratorId,
								block,
								[
									{
										...knowledgeInjection.createKnowledgeHintBlock(hits, "user_message", cycleSeq),
										modelText: block,
									},
								],
							);
							broadcastToNarrator(narratorId, {
								type: "message",
								narratorId,
								message: {
									id: knowledgeMessage.id,
									narratorId,
									role: knowledgeMessage.role,
									contentJson: knowledgeMessage.contentJson,
									contentText: knowledgeMessage.contentText,
									createdAt: knowledgeMessage.createdAt,
									seq: knowledgeMessage.seq,
									children: [],
								},
							});
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

			/**
			 * Suspend this turn until the blocking condition clears, then report
			 * whether the loop may continue.
			 *
			 * Shared by the entry points that need identical behaviour: the pre-flight
			 * check below (the NUG catalog already recorded an outage) and the
			 * post-request `modelUnavailable` branch (the provider just refused). Both
			 * park on a condition they cannot influence, and both must NOT replay the
			 * request while waiting — a replay re-uploads the whole history, which is
			 * exactly why the wait exists.
			 *
			 * The two wait kinds differ only in how recovery is observed:
			 *  - `credentials` (NUG): the credential pool comes back at an unknown time,
			 *    so the shared availability poller checks the lightweight `/v1/models`
			 *    list until the model reports available.
			 *  - `quota` (Kimi): the reset instant is published (`resumeAt`), so this
			 *    sleeps to it. No polling and no request during the wait.
			 *
			 * @returns true when recovery happened and the caller should `continue`
			 * to rebuild history from the DB; false when the caller must `break`
			 * (interrupted, or the narrator went away while waiting).
			 */
			const suspendUntilModelRecovered = async (
				mu: Omit<NonNullable<ExecuteLoopResult["modelUnavailable"]>, "provider">,
			): Promise<boolean> => {
				// Finalize or clean up the partial message from the failed turn.
				// If tools already ran (side effects), keep it so the rebuilt history
				// includes them; otherwise it is deleted so the resume starts fresh.
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				let keptPartial = false;
				if (partialId) {
					keptPartial = await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}

				// The reset clock is what this wait is about, so the status carries the
				// instant the user is waiting for as well as the tag that says why.
				const quotaResumeAt =
					mu.waitKind === "quota" && typeof mu.resumeAt === "number" ? mu.resumeAt : undefined;
				const waitingSubstatus = quotaResumeAt ? "quota_exhausted" : "model_unavailable";
				await narratorService.updateStatus(narratorId, "waiting", {
					substatus: [waitingSubstatus],
					errorMessage: JSON.stringify({
						type: quotaResumeAt ? "quota_exhausted" : "model_unavailable",
						...mu,
					}),
				});
				broadcastToNarrator(narratorId, {
					type: "model_unavailable_waiting",
					narratorId,
					message: mu.message,
					model: mu.model,
					providerId: mu.providerId,
					providerPrefix: mu.providerPrefix,
					nugModelId: mu.nugModelId,
					diagnostics: mu.diagnostics,
					waitKind: mu.waitKind,
					resumeAt: quotaResumeAt,
				});
				if (subagentPlacement)
					broadcastToNarrator(subagentPlacement.parentNarratorId, {
						type: "subagent_model_unavailable_waiting",
						narratorId: subagentPlacement.parentNarratorId,
						subagentNarratorId: narratorId,
						message: mu.message,
						model: mu.model,
						nugModelId: mu.nugModelId,
						diagnostics: mu.diagnostics,
						waitKind: mu.waitKind,
						resumeAt: quotaResumeAt,
					});

				const outcome = await waitForModelAvailabilityOrChange({
					target: active,
					isCurrent: () => active.alive && owner.isCurrent(),
					hasModelChanged: () =>
						active._modelRef !== turnModelRef ||
						active.model !== turnEffectiveModel ||
						(turnModelRef === FOLLOW_DEFAULT_MODEL &&
							resolveEffectiveModel(turnModelRef, active.provider) !== turnEffectiveModel),
					subscribe: subscribeSettingsChanges,
					wait: (signal) =>
						quotaResumeAt
							? waitForKimiQuotaReset(quotaResumeAt, signal)
							: mu.providerId && mu.nugModelId
								? nugAvailabilityPoller.waitForModelAvailable({
										providerId: mu.providerId,
										nugModelId: mu.nugModelId,
										signal,
									})
								: Promise.resolve("aborted"),
				});

				if (!active.alive || !owner.isCurrent()) return false;
				if (active.abortController.signal.aborted || outcome === "aborted") {
					await finalizeInterruptedRun(active, narratorId, undefined);
					runState.wasInterrupted = true;
					return false;
				}
				if (!active.alive) return false;

				// Recovery reached — resume by replaying the same turn. Rebuilt history
				// from the DB happens at the top of the loop (as with transient retry),
				// so this is the only point where a full request is issued again.
				broadcastToNarrator(narratorId, {
					type: "model_unavailable_recovered",
					narratorId,
					model: mu.model,
					nugModelId: mu.nugModelId,
					waitKind: mu.waitKind,
				});
				if (subagentPlacement)
					broadcastToNarrator(subagentPlacement.parentNarratorId, {
						type: "subagent_model_unavailable_recovered",
						narratorId: subagentPlacement.parentNarratorId,
						subagentNarratorId: narratorId,
						model: mu.model,
						nugModelId: mu.nugModelId,
						waitKind: mu.waitKind,
					});
				await narratorService.updateStatus(narratorId, "working");
				if (keptPartial) {
					runState.input.text = "";
					runState.input.images = undefined;
				}
				// Stateful providers (codex) reuse an upstream session keyed by
				// narratorId. Keep `conversationId` stable so prompt_cache_key /
				// session-id retain cache affinity; only reset the upstream session
				// chain so rebuilt history is not chained to a stale
				// previous_response_id.
				if (usesStatefulModel(resolved.provider, resolved.model)) {
					active._resetUpstreamSessionOnNextRequest = true;
				}
				return true;
			};

			// --- Pre-flight: the model is already known to be unavailable ---
			// The catalog records an outage as soon as one request is refused, so a
			// later turn on the same model can know upfront. Waiting here instead of
			// sending the request saves a full history upload, and it does not depend
			// on the gateway's error text being recognized. A model whose state is
			// unknown is treated as usable, so this never blocks a working model.
			{
				const known = resolveKnownUnavailableNugModel(resolved.model, resolved.provider);
				if (known && active.alive) {
					const resumed = await suspendUntilModelRecovered({
						message: `Model ${known.model} is recorded as temporarily unavailable; waiting for it to recover before sending the request.`,
						model: known.model,
						providerId: known.providerId,
						providerPrefix: known.providerPrefix,
						nugModelId: known.nugModelId,
					});
					if (!resumed) break;
					// Re-resolve from the loop top: the user may have switched models
					// while this turn was suspended.
					runState.recovery.transientRetries = 0;
					continue;
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
			runState.lastPass = result;
			runState.recovery.overflowRetries = resetContextOverflowRetriesAfterProgress(
				runState.recovery.overflowRetries,
				result.completedAssistantTurn,
			);

			// Track the latest pass's final text for the Stop hook (set on every pass,
			// so the most recent assistant text / error message wins regardless of how
			// the loop ultimately terminates).
			if (result.finalText) {
				runState.finalText = result.finalText;
			}

			// Track whether the latest pass ended by hitting the max-turns limit.
			// Refreshed every pass (unconditionally) so that if the loop continues
			// afterwards — e.g. goal continuation or a buffered message — and ends
			// normally, this is cleared back to false before the Stop hook fires.
			runState.hitMaxTurns = result.maxTurnsExceeded === true;

			runState.totalTokens += accountTokenUsageForTurn(active);

			// Suppress runaway auto-continuation when a continuation pass makes no effective
			// progress: either it called no tools, or it repeatedly hit the same protected-task
			// reflection denial. A different denial starts a fresh count; real tool progress resets it.
			const continuationKind = active._continuationTurn;
			if (continuationKind) {
				const stall = computeContinuationStallState(continuationKind, result, {
					count: active._continuationStallCount ?? 0,
					key: active._continuationStallKey,
				});
				active._continuationStallCount = stall.count;
				active._continuationStallKey = stall.key;
				active._continuationSuppressed = stall.suppressed;
				if (stall.suppressed && stall.key?.startsWith("task-reflection:")) {
					logger.warn("Suppressing repeated protected-task reflection continuation", {
						narratorId,
						continuationKind,
						stallCount: stall.count,
					});
				}
				active._continuationTurn = undefined;
			} else {
				active._continuationStallCount = 0;
				active._continuationStallKey = undefined;
				active._continuationSuppressed = false;
			}

			if (profile.kind === "subagent" && profile.control?.turnAbort.signal.aborted) {
				const control = await applyForegroundControl(active, owner, profile, result);
				if (control.kind === "resume") {
					resetForegroundTurn(active, profile);
					runState.input.text = control.prompt;
					runState.pendingPrePromptBashCommand = control.prePromptBashCommand;
					active._currentUserId = control.userId;
					runState.hadError = false;
					runState.wasInterrupted = false;
					continue;
				}
				if (control.kind === "finish") {
					runState.finalText = control.finalText;
					runState.hadError = control.hasError;
					runState.wasInterrupted = control.interrupted;
					break;
				}
			}
			const recoveryState = runState.recovery;
			const recovery = selectRuntimeRecovery(recoveryState, {
				result,
				aborted: active.abortController.signal.aborted,
				planApproved: !!active._planApprovedContinue,
				stateful: usesStatefulModel(resolved.provider, resolved.model),
				maxTransientRetries: getMaxTransientRetries(),
			});
			// [continuation-source: abort-before-recovery]
			if (recovery.kind === "aborted") {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				await finalizeInterruptedRun(active, narratorId, partialId);
				runState.wasInterrupted = true;
				break;
			}

			// [continuation-source: payment-required]
			if (recovery.kind === "payment" && result.paymentRequired && active.alive) {
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
				if (subagentPlacement) {
					const payment = result.paymentRequired;
					for (const recipient of [narratorId, subagentPlacement.parentNarratorId]) {
						broadcastToNarrator(recipient, {
							type: "payment_required",
							narratorId: recipient,
							providerId: payment.providerId,
							providerPrefix: payment.providerPrefix,
							balance: payment.balance,
							required: payment.required,
							resumeAction: payment.resumeAction,
						});
					}
				}
				runState.hadError = true;
				break;
			}

			// --- Blocked, but recoverable: suspend and wait for recovery ---
			// Either a NUG model whose credential pool is disabled, or an exhausted
			// Kimi coding-plan allowance. Instead of replaying the full request
			// (re-uploading the entire history) over and over, suspend the narrator and
			// wait on whatever tells us recovery happened — the availability poller for
			// credentials, the published reset instant for quota. Then resume by
			// rebuilding history from the DB and issuing one fresh request.
			// [continuation-source: model-unavailable]
			if (recovery.kind === "model-unavailable" && result.modelUnavailable && active.alive) {
				const mu = result.modelUnavailable;
				const isQuota = mu.waitKind === "quota";
				const quotaResetAt =
					isQuota && typeof mu.quotaResetAt === "number" ? mu.quotaResetAt : undefined;
				const quotaResumeAt = isQuota && typeof mu.resumeAt === "number" ? mu.resumeAt : undefined;
				/**
				 * Why this quota wall is being reported instead of parked on.
				 *
				 * Two causes, one exit. `reset-beyond-budget` is the loop's verdict (the
				 * reset is published but further out than the wait budget allows).
				 * `wait-budget-spent` is this run's (every suspension costs a full history
				 * re-upload, so a reset that keeps resolving to "soon" must not become a
				 * replay loop).
				 *
				 * Both produce the same user-facing outcome, so they share a branch and
				 * differ only by the reason code — a divergence here would mean one of them
				 * silently loses the reset instant that makes the error actionable.
				 */
				const quotaRefusalReason = !isQuota
					? undefined
					: quotaResumeAt === undefined
						? "reset-beyond-budget"
						: runState.recovery.quotaWaits >= MAX_QUOTA_WAITS_PER_RUN
							? "wait-budget-spent"
							: undefined;
				if (quotaRefusalReason) {
					// Serialized as a payload rather than left as the raw upstream text, on
					// the `payment_required` pattern: `errorMessage` is the only failure
					// carrier that survives to the next page load, so the reset instant has
					// to ride in it for the panel to explain the wall in the user's language
					// after a refresh. `reason` lets the two non-waiting causes stay
					// distinguishable in logs without changing what the user is told.
					await narratorService.updateStatus(narratorId, "idle", {
						substatus: ["error"],
						errorCode: KIMI_QUOTA_EXHAUSTED,
						errorMessage: JSON.stringify({
							type: KIMI_QUOTA_EXHAUSTED,
							reason: quotaRefusalReason,
							model: mu.model,
							provider: mu.provider,
							providerPrefix: mu.providerPrefix,
							quotaResetAt,
						}),
						diagnostics: mu.diagnostics,
					});
					active.events.emit("event", {
						type: "error",
						data: { message: mu.message, diagnostics: mu.diagnostics },
					});
					// Deliberately NOT broadcasting `model_unavailable_recovered`: it tells
					// the client the block cleared and it is resuming, which is false here and
					// would flash a green "quota restored" notice over the error. The client
					// drops its waiting notice from the status change this write produces.
					logger.warn("Kimi quota wall reported instead of waited on", {
						narratorId,
						providerId: mu.providerId,
						model: mu.model,
						reason: quotaRefusalReason,
						quotaResetAt,
						quotaWaits: runState.recovery.quotaWaits,
					});
					runState.finalText = mu.message;
					runState.hadError = true;
					break;
				}
				// The gateway just refused this model, which is first-hand proof it
				// cannot serve right now. Record that in the model cache before
				// waiting: the poller decides recovery from the cache, and a
				// snapshot taken before the outage would otherwise report the model
				// as available and resume immediately, only to fail again.
				if (mu.providerId && mu.nugModelId) {
					markNugCachedModelUnavailable(mu.providerId, mu.nugModelId);
				}
				if (quotaResumeAt) runState.recovery.quotaWaits += 1;
				const resumed = await suspendUntilModelRecovered(mu);
				if (!resumed) break;
				runState.recovery.transientRetries = 0;
				continue;
			}

			// --- Context length exceeded: emergency compact/retry ---
			// [continuation-source: context-overflow]
			if (recovery.kind === "overflow" && active.alive) {
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
					contextPercentBefore: active._contextUsagePct,
					overflowRetries: runState.recovery.overflowRetries,
					maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
					baselineCompactSeq,
					signal: active.abortController.signal,
					onBroadcast: (event) =>
						broadcastToNarrator(narratorId, event as Parameters<typeof broadcastToNarrator>[1]),
				});

				runState.recovery.overflowRetries = overflow.overflowRetries;

				if (overflow.action === "retry_compacted") {
					// Keep conversationId stable for prompt-cache affinity. Compact may
					// already have reset the upstream session via resetActiveUpstreamSession;
					// still set the flag so a non-compact ride-on cannot chain a stale
					// previous_response_id. Do not null _persistedConversationId here —
					// the id did not change on this path.
					active._resetUpstreamSessionOnNextRequest = true;
					runState.recovery.transientRetries = 0;
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
				runState.finalText = failure.message;
				runState.hadError = true;
				break;
			}

			// [continuation-source: transient-error]
			// [continuation-source: silent-disconnect]
			if (active.alive && (recovery.kind === "backoff" || recovery.kind === "retry-exhausted")) {
				const outcome = await executeRuntimeRetry(recoveryState, recovery, {
					narratorId,
					locale,
					signal: active.abortController.signal,
					finalizePartial: async () => {
						const partialId = active._partialMessageId;
						active._partialMessageId = undefined;
						return partialId ? finalizeOrCleanupPartialMessage(partialId, narratorId) : false;
					},
				});
				runState.recovery.transientRetries = recoveryState.transientRetries;
				if (outcome.kind === "aborted") {
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					await finalizeInterruptedRun(active, narratorId, partialId);
					runState.wasInterrupted = true;
					break;
				}
				if (outcome.kind === "replay") {
					if (outcome.keptPartial) {
						runState.input.text = "";
						runState.input.images = undefined;
					}
					// Keep conversationId stable across transient replay so the next
					// request reuses the same prompt_cache_key / session-id.
					active._resetUpstreamSessionOnNextRequest = outcome.resetUpstreamSession;
					continue;
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: outcome.error,
					diagnostics: result.retryableDiagnostics,
				});
				active.events.emit("event", {
					type: "error",
					data: { message: outcome.error, diagnostics: result.retryableDiagnostics },
				});
				runState.finalText = outcome.error;
				runState.hadError = true;
				break;
			}

			// [continuation-source: max-turns-spec-continuation]
			if (result.maxTurnsExceeded && active.alive && !runState.hadError) {
				const continuationPrompt = await continueForSpec("maxTurns", false);
				if (continuationPrompt) {
					await narratorService.updateStatus(narratorId, "working");
					runState.input.text = "";
					runState.input.images = undefined;
					continue;
				}
			}

			if (result.hasError && active.alive && !runState.hadError) {
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: result.finalText,
					errorCode: result.errorCode,
					diagnostics: result.errorDiagnostics,
				});
				active.events.emit("event", {
					type: "error",
					data: { message: result.finalText, diagnostics: result.errorDiagnostics },
				});
				runState.finalText = result.finalText || "Agent run failed";
				runState.hadError = true;
				break;
			}

			// Reset transient retry counter on success or after a non-retried silent disconnect.
			runState.recovery.transientRetries = 0;

			// "completion_limit" (provider hit its max output tokens) and "resumable_error"
			// (a transient failure occurred after partial output was already produced, e.g. a
			// NUG-reported stream disconnect) both resume from partial output the same way —
			// only the continuation prompt shown to the model differs.
			//
			// The decision itself lives in `planTurnInterruption`, shared with the subagent
			// loop: this branch and its subagent counterpart were two hand-written copies of
			// one rule, which is exactly how they drift. `suppressed: !active.alive` reproduces
			// the old `&& active.alive` guard — an interrupted pass on a dead session resets the
			// counter and falls through to the normal termination path.
			// [continuation-source: interruption-continuation]
			const interruptionPlan = selectRuntimeInterruption(runState.recovery, result, {
				suppressed: !active.alive,
				maxRetries: MAX_INTERRUPTION_RETRIES,
			});
			if (interruptionPlan.action !== "none") {
				const continuationLogLabel = interruptionContinuationLabel(
					interruptionPlan.reason,
					"primary",
				);
				if (interruptionPlan.action === "stop") {
					// Retry budget spent. Deliberately falls THROUGH rather than breaking: the
					// pass produced real partial output, so the rest of the turn-end handling
					// (title, queued input, idle transition) still applies.
					logger.warn(`${continuationLogLabel}: max retries reached, stopping`, {
						narratorId,
						retries: interruptionPlan.retries,
					});
				} else if (interruptionPlan.action === "replay") {
					logger.info(`${continuationLogLabel}: replaying interrupted tool-result turn`, {
						narratorId,
						retries: interruptionPlan.retries,
					});
					runState.input.text = "";
					runState.input.images = undefined;
					continue;
				} else {
					const continueText = getToolMessage(interruptionPlan.promptKey, locale);
					// Resume prompt synthesized by the loop, not typed by anyone.
					const userMsg = await messageWriters.persistUserMessage(
						narratorId,
						continueText,
						[{ type: "text", text: continueText }],
						undefined,
						undefined,
						{
							origin: "system",
							originLabel: formatOriginLabel("autoContinuation"),
						},
					);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: fileReferenceMessageForDisplay(userMsg),
					});
					active.events.emit("event", {
						type: "user_message",
						data: fileReferenceMessageForDisplay(userMsg),
					});
					await narratorService.updateStatus(narratorId, "working");
					runState.input.text = continueText;
					runState.input.images = undefined;
					continue;
				}
			}

			if (result.shouldUpdateTitle) {
				shouldUpdateTitle = true;
			}

			// Plan approved — abort was triggered by onExitPlanMode so we persist
			// a user message and restart the loop to drive plan execution.
			// [continuation-source: plan-approved]
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

				// Retrieve the approver identity (userId + whether a human or the plan
				// reflection approved) so the injected turn is attributed correctly.
				const approverId = pendingPlanApprover.get(narratorId);
				if (approverId) pendingPlanApprover.delete(narratorId);
				const approverSource = pendingPlanApproverSource.get(narratorId);
				if (approverSource) pendingPlanApproverSource.delete(narratorId);

				// Attribution lives in its own pure module (precedence documented there):
				// chained feedback → the typist, else a recorded human approver, else the
				// plan reflection's "计划反思" identity, else the auto-continuation card.
				const { originOptions, createdBy } = resolvePlanApprovalAttribution({
					hasFeedback: !!fb,
					feedbackUserId: fb?.userId ?? null,
					approverId,
					approverSource,
				});
				const userMsg = await messageWriters.persistUserMessage(
					narratorId,
					promptText,
					[{ type: "text", text: promptText }],
					undefined,
					createdBy,
					originOptions,
				);
				broadcastToNarrator(narratorId, {
					type: "user_message",
					narratorId,
					message: fileReferenceMessageForDisplay(userMsg),
				});
				active.events.emit("event", {
					type: "user_message",
					data: fileReferenceMessageForDisplay(userMsg),
				});
				await narratorService.updateStatus(narratorId, "working");
				runState.input.text = promptText;
				runState.input.images = undefined;
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
				runState.wasInterrupted = true;
				break;
			}

			// Check for chained feedback BEFORE marking idle/unread — when the user
			// approves a permission with attached text, the loop is aborted right
			// after the tool completes so the feedback is injected immediately
			// instead of waiting for the entire turn to finish.
			// [continuation-source: permission-feedback]
			const fb = pendingFeedback.get(narratorId);
			if (fb) {
				pendingFeedback.delete(narratorId);
				// Text the approver typed alongside their permission decision.
				const userMsg = await messageWriters.persistUserMessage(
					narratorId,
					fb.feedbackText,
					[{ type: "text", text: fb.feedbackText }],
					undefined,
					fb.userId ?? undefined,
					{ origin: "user" },
				);
				broadcastToNarrator(narratorId, {
					type: "user_message",
					narratorId,
					message: fileReferenceMessageForDisplay(userMsg),
				});
				active.events.emit("event", {
					type: "user_message",
					data: fileReferenceMessageForDisplay(userMsg),
				});
				await narratorService.updateStatus(narratorId, "working");
				runState.input.text = fb.feedbackText;
				// Approving a permission with attached text starts a new pass here, so a
				// cut-in message queued during the same tool call needs its boundary back.
				rearmCutInSoftStopBeforeContinuing(active);
				continue;
			}

			// Review git state check — if the review narrator modified files,
			// reset and re-inject a message to continue the loop.
			// [continuation-source: review-git-guard]
			if (active._chapterRole === "review" && active._chapterId && active.alive) {
				const gitCheck = await reviewService.checkAndResetGitState(active._chapterId);
				if (!gitCheck.clean && gitCheck.message) {
					// Review guardrail notice generated by the review service.
					const userMsg = await messageWriters.persistUserMessage(
						narratorId,
						gitCheck.message,
						[{ type: "text", text: gitCheck.message }],
						undefined,
						undefined,
						{ origin: "system", originLabel: formatOriginLabel("review") },
					);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: fileReferenceMessageForDisplay(userMsg),
					});
					active.events.emit("event", {
						type: "user_message",
						data: fileReferenceMessageForDisplay(userMsg),
					});
					await narratorService.updateStatus(narratorId, "working");
					runState.input.text = gitCheck.message;
					// The guardrail notice starts a new pass, so keep a cut-in message's
					// boundary alive instead of stranding it for the rest of the loop.
					rearmCutInSoftStopBeforeContinuing(active);
					continue;
				}
				// Git is clean and loop ended normally — conclude the review
				if (!result.hasError) {
					await reviewService.concludeReview(active._chapterId);
				}
			}

			// Agent loop done — update stats (always, even if we continue with buffered messages)
			await narratorService.updateStats(narratorId, 0);

			// Compact after a complete turn when context usage reaches compactStart.
			// This is a fallback — the mid-turn context_usage handler may have already started
			// a background compact.
			// [continuation-source: post-turn-compact]
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

				if (postTurnContextPct >= postTurnThresholds.compactStart) {
					const boundaryMessageId = await narratorService.getCompactBoundaryMessage(
						narratorId,
						getAutoCompactKeepPairs(),
					);

					if (boundaryMessageId) {
						logger.info("Triggering background compact (post-turn)", {
							narratorId,
							boundaryMessageId,
							contextPct: postTurnContextPct,
							threshold: postTurnThresholds.compactStart,
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
						});
					}
				}
			}

			// Anything queued during this turn (completions AND inbound messages) keeps the
			// loop running instead of going idle. Previously only completions were checked
			// here, so a message that arrived at this exact moment waited for the next wake.
			// [continuation-source: injection-drain]
			const bgCompletionPrompt = await drainAndPersistPendingInjections(active, subagentPlacement);
			if (bgCompletionPrompt) {
				await narratorService.updateStatus(narratorId, "working");
				runState.input.text = "";
				runState.input.images = undefined;
				// This drain starts a fresh pass before the buffer consumer below is
				// reached, which would strand a cut-in message for the rest of the loop.
				rearmCutInSoftStopBeforeContinuing(active);
				continue;
			}

			// Check for buffered messages BEFORE transitioning to idle/unread —
			// this prevents spurious notifications when there are queued messages.
			// When the loop had an error, skip consumption entirely so queued
			// messages are preserved for the user to retry or dismiss.
			// [continuation-source: buffered-message]
			if (
				profile.kind === "subagent" &&
				!runState.hadError &&
				!active.abortController.signal.aborted
			) {
				const input = await consumeNextBufferedSubagentMessage({
					narratorId,
					parentNarratorId: profile.parentNarratorId,
					toolUseId: profile.parentToolUseId,
					model: active.model,
					provider: active.provider,
					cwd: active.cwd,
				});
				if (input) {
					active._bufferSoftStopTaken = false;
					runState.input.text = input.currentInput ?? input.prompt;
					runState.pendingPrePromptBashCommand = input.prePromptBashCommand;
					if (!input.preservePrincipal) active._currentUserId = input.userId ?? null;
					active.conversationId = randomUUID();
					active._resetUpstreamSessionOnNextRequest = true;
					continue;
				}
			}
			if (
				profile.kind === "primary" &&
				!runState.hadError &&
				!isNarratorRevertAdmissionBlocked(narratorId)
			) {
				const bufferedRow = await claimInboxHead(
					narratorId,
					(candidate) => candidate.kind === "user_input",
				);
				let buffered: BufferedMessage | undefined;
				try {
					buffered = bufferedRow ? projectMailboxUserMessage(bufferedRow) : undefined;
				} catch (error) {
					if (bufferedRow) await releaseInboxClaim(bufferedRow, error);
					throw error;
				}
				if (buffered) {
					const bufferedClaim = buffered._mailboxClaim;
					if (!bufferedClaim) throw new Error("Claimed buffered input missing mailbox claim");
					active._bufferSoftStopTaken = false;
					// Keep accepted snapshots and uploaded files recoverable until the
					// ordinary user message commits, just like the interrupt drain path.
					const terminalCommand =
						parseQueuedNewCommand(buffered.text, buffered.commandText) ||
						parseQueuedGoalCommand(buffered.text, buffered.commandText);
					pendingBufferedDelivery = buffered;
					if (terminalCommand && parseQueuedNewCommand(buffered.text, buffered.commandText)) {
						await persistClaimedUserInput({
							claim: bufferedClaim,
							reservedMessageId: bufferedRow?.recipientMessageId,
							narratorId,
							text: buffered.text,
							contentBlocks: [{ type: "text", text: buffered.text }],
							commandText: buffered.commandText,
							createdBy: buffered.createdBy,
						});
						pendingBufferedDelivery = undefined;
					}
					// Broadcast which message was consumed + remaining queue snapshot
					const remaining = toBufferSummary(await getBufferedMessagesAsync(narratorId));
					broadcastToNarrator(narratorId, {
						type: "buffer_consumed",
						narratorId,
						messageId: buffered.id,
						remaining,
					});
					// [continuation-source: queued-command]
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
						if ((await getBufferedMessagesAsync(narratorId)).length > 0) {
							runState.wasInterrupted = true;
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
					// A queued /goal appends its protected task, then continues this same
					// loop with an explicit Spec instruction. Later queued messages retain
					// their order and are consumed after this goal turn.
					const goalCommand = parseQueuedGoalCommand(buffered.text, buffered.commandText);
					if (goalCommand) {
						await executeQueuedGoalCommand(narratorId, buffered, goalCommand.objective);
						active._continuationSuppressed = false;
						active._continuationStallCount = 0;
						active._continuationStallKey = undefined;
						active._currentUserId = buffered.createdBy ?? active._currentUserId ?? null;
						const continuationPrompt = await maybeStartContinuation(active, false, {
							explicitStart: true,
						});
						if (continuationPrompt) {
							await narratorService.updateStatus(narratorId, "working");
							runState.input.text = "";
							runState.input.images = undefined;
							continue;
						}
						if ((await getBufferedMessagesAsync(narratorId)).length > 0) {
							runState.wasInterrupted = true;
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
						| PersistedUserImageBlock
						| FileReferenceSnapshot
						| {
								type: "text_file";
								filename: string;
								size: number;
								filePath: string;
						  }
					> = [];
					if (buffered.images?.length) {
						for (const img of buffered.images) {
							persistBlocks.push(imageRefToContentBlock(img));
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
					// Resolve spill-backed getters while the claim still leases staging files.
					// Both values are needed after persistence permits staging cleanup.
					const fileReferences = buffered.fileReferences;
					const bashCommand = buffered.bashCommand;
					// contentJson blocks store raw user text; contentText stores effectiveBufferedText (see feedMessage)
					persistBlocks.push(...(fileReferences ?? []), {
						type: "text",
						text: buffered.text,
					});
					const userMsg = await persistClaimedUserInput({
						claim: bufferedClaim,
						reservedMessageId: bufferedRow?.recipientMessageId,
						narratorId,
						text: effectiveBufferedText,
						contentBlocks: persistBlocks,
						commandText: buffered.commandText,
						createdBy: buffered.createdBy,
					});
					pendingBufferedDelivery = undefined;
					await cleanupBufferedTextFilesAsync(buffered._stagingId ?? buffered.id);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: fileReferenceMessageForDisplay(userMsg),
					});
					active.events.emit("event", {
						type: "user_message",
						data: fileReferenceMessageForDisplay(userMsg),
					});
					await narratorService.updateStatus(narratorId, "working");
					// runBashFirst flow: run the Bash command as an assistant tool card after the
					// user message, then replay it as the current turn (empty text) so the model
					// sees: user prompt → Bash tool call/result → reply.
					if (bashCommand) {
						await handleBashCommand(
							narratorId,
							bashCommand,
							`/bash ${bashCommand}`,
							buffered.createdBy ?? undefined,
							{ skipUserMessage: true, signal: active.abortController.signal },
						);
						runState.input.text = "";
						runState.input.images = undefined;
						continue;
					}
					runState.input.text = projectFileReferenceText(effectiveBufferedText, fileReferences);
					runState.input.images = buffered.images;
					continue;
				}
			}

			// The pass above ended early only to let a queued message cut in, but the
			// queue is now empty — the user cancelled it while the current tool call was
			// still running. The model's work is unfinished, so resume the turn instead
			// of settling idle (which would look like the narrator stopping on its own
			// right after that tool call).
			// [continuation-source: soft-stop-recovery]
			if (active._bufferSoftStopTaken) {
				active._bufferSoftStopTaken = false;
				if (!runState.hadError && active.alive) {
					logger.info("Resuming turn after a cancelled cut-in queued message", { narratorId });
					await narratorService.updateStatus(narratorId, "working");
					runState.input.text = "";
					runState.input.images = undefined;
					continue;
				}
			}

			// [continuation-source: spec-continuation]
			const continuationPrompt = await continueForSpec("spec", runState.hadError);
			if (continuationPrompt) {
				await narratorService.updateStatus(narratorId, "working");
				// The continuation prompt was persisted as a system message; the next
				// provider call only needs an empty turn to advance the conversation.
				runState.input.text = "";
				runState.input.images = undefined;
				continue;
			}

			// [continuation-source: compact-restart]
			// A late compact only resumes an unfinished pass. A naturally completed
			// response must never issue an empty extra request merely to consume a compact.
			if (
				!result.completedNaturally &&
				!runState.hadError &&
				!active.abortController.signal.aborted &&
				(compactDoneFlag || hasPendingHistoryCompact(narratorId))
			) {
				runState.input.text = "";
				runState.input.images = undefined;
				continue;
			}

			if (profile.kind === "subagent" && profile.control) {
				const control = await applyForegroundControl(active, owner, profile, result);
				if (control.kind === "resume") {
					resetForegroundTurn(active, profile);
					runState.input.text = control.prompt;
					runState.pendingPrePromptBashCommand = control.prePromptBashCommand;
					active._currentUserId = control.userId;
					runState.hadError = false;
					runState.wasInterrupted = false;
					continue;
				}
				if (control.kind === "finish") {
					runState.finalText = control.finalText;
					runState.hadError = control.hasError;
					runState.wasInterrupted = control.interrupted;
					break;
				}
			}

			// No buffered messages — now transition to idle/unread (triggers notifications)
			if (!runState.hadError) {
				// Drain any queued injection FIRST, before flipping the DB status to idle.
				// This closes the window where status is already idle (visible to clients /
				// route admission) while this loop is still running and about to pick up more
				// work. If anything is queued, keep the status working and continue this loop
				// instead of going idle at all.
				// [continuation-source: pre-idle-injection-drain]
				const bgCompletionAfterIdle = await drainAndPersistPendingInjections(
					active,
					subagentPlacement,
				);
				if (bgCompletionAfterIdle) {
					await narratorService.updateStatus(narratorId, "working");
					runState.input.text = "";
					runState.input.images = undefined;
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
		if (pendingBufferedDelivery) {
			try {
				await restoreBufferedMessage(narratorId, pendingBufferedDelivery);
			} catch (restoreError) {
				logger.error("Failed to restore undelivered buffered message", {
					narratorId,
					error: String(restoreError),
				});
			}
			pendingBufferedDelivery = undefined;
		}
		const errorMsg = serializeCatalogErrorMessage(err);
		logger.error("Narrator loop error", {
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
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
		runState.finalText = errorMsg;
		runState.hadError = true;
		active.events.emit("event", { type: "error", data: { message: errorMsg } });
	} finally {
		unregisterUpdateLoop();
		// A child publisher owns its terminal boundary; the primary finalizer must
		// never publish a second conclusion or clear its inbox/control state.
		if (owner.isCurrent() && profile.kind === "primary") {
			active._loopRunning = false;
			active.alive = false;

			// Backstop for the write-claim registry: `onErrorCleanup` covers the loop's own
			// abort/error events, but a throw out of executeAgentLoop itself never reaches
			// it. Any claim still in flight once the loop is over belongs to a tool that
			// will never report a result, and leaving it open makes its declared paths
			// shadow every later window in this worktree. Idempotent — sealing an already
			// closed claim does nothing.
			if (active._isInGitRepo) abandonSessionTreeSnapshots(active, narratorId);

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
			// user interrupt. Hook failures never affect narrator state, but their actual
			// execution must settle before file-revert admission can be granted.
			if (saParentNarratorId === undefined) {
				await (async () => {
					try {
						// This branch is only entered for primary profiles, so querying the
						// narrator variant is redundant and would be SQLite-only on PG.
						const stopReason = runState.hadError
							? "error"
							: runState.wasInterrupted
								? "aborted"
								: runState.hitMaxTurns
									? "max_turns"
									: "done";
						const { hookService } = await import("../hook-service");
						await hookService.runHooks(
							"Stop",
							{
								hook_event_name: "Stop",
								narrator_id: narratorId,
								chapter_id: active._chapterId,
								project_id: active._projectId,
								cwd: active.cwd,
								stop_reason: stopReason,
								stop_error: runState.hadError,
								last_assistant_text: runState.finalText.slice(0, 2000),
								duration_ms: Date.now() - loopStartedAt,
								total_tokens: runState.totalTokens,
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
			let pendingStopHandoff = false;
			try {
				// This finalizer can run with a primary runtime profile while the persisted
				// narrator is a subagent. Keep the SQLite read only behind an explicit PG gate.
				const pgRuntime = hasPostgresRuntime();
				if (pgRuntime)
					logger.warn(
						"Skipping persisted subagent handoff: PostgreSQL narrator port is unavailable",
						{
							narratorId,
						},
					);
				const narr = pgRuntime
					? undefined
					: await db.query.narrators.findFirst({
							where: eq(narrators.id, narratorId),
							columns: { variant: true, parentNarratorId: true },
						});
				if (narr && isSubagentVariant(narr.variant)) {
					const lastFinalText = await getSubagentFinalText(narratorId);

					// --- Takeover handoff ---
					// While the subagent is taken over, the parent stays blocked in
					// waitForManualOverride (foreground) or holds a background_task_id
					// (background). When an intermediate loop finishes but the user has
					// NOT stopped takeover, do nothing (keep the takeover active; the
					// subagent waits idle[taken_over] for the next user action).
					if (consumePendingBackgroundFinalize(narratorId)) {
						// Background takeover stopped while still working — finalize as a
						// background completion so the parent learns the result.
						const { finalizeTakenOverBackgroundSubagent } = await import("../subagent-runner");
						const watcher = getConclusionWatcher(narratorId);
						const parentId = saParentNarratorId ?? narr.parentNarratorId ?? "";
						const tuid = watcher?.toolUseId ?? saParentToolUseId ?? "";
						clearTakenOver(narratorId);
						if (parentId) {
							await finalizeTakenOverBackgroundSubagent(
								narratorId,
								parentId,
								tuid,
								runState.hadError,
								lastFinalText,
								locale,
							);
						}
					} else if (consumePendingStopTakeover(narratorId)) {
						// Foreground takeover stopped while still working — resolve the
						// parent's blocked Promise exactly once so the parent's
						// runForegroundLoop finalizer returns the result (no double-write).
						pendingStopHandoff = true;
						if (getManualOverrideMap().has(narratorId)) {
							clearTakenOver(narratorId);
							resolveManualOverride(narratorId, lastFinalText, runState.hadError);
						} else {
							// Session-engine takeover stopped while still working — the
							// parent was already unblocked when the user continued the
							// subagent, so hand the result back via the conclusion watcher
							// and clear the lingering taken_over tag.
							const watcher = getConclusionWatcher(narratorId);
							if (watcher) {
								const resultMsgId = await getSubagentResultMessageId(narratorId);
								const reference = await prepareSubagentConclusionReference(
									narratorId,
									watcher.parentNarratorId,
									watcher.toolUseId,
									watcher.originToolCallId,
								);
								await updateToolCallConclusion({
									toolCallId: reference.toolCallId,
									messageId: reference.messageId,
									subagentId: narratorId,
									parentNarratorId: watcher.parentNarratorId,
									toolUseId: watcher.toolUseId,
									finalText: lastFinalText,
									hasError: runState.hadError,
									resultMessageId: resultMsgId,
									refreshTiming: true,
								});
								if (getConclusionWatcher(narratorId) === watcher)
									removeConclusionWatcher(narratorId);
							}
							clearTakenOver(narratorId);
							await narratorService.removeSubstatus(narratorId, "taken_over").catch(() => {});
						}
					} else if (isTakenOver(narratorId)) {
						// Still taken over — keep blocked/held, no handoff.
					} else {
						const watcher = getConclusionWatcher(narratorId);
						if (watcher) {
							// Resolve the last assistant message ID for result binding
							const resultMsgId = await getSubagentResultMessageId(narratorId);
							const reference = await prepareSubagentConclusionReference(
								narratorId,
								watcher.parentNarratorId,
								watcher.toolUseId,
								watcher.originToolCallId,
							);
							await updateToolCallConclusion({
								toolCallId: reference.toolCallId,
								messageId: reference.messageId,
								subagentId: narratorId,
								parentNarratorId: watcher.parentNarratorId,
								toolUseId: watcher.toolUseId,
								finalText: lastFinalText,
								hasError: runState.hadError,
								resultMessageId: resultMsgId,
								refreshTiming: true,
							});
							if (getConclusionWatcher(narratorId) === watcher) removeConclusionWatcher(narratorId);
						}
					}
				}
			} catch (err) {
				if (pendingStopHandoff && isTakenOver(narratorId)) markPendingStopTakeover(narratorId);
				logger.error("Failed to resolve suspended subagent / conclusion watcher", {
					narratorId,
					error: String(err),
				});
			}

			// Restore model after temporary override (slash command with modelOverride.mode="temporary")
			// Read from DB so this survives server restarts. There is no backend-neutral
			// pending-restore port yet; PG must skip this SQLite-only fallback explicitly.
			if (hasPostgresRuntime()) {
				logger.warn("Skipping pending model restore: PostgreSQL narrator port is unavailable", {
					narratorId,
				});
			} else {
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
			}

			if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
			// Stop file watcher for this narrator
			if (active._worktreePath) {
				worktreeWatcher.unwatch(active._worktreePath, narratorId);
			}
			// Persist conversationId so the next activation can resume the API session
			// (avoids cache miss from generating a new random UUID every time).
			//
			// Compare-and-set against the id this session started from. A compact clears
			// the column to demand a fresh upstream session on the next request, and a
			// background compact can land after the turn that started it — including on a
			// turn that ended perfectly normally. An unconditional write would undo that
			// signal, and the next activation would resume a session still holding the
			// pre-compact history alongside the compacted one.
			persistConversationIdIfUnchanged(narratorId, active);
			active._preparedPlanModes?.clear();
			if (activeNarrators.get(narratorId) === active) activeNarrators.delete(narratorId);
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
			pendingPlanApproverSource.delete(narratorId);
			pendingPlanDiff.delete(narratorId);
			// Soft-stop bookkeeping never survives the loop that owns it.
			active._bufferSoftStop = false;
			active._bufferSoftStopTaken = false;
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
			const hasBuffered = (await getBufferedMessagesAsync(narratorId)).length > 0;
			if (runState.hadError || (runState.wasInterrupted && hasBuffered)) {
				// Only broadcast buffer_preserved on error — when interrupted the
				// auto-resume below will immediately consume the first message, so
				// showing a "preserved" notification would be misleading.
				if (runState.hadError) {
					const preserved = await getBufferedMessagesAsync(narratorId);
					if (preserved?.length) {
						broadcastToNarrator(narratorId, {
							type: "buffer_preserved",
							narratorId,
							messages: toBufferSummary(preserved),
						});
					}
				}
			}
			// No terminal queue clear: messages accepted after the last read belong to the next run.
			if (
				!runState.hadError &&
				(await hasInboxKind(narratorId, ["user_input", "agent_message", "task_notice"]))
			)
				active._resumeBufferedAfterLoop = true;

			// 6. Per-narrator git status Promise cache (Bash before-status snapshots)
			active._bashBeforeStatus?.clear();

			// Safety net: transient "reflecting"/"reasoning" tags are added mid-turn
			// (danger/task reflection gates, streaming reasoning) and cleared by
			// event-driven or status-transition code. Some escape paths — a
			// compareAndSetStatus no-op after status drift, a silent disconnect break,
			// or a DB lock swallowing the clear — can leave one stuck, which pins the
			// sidebar tab icon purple until the next server restart. The loop has now
			// fully ended, so neither tag should survive; strip any leftover here.
			for (const staleTag of ["reflecting", "reasoning"] as const) {
				if (active._substatus.has(staleTag)) active._substatus.delete(staleTag);
			}
			if (hasPostgresRuntime()) {
				logger.warn(
					"Skipping persisted transient substatus cleanup: PostgreSQL narrator port is unavailable",
					{
						narratorId,
					},
				);
			} else {
				try {
					const leftover = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { substatus: true },
					});
					const tags = parseSubstatus(leftover?.substatus);
					if (tags.includes("reflecting") || tags.includes("reasoning")) {
						await narratorService.updateSubstatus(
							narratorId,
							tags.filter((t) => t !== "reflecting" && t !== "reasoning"),
						);
					}
				} catch (err) {
					logger.warn("Failed to clear stale transient substatus after narrator loop", {
						narratorId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			if (shouldUpdateTitle) {
				generateAndSetTitle(narratorId, locale).catch(() => {});
			}
			active._provisionalTitle = undefined;

			// Auto-resume: when the loop was interrupted and buffered messages remain,
			// consume them. This makes priority messages run at the next safe boundary
			// without waiting for manual input. `/new` drains immediately; `/goal`
			// starts a Spec continuation and leaves later queued messages in order.
			// Messages can also arrive during a normal finalizer now that busy covers
			// its full lifetime. Let the post-release check drain those rather than
			// leaving them stranded (or clearing them as the old early-idle path did).
			active._resumeBufferedAfterLoop = !runState.hadError;

			// Wait until every old-session cleanup step is complete before broadcasting
			// the recovery card. Otherwise a fast click could start a new session while
			// this finally block still owns and clears narrator-scoped state.
			if (pendingWorkingDirectoryRecovery) {
				try {
					await narratorService.persistDisplayMessage(narratorId, "", [
						{
							type: "cwd_recovery",
							missingCwd: pendingWorkingDirectoryRecovery.missingCwd,
							suggestedCwd: pendingWorkingDirectoryRecovery.suggestedCwd,
						},
					]);
				} catch (err) {
					logger.error("Failed to persist missing workdir recovery notice", {
						narratorId,
						error: String(err),
					});
				}
			}
		}
	}

	let finalText = runState.finalText;
	if (runState.lastPass?.paymentRequired)
		finalText = `Payment required: ${runState.lastPass.paymentRequired.message}`;
	if (
		profile.kind === "subagent" &&
		!finalText.trim() &&
		!runState.hadError &&
		!runState.wasInterrupted &&
		!active.abortController.signal.aborted
	) {
		const latest = await narratorService.getLatestAssistantTextAndId(narratorId).catch(() => null);
		if (latest?.text.trim()) finalText = latest.text;
		else
			finalText =
				(await narratorService.getLatestSuccessfulCompactSummary(narratorId).catch(() => null))
					?.summary ?? "";
	}
	if (continuationStopNote && !runState.wasInterrupted && !active.abortController.signal.aborted) {
		finalText = finalText.trim()
			? `${finalText.trim()}\n\n${continuationStopNote}`
			: continuationStopNote;
	}
	return {
		started: true,
		allowInboxWake: !runState.hadError,
		finalText,
		hasError: runState.hadError,
		aborted: runState.wasInterrupted,
		contextLengthExceeded: runState.hadError && runState.lastPass?.contextLengthExceeded === true,
		lastPass: runState.lastPass,
	};
}
