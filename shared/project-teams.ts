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

// ── P3: work item lifecycle ──────────────────────────────────────────────────

/**
 * The coordinator's `Team` tool actions (plan §二.4). PR, CI and integration actions
 * (`integrate`, `pr.*`, `merge.local`) are deferred with the hosting and integration PRs.
 */
export const TEAM_TOOL_ACTIONS = [
	"work.list",
	"work.create",
	"work.review",
	"work.ready",
	"work.sync",
	"work.cancel",
	"brief",
	"checkin",
	"cleanup",
	"decision",
] as const;
export type TeamToolAction = (typeof TEAM_TOOL_ACTIONS)[number];

/**
 * Kind of a work item made by `Agent({ isolation: "worktree" })`: its worktree is cleaned and the
 * item cancelled when the subagent's run ends without a commit or an uncommitted change. Items
 * made by `Team({ action: "work.create" })` keep the default kind and are never cleaned on their
 * own.
 */
export const TEAM_ISOLATED_WORK_KIND = "isolated";
/** Default kind of a work item. */
export const TEAM_DEFAULT_WORK_KIND = "change";

/** Longest work item title. */
export const TEAM_WORK_TITLE_MAX_LENGTH = 200;
/** Text budget (UTF-8 bytes) of a decision recorded on people's behalf. */
export const TEAM_DECISION_MAX_BYTES = 2 * 1024;
/** Bounds of a check-in delay in minutes: at least five minutes, at most one day. */
export const TEAM_CHECKIN_MIN_MINUTES = 5;
export const TEAM_CHECKIN_MAX_MINUTES = 24 * 60;
/** Most work items one `work.list` returns (open ones first). */
export const TEAM_WORK_LIST_LIMIT = 30;

/** Work item and team events written by P3, each with its person or agent. */
export type TeamWorkEventKind =
	| "work.created"
	| "work.started"
	| "work.start_failed"
	| "work.review"
	| "work.ready"
	| "work.sync"
	| "work.cancelled"
	| "work.cleanup"
	| "team.checkin"
	| typeof TEAM_DECISION_EVENT_KIND;

// ── X: who is changing what across teams, exclusive paths ────────────────────

/** Most changed paths stored per work item; past it the item's top-level entries are stored. */
export const TEAM_CHANGED_PATHS_MAX = 2000;
/** Most paths of one item compared path by path; past it the item compares by top-level entry. */
export const TEAM_OVERLAP_COMPARE_PATHS = 500;
/** Most active work items of one project the overlap check looks at. */
export const TEAM_OVERLAP_PROJECT_ITEMS = 100;
/** Work items whose changed paths one background pass refreshes. */
export const TEAM_CHANGED_PATHS_BATCH = 50;
/** How often the background pass runs. */
export const TEAM_CHANGED_PATHS_INTERVAL_MS = 2 * 60_000;
/** Most overlap entries the "who is changing what" response lists. */
export const TEAM_OVERLAP_LIST_LIMIT = 200;
/** A coordinator hears about new cross-team overlaps at most this often. */
export const TEAM_OVERLAP_NOTICE_INTERVAL_MS = 10 * 60_000;

/**
 * A stored changed path ending in `/` is a top-level directory: the item changed more than
 * {@link TEAM_CHANGED_PATHS_MAX} paths, so only its top-level entries were kept.
 */
export const TEAM_CHANGED_DIR_SUFFIX = "/";

/** Most exclusive path globs one project lists, and their UTF-8 budget serialized. */
export const TEAM_EXCLUSIVE_PATHS_MAX = 50;
export const TEAM_EXCLUSIVE_PATHS_MAX_BYTES = 4 * 1024;
export const TEAM_EXCLUSIVE_PATH_MAX_LENGTH = 200;

/**
 * The lock key a work item holds while its changes touch the project's exclusive paths: one lock
 * per project (`team_work_items (project_id, exclusive_key)` is unique), taken at `work.ready`,
 * released when the holder is merged or cancelled, or by a person with project manage access.
 */
export const TEAM_EXCLUSIVE_LOCK_KEY = "paths";

/**
 * Teams settings of a project (`projects.chapter_settings.teams`). Example for NarraFork itself,
 * where only one in-flight branch may add a migration:
 * `{ "exclusivePaths": ["drizzle/**", "drizzle-postgres/**", "server/db/schema.ts"] }`.
 * Nothing is filled in automatically.
 */
export interface TeamProjectSettings {
	/** Path globs (relative to the repository root, `**` for any depth) only one item may change at a time. */
	exclusivePaths?: string[];
}

/** Events written by X. */
export type TeamOverlapEventKind =
	| "work.overlap"
	| "work.exclusive_taken"
	| "work.exclusive_refused"
	| "work.exclusive_released";

/** How much of a work item the reader may see. */
export type TeamOverlapAccess = "member" | "reader" | "hidden";

/**
 * A work item in an overlap, as one reader may see it: a member of its team sees it whole; a
 * reader of the team's coordinator sees the team name and the item title; anyone else sees only
 * that it is another team's.
 */
export interface TeamOverlapItemRef {
	access: TeamOverlapAccess;
	/** Reader and member. */
	teamId?: string;
	teamName?: string;
	title?: string;
	/** Member only. */
	id?: string;
	state?: TeamWorkItemState;
	branch?: string | null;
	exclusiveKey?: string | null;
}

export interface TeamOverlapEntry {
	/** A file path, or a top-level directory ending in `/` when compared by directory. */
	path: string;
	kind: "file" | "dir";
	/** The items touching it (at least two), in a stable order. */
	items: TeamOverlapItemRef[];
}

export interface TeamExclusiveLockView {
	key: string;
	holder: TeamOverlapItemRef;
	/** The reader may force-release it (project manage access). */
	canRelease: boolean;
	/** The holder's id, for the release call (only when the reader may release it). */
	holderId?: string;
}

/** `GET /api/projects/:projectId/team-overlaps`. */
export interface TeamOverlapResponse {
	/** When the overlaps were computed from the stored changed paths (null: none yet). */
	computedAt: string | null;
	/** Active work items looked at (at most {@link TEAM_OVERLAP_PROJECT_ITEMS}). */
	activeItems: number;
	/** More active items exist than were looked at. */
	activeItemsCapped: boolean;
	entries: TeamOverlapEntry[];
	/** Entries not listed (over {@link TEAM_OVERLAP_LIST_LIMIT}). */
	moreEntries: number;
	exclusivePaths: string[];
	locks: TeamExclusiveLockView[];
}
