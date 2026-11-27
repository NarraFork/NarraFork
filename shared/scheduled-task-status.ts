/**
 * scheduled-task-status.ts — the vocabulary of a scheduled task and of each of its runs.
 *
 * TWO AXES PER RUN, AND WHY THEY ARE NOT ONE
 * -----------------------------------------
 * A run used to be "success" the moment its prompt was delivered, which said nothing
 * about whether the work was done. Collapsing everything into one richer status would
 * repeat the mistake in a new shape, because the two things it would be mixing are not
 * equally trustworthy:
 *
 *   - `status`  — what the server OBSERVED: the loop is running, is parked on a person,
 *                 ended, errored, was cut short. Reliable; nobody can forget to set it.
 *   - `outcome` — what the model SAID about its own work. Useful, but a model can forget
 *                 to say it, and can say "done" when it is not.
 *
 * `runVerdict` combines them for display, and deliberately has a state for "ended, and
 * nobody said how it went" rather than guessing. That state is never a success and never
 * a failure.
 *
 * A third thing, the task's `lifecycle`, is about the schedule and not about any run: a
 * task is "ended" when it will not fire again, whatever its last run did.
 */

/**
 * `success` is legacy: rows written before runs were tracked to completion, where it
 * meant only "dispatched". It is kept as a distinct value so those rows are never
 * re-read as a claim that the work finished.
 */
export const SCHEDULED_RUN_STATUSES = [
	"waiting",
	"running",
	"blocked",
	"completed",
	"failed",
	"interrupted",
	"timed_out",
	"skipped",
	"missed",
	"success",
] as const;
export type ScheduledRunStatus = (typeof SCHEDULED_RUN_STATUSES)[number];

/** Executing runs only: waiting runs have no runtime or report authority. */
export const ACTIVE_RUN_STATUSES = [
	"running",
	"blocked",
] as const satisfies readonly ScheduledRunStatus[];

export function isActiveRunStatus(status: string | null | undefined): boolean {
	return status === "running" || status === "blocked";
}

/** Accepted runs that still prevent a schedule from completing. */
export const UNFINISHED_RUN_STATUSES = [
	"waiting",
	...ACTIVE_RUN_STATUSES,
] as const satisfies readonly ScheduledRunStatus[];

export function isUnfinishedRunStatus(status: string | null | undefined): boolean {
	return status === "waiting" || isActiveRunStatus(status);
}

/** The precise execution an interrupt accepted; never retargeted after an await or restart. */
export interface ScheduledRunInterruptTarget {
	narratorId: string;
	logicalRunId?: string;
	executionEpoch?: string;
	scheduledRunId?: string;
}

/** Why a run is parked. `provider_wait` is the only one no person can clear. */
export const RUN_BLOCK_REASONS = ["question", "plan", "permission", "provider_wait"] as const;
export type RunBlockReason = (typeof RUN_BLOCK_REASONS)[number];

/** What the model reported about its own work. */
export const RUN_OUTCOMES = ["done", "partial", "blocked", "no_change"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export function isRunOutcome(value: unknown): value is RunOutcome {
	return typeof value === "string" && (RUN_OUTCOMES as readonly string[]).includes(value);
}

/** Why a run did not end normally, or did not start. */
export const RUN_ERROR_KINDS = [
	/** The prompt could not be delivered at all. */
	"dispatch",
	/** The loop ended on a model or provider error after its own retries. */
	"provider",
	/** The run outlived its maximum duration. */
	"timeout",
	/** The run waited on a person for longer than the task allows. */
	"blocked_timeout",
	/** The server restarted underneath the run. */
	"restart",
	/** The task's owner may no longer act on the project or session. */
	"acl",
	/** The target session was already running or its admission queue was full. */
	"busy",
	/** No execution slot became available before the accepted wait deadline. */
	"busy_timeout",
	/** Another scheduled run interrupted this precise execution. */
	"scheduled_interrupt",
	/** Accepted work was cancelled before dispatch (for example, by pausing its task). */
	"cancelled",
	/** The project or session the task points at is gone. */
	"target_missing",
	/** A person stopped the run. */
	"user_interrupt",
] as const;
export type RunErrorKind = (typeof RUN_ERROR_KINDS)[number];

export const RUN_TRIGGERS = ["schedule", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * A run as the interface names it. `unconfirmed` and `incomplete` exist only here: they
 * are a completed run seen through what the model did or did not report.
 */
export type RunVerdict =
	| "succeeded"
	| "completed"
	| "waiting"
	| "unconfirmed"
	| "incomplete"
	| "failed"
	| "timed_out"
	| "interrupted"
	| "running"
	| "blocked"
	| "skipped"
	| "missed"
	| "dispatched";

export function runVerdict(
	status: string | null | undefined,
	outcome: string | null | undefined,
	requireReport = true,
): RunVerdict {
	switch (status) {
		case "waiting":
		case "running":
		case "blocked":
		case "failed":
		case "timed_out":
		case "interrupted":
		case "skipped":
		case "missed":
			return status;
		case "completed":
			if (outcome === "done" || outcome === "no_change") return "succeeded";
			if (outcome === "partial" || outcome === "blocked") return "incomplete";
			return requireReport ? "unconfirmed" : "completed";
		default:
			// Legacy `success`, and anything unrecognized: all that is known is that it was sent.
			return "dispatched";
	}
}

/**
 * Whether a run calls for a person to look.
 *
 * `unconfirmed` is left out: it means the model did not report, which is worth showing
 * but would otherwise put every quiet task in front of its owner every day.
 */
export function verdictNeedsAttention(verdict: RunVerdict): boolean {
	return (
		verdict === "failed" ||
		verdict === "timed_out" ||
		verdict === "incomplete" ||
		verdict === "blocked" ||
		verdict === "interrupted"
	);
}

/** Where a task stands as a schedule, independent of how any run went. */
export const TASK_LIFECYCLES = ["active", "paused", "ended"] as const;
export type TaskLifecycle = (typeof TASK_LIFECYCLES)[number];

export function taskLifecycle(task: {
	enabled: boolean;
	completedAt: string | null | undefined;
}): TaskLifecycle {
	if (task.completedAt) return "ended";
	return task.enabled ? "active" : "paused";
}

/** Why a task is not enabled. Null on a row that predates the column means a person did it. */
export const TASK_PAUSE_REASONS = ["user", "circuit_breaker"] as const;
export type TaskPauseReason = (typeof TASK_PAUSE_REASONS)[number];

/**
 * How the task's model applies to a session it reuses.
 *
 *   - `follow`     leave the session's model alone;
 *   - `temporary`  switch for this run only, then restore what the session had;
 *   - `sync`       set the session to the task's model before each run, and leave it.
 */
export const TASK_MODEL_POLICIES = ["follow", "temporary", "sync"] as const;
export type TaskModelPolicy = (typeof TASK_MODEL_POLICIES)[number];

export const TASK_NARRATOR_MODES = ["new", "reuse", "existing"] as const;
export type TaskNarratorMode = (typeof TASK_NARRATOR_MODES)[number];
export const TASK_CONTEXT_POLICIES = ["keep", "clear"] as const;
export type TaskContextPolicy = (typeof TASK_CONTEXT_POLICIES)[number];
export const TASK_ON_BUSY_POLICIES = ["skip", "wait", "interrupt"] as const;
export type TaskOnBusyPolicy = (typeof TASK_ON_BUSY_POLICIES)[number];

/**
 * What an unattended run does when it reaches something only a person can settle.
 *
 *   - `auto`  never wait: the question is refused with guidance, a plan is approved, an
 *             approval request is denied, and the run carries on;
 *   - `wait`  mark the run blocked, tell the owner, and give up after a while.
 */
export const TASK_ON_BLOCKED_POLICIES = ["auto", "wait"] as const;
export type TaskOnBlockedPolicy = (typeof TASK_ON_BLOCKED_POLICIES)[number];

export const TASK_CREATOR_KINDS = ["user", "narrator"] as const;
export type TaskCreatorKind = (typeof TASK_CREATOR_KINDS)[number];

/** Names kept for display after the user or session they describe is gone. */
export interface TaskCreatorSnapshot {
	username?: string;
	narratorTitle?: string;
	/** The session a creating subagent belongs to. */
	rootNarratorId?: string;
}

/** Who last changed a task, and how. */
export interface TaskModifiedBy {
	kind: TaskCreatorKind | "system";
	userId: string | null;
	narratorId?: string | null;
	toolCallId?: string | null;
	action: string;
	at: string;
}

/** What an unattended run settled without a person, for the run's record. */
export interface RunAutoHandled {
	question: number;
	plan: number;
	permission: number;
	/** The most recent few, in the model's own words, trimmed. */
	notes: string[];
}

export const RUN_AUTO_HANDLED_NOTE_LIMIT = 5;
export const RUN_AUTO_HANDLED_NOTE_CHARS = 200;

/** How much work a run took, copied from its turns when it settles. */
export interface RunStats {
	/** Narrator turns the run spanned: the first, plus continuations and wake-ups. */
	turns?: number;
	steps?: number;
	toolCalls?: number;
}

/** Bounds on the task settings a person or a model may choose. */
export const SCHEDULED_TASK_LIMITS = {
	maxRunMinutes: { min: 5, max: 1440, default: 60 },
	blockedWaitMinutes: { min: 1, max: 1440, default: 30 },
	busyWaitMinutes: { min: 1, max: 1440, default: 30 },
	maxWaitingPerNarrator: 64,
	interruptWaitMs: 15_000,
	outcomeSummaryChars: 2000,
	/** How much of the last summary rides on the task row for list display. */
	lastSummaryChars: 500,
} as const;
