import { resolve } from "node:path";
import { quotaExhaustedCode } from "@shared/agent-protocol/quota-exhausted";
import { bufferedRowMode, resolveBufferQueueMode } from "@shared/buffer-queue-mode";
import { serializeCatalogErrorMessage } from "@shared/error-catalog";
import { type FileReferenceSnapshot, fileReferenceMessageForDisplay } from "@shared/file-reference";
import { resolveMcpLoadingMode } from "@shared/mcp-loading-mode";
import { formatOriginLabel } from "@shared/message-origin";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { resolveProviderAndModel } from "../../lib/agent";
import { analyzeShellCommand } from "../../lib/agent/bash-analyze";
import { LOCAL_DEVICE_ID } from "../../lib/agent/execution/backend";
import { projectFileReferenceText } from "../../lib/agent/file-reference-projection";
import {
	acknowledgePipelineExitConfirmation,
	clearPipelineStateIfActive,
} from "../../lib/agent/pipeline-state";
import { detectShell } from "../../lib/agent/shell";
import { toolRegistry } from "../../lib/agent/tool-registry";
import { getMissingWorkingDirectoryRecovery, SHELL_TOOL_NAME } from "../../lib/agent/tools/bash";
import { clearBehaviorFenceEditGrant } from "../../lib/agent/tools/behavior-fence-grant";
import { KNOWLEDGE_KIND_DENY_CORE, OPTIONAL_TOOLS } from "../../lib/agent/tools/index";
import type { ToolDefinition } from "../../lib/agent/types";
import { buildAttachedFilesHint } from "../../lib/attached-files";
import { normalizeBooleanOverride, resolveBooleanOverride } from "../../lib/boolean-override";
import { queueContextCharacterRefresh } from "../../lib/context-characters";
import { withDbRetry } from "../../lib/db-resilience";
import { resolveInjectedDevices } from "../../lib/device-injection-trait";
import { resolveFastModeForUser } from "../../lib/fast-mode";
import { logger } from "../../lib/logger";
import {
	formatSubagentModelRestrictionDescription,
	getBlockedSkills,
	getDisabledToolSet,
} from "../../lib/narrator-custom-traits";
import {
	isBotNarrator,
	isPlanModeTrait,
	parseSubstatus,
	redactDraftTraits,
} from "../../lib/narrator-utils";
import { nugAvailabilityPoller } from "../../lib/nug-availability-poller";
import { resolveKnownUnavailableNugModel } from "../../lib/nug-model-availability";
import { markNugCachedModelUnavailable } from "../../lib/nug-model-cache";
import { resolveEffectiveRelaxedPlan } from "../../lib/permission-modes";
import {
	getBotModePrompt,
	getRunDeliveryHint,
	getToolMessage,
	getToolMessageWithParams,
	type Locale,
} from "../../lib/prompt-i18n";
import { MAX_QUOTA_WAITS_PER_RUN, waitForQuotaReset } from "../../lib/provider-quota-wait";
import { policySourceIdOf, type RuntimeSourceRow, runDeliverToOf } from "../../lib/runtime-source";
import {
	getSearchExecutionScope,
	SearchExecutionBudgetExceededError,
} from "../../lib/search/execution-scope";
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
import { sideCarBodyWithText } from "../../lib/sidecar-templates";
import type { ImageRef, PersistedUserImageBlock, TextFileRef } from "../../lib/uploads";
import {
	getImagePath,
	imageRefToContentBlock,
	imageToBase64,
	saveTextFileToWorktree,
} from "../../lib/uploads";
import {
	type RunDeliverTo,
	readRuntimeRegistrationColumn,
} from "../../lib/validators/runtime-registration";
import { broadcastToNarrator } from "../../websocket/narrator-ws";
import { consumeAgentMessageHistory, isLastModelInputMailbox } from "../agent-message-delivery";
import {
	claimInboxHead,
	hasInboxKind,
	persistClaimedUserInput,
	releaseInboxClaim,
} from "../agent-runtime/inbox";
import { type ExecutionOwner, getRunHold, type RunControl } from "../agent-runtime/ownership";
import { awaitRunHold } from "../agent-runtime/run";
import { getRuntimeQueuePort } from "../agent-runtime/runtime-queue-port";
import { backgroundTaskService } from "../background-task-service";
import { getAgentFileReferenceContext } from "../file-reference-context";
import { getStatusSummaryCached, invalidateStatus } from "../git-status-cache";
import { injectionKey, knowledgeInjection } from "../knowledge-injection";
import { knowledgeInjectionReads, knowledgeService } from "../knowledge-service";
import {
	cleanupBufferedTextFilesAsync,
	getBufferedMessagesAsync,
	mailboxInputRequiresFreshTurn,
	projectMailboxUserMessage,
	restoreBufferedMessage,
	toBufferSummary,
} from "../narrator-buffer";
import { runCustomCompact, runPlanCompact } from "../narrator-compact";
import { freezeNarratorContextComposition } from "../narrator-context-composition";
import { optionalToolDescription, reconcileEpoch } from "../narrator-epochs";
import {
	clearStreamingSnapshot,
	type EventHandlerContext,
	type EventHooks,
	persistDetachedToolResult,
	processEvent,
	retireSubagentOutputCharCount,
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
	accountRequestTokenUsage,
	accountTokenUsageForTurn,
	applySessionDefaultDevice,
	buildContextManagementHooks,
	buildSystemPrompt,
	cleanupPartialMessage,
	completeOrphanedToolCalls,
	consumeQuestionAnswerModelReceipts,
	drainAndPersistPendingInjections,
	drainInjectionsIntoHistory,
	ensureSkillCacheFreshForActiveNarrator,
	evaluateSoftStopRequest,
	executeQueuedGoalCommand,
	executeQueuedNewCommand,
	filterOAuthSessionDevices,
	finalizeInterruptedRun,
	finalizeOrCleanupPartialMessage,
	hasPendingBufferedGuidance,
	inheritedModelRuntime,
	maybeStartContinuation,
	parseQueuedGoalCommand,
	parseQueuedNewCommand,
	persistConversationIdIfUnchanged,
	rearmCutInSoftStopBeforeContinuing,
	resolveRuntimeReasoningEffort,
	resolveSessionDevices,
	setNarratorDefaultDevice,
	settleNarratorRuntimeModel,
	updateNarratorModel,
	urgentActivitySignal,
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
	withNarratorMutationAdmission,
} from "../narrator-session-state";
import { clearAliasRegistry, clearTeamFileChanges } from "../narrator-subagent";
import { generateAndSetTitle } from "../narrator-title";
import { abandonSessionTreeSnapshots } from "../narrator-tree-snapshot-hooks";
import { endTurn, startTurn } from "../narrator-turns";
import { assertOAuthNarratorRuntimeActive } from "../oauth-narrator-runtime-policy";
import { keepOutlineTaskLeases, type OutlineLeaseKeeper } from "../outline/lease-keeper";
import { resolvePlanApprovalAttribution } from "../plan-approval-attribution";
import { subagentRetryRecoveredBroadcast } from "../subagent-executor";
import { isMcpToolAllowedForNarrator, runtimeToolFilter } from "../subagent-tools";
import { buildFinalToolStartAuthorization } from "../tool-final-start-authorization";
import { mcpToolMarker, parseMcpServerMarker, parseMcpToolMarker } from "../tool-load-markers";
import { resolveNarratorCapabilities } from "../trait-layer-service";
import { buildTreeSnapshotExecutionHooks, FILE_MUTATING_TOOLS } from "../tree-snapshot-loop-hooks";
import {
	computeContinuationStallState,
	createSpecContinuationState,
	interruptionContinuationLabel,
	MAX_TURN_INTERRUPTION_RETRIES,
	shouldResumeAfterCompact,
	specContinuationStopNote,
} from "../turn-continuation-decisions";
import { registerNarratorLoop } from "../update-coordinator";
import { createRuntimeEventContext, createRuntimeMessageWriters } from "./context";
import { buildRuntimeHistory, questionModelReceipts } from "./history";
import { createRuntimeRunState, type RuntimeRunOutcome } from "./input";
import { waitForModelAvailabilityOrChange } from "./model-availability-wait";
import {
	applyPlanApproval,
	dropDeferredPlanApproval,
	runDeferredPlanApproval,
} from "./plan-approval-restart";
import { type RuntimePolicy, runtimeInteractionHint } from "./policy";
import { countRuntimeSystemCharacters } from "./prompt-characters";
import type { RuntimeRecoveryState, RuntimeRecoveryTransition } from "./transition";
import { selectRuntimeInterruption, selectRuntimeRecovery } from "./transition";

/**
 * Where a narrator's file-mutating tool calls should be git-tracked, or null.
 *
 * Narrators track their cwd, but only a local Git repo — gitService spawns local
 * git, so a remote device would report the host's state. Evaluated per tool call rather than
 * per session so a mid-session cwd switch re-evaluates `_isInGitRepo`.
 *
 * Known gap: `_isInGitRepo` is probed at session creation and cwd switches
 * only, so a `git init` inside the current directory activates the push path
 * no sooner than the next session/cwd change; the client-side `not_git`
 * workspace re-probe interval covers the bar in the meantime.
 */
export function gitTrackPathForSession(
	session: Pick<ActiveNarrator, "_isInGitRepo" | "_defaultDeviceId" | "cwd">,
): string | null {
	if (
		session._isInGitRepo === true &&
		(session._defaultDeviceId ?? LOCAL_DEVICE_ID) === LOCAL_DEVICE_ID
	)
		return session.cwd;
	return null;
}

/** Return whether a completed Bash input contains a parsed Git command. */
export async function isGitCommandToolResult(
	toolName: string,
	input: Record<string, unknown> | undefined,
	cwd: string,
): Promise<boolean> {
	if (toolName !== SHELL_TOOL_NAME || !input) return false;
	const command = typeof input.command === "string" ? input.command : "";
	if (!command || !/\bgit\b/.test(command)) return false;
	const analysis = await analyzeShellCommand(command, cwd, detectShell().type);
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

/**
 * The session's stored base prompt plus projections of its registered relations and
 * capability ceiling. Delivery names its actual recipient; only capability denials
 * state interaction limits. A control grant adds no prompt or behavioral restrictions.
 * A bot's channel is a relation too: its audience reads only what it sends them, so
 * the protocol follows the persona rather than replacing it.
 */
export function runtimeBasePrompt(
	row: RuntimeSourceRow & { systemPrompt: string | null; traits?: unknown },
	locale: Locale,
	policy: RuntimePolicy,
): string | null {
	const base = row.systemPrompt;
	const sections: string[] = [];
	if (isBotNarrator(row.traits)) sections.push(getBotModePrompt(locale));
	const deliverTo = runDeliverToOf(row);
	if (deliverTo) {
		const run = readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.run;
		sections.push(getRunDeliveryHint(locale, deliverTo, run?.cancelWith));
	}
	const interaction = runtimeInteractionHint(policy, locale);
	if (interaction) sections.push(interaction);
	if (sections.length === 0) return base;
	return [base, sections.join("\n")].filter(Boolean).join("\n\n");
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
	/** Live relationship state of this run; absent for a bare session run in tests. */
	run?: RunControl,
	/** An accepted `/bash` pre-command the runtime runs (and owns) before the first pass. */
	prePromptBashCommand?: string,
): Promise<RuntimeRunOutcome> {
	const { narratorId, locale } = active;
	const runState = createRuntimeRunState({ kind: "current", text, images }, prePromptBashCommand);
	const continuationState = createSpecContinuationState();
	let continuationStopNote: string | null = null;
	let abortedBeforeCleanup: boolean | undefined;
	let freshInput = false;
	let terminalStatus: RuntimeRunOutcome["terminalStatus"];
	// A plain run becomes idle only after its terminal transaction. A held boundary
	// may rest visibly because its durable mirror authorizes recovery without delivery.
	const restingStatus = () =>
		run && (!getRunHold(narratorId) || getRunHold(narratorId)?.released)
			? ("working" as const)
			: ("idle" as const);

	// Keep the machine-readable failure with the outcome; finalization happens only
	// after the terminal transaction and must not reconstruct it from display text.
	const updateTerminalStatus = (status: NonNullable<RuntimeRunOutcome["terminalStatus"]>) => {
		terminalStatus = status;
		return narratorService.updateStatus(narratorId, restingStatus(), status);
	};

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

	// The run's registered result destination decides transcript placement, the
	// display adapter's second broadcast target and placement-only notices. It is read
	// once: a run never changes where it delivers.
	let deliverTo: RunDeliverTo | undefined;
	let placement: { parentNarratorId: string; parentToolUseId: string } | undefined;
	let messageWriters = createRuntimeMessageWriters();
	try {
		unregisterUpdateLoop = registerNarratorLoop(narratorId, locale, {
			userId: active._currentUserId,
			replyInUserLanguage: active._replyInUserLanguage,
		});
		// A legitimately admitted run is an explicit recovery from a previous stop.
		if (!active.abortController.signal.aborted)
			db.update(narrators)
				.set({ lastStopReason: "normal" })
				.where(eq(narrators.id, narratorId))
				.run();
		const initNarrator = await narratorService.getById(narratorId);
		deliverTo = runDeliverToOf(initNarrator);
		placement = deliverTo
			? { parentNarratorId: deliverTo.narratorId, parentToolUseId: deliverTo.toolUseId }
			: undefined;
		messageWriters = createRuntimeMessageWriters(placement?.parentToolUseId);
	} catch (error) {
		if (owner.isCurrent()) {
			active._loopRunning = false;
			active.alive = false;
		}
		unregisterUpdateLoop();
		throw error;
	}
	// One run, one `narrator_turns` row; envelopes written from here carry its id.
	const turnId = startTurn(narratorId);

	// One continuation decision for every session. Placement affects only the saved
	// transcript and the explanation attached to the delivered result, never its budget.
	const continueForSpec = async (cause: "spec" | "maxTurns", suppressed: boolean) => {
		if (runState.lastPass?.reasoningOnlyIdle) return null;
		const content = await maybeStartContinuation(active, suppressed, {
			cause,
			state: continuationState,
			placement,
		});
		continuationStopNote =
			deliverTo && continuationState.stop
				? specContinuationStopNote(continuationState.stop, locale)
				: null;
		return content;
	};

	/**
	 * A stopped turn of a held run (the user drives it) parks instead of ending the run.
	 *
	 * A stop can land at ANY await of a pass — while streaming, in a retry backoff, a
	 * model-availability wait or the turn-end bookkeeping — so every abort exit asks
	 * here first. Only the run's own cancellation (caller, deadline, task cancel) ends
	 * a held run; a local Stop only ends the current turn and keeps the hold.
	 *
	 * Returns what the caller must do next, or undefined to keep its own abort exit.
	 */
	const applyInterruptedTurnControl = async (
		_pass: ExecuteLoopResult,
	): Promise<"continue" | "break" | undefined> => {
		const hold = getRunHold(narratorId);
		if (
			!run ||
			!hold ||
			hold.released ||
			run.cancel.signal.aborted ||
			!active.abortController.signal.aborted ||
			active._planApprovedContinue
		)
			return;
		const partialId = active._partialMessageId;
		active._partialMessageId = undefined;
		await finalizeInterruptedRun(active, narratorId, partialId);
		return holdAtBoundary();
	};
	/**
	 * Park a held run at a turn boundary until queued input, a release, or the run's
	 * cancellation. Input resumes the same run (same owner, same deadline); a release
	 * lets the ordinary terminal path deliver the result.
	 */
	const holdAtBoundary = async (): Promise<"continue" | "break"> => {
		if (!run) return "break";
		for (;;) {
			const woke = await awaitRunHold(owner, run, () =>
				hasInboxKind(narratorId, ["user_input", "agent_message"]),
			);
			if (woke !== "input") {
				if (woke === "cancel") runState.wasInterrupted = true;
				return "break";
			}
			active.abortController = new AbortController();
			if (run.cancel.signal.aborted) active.abortController.abort(run.cancel.signal.reason);
			active.alive = true;
			active._interruptCleanupDone = false;
			const next = await consumeNextInput({ fromHold: true });
			if (next === "break") {
				freshInput = true;
				return "break";
			}
			if (next === "continue") {
				runState.hadError = false;
				runState.wasInterrupted = false;
				return "continue";
			}
		}
	};
	const adoptHumanPrincipal = async (userId: string | null | undefined) => {
		if (!userId) return;
		if (run?.logicalRunId) {
			const { registerRunPrincipal } = await import("../narrator-runtime-registration");
			await registerRunPrincipal(narratorId, run.logicalRunId, userId);
		}
		active._currentUserId = userId;
		if (run) {
			run.principal = userId;
			if (run.binding) run.binding.principal = { userId };
		}
	};
	/**
	 * The single input consumer. Queued input is adopted by message intent, never by
	 * who the recipient is: a user's input (and only a user's) may establish a new
	 * execution principal; an agent message never rewrites it. Input that cannot join
	 * the running pass (attachments, a pre-command, a new principal, a control
	 * command) is persisted here and starts the next pass of the same run.
	 */
	const consumeNextInput = async (
		options: { fromHold?: boolean } = {},
	): Promise<"continue" | "break" | "none"> => {
		if (isNarratorRevertAdmissionBlocked(narratorId)) return "none";
		// Agent messages and notices queued for this session are adopted in order first.
		if (options.fromHold) {
			const delivered = await drainAndPersistPendingInjections(active, placement);
			if (delivered) {
				await narratorService.updateStatus(narratorId, "working");
				runState.input.text = "";
				runState.input.images = undefined;
				return "continue";
			}
		}
		// Serialize this claim with HTTP acceptance + interrupt. Otherwise a live
		// loop can consume the replacement while its enqueue is returning, then
		// the interrupt intended for the old input would abort the new one.
		let requiresFreshTurn = false;
		const bufferedRow = await withNarratorMutationAdmission(narratorId, async () => {
			if (active.abortController.signal.aborted) return undefined;
			return claimInboxHead(narratorId, (candidate) => {
				if (
					active.abortController.signal.aborted ||
					candidate.kind !== "user_input" ||
					(active._bufferSoftStopTaken && bufferedRowMode(candidate) === "turn")
				)
					return false;
				// A blocked ordinary next step must not end unfinished recovery
				// merely because its later execution needs a fresh owner/model.
				requiresFreshTurn = mailboxInputRequiresFreshTurn(candidate);
				return !requiresFreshTurn;
			});
		});
		// Let the finalizer restore the previous model and release its epoch first.
		if (requiresFreshTurn) {
			if (run && getRunHold(narratorId) && !getRunHold(narratorId)?.released) freshInput = true;
			return "break";
		}
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
				parseQueuedNewCommand(
					buffered.text,
					buffered.commandText,
					buffered.composerDocument,
					buffered.executionIntent,
				) ||
				parseQueuedGoalCommand(
					buffered.text,
					buffered.commandText,
					buffered.composerDocument,
					buffered.executionIntent,
				);
			pendingBufferedDelivery = buffered;
			if (
				terminalCommand &&
				parseQueuedNewCommand(
					buffered.text,
					buffered.commandText,
					buffered.composerDocument,
					buffered.executionIntent,
				)
			) {
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
			active._bufferGuidancePending = remaining.some(
				(message) =>
					message.state !== "failed" &&
					resolveBufferQueueMode(message.queueMode, message.priority) !== "turn",
			);
			// Materialize accumulated guidance before starting another model
			// request, so one request sees the whole FIFO batch. An urgent (interrupt)
			// input owns the next request: older tool guidance must not spend its soft
			// stop against that fresh pass; it is adopted at the pass's own boundary.
			active._bufferSoftStop =
				resolveBufferQueueMode(buffered.queueMode, buffered.priority) === "interrupt"
					? false
					: active._bufferGuidancePending;
			broadcastToNarrator(narratorId, {
				type: "buffer_consumed",
				narratorId,
				messageId: buffered.id,
				remaining,
			});
			// [continuation-source: queued-command]
			const newCommand = parseQueuedNewCommand(
				buffered.text,
				buffered.commandText,
				buffered.composerDocument,
				buffered.executionIntent,
			);
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
						restingStatus(),
						{
							substatus: ["unread"],
						},
					);
				}
				return "break";
			}
			// A queued /goal appends its protected task, then continues this same
			// loop with an explicit Spec instruction. Later queued messages retain
			// their order and are consumed after this goal turn.
			const goalCommand = parseQueuedGoalCommand(
				buffered.text,
				buffered.commandText,
				buffered.composerDocument,
				buffered.executionIntent,
			);
			if (goalCommand) {
				await executeQueuedGoalCommand(narratorId, buffered, goalCommand.objective);
				active._continuationSuppressed = false;
				active._continuationStallCount = 0;
				active._continuationStallKey = undefined;
				await adoptHumanPrincipal(buffered.createdBy);
				const continuationPrompt = await maybeStartContinuation(active, false, {
					explicitStart: true,
				});
				if (continuationPrompt) {
					await narratorService.updateStatus(narratorId, "working");
					runState.input.text = "";
					runState.input.images = undefined;
					return "continue";
				}
				if ((await getBufferedMessagesAsync(narratorId)).length > 0) {
					runState.wasInterrupted = true;
				} else {
					await narratorService.compareAndSetStatus(
						narratorId,
						["working", "waiting"],
						restingStatus(),
						{
							substatus: ["unread"],
						},
					);
				}
				return "break";
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
			const effectiveBufferedText = buffered.text + buildAttachedFilesHint(savedBufferedTextFiles);
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
				composerDocument: buffered.composerDocument,
				commandText: buffered.commandText,
				createdBy: buffered.createdBy,
				parentToolUseId: placement?.parentToolUseId,
			});
			pendingBufferedDelivery = undefined;
			// A human's own input establishes the execution principal of what follows.
			await adoptHumanPrincipal(buffered.createdBy);
			await cleanupBufferedTextFilesAsync(buffered._stagingId ?? buffered.id);
			broadcastToNarrator(narratorId, {
				type: "user_message",
				narratorId,
				message: fileReferenceMessageForDisplay({ ...userMsg, parentToolUseId: null }),
			});
			if (placement)
				broadcastToNarrator(placement.parentNarratorId, {
					type: "user_message",
					narratorId: placement.parentNarratorId,
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
				// The pre-command is current activity: urgent input cancels it like tool IO
				// (a fresh channel: the input being adopted may itself have been urgent).
				await handleBashCommand(
					narratorId,
					bashCommand,
					`/bash ${bashCommand}`,
					buffered.createdBy ?? undefined,
					{
						skipUserMessage: true,
						signal: urgentActivitySignal(active, active.abortController.signal),
					},
				);
				runState.input.text = "";
				runState.input.images = undefined;
				return "continue";
			}
			runState.input.text = projectFileReferenceText(effectiveBufferedText, fileReferences);
			runState.input.images = buffered.images;
			return "continue";
		}
		return "none";
	};
	/** The pass shape handed to control when a stop lands outside a model pass. */
	const abortedPass = (pass?: ExecuteLoopResult): ExecuteLoopResult => ({
		...(pass ?? { finalText: runState.finalText, hasError: false, shouldUpdateTitle: false }),
		aborted: true,
	});

	// Outline tasks this session set in progress stay its own while it runs (renewed at run start,
	// at each pass and tool boundary, and on a timer through long tool calls).
	let outlineLeases: OutlineLeaseKeeper | undefined;
	try {
		outlineLeases = keepOutlineTaskLeases(narratorId);
		while (active.alive && owner.isCurrent()) {
			void outlineLeases.touch();
			// The run's own cancellation reaches whichever turn controller is current.
			if (run?.cancel.signal.aborted && !active.abortController.signal.aborted)
				active.abortController.abort(run.cancel.signal.reason);
			// Request-only control has one pass lifetime; a new pass must never inherit
			// an already-consumed guidance abort from the preceding request.
			active._guidanceAbortController = new AbortController();
			const passUrgentGuidance = new AbortController();
			active._urgentGuidanceAbortController = passUrgentGuidance;
			if (active._bufferSoftStop && hasPendingBufferedGuidance(narratorId)) {
				active._guidanceAbortController.abort(new Error("Immediate guidance requested"));
			}
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
						signal: AbortSignal.any([active.abortController.signal, passUrgentGuidance.signal]),
					},
				);
				runState.input.text = "";
				runState.firstPass = false;
				// A stop during the pre-command ends the turn before any model request.
				if (active.abortController.signal.aborted) {
					const next = await applyInterruptedTurnControl(abortedPass());
					if (next === "continue") continue;
					if (next === "break") break;
					await finalizeInterruptedRun(active, narratorId);
					runState.wasInterrupted = true;
					break;
				}
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
			// Materialize queued receipts before building history. They then enter this
			// request exactly once through normal history adoption (including subagents).
			if (!active.abortController.signal.aborted)
				await drainAndPersistPendingInjections(active, placement);
			const historyDeadline = Date.now() + 10_000;
			let rawMessages = await narratorService.getModelHistorySinceLastCompact(
				narratorId,
				undefined,
				{
					signal: active.abortController.signal,
					deadline: historyDeadline,
				},
			);
			// History below is rebuilt from the latest post-compact messages, so any
			// pending-compact guard set by a background compact can be released here.
			clearActiveHistoryCompactPending(narratorId);

			// Rebuild system prompt each iteration so AGENTS.md/CLAUDE.md changes are picked up.
			const modelVersionBeforeLoad = active._modelRefreshVersion;
			const freshNarrator = await narratorService.getById(narratorId);
			// Effective traits and the capability ceiling, resolved strictly once per pass
			// so a layer or source change applies from the next pass. A layer that cannot
			// be read fails the pass; it never runs without its restrictions.
			const passCapabilities = await resolveNarratorCapabilities(
				narratorId,
				active._currentUserId ?? null,
			);
			const runtimePolicy = passCapabilities.policy;
			const profileToolFilter = runtimeToolFilter(runtimePolicy);
			{
				if (active._workspaceInstallFailed)
					throw new Error("Workspace context installation requires session recovery");
				const { workspaceContextService } = await import("../workspace-context-service");
				active._workspaceContext = await workspaceContextService.get(narratorId);
				active._workspacePassInvalidated = false;
			}
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

			// Every refresh derives the complete request view from one registry array. An
			// explicit ceiling has no managed loading and needs no MCP grant DB read.
			const managedOptionalTools = new Set<string>();
			let toolCandidates: readonly ToolDefinition[] = [];
			let toolRegistryRevision = toolRegistry.revision;
			const refreshMcpToolLoading = async () => {
				const candidates = toolRegistry.all();
				toolRegistryRevision = toolRegistry.revision;
				toolCandidates = candidates;
				managedOptionalTools.clear();
				if (runtimePolicy.tools.builtin !== "all") return;
				for (const tool of candidates) {
					if (
						OPTIONAL_TOOLS.has(tool.name) &&
						(!tool.isAvailable || tool.isAvailable()) &&
						profileToolFilter(tool) &&
						(!oauthRuntime || oauthRuntime.allowedTools.has(tool.name)) &&
						!active._disabledTools.has(tool.name)
					)
						managedOptionalTools.add(tool.name);
				}
				const [latestNarrator] = await db
					.select({ enabledTools: narrators.enabledTools })
					.from(narrators)
					.where(eq(narrators.id, narratorId))
					.limit(1);
				const explicitTools = new Set(latestNarrator?.enabledTools ?? []);
				const loadedMcpServers = new Set(
					(latestNarrator?.enabledTools ?? []).flatMap((value) => {
						const id = parseMcpServerMarker(value);
						return id ? [id] : [];
					}),
				);
				// Rebuild on every model request: neither resident membership nor old
				// registry names are an explicit server-loading grant.
				for (const name of managedOptionalTools) {
					if (name.startsWith("mcp__")) managedOptionalTools.delete(name);
				}
				for (const name of active._enabledOptionalTools) {
					if (name.startsWith("mcp__") || parseMcpServerMarker(name) || parseMcpToolMarker(name))
						active._enabledOptionalTools.delete(name);
				}
				for (const value of latestNarrator?.enabledTools ?? []) {
					if (parseMcpServerMarker(value) || parseMcpToolMarker(value))
						active._enabledOptionalTools.add(value);
				}
				const servers = new Map((settings.mcpServers ?? []).map((server) => [server.id, server]));
				for (const tool of candidates) {
					if (!tool.metadata?.mcpServerId) continue;
					const server = servers.get(tool.metadata.mcpServerId);
					if (
						!server ||
						resolveMcpLoadingMode(server) === "disabled" ||
						!profileToolFilter(tool) ||
						(oauthRuntime && !oauthRuntime.allowedTools.has(tool.name)) ||
						active._disabledTools.has(tool.name) ||
						!isMcpToolAllowedForNarrator(tool)
					)
						continue;
					managedOptionalTools.add(tool.name);
					if (
						resolveMcpLoadingMode(server) === "resident" ||
						loadedMcpServers.has(server.id) ||
						explicitTools.has(mcpToolMarker(server.id, tool.name))
					)
						active._enabledOptionalTools.add(tool.name);
					else active._enabledOptionalTools.delete(tool.name);
				}
			};
			await refreshMcpToolLoading();
			const toolLoadingInput = () => ({
				// Freeze one request's derivation; live active membership is only for execution.
				managed: new Set(managedOptionalTools),
				current: new Set(active._enabledOptionalTools),
				candidates: toolCandidates,
				registryRevision: toolRegistryRevision,
			});

			// Preserve the original signed array. buildRuntimeHistory drops the placement under
			// this run's destination on its detached model projection only; both freshness
			// guards use these raw rows.

			// The row is authoritative, including a pin made after the executor built
			// its one-time snapshot. initialModel only identifies the initial history.
			const modelSelectionRef = freshNarrator.model ?? FOLLOW_DEFAULT_MODEL;
			if (
				active._modelRefreshVersion !== modelVersionBeforeLoad &&
				active._modelSelectionRef !== undefined
			) {
				// A live update landed while the DB/OAuth/device snapshot was awaited.
				// That newer selection must not be replaced by the pass's older row.
				await settleNarratorRuntimeModel(active);
			} else {
				inheritedModelRuntime.select(active, modelSelectionRef, policySourceIdOf(freshNarrator));
				active._reasoningEffortRef = freshNarrator.reasoningEffort ?? null;
				if (modelSelectionRef === FOLLOW_PARENT_MODEL) {
					inheritedModelRuntime.refresh(active);
					await settleNarratorRuntimeModel(active);
				} else {
					active._modelRef = modelSelectionRef;
					active._settingsRevision = getSettingsRevision();
					active.model = resolveEffectiveModel(modelSelectionRef, active.provider);
					active.provider = resolveProvider(active.model);
					active.reasoningEffort = resolveRuntimeReasoningEffort(
						active.provider,
						active.model,
						active._reasoningEffortRef,
					);
				}
			}
			runState.initialSettingsApplied = true;
			const turnModelRef = active._modelRef;
			const turnEffectiveModel = active.model;
			const turnModelRefreshVersion = active._modelRefreshVersion;
			const resolved = resolveProviderAndModel(active.model, active.provider);
			active.provider = resolved.provider;
			recordNarratorRuntimeModel(
				narratorId,
				active._modelSelectionRef ?? active._modelRef ?? FOLLOW_DEFAULT_MODEL,
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

			// What this request must carry before its history is built: a new epoch at a
			// boundary, or notices for tool changes that bypassed `/load` (§7.7). Reuse the
			// exact epoch and candidates for projection instead of querying/scanning again.
			const toolLoading = toolLoadingInput();
			const reconciled = await reconcileEpoch({
				narratorId,
				messages: rawMessages,
				...toolLoading,
				model: resolved.model,
				provider: resolved.provider,
				noticeText: (kind, toolName) =>
					kind === "tool_loaded"
						? getToolMessageWithParams("toolLoaded", locale, {
								toolName,
								toolDescription: optionalToolDescription(toolName, locale),
							})
						: getToolMessageWithParams("toolUnloaded", locale, { toolName }),
			});
			if (reconciled.opened) active._resetUpstreamSessionOnNextRequest = true;
			if (reconciled.changed)
				rawMessages = await narratorService.getModelHistorySinceLastCompact(narratorId, undefined, {
					signal: active.abortController.signal,
					deadline: historyDeadline,
				});
			const historyOptions = {
				narratorId,
				model: resolved.model,
				provider: resolved.provider,
				currentInput: runState.input.text,
				attachmentCwd: active.cwd,
				attachmentSignal: active.abortController.signal,
				deadline: historyDeadline,
				toolLoading: { ...toolLoading, epoch: reconciled.epoch },
			};
			let preparedHistory = await buildRuntimeHistory({
				...historyOptions,
				sourceMessages: rawMessages,
			});

			// Passive knowledge injection (point A): when this turn carries real user text,
			// surface relevant knowledge-base entries the triggering user may read.
			// ACL is resolved by the loop-triggering user (active._currentUserId), not the narrator.
			// The hit is persisted as a sys row and the history rebuilt to carry it, so this
			// request and every later rebuild send the same bytes.
			const knowledgeQuery = preparedHistory.currentInputText;
			let knowledgePersisted = false;
			if (knowledgeQuery.trim()) {
				try {
					const hits = await knowledgeInjection.resolveInjections(actingUserId, knowledgeQuery, {
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
							for (const h of hits) knowledgeInjectedIds.add(injectionKey(h));
							knowledgePersisted = true;
						}
					}
				} catch (err) {
					logger.warn("Knowledge injection (user message) failed", {
						narratorId,
						error: String(err),
					});
				}
			}
			if (knowledgePersisted) {
				preparedHistory = await buildRuntimeHistory({
					...historyOptions,
					sourceMessages: await narratorService.getModelHistorySinceLastCompact(
						narratorId,
						undefined,
						{ signal: active.abortController.signal, deadline: historyDeadline },
					),
				});
			}

			const receipts = questionModelReceipts(preparedHistory.modelMessages);
			active._questionAnswerModelReceipts = new Map(receipts.map(({ id, text }) => [id, text]));
			runState.firstPass = false;

			const storeRuntimeCharacters = async (values: {
				systemChars?: number;
				toolsChars?: number;
			}) => {
				try {
					const { storeContextRuntimeCharacters } = await import("../narrator-context-composition");
					await storeContextRuntimeCharacters(narratorId, values);
				} catch (error) {
					logger.warn("Failed to store context runtime characters", {
						narratorId,
						error: String(error),
					});
				}
			};
			const {
				prompt: freshSystemPrompt,
				usedCompactSummary,
				summaryRange,
			} = await buildSystemPrompt(
				{
					systemPrompt: oauthRuntime
						? (oauthRuntime.systemPrompt ?? null)
						: runtimeBasePrompt(freshNarrator, locale, runtimePolicy),
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
			active.systemPrompt = freshSystemPrompt;
			const { buildPendingQuestionHint } = await import("../narrator-question-service");
			const pendingQuestionHint = await buildPendingQuestionHint(narratorId);
			if (pendingQuestionHint)
				active.systemPrompt = `${active.systemPrompt ?? ""}\n\n${pendingQuestionHint}`;
			const initialSystemChars = countRuntimeSystemCharacters(
				active.systemPrompt,
				freshNarrator.contextSummary,
				summaryRange,
			);
			// Already-held prompt/summary memory, never a cache count or a GET body read.
			let runtimeSummaryChars = (active.systemPrompt?.length ?? 0) - initialSystemChars;
			await storeRuntimeCharacters({ systemChars: initialSystemChars });
			active._usedCompactSummary = usedCompactSummary;

			const eventContext: EventHandlerContext = createRuntimeEventContext({
				getFileReferenceContext: () => getAgentFileReferenceContext(config),
				narratorId,
				broadcastTargetId: placement?.parentNarratorId ?? narratorId,
				userId: active._currentUserId ?? null,
				sseEmitter: active.events,
				conversationId: active.conversationId,
				locale: active.locale,
				providerPrefix: resolved.provider,
				provider: resolved.provider,
				model: resolved.model,
				// Subagent dual-broadcast fields — when set, dualBroadcast sends
				// events to both the parent narrator and the subagent's own page.
				parentToolUseId: placement?.parentToolUseId,
				subagentModel: placement ? resolved.model : undefined,
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
				accountRequestTokenUsage: (usage) => {
					if (activeNarrators.get(narratorId) === active) {
						accountRequestTokenUsage(active, usage);
					}
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
				getModel: () => resolveProviderAndModel(active.model, active.provider).model,
				getProvider: () => resolveProviderAndModel(active.model, active.provider).provider,
				getAttachmentCwd: () => active.cwd,
				getToolLoading: toolLoadingInput,
				refreshToolLoading: refreshMcpToolLoading,
				attachmentSignal: active.abortController.signal,
				onCompactDone: () => {
					compactDoneFlag = true;
				},
				isCompactDone: () => compactDoneFlag,
				clearCompactDone: () => {
					compactDoneFlag = false;
				},
				rebuildSystemPrompt: async () => {
					const freshNarrator = await narratorService.getById(narratorId);
					const freshOAuthRuntime = await assertOAuthNarratorRuntimeActive(
						narratorId,
						active._currentUserId,
					);
					const { prompt, summaryRange } = await buildSystemPrompt(
						{
							systemPrompt: freshOAuthRuntime
								? (freshOAuthRuntime.systemPrompt ?? null)
								: runtimeBasePrompt(freshNarrator, locale, runtimePolicy),
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
					const hint = await buildPendingQuestionHint(narratorId);
					const finalPrompt = hint ? `${prompt}\n\n${hint}` : prompt;
					const systemChars = countRuntimeSystemCharacters(
						finalPrompt,
						freshNarrator.contextSummary,
						summaryRange,
					);
					runtimeSummaryChars = (finalPrompt?.length ?? 0) - systemChars;
					await storeRuntimeCharacters({ systemChars });
					// NOTE: Do NOT set active.systemPrompt here — the returned value
					// flows through onBeforeTurn → loop.ts which updates config.systemPrompt.
					// Setting active.systemPrompt would create a second source of truth.
					return finalPrompt;
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
					if (planState.planReflectionDisabled) {
						broadcastToNarrator(narratorId, {
							type: "reflection_overrides_changed",
							narratorId,
							planReflectionAutoApproveOverride: "off",
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
					let approval: "compact" | "continue" | undefined;
					let planText: string | null | undefined;
					if (pendingPlanCompact.has(narratorId)) {
						pendingPlanCompact.delete(narratorId);
						planText = await narratorService.getToolCallPlanText(toolUseId);
						if (planText) approval = "compact";
					} else {
						// Non-compact: abort the current agent loop and persist a user
						// message so the next iteration starts with an explicit
						// "plan approved, begin execution" prompt — this prevents the
						// model from ignoring the tool result and asking the user again.
						approval = "continue";
					}
					if (!approval) return;
					// ExitPlanMode runs as soon as its input is complete, so the approval can
					// land while the same response is still streaming; the restart then waits
					// for that response to be finalized (see plan-approval-restart.ts).
					await applyPlanApproval(active, approval, {
						compact:
							approval === "compact" && planText
								? async () => {
										await runPlanCompact(narratorId, planText);
										resetActiveUpstreamSession(narratorId);
										broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
									}
								: undefined,
						abort: () => active.abortController.abort(),
					});
				},
				onAssistantMessageFinalized: () => runDeferredPlanApproval(active),
				onClearCompactSummary: async () => {
					if (!active._usedCompactSummary) return;
					await db
						.update(narrators)
						.set({
							contextSummary: null,
							contextSummaryChars: 0,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(narrators.id, narratorId));
					queueContextCharacterRefresh(narratorId);
					active._usedCompactSummary = false;
				},
				onToolResult: (event) => {
					void outlineLeases?.touch();
					if (!event.isError || event.toolName !== SHELL_TOOL_NAME) return;
					const recovery = getMissingWorkingDirectoryRecovery(event.metadata);
					if (!recovery) return;
					missingWorkingDirectoryRecovery = {
						output: event.output,
						missingCwd: recovery.missingCwd,
						suggestedCwd: recovery.suggestedCwd,
					};
				},
				// gitTrackPathForSession decides per tool call, not per session: a
				// mid-session cwd switch re-evaluates _isInGitRepo. Without this hook a
				// standalone narrator's git bar never moved until a foreground refetch.
				onGitTrack: (toolName, toolUseId, input) => {
					if (!FILE_MUTATING_TOOLS.has(toolName)) return;
					const worktreePath = gitTrackPathForSession(active);
					if (!worktreePath) return;
					// Mark the directory dirty at the tool boundary, not in the narrator's
					// trailing timer. The directory pool owns throttled live refreshes;
					// this timer only pushes the session's status line.
					invalidateStatus(worktreePath);
					const scheduleRefresh = (delayMs: number) => {
						// Collapse rapid successive calls into one trailing query. Git commands
						// use delay 0 so branch/commit-only changes are visible immediately.
						if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
						active._gitTrackTimer = setTimeout(() => {
							active._gitTrackTimer = undefined;
							// Reuse the directory pool's result (or another narrator's query).
							// A late timer must not invalidate the same completed write again.
							getStatusSummaryCached(worktreePath).then(
								(gitStatus) => {
									// Strip files array from WS broadcast to avoid
									// sending huge payloads when many files are changed.
									// The Git panel fetches the full list via API.
									const { files: _files, ...statusWithoutFiles } = gitStatus;
									broadcastToNarrator(narratorId, {
										type: "git_status",
										narratorId,
										toolUseId,
										status: statusWithoutFiles as typeof gitStatus,
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
						typeof input?.workdir === "string" ? resolve(active.cwd, input.workdir) : active.cwd;
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
				},

				onContextUsage: ctxMgmt.onContextUsage,
				onErrorCleanup: async (message, diagnostics) => {
					// A plan approval still waiting for its response to finish never restarted
					// the pass: this ending is an ordinary interruption or failure, and the
					// partial response must be kept, not cleaned up as an approval abort.
					dropDeferredPlanApproval(active);
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
					await updateTerminalStatus({
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

			const resolvedReasoningEffort = active.reasoningEffort ?? undefined;

			// Resolved per turn, not frozen at creation: an "inherit" override follows
			// the acting user's fastModeDefault preference, so flipping that default
			// takes effect on existing narrators from their next turn onward.
			const resolvedFastMode = await resolveFastModeForUser(
				freshNarrator.fastModeOverride,
				actingUserId,
			);

			// Restrictions come from the same strict per-pass resolution as the ceiling.
			const turnTraits = passCapabilities.traits;
			turnSessionDevices = resolveInjectedDevices(turnSessionDevices, turnTraits.deviceInjection);
			runState.stopHooks = runtimePolicy.capabilities.stopHooks;
			active._disabledTools = getDisabledToolSet(turnTraits.traits);
			const turnBlocked = getBlockedSkills(turnTraits.traits);
			active._blockedSkills = { all: turnBlocked.all, names: turnBlocked.names };
			const resolvedServiceTier =
				resolvedFastMode && usesCodexModel(resolved.provider, resolved.model)
					? "priority"
					: undefined;

			const resetUpstreamSessionForThisLoop = active._resetUpstreamSessionOnNextRequest === true;
			active._resetUpstreamSessionOnNextRequest = false;
			await ensureSkillCacheFreshForActiveNarrator(active);
			const availableDevices = turnSessionDevices;

			let toolCallLimitExceeded = false;
			const passWorkspaceContext = active._workspaceContext;
			let lastModelInputWasMailbox = false;
			let adoptedInput: { history: unknown[]; content: string } | undefined;
			let afterToolsInput: { history: unknown[]; content: string; mailbox: boolean } | undefined;
			const config: import("../../lib/agent").AgentConfig = {
				// Freeze this logical run's segment across every retry/compact pass.
				executionSegmentId: run?.executionSegmentId,
				runtimePolicy,
				bot: isBotNarrator(freshNarrator.traits),
				narratorId,
				conversationId: active.conversationId,
				model: resolved.model,
				provider: resolved.provider,
				cwd: active.cwd,
				workspaceContext: passWorkspaceContext,
				assertWorkspaceCurrent: passWorkspaceContext
					? () => {
							if (
								active._workspaceInstallFailed ||
								active._workspacePassInvalidated ||
								active._workspaceContext?.revision !== passWorkspaceContext.revision ||
								active._workspaceContext?.contextKey !== passWorkspaceContext.contextKey
							)
								throw new Error("Workspace changed; this old pass cannot start more tools");
						}
					: undefined,
				switchWorkingDirectory:
					runtimePolicy.capabilities.switchWorkingDirectory && !oauthRuntime
						? async (request) => {
								const { workspaceContextService } = await import("../workspace-context-service");
								return workspaceContextService.switch(narratorId, request, {
									origin: "agent",
									active,
									userId: active._currentUserId,
								});
							}
						: undefined,
				systemPrompt: active.systemPrompt ?? undefined,
				onToolsCharacters: (toolsChars) => storeRuntimeCharacters({ toolsChars }),
				freezeContextComposition: (counts, requestId, startedAt, signal) =>
					freezeNarratorContextComposition(
						narratorId,
						counts,
						requestId,
						startedAt,
						runtimeSummaryChars,
						signal,
					),
				locale,
				signal: active.abortController.signal,
				guidanceSignal: active._guidanceAbortController.signal,
				urgentGuidanceSignal: active._urgentGuidanceAbortController.signal,
				parentNarratorId: placement?.parentNarratorId,
				parentToolUseId: placement?.parentToolUseId,
				reviewReadOnlyBash: runtimePolicy.readOnlyGitShell,
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
				skillScopeKey: active._skillScopeKey ?? undefined,
				userId: active._currentUserId ?? null,
				projectId: oauthRuntime?.projectId ?? active._projectId ?? null,
				// A pass owns its device identity; selection changes only affect the next pass.
				defaultDeviceId: active._defaultDeviceId ?? null,
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
				maxToolCallsPerResponse: settings.agent.maxToolCallsPerResponse,
				onToolCallLimitExceeded: () => {
					toolCallLimitExceeded = true;
					active.abortController.abort();
				},
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
				onToolExecutionFinalAuthorization: buildFinalToolStartAuthorization({
					narratorId,
					cwd: active.cwd,
					signal: active.abortController.signal,
					userId: active._currentUserId,
				}),
				runtimeAuthorizationGuard: oauthRuntime
					? async () => {
							await assertOAuthNarratorRuntimeActive(narratorId, active._currentUserId);
						}
					: undefined,
				blockedSkills: {
					all: active._blockedSkills.all,
					names: [...active._blockedSkills.names],
				},
				subagentModelRestrictionDescription: formatSubagentModelRestrictionDescription(
					freshNarrator.traits,
				),
				toolLoading: preparedHistory.toolLoading,
				toolCandidates: preparedHistory.toolCandidates,
				isToolLoaded: (name) => active._enabledOptionalTools.has(name),
				toolFilter: (tool) => {
					if (!profileToolFilter(tool)) return false;
					if (oauthRuntime && !oauthRuntime.allowedTools.has(tool.name)) return false;
					if (active._disabledTools.has(tool.name)) return false;
					// When all skills are blocked, hide the Skill tool entirely.
					if (tool.name === "Skill" && active._blockedSkills.all) return false;
					// Newly connected MCP tools wait for the next managed snapshot; auto must never leak.
					if (tool.name.startsWith("mcp__")) {
						const server = settings.mcpServers?.find(
							(item) => item.id === tool.metadata?.mcpServerId,
						);
						return (
							!!server &&
							resolveMcpLoadingMode(server) !== "disabled" &&
							(runtimePolicy.tools.builtin !== "all" || managedOptionalTools.has(tool.name)) &&
							isMcpToolAllowedForNarrator(tool)
						);
					}
					// An explicit ceiling allowlist is authoritative; session-level optional
					// tool loading only narrows a session whose ceiling admits every tool.
					if (runtimePolicy.tools.builtin !== "all") return true;
					// Whether a loadable tool enters the request's array is decided by the
					// loop from the history's loading state (`toolLoading` above).
					if (OPTIONAL_TOOLS.has(tool.name)) {
						return managedOptionalTools.has(tool.name);
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
						// A pending approval is current activity: urgent input cancels it too.
						options?.signal ??
							AbortSignal.any([active.abortController.signal, passUrgentGuidance.signal]),
						toolName,
						input,
						toolUseId,
						active.cwd,
						locale,
						placement?.parentNarratorId,
						options,
						placement?.parentToolUseId,
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
				rebuildRequestHistory: ctxMgmt.rebuildRequestHistory,
				historyEndsWithToolResults: preparedHistory.endsWithToolResults,
				getContextUsagePercentage: () => active._contextUsagePct,
				onReasoningOnlyHighContext: ctxMgmt.onReasoningOnlyHighContext,
				shouldIdleOnReasoningOnly: async () => {
					// Waiting on a mailbox reply or on its own background work, for any session.
					if (lastModelInputWasMailbox) return true;
					const { activeWorkCount } =
						await backgroundTaskService.countActiveKindsByParent(narratorId);
					return activeWorkCount > 0;
				},
				initialCompletedToolCount: active._todoReminderCompletedToolCount ?? 0,
				onCompletedToolCount: (count: number) => {
					active._todoReminderCompletedToolCount = count;
					// The behavior-fence edit window only covers the first tool call of a user
					// turn. Once any tool completes (counter advances past its initial value),
					// close the window so later tool calls in the same turn cannot write the fence.
					clearBehaviorFenceEditGrant(narratorId);
				},
				getQuestionModelReceipts: () =>
					Array.from(active._questionAnswerModelReceipts ?? [], ([id, text]) => ({ id, text })),
				onModelInputConsumed: (history, content, answerEventIds) => {
					adoptedInput = { history, content };
					lastModelInputWasMailbox =
						afterToolsInput?.history === history && afterToolsInput.content === content
							? afterToolsInput.mailbox
							: isLastModelInputMailbox(history, content);
					consumeAgentMessageHistory(history);
					// DB presence and Await completion are only candidates. The loop
					// confirms the IDs actually supplied after projection/compaction.
					active._questionAnswerAdoptedMessageIds = new Set(answerEventIds);
					consumeQuestionAnswerModelReceipts(narratorId, active._questionAnswerAdoptedMessageIds);
					for (const id of answerEventIds ?? [])
						active._questionAnswerFallbackMessageIds?.delete(id);
				},
				getAfterToolsInjections: async () => {
					const input = await drainInjectionsIntoHistory(active, locale, placement);
					return {
						...input,
						onConsumed: () => {
							input.onConsumed();
							if (input.parts.length > 0) {
								lastModelInputWasMailbox = input.lastInputWasMailbox;
								// onConsumed runs only once, whereas the exact same request can
								// be adopted again after a transient retry. Retain its provenance.
								afterToolsInput = adoptedInput
									? { ...adoptedInput, mailbox: input.lastInputWasMailbox }
									: undefined;
							}
						},
					};
				},
				deliverInjectionRow: async (injection) => {
					const { messageId, turnText } = await deliverInjection(narratorId, {
						subagent: placement,
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
					return { text: turnText ?? "", messageId: messageId ?? undefined };
				},
				getRuntimeSettingsOverride: async () => {
					await settleNarratorRuntimeModel(active);
					// active.model/reasoningEffort are updated in real time by narrator routes.
					// For raw refs that follow settings (__default__ / __agg__), also re-resolve
					// when global settings change so the next API request picks up default-model
					// or aggregation membership/routing updates, including retry attempts.
					const revision = getSettingsRevision();
					if (
						active._modelSelectionRef !== FOLLOW_PARENT_MODEL &&
						active._settingsRevision !== revision
					) {
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
							project_id: active._projectId,
							cwd: active.cwd,
							...payload,
						},
						active._projectId,
						typeof payload.tool_name === "string" ? payload.tool_name : undefined,
					);
				},
				// Host stops skip every call that has not started yet.
				shouldStop: () => {
					if (active._workspacePassInvalidated || active._workspaceInstallFailed) return true;
					// An approved plan ends this pass; nothing after ExitPlanMode may start.
					return !!active._planApprovedContinue;
				},
				// Queued user input never skips a call: the step's tools all run first.
				shouldYieldToInput: () => {
					// Cancellation is irreversible even when the queued guidance has since
					// been removed/downgraded. Record the actual pass interruption using
					// its captured signals, independently of whether input remains. This
					// keeps ordinary next steps behind recovery of the unfinished work.
					if (config.guidanceSignal?.aborted || config.urgentGuidanceSignal?.aborted) {
						active._bufferSoftStopTaken = true;
					}
					const decision = evaluateSoftStopRequest({
						feedbackSoftStop: active._feedbackSoftStop,
						bufferSoftStop: active._bufferSoftStop,
						hasPendingBufferedWork: hasPendingBufferedGuidance(narratorId),
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

			// Convert images to base64 for the agent loop (first iteration only). A persisted
			// input already carries its images in the projected history.
			let loopImages: Array<{ format: string; base64: string; position?: number }> | undefined;
			if (preparedHistory.currentInputPersisted) runState.input.images = undefined;
			if (runState.input.images?.length) {
				const resolved: Array<{ format: string; base64: string; position: number }> = [];
				for (const [position, img] of runState.input.images.entries()) {
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
							// A skipped image must not shift later ones onto the wrong `[image #N]`.
							resolved.push({
								format: mimeToFormat[effectiveMime] ?? "png",
								base64: result.base64,
								position,
							});
						} catch {
							// Image file may have been deleted — skip silently
						}
					}
				}
				if (resolved.length > 0) loopImages = resolved;
				runState.input.images = undefined; // only attach images on the first iteration
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
			): Promise<boolean | "interrupted"> => {
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
					quotaProvider: mu.quotaProvider,
					quotaBucket: mu.quotaBucket,
					resumeAt: quotaResumeAt,
				});
				if (placement)
					broadcastToNarrator(placement.parentNarratorId, {
						type: "subagent_model_unavailable_waiting",
						narratorId: placement.parentNarratorId,
						subagentNarratorId: narratorId,
						message: mu.message,
						model: mu.model,
						nugModelId: mu.nugModelId,
						diagnostics: mu.diagnostics,
						waitKind: mu.waitKind,
						quotaProvider: mu.quotaProvider,
						quotaBucket: mu.quotaBucket,
						resumeAt: quotaResumeAt,
					});

				const outcome = await waitForModelAvailabilityOrChange({
					target: active,
					isCurrent: () => active.alive && owner.isCurrent(),
					hasModelChanged: () =>
						active._modelRefreshVersion !== turnModelRefreshVersion ||
						active._modelRef !== turnModelRef ||
						active.model !== turnEffectiveModel ||
						(active._modelSelectionRef === FOLLOW_PARENT_MODEL &&
							active._settingsRevision !== getSettingsRevision()) ||
						(turnModelRef === FOLLOW_DEFAULT_MODEL &&
							resolveEffectiveModel(turnModelRef, active.provider) !== turnEffectiveModel),
					subscribe: subscribeSettingsChanges,
					wait: (signal) =>
						quotaResumeAt
							? waitForQuotaReset(quotaResumeAt, signal)
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
					// A stopped turn of a taken-over subagent goes back to its control
					// transition (re-suspend in taken_over) instead of ending the run.
					if (run && !run.cancel.signal.aborted && getRunHold(narratorId)) return "interrupted";
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
					quotaProvider: mu.quotaProvider,
				});
				if (placement)
					broadcastToNarrator(placement.parentNarratorId, {
						type: "subagent_model_unavailable_recovered",
						narratorId: placement.parentNarratorId,
						subagentNarratorId: narratorId,
						model: mu.model,
						nugModelId: mu.nugModelId,
						waitKind: mu.waitKind,
						quotaProvider: mu.quotaProvider,
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
					if (resumed === "interrupted") {
						const next = await applyInterruptedTurnControl(abortedPass());
						if (next === "continue") continue;
						if (next === "break") break;
						await finalizeInterruptedRun(active, narratorId, undefined);
						runState.wasInterrupted = true;
						break;
					}
					if (!resumed) break;
					// Re-resolve from the loop top: the user may have switched models
					// while this turn was suspended.
					runState.recovery.transientRetries = 0;
					continue;
				}
			}

			active._tokenUsageBaseline = active._requestTokenTotal ?? 0;
			active._interruptCleanupDone = false;
			let result: ExecuteLoopResult;
			try {
				result = await executeAgentLoop({
					config,
					// Only input no persisted row carries; the projected history holds the rest.
					userText: preparedHistory.currentText,
					history: { rows: preparedHistory.modelMessages, built: preparedHistory.history },
					startedWithToolResults: preparedHistory.endsWithToolResults,
					images: loopImages,
					eventContext,
					hooks,
				}).finally(() => {
					// Account before workspace restarts, limits, or thrown-error exits.
					runState.totalTokens += accountTokenUsageForTurn(active);
				});
			} catch (error) {
				// A held run keeps the user's session: a failed turn reports its error and
				// parks at the hold like any other turn end, instead of ending the run.
				if (!run || !getRunHold(narratorId) || getRunHold(narratorId)?.released) throw error;
				const message = serializeCatalogErrorMessage(error);
				runState.finalText = message;
				await updateTerminalStatus({
					substatus: ["error"],
					errorMessage: message,
				});
				const next = await holdAtBoundary();
				if (next === "continue") continue;
				runState.hadError = true;
				break;
			}
			runState.lastPass = result;
			if (
				active._workspacePassInvalidated &&
				!active._workspaceInstallFailed &&
				!active.abortController.signal.aborted
			) {
				// Rebuild config, permissions, skills, prompt and file-reference lanes together.
				// The notice is a row, so the next pass and every rebuild send the same words.
				active._workspacePassInvalidated = false;
				await deliverInjection(narratorId, {
					subagent: placement,
					source: "workspace_changed",
					...sideCarBodyWithText("workspace_changed", { kind: "notice" }, locale),
					locale,
				});
				runState.input.text = "";
				runState.input.images = undefined;
				continue;
			}
			if (toolCallLimitExceeded) {
				// Stop before any retry, review/task continuation or buffered-message replay.
				// A new explicit user turn can still start normally; no persistent latch.
				runState.hadError = true;
				runState.wasInterrupted = true;
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				await finalizeInterruptedRun(active, narratorId, partialId);
				break;
			}
			runState.recovery.overflowRetries = resetContextOverflowRetriesAfterProgress(
				runState.recovery.overflowRetries,
				result.completedAssistantTurn,
			);

			// Track the latest pass's final text for the Stop hook (set on every pass,
			// so the most recent assistant text / error message wins regardless of how
			// the loop ultimately terminates).
			if (result.finalText || result.reasoningOnlyIdle) {
				runState.finalText = result.finalText;
			}

			// Track whether the latest pass ended by hitting the max-turns limit.
			// Refreshed every pass (unconditionally) so that if the loop continues
			// afterwards — e.g. goal continuation or a buffered message — and ends
			// normally, this is cleared back to false before the Stop hook fires.
			runState.hitMaxTurns = result.maxTurnsExceeded === true;

			const searchScope = getSearchExecutionScope();
			if (searchScope && (searchScope.remainingTurns <= 0 || result.maxTurnsExceeded)) {
				// No retry/spec/goal continuation can acquire a fresh budget implicitly.
				const completedNaturally =
					result.completedNaturally === true &&
					!result.hasError &&
					!result.maxTurnsExceeded &&
					!result.aborted &&
					!result.interrupted &&
					!result.contextLengthExceeded &&
					!result.silentDisconnect &&
					!result.paymentRequired &&
					!result.modelUnavailable &&
					!result.retryableError;
				if (!completedNaturally) {
					// Recovery signals often leave hasError=false and finalText contains
					// partial assistant output, not the upstream failure. Keep their specific
					// error instead of masking it with the exhausted-budget fallback.
					const message =
						result.paymentRequired?.message ||
						result.modelUnavailable?.message ||
						result.retryableError ||
						(result.hasError && !result.maxTurnsExceeded ? result.finalText : "") ||
						(result.silentDisconnect ? "Codex WebSocket silent disconnect" : "") ||
						(result.contextLengthExceeded ? "Error: context length exceeded" : "") ||
						(result.aborted ? "Aborted" : "") ||
						new SearchExecutionBudgetExceededError().message;
					const errorCode = result.paymentRequired
						? "payment_required"
						: (result.retryableErrorCode ?? result.errorCode);
					const diagnostics =
						result.modelUnavailable?.diagnostics ??
						result.retryableDiagnostics ??
						result.errorDiagnostics;
					runState.hadError = true;
					runState.finalText = message;
					await updateTerminalStatus({
						substatus: ["error"],
						errorMessage: message,
						errorCode,
						diagnostics,
					});
					active.events.emit("event", {
						type: "error",
						data: { message, errorCode, diagnostics },
					});
				}
				break;
			}

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

			// `isForegroundTurnInterrupted`, not `turnAbort.signal.aborted` alone: a direct
			// abort of the session controller on a taken-over subagent (Stop route, plugin
			// API) never touches turnAbort, and falling through to the generic abort exit
			// below would end the takeover and settle the parent's blocked tool call.
			{
				const next = await applyInterruptedTurnControl(result);
				if (next === "continue") continue;
				if (next === "break") break;
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
				terminalStatus = {
					substatus: ["payment_required"],
					errorCode: "payment_required",
					errorMessage: JSON.stringify({ type: "payment_required", ...result.paymentRequired }),
				};
				await narratorService.updateStatus(narratorId, restingStatus(), terminalStatus);
				active.events.emit("event", {
					type: "payment_required",
					data: result.paymentRequired,
				});
				if (placement) {
					const payment = result.paymentRequired;
					for (const recipient of [narratorId, placement.parentNarratorId]) {
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
				 * Three causes, one exit. `reset-beyond-budget` and `reset-unknown` are the
				 * loop's verdict (the reset is further out than the wait budget allows, or
				 * nothing upstream said when it is). `wait-budget-spent` is this run's (every
				 * suspension costs a full history re-upload, so a reset that keeps resolving
				 * to "soon" must not become a replay loop).
				 *
				 * All produce the same user-facing outcome, so they share a branch and differ
				 * only by the reason code — a divergence here would mean one of them silently
				 * loses the reset instant that makes the error actionable.
				 */
				const quotaRefusalReason = !isQuota
					? undefined
					: quotaResumeAt === undefined
						? quotaResetAt === undefined
							? "reset-unknown"
							: "reset-beyond-budget"
						: runState.recovery.quotaWaits >= MAX_QUOTA_WAITS_PER_RUN
							? "wait-budget-spent"
							: undefined;
				if (quotaRefusalReason) {
					// Serialized as a payload rather than left as the raw upstream text, on
					// the `payment_required` pattern: `errorMessage` is the only failure
					// carrier that survives to the next page load, so the reset instant has
					// to ride in it for the panel to explain the wall in the user's language
					// after a refresh. `reason` lets the non-waiting causes stay
					// distinguishable in logs without changing what the user is told.
					// `type` names the plan (KIMI_QUOTA_EXHAUSTED / OPENCODE_QUOTA_EXHAUSTED)
					// so the message says whose allowance is spent.
					const quotaCode = quotaExhaustedCode(mu.quotaProvider);
					terminalStatus = {
						substatus: ["error"],
						errorCode: quotaCode,
						errorMessage: JSON.stringify({
							type: quotaCode,
							reason: quotaRefusalReason,
							model: mu.model,
							provider: mu.provider,
							providerPrefix: mu.providerPrefix,
							quotaBucket: mu.quotaBucket,
							quotaResetAt,
						}),
					};
					await updateTerminalStatus({
						...terminalStatus,
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
					logger.warn("Quota wall reported instead of waited on", {
						narratorId,
						quotaProvider: mu.quotaProvider ?? "kimi",
						providerId: mu.providerId,
						model: mu.model,
						reason: quotaRefusalReason,
						quotaBucket: mu.quotaBucket,
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
				if (resumed === "interrupted") {
					const next = await applyInterruptedTurnControl(abortedPass(result));
					if (next === "continue") continue;
					if (next === "break") break;
					await finalizeInterruptedRun(active, narratorId, undefined);
					runState.wasInterrupted = true;
					break;
				}
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
				await updateTerminalStatus({
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
					// Stopped during the retry backoff: a taken-over subagent re-suspends.
					const next = await applyInterruptedTurnControl(abortedPass(result));
					if (next === "continue") continue;
					if (next === "break") break;
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
				await updateTerminalStatus({
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
				await updateTerminalStatus({
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
				// A held run parks after a failed turn too; the user decides what next.
				if (run && getRunHold(narratorId) && !getRunHold(narratorId)?.released) {
					const next = await holdAtBoundary();
					if (next === "continue") continue;
				}
				runState.hadError = true;
				break;
			}

			// A successful pass right after transient retries: tell the parent panel
			// the subagent has recovered, so its stale "retry N/M" badge clears now
			// instead of lingering for the whole remaining run (the parent only
			// clears `_retryInfo` on `subagent_status_changed` /
			// `subagent_conclusion_updated`, and an already-working subagent emits
			// neither mid-run). Returns null when no retry preceded this pass.
			if (placement) {
				const retryRecovered = subagentRetryRecoveredBroadcast(
					runState.recovery.transientRetries,
					placement.parentNarratorId,
					narratorId,
				);
				if (retryRecovered) {
					broadcastToNarrator(placement.parentNarratorId, retryRecovered);
				}
			}
			// Reset transient retry counter on success or after a non-retried silent disconnect.
			runState.recovery.transientRetries = 0;
			// The quota budget bounds CONSECUTIVE suspensions: a pass that got through
			// proves the last wait actually recovered, so a long autonomous run may wait
			// out a later window too instead of failing on its fourth wall in a day.
			// Walls that keep refusing without any progress still hit the cap.
			runState.recovery.quotaWaits = 0;

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
					// Completion-limit exhaustion still falls through with its real partial
					// output. A resumable upstream failure must instead retain the last failed
					// attempt's diagnostics in a durable error card when continuation is spent.
					logger.warn(`${continuationLogLabel}: max retries reached, stopping`, {
						narratorId,
						retries: interruptionPlan.retries,
					});
					if (interruptionPlan.reason === "resumable_error" && result.interruptionError) {
						await updateTerminalStatus({
							substatus: ["error"],
							errorMessage: result.interruptionError,
							diagnostics: result.interruptionDiagnostics,
						});
						active.events.emit("event", {
							type: "error",
							data: {
								message: result.interruptionError,
								diagnostics: result.interruptionDiagnostics,
							},
						});
						runState.finalText = result.interruptionError;
						runState.hadError = true;
						break;
					}
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
				// The stop may have landed during the awaits since the pass returned.
				const next = await applyInterruptedTurnControl(abortedPass(result));
				if (next === "continue") continue;
				if (next === "break") break;
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
				// The approver's attached text is human input, like an adopted queue item.
				await adoptHumanPrincipal(fb.userId);
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
			const bgCompletionPrompt = await drainAndPersistPendingInjections(active, placement);
			if (bgCompletionPrompt) {
				await narratorService.updateStatus(narratorId, "working");
				runState.input.text = "";
				runState.input.images = undefined;
				// This drain starts a fresh pass before the buffer consumer below is
				// reached, which would strand a cut-in message for the rest of the loop.
				rearmCutInSoftStopBeforeContinuing(active);
				continue;
			}

			// Queued input BEFORE transitioning to idle/unread — this prevents spurious
			// notifications when there are queued messages. When the loop had an error,
			// skip consumption so queued messages are preserved for retry or dismissal.
			// [continuation-source: buffered-message]
			if (!runState.hadError) {
				const next = await consumeNextInput();
				if (next === "continue") continue;
				if (next === "break") break;
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
				shouldResumeAfterCompact(
					{ ...result, hasError: runState.hadError },
					compactDoneFlag || hasPendingHistoryCompact(narratorId),
					active.abortController.signal.aborted,
				)
			) {
				runState.input.text = "";
				runState.input.images = undefined;
				continue;
			}

			// [continuation-source: run-hold]
			// The user holds this run's result — whatever the turn's outcome: park at the
			// turn end instead of delivering, and resume the same run for the user's (or a
			// Send's) next input.
			if (run && getRunHold(narratorId) && !getRunHold(narratorId)?.released) {
				const next = await holdAtBoundary();
				if (next === "continue") continue;
				active.events.emit("event", { type: "done", data: null });
				break;
			}

			// No buffered messages — now transition to idle/unread (triggers notifications)
			if (!runState.hadError) {
				// Drain any queued injection FIRST, before flipping the DB status to idle.
				// This closes the window where status is already idle (visible to clients /
				// route admission) while this loop is still running and about to pick up more
				// work. If anything is queued, keep the status working and continue this loop
				// instead of going idle at all.
				// [continuation-source: pre-idle-injection-drain]
				const bgCompletionAfterIdle = await drainAndPersistPendingInjections(active, placement);
				if (bgCompletionAfterIdle) {
					await narratorService.updateStatus(narratorId, "working");
					runState.input.text = "";
					runState.input.images = undefined;
					continue;
				}

				// Drain awaited above: synchronously arbitrate takeover vs terminal now.
				// A successful hold must park; once finalizing is claimed new holds fail.
				if (run) {
					if (getRunHold(narratorId) && !getRunHold(narratorId)?.released) {
						if ((await holdAtBoundary()) === "continue") continue;
					} else run.finalizing = true;
				} else {
					await narratorService.compareAndSetStatus(
						narratorId,
						["working", "waiting"],
						restingStatus(),
						{ substatus: ["unread"] },
					);
				}
				// The run finalizer commits its terminal before the public idle write.
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
					updateTerminalStatus({
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
		// The run ended: the session's claims go on the idle lease while it waits for its next
		// turn, a subagent's pass to its root (not waited for).
		void outlineLeases?.stop();
		if (run && !freshInput && (!getRunHold(narratorId) || getRunHold(narratorId)?.released))
			run.finalizing = true;
		unregisterUpdateLoop();
		// The one session finalizer; result delivery belongs to the run service.
		if (owner.isCurrent()) {
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
			// Fire once per completed response turn when the capability ceiling allows
			// hooks. Covers every termination path: normal done, error, and user
			// interrupt. Hook failures never affect narrator state, but their actual
			// execution must settle before file-revert admission can be granted.
			if (runState.stopHooks) {
				await (async () => {
					try {
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
						updateNarratorModel(narratorId, restoreModel);
						// The primary active is already marked dead above, so the live
						// updater only propagates to followers; still publish this DB restore.
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
			retireSubagentOutputCharCount(narratorId);
			// Finalization cancels leftover resources, not the completed user turn.
			// Preserve real cancellation before the internal cleanup abort changes the signal.
			abortedBeforeCleanup = active.abortController.signal.aborted;
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

	const aborted =
		runState.wasInterrupted || (abortedBeforeCleanup ?? active.abortController.signal.aborted);
	endTurn(narratorId, turnId, {
		status: aborted ? "interrupted" : runState.hadError ? "failed" : "completed",
		stopReason: aborted
			? "user_interrupt"
			: runState.hadError
				? "error"
				: runState.hitMaxTurns
					? "max_turns"
					: "end_turn",
	});
	let finalText = runState.finalText;
	if (runState.lastPass?.paymentRequired)
		finalText = `Payment required: ${runState.lastPass.paymentRequired.message}`;
	// A run that delivers to a tool call always delivers its best available text.
	if (
		placement &&
		!runState.lastPass?.reasoningOnlyIdle &&
		!finalText.trim() &&
		!runState.hadError &&
		!aborted
	) {
		const latest = await narratorService.getLatestAssistantTextAndId(narratorId).catch(() => null);
		if (latest?.text.trim()) finalText = latest.text;
		else
			finalText =
				(await narratorService.getLatestSuccessfulCompactSummary(narratorId).catch(() => null))
					?.summary ?? "";
	}
	if (continuationStopNote && !aborted) {
		finalText = finalText.trim()
			? `${finalText.trim()}\n\n${continuationStopNote}`
			: continuationStopNote;
	}
	if (runState.hadError && !aborted)
		db.update(narrators).set({ lastStopReason: "error" }).where(eq(narrators.id, narratorId)).run();
	return {
		started: true,
		allowInboxWake: !runState.hadError && !aborted,
		freshInput,
		terminalStatus,
		finalText,
		hasError: runState.hadError,
		aborted,
		contextLengthExceeded: runState.hadError && runState.lastPass?.contextLengthExceeded === true,
		lastPass: runState.lastPass,
	};
}
