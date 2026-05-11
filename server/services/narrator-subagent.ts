/**
 * Pure re-export barrel for backward compatibility.
 *
 * The original monolithic narrator-subagent.ts has been split into focused modules:
 * - subagent-alias.ts       — alias registry
 * - subagent-team.ts        — team file tracking + messaging
 * - subagent-detach.ts      — detach/attach + abort controllers + ProxyAbortController
 * - subagent-manual-override.ts — manual override + conclusion watchers
 * - subagent-executor.ts    — core execution (executeSubagent, finalizeSubagent, etc.)
 * - subagent-runner.ts      — entry orchestration (runSubagent, continueSubagent, etc.)
 * - subagent-tools.ts       — tool filtering + system prompt building
 *
 * All external imports from "@server/services/narrator-subagent" continue to work
 * via the re-exports below.
 */

// Background completion queue
export { drainCompletedBackgroundSubagents } from "./bg-completion-queue";

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
	buildSubagentEventContext,
	clearSubagentBufferedMessages,
	consumeNextBufferedSubagentMessage,
	executeSubagent,
	finalizeSubagent,
	getSubagentBufferedMessages,
	getSubagentBufferedMessagesMap,
	loadSubagentHistory,
	pushSubagentBufferedMessage,
	type SubagentBufferedMessage,
	type SubagentExecOptions,
} from "./subagent-executor";

// Manual override + conclusion watchers
export {
	abandonManualOverride,
	type ConclusionWatcher,
	getConclusionWatcher,
	getConclusionWatchersMap,
	getManualOverrideMap,
	isManualOverride,
	MANUAL_OVERRIDE_TIMEOUT_MS,
	type ManualOverrideEntry,
	registerConclusionWatcher,
	removeConclusionWatcher,
	resolveManualOverride,
	waitForManualOverride,
} from "./subagent-manual-override";

// Runner (entry points)
export {
	BACKGROUND_TASK_TIMEOUT_MS,
	broadcastSubagentStarted,
	type ContinueSubagentInput,
	cancelBackgroundTask,
	continueSubagent,
	executeBackgroundTask,
	getBackgroundTaskStatus,
	type RunSubagentInput,
	runForegroundLoop,
	runSubagent,
	waitForBackgroundTask,
} from "./subagent-runner";

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
