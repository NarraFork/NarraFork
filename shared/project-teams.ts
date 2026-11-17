/**
 * project-teams.ts — the wire shapes and limits of a project team (docs/PROJECT_TEAMS-PLAN.md).
 *
 * A team IS one coordinator narrator (`team` trait) inside a project: its id is the
 * coordinator's narrator id and its name is that narrator's title, so renaming the session
 * renames the team. Members are the people who may write to the coordinator; there is no
 * separate team ACL.
 *
 * Shared because the server validates against these limits and later client PRs render the
 * same shapes. Each team PR appends its own section; keep earlier sections stable.
 */

// ── P1: teams ────────────────────────────────────────────────────────────────

export const TEAM_STATUSES = ["active", "archived"] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** UTF-8 byte budget of the team brief (shared rules for the coordinator and its subagents). */
export const TEAM_BRIEF_MAX_BYTES = 4 * 1024;
/** UTF-8 byte budget of the serialized team settings. */
export const TEAM_SETTINGS_MAX_BYTES = 16 * 1024;
/** Longest team name accepted at creation (the narrator title). */
export const TEAM_NAME_MAX_LENGTH = 120;
/** Longest base branch name accepted. */
export const TEAM_BRANCH_MAX_LENGTH = 200;

/**
 * Suggested limits for the coordinator's own work (plan §二.2, decision T4: all soft — never
 * refused or truncated; P2 appends a reminder to the tool result when one is exceeded).
 */
export interface CoordinatorLimits {
	/** Lines changed by one Edit/Write (the larger of old and new text). */
	editLines: number;
	/** Lines of one newly created file. */
	newFileLines: number;
	/** Files changed in one turn. */
	filesPerTurn: number;
	/** Lines returned by one Read. */
	readLines: number;
	/** Lines returned by one Grep/Glob. */
	searchLines: number;
	/** Bytes of one Bash output. */
	bashOutputBytes: number;
	/** Context usage share (percent) above which the team status suggests compacting. */
	contextPercent: number;
}

export const DEFAULT_COORDINATOR_LIMITS: Readonly<CoordinatorLimits> = Object.freeze({
	editLines: 30,
	newFileLines: 60,
	filesPerTurn: 3,
	readLines: 300,
	searchLines: 100,
	bashOutputBytes: 8 * 1024,
	contextPercent: 60,
});

/** Team-level settings. Every field is optional; absent means the default. */
export interface TeamSettings {
	/** Overrides of {@link DEFAULT_COORDINATOR_LIMITS}. */
	coordinatorLimits?: Partial<CoordinatorLimits>;
	/** When true, merging back to the base waits for a person (decision T7's opt-out). */
	mergeNeedsPerson?: boolean;
}

/** The effective coordinator limits of a team. */
export function effectiveCoordinatorLimits(settings: TeamSettings | null | undefined) {
	return { ...DEFAULT_COORDINATOR_LIMITS, ...(settings?.coordinatorLimits ?? {}) };
}

/** What the caller may do with a team: write = member, read = onlooker. */
export type TeamAccess = "read" | "write";

/** A team as the API returns it. The brief is only on the detail response. */
export interface TeamSummary {
	/** The coordinator narrator's id. */
	id: string;
	projectId: string;
	/** The coordinator narrator's title. */
	name: string;
	baseBranch: string;
	status: TeamStatus;
	/** The coordinator narrator's run status (idle / working / waiting / archived). */
	coordinatorStatus: string;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	access: TeamAccess;
	/** UTF-8 bytes of the brief, so lists can show "has a brief" without carrying it. */
	briefBytes: number;
}

export interface TeamDetail extends TeamSummary {
	brief: string;
	settings: TeamSettings;
}

export interface TeamListResponse {
	teams: TeamSummary[];
	nextCursor: string | null;
}

// ── P1: work items (tables only; P3 adds the lifecycle) ──────────────────────

export const TEAM_WORK_ITEM_STATES = [
	"queued",
	"in_progress",
	"in_review",
	"ready",
	"merged",
	"cancelled",
] as const;
export type TeamWorkItemState = (typeof TEAM_WORK_ITEM_STATES)[number];

/** States in which a work item no longer needs anything (its worktree may still be recorded). */
export const TEAM_WORK_ITEM_FINISHED_STATES: readonly TeamWorkItemState[] = ["merged", "cancelled"];

export const TEAM_REVIEW_VERDICTS = ["blocker", "clear"] as const;
export type TeamReviewVerdict = (typeof TEAM_REVIEW_VERDICTS)[number];

/** Byte budget of `team_work_items.changed_paths_json` (at most 2,000 paths). */
export const TEAM_CHANGED_PATHS_MAX_BYTES = 128 * 1024;
/** Byte budget of `team_work_events.detail_json`. */
export const TEAM_EVENT_DETAIL_MAX_BYTES = 8 * 1024;

export const TEAM_EVENT_ACTOR_KINDS = ["person", "agent", "system"] as const;
export type TeamEventActorKind = (typeof TEAM_EVENT_ACTOR_KINDS)[number];

/** Team-level event kinds recorded by P1. Later PRs add their own. */
export type TeamEventKind =
	| "team.created"
	| "team.brief"
	| "team.settings"
	| "team.archived"
	| "team.unarchived"
	| CoordinatorOverrunEventKind
	| typeof TEAM_DECISION_EVENT_KIND;

// ── P2: coordinator reminders and team status ────────────────────────────────

/** The per-call limits a coordinator's tool call can go over (context use is a status note). */
export const COORDINATOR_OVERRUN_KINDS = [
	"editLines",
	"newFileLines",
	"filesPerTurn",
	"readLines",
	"searchLines",
	"bashOutputBytes",
] as const;
export type CoordinatorOverrunKind = (typeof COORDINATOR_OVERRUN_KINDS)[number];

/** Event kind prefix of a recorded overrun: `coordinator.overrun.<CoordinatorOverrunKind>`. */
export const COORDINATOR_OVERRUN_EVENT_PREFIX = "coordinator.overrun.";
export type CoordinatorOverrunEventKind =
	`${typeof COORDINATOR_OVERRUN_EVENT_PREFIX}${CoordinatorOverrunKind}`;

/**
 * A decision the coordinator took on people's behalf (plan §二.14 "决定替人做了要说"), with
 * `detail_json.summary`. The team status lists the latest few; P3's Team tool writes them.
 */
export const TEAM_DECISION_EVENT_KIND = "team.decision";

/** UTF-8 byte budget of one team status row (plan §二.2: about 6 KB). */
export const TEAM_STATUS_MAX_BYTES = 6 * 1024;
/** A long run looks at the team status again at most this often. */
export const TEAM_STATUS_CADENCE_MS = 10 * 60_000;
