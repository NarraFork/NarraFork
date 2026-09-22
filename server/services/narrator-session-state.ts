import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { FileReferenceSnapshot } from "@shared/file-reference";
import type { DangerInfo, PermissionResult, ReasoningEffort } from "../lib/agent";
import { AsyncMutex } from "../lib/async-mutex";
import { AppError, NotFoundError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { isSubagentVariant } from "../lib/narrator-utils";
import { normalizePathForComparison } from "../lib/platform-path";
import type { Locale } from "../lib/prompt-i18n";
import type { ImageRef } from "../lib/uploads";
import { createRuntimeMapView, executionAdmissions } from "./agent-runtime/ownership";
import type { FrozenExecutionTarget } from "./execution-policy/types";
import { getBufferedMessages } from "./narrator-buffer";
import type { TokenUsageSnapshot } from "./narrator-event-handler";

// === ActiveNarrator interface ===

/** Ephemeral plan-mode preparation keyed by the persisted tool-call row. */
export interface PreparedPlanMode {
	toolCallId: string;
	toolUseId: string;
	planFileId: string;
	planFilePath: string;
	previousPermissionMode?: string;
}

export interface ActiveNarrator {
	abortController: AbortController;
	narratorId: string;
	conversationId: string;
	cwd: string;
	/** Raw model reference stored on the narrator, e.g. __default__ or __agg__:id. */
	_modelRef?: string;
	model: string;
	provider: string;
	/** Settings revision used to derive `_modelRef` / `_reasoningEffortRef` into runtime values. */
	_settingsRevision?: number;
	/** Cancels a model-unavailable wait without aborting the narrator turn. */
	_modelUnavailableWaitCancel?: () => void;
	/** Raw narrator reasoning effort override from DB. Null/undefined means follow provider/global default. */
	_reasoningEffortRef?: ReasoningEffort | null;
	/** Runtime reasoning effort to apply before the next model request. Null/undefined means use provider default. */
	reasoningEffort?: ReasoningEffort | null;
	systemPrompt: string | null;
	events: EventEmitter;
	alive: boolean;
	locale: Locale;
	/** ISO timestamp of current turn start, copied from updateStatus(thinking, setTurnStart=true). */
	_turnStartedAt?: string;
	/** Time to first text/reasoning token in current turn. */
	_ttftMs?: number;
	_usedCompactSummary?: boolean;
	/** Current context usage percentage — used for message metadata */
	_contextUsagePct?: number;
	/** Last reported metering from the provider */
	_lastMeterUsage?: number;
	_lastMeterUnit?: string;
	/** Last reported token usage snapshot from context_usage events */
	_lastTokenUsage?: TokenUsageSnapshot;
	/** Whether to append language instruction to system prompt */
	_replyInUserLanguage?: boolean;
	/** Set when ExitPlanMode completes — the loop should restart with a user message.
	 *  "continue" = no compact; "compact" = compact was performed, needs fresh context. */
	_planApprovedContinue?: "continue" | "compact";
	/** Cached chapter ID (set when narrator is bound to an active chapter) */
	_chapterId?: string;
	/** Cached project ID (set when narrator is bound to a chapter with a project) */
	_projectId?: string;
	/** Cached chapter role (trunk/branch/exploration/review) */
	_chapterRole?: string;
	/** Narrator kind for specialized standalone types (e.g. "knowledge" steward). */
	_narratorKind?: "knowledge";
	/** Cached worktree path (set when narrator is bound to an active chapter with a worktree) */
	_worktreePath?: string;
	/** Plan file ID — set when entering plan mode, used to lock Write/Edit to .narrafork/plans/plan-{id}.md */
	_planFileId?: string;
	/** Plan file path — set when entering plan mode, passed to EnterPlanMode tool for the prompt */
	_planFilePath?: string;
	/**
	 * Live plan-mode value for the RUNNING pass, set by a manual toggle mid-pass.
	 *
	 * `undefined` means "follow the DB snapshot taken at pass start". A manual toggle
	 * writes the DB, but the pass already captured `planMode` into its AgentConfig, so
	 * without this the running turn keeps the stale value while the permission gate
	 * (which re-reads the DB per tool call) has already switched.
	 *
	 * ⚠️ Cleared at the start of every pass. The DB is the truth; this only covers the
	 * window between "DB changed" and "the next pass re-reads it". Leaving it set would
	 * make one manual toggle permanently shadow every other path that changes plan mode
	 * (the model's own EnterPlanMode/ExitPlanMode, fork, recovery).
	 */
	_planModeLive?: boolean;
	/** Live relaxed-plan value for the running pass. Same one-pass lifetime as `_planModeLive`. */
	_relaxedPlanLive?: boolean;
	/** Prepared EnterPlanMode calls that have not committed plan mode yet. */
	_preparedPlanModes?: Map<string, PreparedPlanMode>;
	/** Legacy permission mode snapshot from before entering plan mode; retained for migration/UI context. */
	_previousPermissionMode?: string;
	/** Cached base branch (for commits-ahead tracking) */
	_baseBranch?: string;
	/** Trailing-edge throttle timer for git status tracking */
	_gitTrackTimer?: ReturnType<typeof setTimeout>;
	/** ID of the partial assistant message being incrementally built via block_complete events */
	_partialMessageId?: string;
	/** Per-tool-call before git status cache: toolUseId → Promise<Set<filePath>> (Bash snapshot) */
	_bashBeforeStatus?: Map<string, Promise<Set<string>>>;
	/**
	 * Workspace tree hash captured before each in-flight file-mutating tool.
	 *
	 * Staged in memory rather than written immediately because the tool's
	 * `narrator_tool_calls` row is not guaranteed to exist when the pre-execution
	 * hook runs; both hashes are persisted together once the tool completes.
	 */
	_treeHashBefore?: Map<string, string>;
	/**
	 * Most recent workspace tree hash captured for this session.
	 *
	 * Reused as the next tool's "before" hash so a run of file-mutating tools costs
	 * one `write-tree` each instead of two. The reuse window is the gap between one
	 * tool finishing and the next starting, so an external edit landing inside that
	 * gap would be attributed to the next tool.
	 */
	_lastTreeHash?: string;
	/** Whether the narrator's cwd is inside a git repo (enables Bash file tracking) */
	_isInGitRepo?: boolean;
	/** Cached project git path (for skill loading) */
	_projectGitPath?: string | null;
	/** Resolved skill scan root (legacy projectGitPath or git root from cwd) */
	_skillRoot?: string | null;
	/** Resolved skill summary cache scope key for current project/cwd context. */
	_skillScopeKey?: string | null;
	/** Optional tools enabled for this session (tool names, e.g. "Terminal") */
	_enabledOptionalTools: Set<string>;
	/** Tools disabled by narrator custom traits. */
	_disabledTools: Set<string>;
	/** Skills blocked by narrator custom traits (`all` hides the Skill tool). */
	_blockedSkills: { all: boolean; names: Set<string> };
	/** Soft-stop flag: set when user approves a permission with feedbackText.
	 *  The agent loop checks this via shouldStop() after tools complete. */
	_feedbackSoftStop?: boolean;
	/** Soft-stop flag: set when a priority buffered message should run after current tools finish. */
	_bufferSoftStop?: boolean;
	/**
	 * Set when the current agent-loop pass actually ended early because of a buffered
	 * soft stop. If the queued input is gone by the time the pass returns (the user
	 * cancelled it in the meantime), the outer loop resumes the turn instead of
	 * settling idle mid-work.
	 */
	_bufferSoftStopTaken?: boolean;
	/** Set once interrupted cleanup has run for the current agent-loop iteration. */
	_interruptCleanupDone?: boolean;
	/** Whether the agent loop is currently running for this narrator. */
	_loopRunning?: boolean;
	/** Queued input is only restarted after the complete loop finalizer released admission. */
	_resumeBufferedAfterLoop?: boolean;
	/**
	 * The user who triggered the current loop turn (set on each runAgentLoop / message feed).
	 * Flows into ToolContext.userId for per-turn knowledge-base ACL. null when triggered by
	 * a background/system continuation (→ anonymous, public-only knowledge access).
	 */
	_currentUserId?: string | null;
	/** Immediate title derived from the first user message while model title generation runs. */
	_provisionalTitle?: string;
	/** Session default execution device id (null → local). Set via SwitchDevice. */
	_defaultDeviceId?: string | null;
	/** Active substatus tags for this narrator session (in-memory, synced to DB on change). */
	_substatus: Set<string>;
	/** One-shot reset for reusable upstream provider sessions before the next request. */
	_resetUpstreamSessionOnNextRequest?: boolean;
	/**
	 * The persisted `apiConversationId` this session started from, used as the
	 * compare-and-set baseline when teardown writes the id back.
	 *
	 * Teardown must not resurrect an id that a compact deliberately cleared: a
	 * background compact nulls the column to force a fresh upstream session, and it
	 * can settle after the turn that started it. Writing unconditionally at that
	 * point would make the next activation resume a session whose upstream state
	 * still holds the pre-compact history.
	 */
	_persistedConversationId?: string | null;
	/**
	 * Latest history compact seq that has completed while this narrator is alive,
	 * but has not yet been consumed by a rebuilt in-memory agent history.
	 */
	_pendingHistoryCompactSeq?: number;
	/** Token usage baseline at the start of the current turn (for round token totals). */
	_tokenUsageBaseline?: TokenUsageSnapshot;
	/** Guard against infinite auto-continuation when continuation turns make no effective progress. */
	_continuationSuppressed?: boolean;
	/** Whether the current pass is a normal task continuation or a blocked-task recovery turn. */
	_continuationTurn?: "task" | "blocked";
	_continuationStallCount?: number;
	/** Identity of the repeated no-progress condition (no tools or the same reflection denial). */
	_continuationStallKey?: string;
	/** Completed tool count used to keep the spec (tasks.json) reminder cadence across loop runs. */
	_todoReminderCompletedToolCount?: number;
	/** Completed tool count when the tasks.json reminder was last injected. */
	_lastTasksReminderCompletedToolCount?: number;
	/** Completed tool count when the behavior fence was last injected. */
	_lastFenceCompletedToolCount?: number;
	/** Resolved tasks.json reminder injection interval for this turn. null/undefined = follow default;
	 *  -1 = disabled; >0 = inject every N completed tool calls. */
	_tasksReminderInterval?: number;
	/** Resolved behavior-fence injection interval for this turn. null/undefined = follow default;
	 *  -1 = disabled; >0 = inject every N completed tool calls. */
	_fenceInterval?: number;
	/** Resolved whether the behavior fence rides along with the tasks.json reminder for this turn. */
	_fenceAttach?: boolean;
}

// === PendingPermission interface ===

/** Complete frozen routed target retained while permission is pending/reprocessed. */
export type PendingExecutionTarget = FrozenExecutionTarget;

/** Normalized ExitPlanMode source retained while a permission is pending/reprocessed. */
export type PendingPlanSource =
	| { kind: "inline" }
	| {
			kind: "file";
			/** Normalized path selected for the plan submission (custom or designated). */
			path: string;
			/** Canonical identity authorized during the most recent read. */
			resolvedPath: string;
			custom: boolean;
	  };

export interface PendingPermission {
	resolve: (result: PermissionResult) => void;
	cleanup: () => void;
	input: Record<string, unknown>;
	narratorId: string;
	toolName: string;
	toolUseId: string;
	broadcastTargetId: string;
	/** Parent Agent/Task/Send tool_use that owns this subagent request. */
	parentToolUseId?: string;
	cwd: string;
	locale: Locale;
	signal: AbortSignal;
	/**
	 * Complete plain-data snapshot of the routed execution identity. The backend itself is
	 * deliberately not retained; reprocessing resolves it again by device id and requires the
	 * same path flavor/runtime generation before re-authorizing any path or command.
	 */
	executionTarget?: PendingExecutionTarget;
	/** Frozen normalized source so reprocessing repeats the same inline/file flow. */
	planSource?: Readonly<PendingPlanSource>;
	planModeSoftDeny?: boolean;
	planSubmittedFromFile?: boolean;
	questionReflectionTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Absolute epoch-ms timestamp at which automatic AskUserQuestion reflection
	 * fires. Sent to the frontend so it can render a live countdown. Undefined
	 * when reflection is not scheduled or has been disarmed/taken over.
	 */
	questionReflectionDeadline?: number;
	/**
	 * AbortController for an in-flight AskUserQuestion reflection answer
	 * generation, so a user takeover can cancel the upstream request.
	 */
	questionReflectionAbort?: AbortController;
	/**
	 * Set when the user takes over an AskUserQuestion reflection (either while it
	 * is generating or after disarming the timer). Prevents the reflection path
	 * from confirming/answering behind the user's back.
	 */
	questionReflectionStoppedByUser?: boolean;
	/**
	 * Whether a user-facing `narrator:attention` (reason=waiting_permission) was
	 * emitted for this request. Mirrors the emit in handlePermission so that
	 * resolvePermission can emit the symmetric `narrator:attention_resolved` only
	 * when an attention was actually raised (never for suppressed/takeover paths).
	 */
	attentionEmitted?: boolean;
}

// === BufferCreator interface ===

export interface BufferCreator {
	id: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

// === SavedBufferedFile interface ===

/** Shape stored in DB for text files that were saved to a temp directory. */
export interface SavedBufferedFile {
	filename: string;
	path: string;
	size: number;
}

// === BufferedMessage interface ===

export interface BufferedExecutionIntent {
	modelOverride?: { model: string; mode: "temporary" | "permanent" };
	/** Built-in control command; execute only after the previous owner has finalized. */
	controlCommand?: boolean;
}

export interface BufferedMessage {
	executionIntent?: BufferedExecutionIntent;
	id: string;
	text: string;
	/** Server-accepted immutable bytes; summaries expose only reference metadata. */
	fileReferences?: FileReferenceSnapshot[];
	images?: ImageRef[];
	textFiles?: File[];
	bufferedAt: string;
	commandText?: string | null;
	/** runBashFirst command to execute before the prompt when this message is consumed. */
	bashCommand?: string | null;
	createdBy?: string | null;
	creator?: BufferCreator | null;
	/** True when this queued message was inserted with priority/cut-in-line semantics. */
	priority?: boolean;
	/** Paths of text files persisted to disk (for DB recovery). */
	_savedFiles?: SavedBufferedFile[];
	/** Mailbox-owned staging directory identity (not the mailbox row id). */
	_stagingId?: string;
	_recipientMessageId?: string;
	state?: "queued" | "failed";
	error?: string | null;
	_mailboxClaim?: import("./agent-runtime/mailbox-types").MailboxClaim;
}

// === NarratorEvent type ===

export type NarratorEvent =
	| { type: "user_message"; data: unknown }
	| { type: "assistant_message"; data: unknown }
	| { type: "stream_event"; data: unknown }
	| { type: "tool_progress"; data: unknown }
	| { type: "result"; data: unknown }
	| { type: "error"; data: { message: string } }
	| { type: "interrupted"; data: { message: string } }
	| {
			type: "context_usage";
			data: {
				percentage: number;
				promptTokens?: number;
				contextWindow?: number;
				isEstimated?: boolean;
			};
	  }
	| { type: "done"; data: null };

// === Module-level state (hotSafe) ===

/** Session settings/cache view, not an independent execution authority. */
export const activeNarrators = createRuntimeMapView("session");

export interface NarratorRuntimeModel {
	requestedModel: string;
	provider: string;
	model: string;
	resolvedAt: number;
}

const RECENT_RUNTIME_MODELS_MAX = 256;
const RECENT_RUNTIME_MODEL_TTL_MS = 30 * 60 * 1_000;
const recentRuntimeModels = hotSafe<Map<string, NarratorRuntimeModel>>(
	"narrafork.recentRuntimeModels",
	() => new Map(),
);

export function recordNarratorRuntimeModel(
	narratorId: string,
	requestedModel: string,
	provider: string,
	model: string,
): void {
	recentRuntimeModels.delete(narratorId);
	recentRuntimeModels.set(narratorId, {
		requestedModel,
		provider,
		model,
		resolvedAt: Date.now(),
	});
	while (recentRuntimeModels.size > RECENT_RUNTIME_MODELS_MAX) {
		const oldest = recentRuntimeModels.keys().next().value;
		if (oldest === undefined) break;
		recentRuntimeModels.delete(oldest);
	}
}

export function clearNarratorRuntimeModel(narratorId: string): void {
	recentRuntimeModels.delete(narratorId);
}

export function getNarratorRuntimeModel(
	narratorId: string,
	currentModel: string,
): NarratorRuntimeModel | null {
	const entry = recentRuntimeModels.get(narratorId);
	if (!entry) return null;
	if (
		entry.requestedModel !== currentModel ||
		Date.now() - entry.resolvedAt > RECENT_RUNTIME_MODEL_TTL_MS
	) {
		recentRuntimeModels.delete(narratorId);
		return null;
	}
	return entry;
}

export interface KnowledgeInjectionCycleState {
	seq: number;
	ids: Set<string>;
}

export const knowledgeInjectionCycleStates = hotSafe<Map<string, KnowledgeInjectionCycleState>>(
	"narrafork.knowledgeInjectionCycleStates",
	() => new Map(),
);

/**
 * Reset reusable upstream provider/session state for the active narrator before
 * its next model request. Returns false when the narrator is not currently active.
 *
 * Every caller reaches here right after an operation that cleared the persisted
 * `apiConversationId` (compact finalize, plan compact, clear-context), so the
 * teardown CAS baseline is moved to null in step. Without that, teardown would
 * compare against the pre-compact id, lose the CAS, and never persist the fresh
 * id — costing the next activation a needless cold upstream session. Claiming the
 * empty column is safe here precisely because the new id belongs to a session
 * that has only ever carried post-compact history.
 */
export function resetActiveUpstreamSession(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return false;
	active.conversationId = randomUUID();
	active._resetUpstreamSessionOnNextRequest = true;
	active._persistedConversationId = null;
	return true;
}

/**
 * Drop the cached workspace tree hash for every session sharing a worktree.
 *
 * `_lastTreeHash` is reused as the next tool's `before` boundary, so anything
 * that changes the worktree behind the session's back must invalidate it. A
 * rollback does exactly that: it rewrites files without going through a tool.
 *
 * Leaving the cache in place is not merely a stale-attribution problem. Segment
 * planning decides "nothing else wrote in between" by testing
 * `previous.after === next.before`, so a `before` describing a state that no
 * longer exists can make two segments merge that should have stayed split — and
 * a merged span reverses whatever another actor wrote inside it.
 *
 * Every active session on the same worktree is cleared, not just the narrator
 * that triggered the rollback: a shared worktree means the write landed in their
 * workspace too. Matching is by normalized path so `/a/b` and `/a/b/` agree.
 */
export function invalidateWorkspaceTreeCache(worktreePath: string): void {
	const target = normalizePathForComparison(worktreePath);
	for (const active of activeNarrators.values()) {
		if (normalizePathForComparison(active.cwd) !== target) continue;
		active._lastTreeHash = undefined;
	}
}

/**
 * Whether any live agent loop is currently running against this worktree.
 *
 * Scoped to the workspace rather than one narrator on purpose. A rollback competes
 * with whoever is writing the *directory*, and that is not only the narrator being
 * rolled back: subagents share their parent's cwd, and a background subagent keeps
 * writing after the parent loop returned — so the parent reads as idle while its
 * child is still mutating files. Other narrators attached to the same chapter are
 * the same situation.
 *
 * Reads `_loopRunning` rather than the DB status because that flag is the
 * authoritative in-memory signal; a status row can lag behind a turn that is still
 * draining.
 */
export function isWorkspaceBeingWritten(worktreePath: string): boolean {
	const target = normalizePathForComparison(worktreePath);
	for (const active of activeNarrators.values()) {
		if (
			!narratorLoopAdmissions.has(active.narratorId) &&
			(!active.alive || active._loopRunning !== true)
		)
			continue;
		if (normalizePathForComparison(active.cwd) === target) return true;
	}
	return false;
}

/**
 * Mark that a completed history compact still needs to be picked up by the
 * active agent loop's in-memory history/system prompt before more auto-compact
 * triggers are allowed.
 */
export function markActiveHistoryCompactPending(narratorId: string, seq?: number | null): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return false;
	const nextSeq = typeof seq === "number" ? seq : 0;
	active._pendingHistoryCompactSeq = Math.max(active._pendingHistoryCompactSeq ?? 0, nextSeq);
	return true;
}

/**
 * Whether a completed history compact is still waiting to be reflected in the
 * active agent loop's in-memory history. While true, additional auto-compact
 * triggers must be suppressed to avoid compacting the same stale context twice.
 */
export function hasPendingHistoryCompact(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	return active?._pendingHistoryCompactSeq != null;
}

/** Clear the pending-history-compact marker once the active history has caught up. */
export function clearActiveHistoryCompactPending(narratorId: string): void {
	const active = activeNarrators.get(narratorId);
	if (active) active._pendingHistoryCompactSeq = undefined;
}

export const narratorCreationLocks = hotSafe<Map<string, Promise<ActiveNarrator>>>(
	"narrafork.narratorCreationLocks",
	() => new Map(),
);

export const pendingPermissions = hotSafe<Map<string, PendingPermission>>(
	"narrafork.pendingPermissions",
	() => new Map(),
);

// === Active subagent runtime settings (lightweight, for getRuntimeSettingsOverride) ===

export interface ActiveSubagentSettings {
	model: string;
	reasoningEffort: ReasoningEffort | null;
}

export const activeSubagentSettings = createRuntimeMapView("subagentSettings");

export function registerActiveSubagent(
	narratorId: string,
	model: string,
	reasoningEffort: ReasoningEffort | null | undefined,
): void {
	activeSubagentSettings.set(narratorId, {
		model,
		reasoningEffort: reasoningEffort ?? null,
	});
}

export function unregisterActiveSubagent(narratorId: string): void {
	activeSubagentSettings.delete(narratorId);
}

export function updateActiveSubagentModel(narratorId: string, model: string): boolean {
	const s = activeSubagentSettings.get(narratorId);
	if (!s) return false;
	s.model = model;
	return true;
}

export function updateActiveSubagentReasoningEffort(
	narratorId: string,
	reasoningEffort: ReasoningEffort | null,
): boolean {
	const s = activeSubagentSettings.get(narratorId);
	if (!s) return false;
	s.reasoningEffort = reasoningEffort;
	return true;
}

export interface PendingDangerConfirmation {
	narratorId: string;
	fingerprint: string;
	expiresAt: number;
	summary: string;
}

export const pendingDangerConfirmations = hotSafe<Map<string, PendingDangerConfirmation>>(
	"narrafork.pendingDangerConfirmations",
	() => new Map(),
);

export interface PendingDangerReflection {
	narratorId: string;
	requestId: string;
	toolCallId: string;
	toolUseId: string;
	toolName: string;
	broadcastTargetId: string;
	parentToolUseId?: string;
	input: Record<string, unknown>;
	fingerprint: string;
	danger: DangerInfo;
	startedAt: number;
	/** Abort controller for the bounded automatic reflection loop only. */
	reflectionAbortController?: AbortController;
	/** True when the user stopped the automatic reflection loop but left permission pending. */
	reflectionStoppedByUser?: boolean;
	/** True when this danger reflection stands in for plan-mode soft-deny approval. */
	planModeSoftDeny?: boolean;
	resolve: (result: PermissionResult) => void;
	cleanup: () => void;
}

export const pendingDangerReflections = hotSafe<Map<string, PendingDangerReflection>>(
	"narrafork.pendingDangerReflections",
	() => new Map(),
);

export const pendingFeedback = hotSafe<
	Map<
		string,
		{
			toolUseId: string;
			feedbackText: string;
			/** The approver, so the injected feedback turn is attributed to them. */
			userId?: string | null;
		}
	>
>("narrafork.pendingFeedback", () => new Map());

export const pendingPlanCompact = hotSafe<Set<string>>(
	"narrafork.pendingPlanCompact",
	() => new Set(),
);

export const pendingPlanApprover = hotSafe<Map<string, string>>(
	"narrafork.pendingPlanApprover",
	() => new Map(),
);

/**
 * Who approved an ExitPlanMode plan: a real user ("user") or the plan reflection
 * ("reflection"). Set alongside `pendingPlanApprover` (user path) or by the
 * reflection confirmation path, read once by the `_planApprovedContinue`
 * persistence branch, then cleared. Separate from `pendingPlanApprover` so a
 * sentinel user id never leaks into the real user-id space.
 */
export const pendingPlanApproverSource = hotSafe<Map<string, "user" | "reflection">>(
	"narrafork.pendingPlanApproverSource",
	() => new Map(),
);

export const pendingPlanDiff = hotSafe<Map<string, string>>(
	"narrafork.pendingPlanDiff",
	() => new Map(),
);

export const planModeAskedOnce = hotSafe<Set<string>>(
	"narrafork.planModeAskedOnce",
	() => new Set(),
);

/**
 * Narrators whose plan mode was toggled manually mid-pass, so the system prompt must be
 * rebuilt at the next turn boundary.
 *
 * The plan-mode reminder (the read-only constraint, the designated plan file path, the
 * ExitPlanMode submission rules) lives ONLY in the system prompt, and that prompt is
 * fixed when a pass starts. Without a rebuild the model is never told it entered plan
 * mode, yet the permission gate is already denying its writes and demanding a plan file
 * it has never heard of.
 *
 * A one-shot marker rather than a persisted column: it is consumed by the act of
 * rebuilding. Persisting it would make a fork or a history replay re-trigger a rebuild
 * that already happened (the same reason `InjectionSchedule` is a parameter).
 */
const pendingPlanModePromptRebuild = hotSafe<Set<string>>(
	"narrafork.pendingPlanModePromptRebuild",
	() => new Set(),
);

/**
 * Ask the running loop to rebuild its system prompt at the next turn boundary.
 *
 * Returns false when the narrator has no live session: there is no pass holding a stale
 * prompt, and the next activation builds a fresh one from the DB anyway.
 */
export function requestPlanModePromptRebuild(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return false;
	pendingPlanModePromptRebuild.add(narratorId);
	return true;
}

/** Take the pending rebuild request, if any. One-shot: a second call returns false. */
export function consumePlanModePromptRebuild(narratorId: string): boolean {
	return pendingPlanModePromptRebuild.delete(narratorId);
}

/** Drop a pending rebuild request (session teardown / recreation). */
export function clearPlanModePromptRebuild(narratorId: string): void {
	pendingPlanModePromptRebuild.delete(narratorId);
}

/**
 * Extra owners of a narrator's `working`/`waiting` status that are NOT an agent loop.
 *
 * Some parent-side work runs with no `activeNarrators` entry at all (subagent
 * recovery stages, the recovery Await batch, planned-update recovery). Those
 * legitimately hold the narrator in a running status, so a busy check based only
 * on `_loopRunning` would wrongly declare them idle. They register here for the
 * duration of that work.
 */
const narratorRuntimeClaims = hotSafe<Map<string, Set<string>>>(
	"narrafork.narratorRuntimeClaims",
	() => new Map(),
);

/**
 * Claim a narrator as busy for non-loop parent-side work. Returns a release
 * function; releasing a claim that was already released is a no-op.
 */
export function claimNarratorRuntime(narratorId: string, token: string): () => void {
	assertNarratorNotReverting(narratorId);
	const claims = narratorRuntimeClaims.get(narratorId) ?? new Set<string>();
	claims.add(token);
	narratorRuntimeClaims.set(narratorId, claims);
	return () => {
		const current = narratorRuntimeClaims.get(narratorId);
		if (!current) return;
		current.delete(token);
		if (current.size === 0) narratorRuntimeClaims.delete(narratorId);
	};
}

export function hasNarratorRuntimeClaim(narratorId: string): boolean {
	return (narratorRuntimeClaims.get(narratorId)?.size ?? 0) > 0;
}

/**
 * Whether this narrator legitimately owns a `working`/`waiting` DB status right now.
 *
 * This is the authoritative in-memory answer to "is this narrator actually busy",
 * and it is deliberately broader than `_loopRunning`:
 * - a live agent loop (`activeNarrators` + `_loopRunning`);
 * - a permission or danger reflection awaiting a decision, which suspends the
 *   loop but keeps the turn alive;
 * - a registered runtime claim for loop-less parent-side work.
 *
 * Two consumers depend on it:
 * - status mirroring for a subagent's permission gates, which must never promote
 *   an idle parent into a fake running state;
 * - the reverse reconcile in `reconcileRunningStatus`, which repairs a DB status
 *   that outlived every runtime owner.
 *
 * Only pending entries OWNED by this narrator count. An entry whose
 * `broadcastTargetId` merely points here belongs to a subagent, and a subagent's
 * pause is not the parent's work.
 */
export const narratorLoopAdmissions = executionAdmissions;

export function isNarratorRuntimeBusy(narratorId: string): boolean {
	if (narratorLoopAdmissions.has(narratorId)) return true;
	const active = activeNarrators.get(narratorId);
	if (active?.alive === true && active._loopRunning === true) return true;
	if (hasNarratorRuntimeClaim(narratorId)) return true;
	for (const pending of pendingPermissions.values()) {
		if (pending.narratorId === narratorId) return true;
	}
	for (const pause of pendingDangerReflections.values()) {
		if (pause.narratorId === narratorId) return true;
	}
	return false;
}

/** Deprecated read-only view; the mailbox is the sole queue authority. */
export const bufferedMessages = {
	get(narratorId: string): BufferedMessage[] | undefined {
		const messages = getBufferedMessages(narratorId);
		return messages.length ? messages : undefined;
	},
	has(narratorId: string): boolean {
		return getBufferedMessages(narratorId).length > 0;
	},
};

// === Shared start/history/revert admission ===

interface NarratorWorkAdmission {
	narratorId: string;
	rootId: string;
	live: boolean;
	settled: Promise<void>;
	release: () => void;
}

interface NarratorAdmissionContext {
	work: Map<string, NarratorWorkAdmission>;
	starts: Map<string, { live: boolean }>;
}

const admissionContext = hotSafe(
	"narrafork.narratorAdmissionContext",
	() => new AsyncLocalStorage<NarratorAdmissionContext>(),
);
const admissionStartLock = hotSafe("narrafork.narratorAdmissionStartLock", () => new AsyncMutex());
const admissionWork = hotSafe<Map<string, Set<NarratorWorkAdmission>>>(
	"narrafork.narratorAdmissionWork",
	() => new Map(),
);
const revertAdmissions = hotSafe<Map<string, { phase: "waiting" | "held" }>>(
	"narrafork.narratorRevertAdmissions",
	() => new Map(),
);

/** Resolve ownership from persisted parent links, never a request's broadcast/cwd hint. */
export async function resolveNarratorAdmissionRoot(narratorId: string): Promise<string> {
	const [{ db }, { narrators }, { eq }] = await Promise.all([
		import("../db"),
		import("../db/schema"),
		import("drizzle-orm"),
	]);
	const seen = new Set<string>();
	let id = narratorId;
	while (seen.size < 32 && !seen.has(id)) {
		seen.add(id);
		// Admission is a frequent metadata read; never load prompts or compact summaries.
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
			columns: { id: true, variant: true, parentNarratorId: true },
		});
		if (!narrator) throw new NotFoundError("Narrator", id);
		if (!isSubagentVariant(narrator.variant)) return id;
		if (!narrator.parentNarratorId) break;
		id = narrator.parentNarratorId;
	}
	throw new AppError(
		"Cannot verify narrator admission root",
		409,
		"NARRATOR_ADMISSION_ROOT_INVALID",
	);
}

export function isNarratorRevertAdmissionBlocked(narratorId: string): boolean {
	const inherited = admissionContext.getStore()?.work.get(narratorId);
	return revertAdmissions.has(inherited?.live ? inherited.rootId : narratorId);
}

export function assertNarratorNotReverting(narratorId: string): void {
	if (isNarratorRevertAdmissionBlocked(narratorId)) {
		throw new AppError(
			"Narrator history is reserved for a file revert",
			409,
			"NARRATOR_REVERT_IN_PROGRESS",
		);
	}
}

function claimAdmissionWork(narratorId: string, rootId: string): NarratorWorkAdmission {
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const work: NarratorWorkAdmission = {
		narratorId,
		rootId,
		live: true,
		settled,
		release: () => {
			if (!work.live) return;
			work.live = false;
			const current = admissionWork.get(rootId);
			current?.delete(work);
			if (current?.size === 0) admissionWork.delete(rootId);
			settle();
		},
	};
	const claims = admissionWork.get(rootId) ?? new Set<NarratorWorkAdmission>();
	claims.add(work);
	admissionWork.set(rootId, claims);
	return work;
}

/**
 * A shared work lease, NOT a mutex held while a loop runs. Nested work gets its own
 * lease so detached compacts/runners cannot outlive admission. An inherited lease
 * only allows existing work to drain while an interrupting revert waits; it never
 * permits writes after the exclusive lease has been granted.
 */
export function withNarratorWorkAdmission<T>(
	narratorId: string,
	fn: () => Promise<T>,
	until?: (result: T) => Promise<unknown> | undefined,
): Promise<T> {
	const inherited = admissionContext.getStore()?.work.get(narratorId);
	const enter = (rootId: string): Promise<T> => {
		const gate = revertAdmissions.get(rootId);
		const draining = [...(admissionContext.getStore()?.work.values() ?? [])].some(
			(work) => work.live && work.rootId === rootId,
		);
		if (gate && !(gate.phase === "waiting" && draining)) {
			return Promise.reject(
				new AppError(
					"Narrator history is reserved for a file revert",
					409,
					"NARRATOR_REVERT_IN_PROGRESS",
				),
			);
		}
		const lease = claimAdmissionWork(narratorId, rootId);
		const parent = admissionContext.getStore();
		const work = new Map(parent?.work);
		work.set(narratorId, lease);
		// The root is also covered when a child publishes a conclusion to its parent.
		work.set(rootId, lease);
		return admissionContext.run({ work, starts: new Map(parent?.starts) }, async () => {
			try {
				const result = await fn();
				const terminal = until?.(result);
				if (terminal) void terminal.then(lease.release, lease.release);
				else lease.release();
				return result;
			} catch (error) {
				lease.release();
				throw error;
			}
		});
	};
	// Preserve the synchronous handoff from a start transaction into a background loop.
	return inherited?.live
		? enter(inherited.rootId)
		: resolveNarratorAdmissionRoot(narratorId).then(enter);
}

/** Short start transaction: a pending revert also prevents NEW automatic turns. */
export function withNarratorStartAdmission<T>(
	narratorId: string,
	fn: () => Promise<T>,
): Promise<T> {
	assertNarratorNotReverting(narratorId);
	return withNarratorMutationAdmission(narratorId, async () => {
		assertNarratorNotReverting(narratorId);
		return fn();
	});
}

/**
 * The same short mutex for history/resume publication. Already-admitted delivery
 * may drain during `waiting`; new callers are rejected by the work lease. Sharing
 * this mutex removes the old resume→edit versus start→resume lock-order cycle.
 */
export function withNarratorMutationAdmission<T>(
	narratorId: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (admissionContext.getStore()?.starts.get(narratorId)?.live) {
		return withNarratorWorkAdmission(narratorId, fn);
	}
	return withNarratorWorkAdmission(narratorId, () =>
		admissionStartLock.acquire(narratorId, async () => {
			const parent = admissionContext.getStore();
			const token = { live: true };
			const starts = new Map(parent?.starts);
			starts.set(narratorId, token);
			try {
				return await admissionContext.run({ work: new Map(parent?.work), starts }, fn);
			} finally {
				token.live = false;
			}
		}),
	);
}

/** Includes startup and COMPLETE finalization, but does not make a background child's parent busy. */
export function hasNarratorAdmissionWork(narratorId: string): boolean {
	return (admissionWork.get(narratorId)?.size ?? 0) > 0;
}

export function listNarratorAdmissionOwners(narratorId: string): string[] {
	return [...new Set([...(admissionWork.get(narratorId) ?? [])].map((work) => work.narratorId))];
}

export async function waitForNarratorAdmissionWork(
	narratorId: string,
	signal: AbortSignal,
): Promise<void> {
	while (hasNarratorAdmissionWork(narratorId)) {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			void Promise.all([...(admissionWork.get(narratorId) ?? [])].map((work) => work.settled))
				.then(() => resolve())
				.finally(() => signal.removeEventListener("abort", onAbort));
		});
	}
	signal.throwIfAborted();
}

/** Reserve starts while interrupt drains OUTSIDE the start mutex; promotion is atomic. */
export function reserveNarratorRevertAdmission(narratorId: string): {
	acquire: (signal: AbortSignal, busy: () => boolean) => Promise<() => void>;
	release: () => void;
} {
	assertNarratorNotReverting(narratorId);
	const gate = { phase: "waiting" as "waiting" | "held" };
	revertAdmissions.set(narratorId, gate);
	const release = () => {
		if (revertAdmissions.get(narratorId) === gate) revertAdmissions.delete(narratorId);
	};
	return {
		release,
		acquire: (signal, busy) =>
			admissionStartLock.acquire(narratorId, async () => {
				signal.throwIfAborted();
				if (hasNarratorAdmissionWork(narratorId) || busy()) {
					throw new AppError("Narrator execution has not settled", 409, "NARRATOR_REVERT_BUSY");
				}
				gate.phase = "held";
				return release;
			}),
	};
}

// === Compact locks ===

export type CompactLockKind = "history" | "history_probe" | "segment";
export type CompactMode = "blocking" | "background";

export interface CompactLockResult {
	kind: CompactLockKind;
	/** True only when this lock actually produced or waited for a history compact. */
	compacted: boolean;
	/** Whether this compact blocked the active turn or ran in the background. */
	mode?: CompactMode;
}

export interface CompactLock {
	kind: CompactLockKind;
	promise: Promise<CompactLockResult>;
	/** Whether this compact blocks the active turn or runs alongside it. */
	mode?: CompactMode;
	/**
	 * Controller to cancel the in-progress summary generation. Present on the
	 * real history-compact lock (not the wrapper history_probe lock). Aborting
	 * it cancels the upstream summary model request so the user can cancel a
	 * long-running compact.
	 */
	abortController?: AbortController;
}

/** Per-narrator lock to prevent concurrent compact operations. */
export const compactLocks = hotSafe<Map<string, CompactLock>>(
	"narrafork.compactLocks.v2",
	() => new Map(),
);
