/**
 * Pure re-export barrel for backward compatibility.
 *
 * The original monolithic narrator-subagent.ts has been split into focused modules:
 * - subagent-alias.ts       — alias registry
 * - subagent-team.ts        — team file tracking + messaging
 * - subagent-detach.ts      — detach/attach + abort controllers + ProxyAbortController
 * - subagent-manual-override.ts — manual override + conclusion watchers
 * - subagent-executor.ts    — core execution (executeSubagent, finalizeSubagent, etc.)
 * - subagent-runner.ts      — initial and resumed subagent execution primitives
 * - subagent-tools.ts       — tool filtering + system prompt building
 *
 * All external imports from "@server/services/narrator-subagent" continue to work
 * via the re-exports below.
 */

// Background completion queue.
//
// Enqueue only: completions now share the ordered `parent-injection-queue` with inbound
// subagent messages, and `narrator-session.deliverPendingInjectionsInOrder` is its single
// consumer — so there is no per-kind drain to re-export.
export { pushBgCompletionNotification } from "./bg-completion-queue";

// Alias registry
export {
	clearAliasRegistry,
	getTaskAlias,
	registerTaskAlias,
	resolveTaskAlias,
} from "./subagent-alias";
// Detach / Attach / Abort controllers
export {
	type AttachEntry,
	attachSubagent,
	consumeForegroundSubagentHardInterrupt,
	type DetachEntry,
	detachSubagent,
	getAttachWaitersMap,
	getBackgroundAbortControllers,
	getDetachableMap,
	getForegroundAbortControllers,
	interruptForegroundSubagent,
	interruptForegroundSubagentsForParent,
	ProxyAbortController,
} from "./subagent-detach";
// Executor
export {
	bufferSubagentUserMessage,
	buildSubagentEventContext,
	clearSubagentBufferedMessages,
	consumeNextBufferedSubagentMessage,
	executeSubagent,
	finalizeSubagent,
	getSubagentBufferedMessages,
	getSubagentBufferedMessagesMap,
	loadSubagentHistory,
	pushSubagentBufferedMessage,
	removeSubagentBufferedMessage,
	reorderSubagentBufferedMessages,
	requestSubagentBufferedMessageSoftStop,
	type SubagentBufferedMessage,
	type SubagentExecOptions,
	updateSubagentBufferedMessage,
} from "./subagent-executor";
// Human/model-facing labels derived from those aliases
export {
	type AgentLabelSource,
	agentLabelFromNarrator,
	clearAgentLabelMemo,
	resolveAgentLabel,
	shortAgentId,
} from "./subagent-label";

// Manual override + conclusion watchers
export {
	abandonManualOverride,
	type ConclusionWatcher,
	claimManualOverride,
	cleanupManualOverrideRuntime,
	clearManualOverrideRuntimes,
	getConclusionWatcher,
	getConclusionWatchersMap,
	getManualOverrideMap,
	getManualOverrideRuntime,
	interruptManualOverride,
	isManualOverride,
	listStaleManualOverrideRuntimes,
	type ManualOverrideClaim,
	type ManualOverrideClaimPhase,
	type ManualOverrideEntry,
	type ManualOverrideResult,
	registerConclusionWatcher,
	releaseManualOverrideClaim,
	removeConclusionWatcher,
	resolveManualOverride,
	resumeManualOverride,
	settleManualOverrideClaim,
	waitForManualOverride,
} from "./subagent-manual-override";
// Unified continuation/resume orchestration
export {
	hasActiveSubagentResumeRun,
	type ResumeSubagentInput,
	type ResumeSubagentResult,
	resolveSubagentOriginToolUseId,
	resumeSubagent,
	type SubagentResumeActor,
	type SubagentResumeIntent,
	withSubagentResumeLock,
} from "./subagent-resume";
// Runner (entry points)
export {
	BACKGROUND_TASK_TIMEOUT_MS,
	broadcastSubagentStarted,
	type ContinueSubagentInput,
	cancelBackgroundTask,
	executeBackgroundTask,
	type ForegroundRunHandle,
	type ForegroundRunPublication,
	type ForegroundRunTerminal,
	finalizeTakenOverBackgroundSubagent,
	getBackgroundTaskStatus,
	type RunSubagentInput,
	runForegroundLoop,
	runSubagent,
	type StartedSubagentContinuation,
	startContinuedSubagent,
	startForegroundRun,
	waitForBackgroundTask,
} from "./subagent-runner";

// Takeover state
export {
	beginSubagentInterruptSuspension,
	clearTakenOver,
	consumePendingBackgroundFinalize,
	consumePendingStopTakeover,
	hydrateTakeoverState,
	isBackgroundTakenOver,
	isPendingStopTakeover,
	isTakenOver,
	listTakenOverSubagents,
	markPendingBackgroundFinalize,
	markPendingStopTakeover,
	markTakenOver,
	preserveTakenOverSubstatus,
	TAKEN_OVER_SUBSTATUS,
} from "./subagent-takeover";
// Team collaboration
export {
	clearTeamFileChanges,
	clearTeamInbox,
	deliverTeamMessage,
	drainTeamInbox,
	getTeamFileChanges,
	hasTeamMessages,
	recordTeamFileChange,
	type TeamMessage,
} from "./subagent-team";

// Tool filtering + system prompt
export { buildSubagentSystemPrompt, resolveToolFilter } from "./subagent-tools";
