import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { DangerInfo, PermissionResult, ReasoningEffort } from "../lib/agent";
import { hotSafe } from "../lib/hot-safe";
import type { Locale } from "../lib/prompt-i18n";
import type { ImageRef } from "../lib/uploads";
import type { TokenUsageSnapshot } from "./narrator-event-handler";

// === ActiveNarrator interface ===

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
	/** Cached prune boundary from the start of the current agent loop iteration */
	_pruneBoundaryMessageId?: string | null;
	/** Cached chapter ID (set when narrator is bound to an active chapter) */
	_chapterId?: string;
	/** Cached project ID (set when narrator is bound to a chapter with a project) */
	_projectId?: string;
	/** Cached chapter role (trunk/branch/exploration/review) */
	_chapterRole?: string;
	/** Cached worktree path (set when narrator is bound to an active chapter with a worktree) */
	_worktreePath?: string;
	/** Plan file ID — set when entering plan mode, used to lock Write/Edit to .narrafork/plan-{id}.md */
	_planFileId?: string;
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
	/** Soft-stop flag: set when user approves a permission with feedbackText.
	 *  The agent loop checks this via shouldStop() after tools complete. */
	_feedbackSoftStop?: boolean;
	/** Soft-stop flag: set when a priority buffered message should run after current tools finish. */
	_bufferSoftStop?: boolean;
	/** Set once interrupted cleanup has run for the current agent-loop iteration. */
	_interruptCleanupDone?: boolean;
	/** Whether the agent loop is currently running for this narrator. */
	_loopRunning?: boolean;
	/** Immediate title derived from the first user message while model title generation runs. */
	_provisionalTitle?: string;
	/** Active substatus tags for this narrator session (in-memory, synced to DB on change). */
	_substatus: Set<string>;
	/** One-shot reset for reusable upstream provider sessions before the next request. */
	_resetUpstreamSessionOnNextRequest?: boolean;
	/**
	 * Latest history compact seq that has completed while this narrator is alive,
	 * but has not yet been consumed by a rebuilt in-memory agent history.
	 */
	_pendingHistoryCompactSeq?: number;
	/** Goal accounting baseline at the start of the current turn. */
	_goalTurnStartedAtMs?: number;
	_goalTokenUsageBaseline?: TokenUsageSnapshot;
	/** Guard against infinite goal continuation when continuation turns make no tool progress. */
	_goalContinuationSuppressed?: boolean;
	_goalContinuationTurn?: boolean;
	_goalContinuationNoToolCount?: number;
	/** One-shot sidecar injected when goals change while the current loop is already running. */
	_pendingGoalStateNotice?: string;
	/** Completed non-TaskCreate tool count used to keep TODO reminder cadence across loop runs. */
	_todoReminderCompletedToolCount?: number;
}

// === PendingPermission interface ===

export interface PendingPermission {
	resolve: (result: PermissionResult) => void;
	cleanup: () => void;
	input: Record<string, unknown>;
	narratorId: string;
	toolName: string;
	toolUseId: string;
	broadcastTargetId: string;
	cwd: string;
	locale: Locale;
	signal: AbortSignal;
	planModeSoftDeny?: boolean;
	questionReflectionTimer?: ReturnType<typeof setTimeout>;
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

export interface BufferedMessage {
	id: string;
	text: string;
	images?: ImageRef[];
	textFiles?: File[];
	bufferedAt: string;
	commandText?: string | null;
	createdBy?: string | null;
	creator?: BufferCreator | null;
	/** True when this queued message was inserted with priority/cut-in-line semantics. */
	priority?: boolean;
	/** Paths of text files persisted to disk (for DB recovery). */
	_savedFiles?: SavedBufferedFile[];
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

export const activeNarrators = hotSafe<Map<string, ActiveNarrator>>(
	"narrafork.activeNarrators",
	() => new Map(),
);

/**
 * Reset reusable upstream provider/session state for the active narrator before
 * its next model request. Returns false when the narrator is not currently active.
 */
export function resetActiveUpstreamSession(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active?.alive) return false;
	active.conversationId = randomUUID();
	active._resetUpstreamSessionOnNextRequest = true;
	return true;
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

export const pendingFeedback = hotSafe<Map<string, { toolUseId: string; feedbackText: string }>>(
	"narrafork.pendingFeedback",
	() => new Map(),
);

export const pendingPlanCompact = hotSafe<Set<string>>(
	"narrafork.pendingPlanCompact",
	() => new Set(),
);

export const pendingPlanApprover = hotSafe<Map<string, string>>(
	"narrafork.pendingPlanApprover",
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

export const bufferedMessages = hotSafe<Map<string, BufferedMessage[]>>(
	"narrafork.bufferedMessages",
	() => new Map(),
);

// === Compact/Prune locks ===

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
}

/** Per-narrator lock to prevent concurrent compact operations. */
export const compactLocks = hotSafe<Map<string, CompactLock>>(
	"narrafork.compactLocks.v2",
	() => new Map(),
);

/** Per-narrator lock to prevent concurrent prune boundary computations. */
export const pruneLocks = hotSafe<Set<string>>("narrafork.pruneLocks", () => new Set());
