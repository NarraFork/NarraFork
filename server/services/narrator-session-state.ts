import type { EventEmitter } from "node:events";
import type { PermissionResult } from "../lib/agent";
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
	model: string;
	provider: string;
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
	/** Permission mode before entering plan mode — used to restore on ExitPlanMode */
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
	/** Resolved skill scan root (projectGitPath or git root from cwd) */
	_skillRoot?: string | null;
	/** Optional tools enabled for this session (tool names, e.g. "Terminal") */
	_enabledOptionalTools: Set<string>;
	/** Soft-stop flag: set when user approves a permission with feedbackText.
	 *  The agent loop checks this via shouldStop() after tools complete. */
	_feedbackSoftStop?: boolean;
	/** Set once interrupted cleanup has run for the current agent-loop iteration. */
	_interruptCleanupDone?: boolean;
	/** Whether the agent loop is currently running for this narrator. */
	_loopRunning?: boolean;
	/** Active substatus tags for this narrator session (in-memory, synced to DB on change). */
	_substatus: Set<string>;
	/** Goal accounting baseline at the start of the current turn. */
	_goalTurnStartedAtMs?: number;
	_goalTokenUsageBaseline?: TokenUsageSnapshot;
	/** Guard against infinite goal continuation when continuation turns make no tool progress. */
	_goalContinuationSuppressed?: boolean;
	_goalContinuationTurn?: boolean;
	_goalContinuationNoToolCount?: number;
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
	planModeSoftDeny?: boolean;
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

export const narratorCreationLocks = hotSafe<Map<string, Promise<ActiveNarrator>>>(
	"narrafork.narratorCreationLocks",
	() => new Map(),
);

export const pendingPermissions = hotSafe<Map<string, PendingPermission>>(
	"narrafork.pendingPermissions",
	() => new Map(),
);

export interface PendingYoloDangerConfirmation {
	narratorId: string;
	fingerprint: string;
	expiresAt: number;
	summary: string;
}

export const pendingYoloDangerConfirmations = hotSafe<Map<string, PendingYoloDangerConfirmation>>(
	"narrafork.pendingYoloDangerConfirmations",
	() => new Map(),
);

export interface PendingYoloPause {
	narratorId: string;
	requestId: string;
	toolUseId: string;
	toolName: string;
	input: Record<string, unknown>;
	fingerprint: string;
	danger: {
		summary: string;
		consequences: string[];
		saferAlternatives: string[];
		details?: string[];
	};
	startedAt: number;
}

export const pendingYoloPauses = hotSafe<Map<string, PendingYoloPause>>(
	"narrafork.pendingYoloPauses",
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

export interface CompactLockResult {
	kind: CompactLockKind;
	/** True only when this lock actually produced or waited for a history compact. */
	compacted: boolean;
}

export interface CompactLock {
	kind: CompactLockKind;
	promise: Promise<CompactLockResult>;
}

/** Per-narrator lock to prevent concurrent compact operations. */
export const compactLocks = hotSafe<Map<string, CompactLock>>(
	"narrafork.compactLocks.v2",
	() => new Map(),
);

/** Per-narrator lock to prevent concurrent prune boundary computations. */
export const pruneLocks = hotSafe<Set<string>>("narrafork.pruneLocks", () => new Set());
