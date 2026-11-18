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

// ── P4: the team page ────────────────────────────────────────────────────────

/**
 * The board's five columns (plan §二.4) and the work item states each shows. "Review" holds
 * both items under review and items ready to merge; "done" is merged back.
 */
export const TEAM_BOARD_COLUMNS = ["queued", "in_progress", "review", "done", "cancelled"] as const;
export type TeamBoardColumn = (typeof TEAM_BOARD_COLUMNS)[number];

export const TEAM_BOARD_COLUMN_STATES: Readonly<
	Record<TeamBoardColumn, readonly TeamWorkItemState[]>
> = Object.freeze({
	queued: ["queued"],
	in_progress: ["in_progress"],
	review: ["in_review", "ready"],
	done: ["merged"],
	cancelled: ["cancelled"],
});

/** The board column a work item state belongs to. */
export function boardColumnOf(state: TeamWorkItemState): TeamBoardColumn {
	for (const column of TEAM_BOARD_COLUMNS)
		if (TEAM_BOARD_COLUMN_STATES[column].includes(state)) return column;
	return "queued";
}

/** Columns of finished items, newest change first; the others oldest first (their queue order). */
export function boardColumnIsFinished(column: TeamBoardColumn): boolean {
	return column === "done" || column === "cancelled";
}

/** Most work items one board column page returns. */
export const TEAM_BOARD_PAGE_LIMIT = 50;
/** Most team events one activity page returns. */
export const TEAM_EVENTS_PAGE_LIMIT = 50;
/** Most pending approvals the team page lists (plan §二.12). */
export const TEAM_APPROVALS_LIMIT = 50;
/** Most running agents the summary names (the count is capped one higher). */
export const TEAM_RUNNING_AGENTS_LIMIT = 20;
/** Most running sessions "pause all" stops in one go (coordinator + both subagent levels). */
export const TEAM_PAUSE_LIMIT = 500;
/** Characters of a tool call's input the approvals list shows. */
export const TEAM_APPROVAL_PREVIEW_CHARS = 300;
/** An event's detail is sent only when its JSON text is at most this many characters. */
export const TEAM_EVENT_DETAIL_PREVIEW_CHARS = 2304;

/** A session of the team tree, as the page names it. */
export interface TeamAgentRef {
	id: string;
	title: string | null;
	/** Narrator run status: idle / working / waiting / archived. */
	status: string;
}

/** One card on the board. Never carries the changed paths or other large columns. */
export interface TeamBoardItem {
	id: string;
	title: string;
	kind: string;
	state: TeamWorkItemState;
	branch: string | null;
	baseRef: string | null;
	/** The recorded head commit, abbreviated to 12 characters. */
	headSha: string | null;
	worker: TeamAgentRef | null;
	reviewRounds: number;
	lastReview: TeamReviewVerdict | null;
	/** Whether a worktree is still recorded (finished items with one can be cleaned). */
	hasWorktree: boolean;
	/** Project-level exclusive lock key, when the item holds one. */
	exclusiveKey: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface TeamBoardColumnPage {
	column: TeamBoardColumn;
	items: TeamBoardItem[];
	nextCursor: string | null;
}

/** One entry of the team's activity log. */
export interface TeamActivityEvent {
	id: string;
	kind: string;
	workItemId: string | null;
	workItemTitle: string | null;
	actorKind: TeamEventActorKind;
	actorId: string | null;
	/** The person's username or the agent's session title, when still known. */
	actorName: string | null;
	/** The event detail when small enough (see {@link TEAM_EVENT_DETAIL_PREVIEW_CHARS}). */
	detail: Record<string, unknown> | null;
	detailOmitted: boolean;
	createdAt: string;
}

export interface TeamActivityPage {
	events: TeamActivityEvent[];
	nextCursor: string | null;
}

/**
 * Pending calls a person answers in the session itself, not with approve / deny: a question
 * needs its answers, a plan its decision, a rule request its rule choice.
 */
export const TEAM_SESSION_DECIDED_TOOLS = {
	AskUserQuestion: "question",
	ExitPlanMode: "plan",
	RequestPermissionRule: "rule",
} as const;
export type TeamApprovalKind =
	| "tool"
	| (typeof TEAM_SESSION_DECIDED_TOOLS)[keyof typeof TEAM_SESSION_DECIDED_TOOLS];

/** The kind of a pending call: approve / deny ("tool"), or answered in its session. */
export function teamApprovalKind(toolName: string): TeamApprovalKind {
	return (TEAM_SESSION_DECIDED_TOOLS as Record<string, TeamApprovalKind>)[toolName] ?? "tool";
}

/** A tool call of the team tree waiting for a person. */
export interface TeamPendingApproval {
	/** The permission request id (the tool call id) the approve / deny routes take. */
	id: string;
	agent: TeamAgentRef;
	/** 0 = the coordinator, 1 = a worker, 2 = a worker's helper. */
	depth: number;
	toolName: string;
	/** "tool": approve / deny here; anything else is answered in the session (open it). */
	kind: TeamApprovalKind;
	/** A short, bounded view of the input (command, path, URL, …). */
	preview: string;
	/** For a question: the questions asked (at most three, each clipped). */
	questions: string[];
	decisionReason: string | null;
	createdAt: string;
}

/** The running sessions of a tree, for "pause all" (members only). */
export interface TeamRunningResponse {
	agents: TeamAgentRef[];
	/** More than {@link TEAM_PAUSE_LIMIT} are running. */
	more: boolean;
}

export interface TeamApprovalsResponse {
	approvals: TeamPendingApproval[];
	/** More visible calls are pending than {@link TEAM_APPROVALS_LIMIT}. */
	more: boolean;
	/**
	 * The scan stopped before reading every pending call (hundreds hidden by running
	 * reflections came first): there may be visible ones it did not reach.
	 */
	unscanned: boolean;
	/**
	 * M1: the latest decisions people took on the tree's calls (approved, denied, answered),
	 * newest first, at most {@link TEAM_RECENT_DECISIONS_LIMIT}.
	 */
	recent: TeamRecentDecision[];
}

/** The team page's top bar; small and cheap so the page can poll it. */
export interface TeamPageSummary {
	teamId: string;
	access: TeamAccess;
	coordinatorStatus: string;
	/** Working or waiting sessions of the tree: coordinator first, then newest first, at most the limit. */
	runningAgents: TeamAgentRef[];
	/** Running sessions counted up to the limit + 1 (a count past the limit means "more"). */
	runningCount: number;
	/** Visible pending approvals counted up to the limit + 1; null for onlookers (members only). */
	pendingApprovalCount: number | null;
	/** Work items per board column. */
	columnCounts: Record<TeamBoardColumn, number>;
	/** The newest team event: the page refetches the board and activity when it changes. */
	lastEventId: string | null;
	lastEventAt: string | null;
}

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
	/**
	 * Path globs (relative to the repository root, `**` for any depth) only one item may change at
	 * a time. `dir/` is stored as `dir/**`; a bare name without glob characters (`drizzle`) covers
	 * that file or directory and everything under it.
	 */
	exclusivePaths?: string[];
}

/** Events written by X. */
export type TeamOverlapEventKind =
	| "work.merged"
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
	/** The overlaps shown are older than the stored paths; a rebuild is running (poll again). */
	stale: boolean;
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

// ── M1: several people in one team ───────────────────────────────────────────

/**
 * A person's place in a team, read from the coordinator's narrator ACL (plan §二.1: no second
 * membership system): write access makes a member (speaks in the conversation, approves and
 * answers), read access an onlooker (watches only).
 */
export type TeamMemberRole = "member" | "onlooker";

/** A person who can reach the team, as the members list shows them. */
export interface TeamMember {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
	role: TeamMemberRole;
	/** The coordinator's owner (manages who else may join). */
	owner: boolean;
	/**
	 * When this person last spoke in the coordinator's conversation, among its latest
	 * {@link TEAM_SPOKE_WINDOW} messages; null when not among them.
	 */
	lastSpokeAt: string | null;
}

/** `GET /api/projects/:projectId/teams/:teamId/members` (members and onlookers). */
export interface TeamMembersResponse {
	members: TeamMember[];
	/** More people than were looked at or listed (see {@link TEAM_MEMBERS_LIST_LIMIT}). */
	more: boolean;
	/** The coordinator's broad read audience: private / project / public. */
	visibility: string;
	/** The coordinator's broad write audience: owner / project / public. */
	writeAudience: string;
	/** The caller may grant and revoke access (the coordinator's owner or an admin). */
	canManage: boolean;
}

/** Most people the members list shows (and the most candidates of each source it checks). */
export const TEAM_MEMBERS_LIST_LIMIT = 100;
/** Messages of the coordinator's conversation read to find when each person last spoke. */
export const TEAM_SPOKE_WINDOW = 500;
/** Most people the team status lists (the rest are counted). */
export const TEAM_STATUS_MEMBERS_LIMIT = 12;

/**
 * Team events of a person's decision on a call of the team tree: who approved, denied, answered,
 * deferred, had the AI answer, dismissed, ignored or followed up (plan §二.12 "记下是谁批的"); an outline plan's
 * decision is `approval.allowed` (draft / lock) or `approval.denied` (return). `actor_id` is the person; the
 * detail names the call. Best-effort: written after the decision, outside its transaction.
 */
export const TEAM_PERSON_DECISION_EVENT_KINDS = [
	"approval.allowed",
	"approval.denied",
	"question.answered",
	/** An asynchronous question closed with the agent told it was dismissed. */
	"question.dismissed",
	/** An asynchronous question closed without telling the agent. */
	"question.ignored",
	/** An answered asynchronous question got a follow-up from a person. */
	"question.supplemented",
	/** A blocking question was turned into an asynchronous one, to answer later. */
	"question.deferred",
	/** A person had the AI answer a blocking question (question reflection) right away. */
	"question.answered_by_ai",
] as const;
export type TeamPersonDecisionEventKind = (typeof TEAM_PERSON_DECISION_EVENT_KINDS)[number];

/** Most recent decisions the approvals drawer lists. */
export const TEAM_RECENT_DECISIONS_LIMIT = 10;

/** A decision a person took on a call of the team tree, for the approvals drawer. */
export interface TeamRecentDecision {
	/** The team event id. */
	id: string;
	kind: TeamPersonDecisionEventKind;
	/** The person who decided, and their username when still known. */
	actorId: string | null;
	actorName: string | null;
	toolName: string;
	approvalKind: TeamApprovalKind;
	/** The session the call belonged to, and its level (0 coordinator, 1 worker, 2 helper). */
	agentId: string | null;
	agentTitle: string | null;
	depth: number;
	createdAt: string;
}
