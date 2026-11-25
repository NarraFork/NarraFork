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

/** The coordinator trait lives in a leaf module the DB read worker may import. */
export { hasTeamTrait, TEAM_TRAIT } from "./team-trait";

export const TEAM_STATUSES = ["active", "archived"] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** UTF-8 byte budget of the team brief (shared rules for the coordinator and its subagents). */
export const TEAM_BRIEF_MAX_BYTES = 4 * 1024;
/** UTF-8 byte budget of the serialized team settings. */
export const TEAM_SETTINGS_MAX_BYTES = 16 * 1024;
/** Longest team name accepted at creation (the narrator title). */
export const TEAM_NAME_MAX_LENGTH = 120;

/**
 * Injection sources of the notes a session gets when it is upgraded to a team or its team is
 * disbanded (`server/services/teams/team-conversion.ts`). Written with `schedule: "none"`: they
 * inform the session and never hand it the next turn (`shared/continue-tail.ts`).
 */
export const TEAM_UPGRADE_NOTE_SOURCE = "team_upgrade";
export const TEAM_DISBAND_NOTE_SOURCE = "team_disband";
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

/** Team-level event kinds recorded by P1 (overruns and decisions aside). Later PRs add their own. */
export const TEAM_LEVEL_EVENT_KINDS = [
	"team.created",
	"team.brief",
	"team.settings",
	"team.archived",
	"team.unarchived",
] as const;
export type TeamEventKind =
	| (typeof TEAM_LEVEL_EVENT_KINDS)[number]
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
	/** D: replace a queued item's dependencies (`dependsOn`). */
	"work.update",
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
/** Longest branch hint (English words naming a work item's branch) `work.create` takes. */
export const TEAM_WORK_BRANCH_HINT_MAX_LENGTH = 80;
/** Text budget (UTF-8 bytes) of a decision recorded on people's behalf. */
export const TEAM_DECISION_MAX_BYTES = 2 * 1024;
/** Bounds of a check-in delay in minutes: at least five minutes, at most one day. */
export const TEAM_CHECKIN_MIN_MINUTES = 5;
export const TEAM_CHECKIN_MAX_MINUTES = 24 * 60;
/** Most work items one `work.list` returns (open ones first). */
export const TEAM_WORK_LIST_LIMIT = 30;

/**
 * Work item and team events written by P3, each with its person or agent. A runtime list so the
 * activity feed can prove every kind has its own wording.
 */
export const TEAM_WORK_EVENT_KINDS = [
	"work.created",
	"work.started",
	"work.start_failed",
	"work.review",
	"work.ready",
	"work.sync",
	"work.cancelled",
	"work.cleanup",
	"team.checkin",
	TEAM_DECISION_EVENT_KIND,
	/** R: a person sent the item back with a reason (`TEAM_WORK_RETURNED_EVENT_KIND`). */
	"work.returned",
	/** D: the coordinator set or replaced an item's dependencies. */
	"work.dependencies_changed",
	/** D: the last dependency of a queued item merged; the coordinator was told it can start. */
	"work.unblocked",
] as const;
export type TeamWorkEventKind = (typeof TEAM_WORK_EVENT_KINDS)[number];

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
	/**
	 * R: a running worker's newest tool call, in the summary's running list only (at most
	 * {@link TEAM_RUNNING_AGENTS_LIMIT} probes per summary), so a row's "doing now" stays live.
	 */
	activity?: TeamWorkerActivity | null;
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
	/** R: what a working or waiting worker did last; absent or null otherwise. */
	activity?: TeamWorkerActivity | null;
	/**
	 * D: the items this one waits for (at most {@link TEAM_WORK_DEPENDENCIES_MAX}), oldest created
	 * first (ties by id).
	 */
	dependsOn?: TeamWorkDependencyRef[];
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

/** One question answered in place on the team page (`TeamPendingApproval.answerForm`). */
export interface TeamQuestionForm {
	/** The answers key the session's own form sends (the question's header), also its title. */
	header: string;
	/** The question's full prompt under its title (the normalized `description`), if any. */
	description: string | null;
	/** Each option's explanation, in the order of {@link options}; null when it has none. */
	optionDescriptions: (string | null)[];
	/**
	 * The option titles exactly as the session's form sends them (the answer value): never
	 * shortened here, the page clips only what it displays. At most
	 * {@link TEAM_QUESTION_OPTIONS_MAX}; a question with more has no in-place form.
	 */
	options: string[];
	multiSelect: boolean;
}

/** Options of an in-place question the approvals list carries. */
export const TEAM_QUESTION_OPTIONS_MAX = 6;

/** A tool call of the team tree waiting for a person. */
export interface TeamPendingApproval {
	/** The permission request id (the tool call id) the approve / deny routes take. */
	id: string;
	agent: TeamAgentRef;
	/** 0 = the coordinator, 1 = a worker, 2 = a worker's helper. */
	depth: number;
	/** R: the session's parent (a helper's worker), to tie the call to a work item. */
	parentId?: string | null;
	toolName: string;
	/** "tool": approve / deny here; anything else is answered in the session (open it). */
	kind: TeamApprovalKind;
	/** A short, bounded view of the input (command, path, URL, …). */
	preview: string;
	/** For a question: the questions asked (at most three, each clipped). */
	questions: string[];
	/**
	 * R: a call asking exactly one question, read whole from its input's bounded prefix: the
	 * answer key (its header) and its options, so it can be answered in place. Absent otherwise
	 * (several questions, or an input too long to read here: its session has the full form).
	 */
	answerForm?: TeamQuestionForm | null;
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
	/** R: messages in the coordinator's conversation (0: nobody has spoken to it yet). */
	coordinatorMessageCount?: number;
	/** R: how the coordinator's last turn ended (`user_interrupt`: a person stopped it). */
	coordinatorStopReason?: string | null;
	/**
	 * R: finished (merged / cancelled) items still holding a worktree, counted up to
	 * {@link TEAM_HELD_WORKTREES_LIMIT} + 1: the team cannot be disbanded until they are cleaned.
	 */
	heldWorktreeCount?: number;
}

/** Finished items holding a worktree the summary counts (one more means "more"). */
export const TEAM_HELD_WORKTREES_LIMIT = 50;

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
export const TEAM_OVERLAP_EVENT_KINDS = [
	"work.merged",
	"work.overlap",
	"work.exclusive_taken",
	"work.exclusive_refused",
	"work.exclusive_released",
] as const;
export type TeamOverlapEventKind = (typeof TEAM_OVERLAP_EVENT_KINDS)[number];

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

// ── R: the team page redesign (work list, drawer, return with a reason) ─────────────────────

/**
 * What a running worker did last, for its row's second line: the newest tool call of its
 * session (name and a short preview of its input). Only for items whose worker is working or
 * waiting; the board reads it with one indexed probe per such row.
 */
export interface TeamWorkerActivity {
	toolName: string;
	/** At most {@link TEAM_ACTIVITY_PREVIEW_CHARS} characters. */
	preview: string;
	at: string;
}

/** Characters of a worker's newest tool input a row shows. */
export const TEAM_ACTIVITY_PREVIEW_CHARS = 120;

/** A branch's size against its merge base: lines added and removed, files changed. */
export interface TeamWorkDiffStat {
	added: number;
	removed: number;
	files: number;
	/** Files git counts as binary (no line counts). */
	binaryFiles: number;
	/** The listing was over its byte cap: the counts cover what was read. */
	truncated: boolean;
}

/** Most work items `GET …/work-stats` takes in one request. */
export const TEAM_WORK_STATS_IDS_MAX = 50;

/** `GET …/teams/:teamId/work-stats?ids=…`: null for an item whose size is not known. */
export interface TeamWorkStatsResponse {
	stats: Record<string, TeamWorkDiffStat | null>;
}

/** One file a work item's branch changed; null line counts for a binary file. */
export interface TeamWorkFileChange {
	path: string;
	added: number | null;
	removed: number | null;
}

/** Most changed files the drawer lists. */
export const TEAM_WORK_FILES_LIMIT = 300;
/** Most events of one work item the drawer reads (its timeline and review rounds). */
export const TEAM_WORK_EVENTS_LIMIT = 100;
/** Bytes of one file's diff the drawer shows; past it the text is cut off. */
export const TEAM_WORK_DIFF_MAX_BYTES = 64 * 1024;

/**
 * Event of a person sending a work item back to its worker with a reason (from in review or
 * ready to in progress). Counted as a review round with a blocker verdict, so the item needs a
 * new clear review before it can be ready again.
 */
export const TEAM_WORK_RETURNED_EVENT_KIND = "work.returned";
/** States a person may return an item from. */
export const TEAM_RETURNABLE_STATES: readonly TeamWorkItemState[] = ["in_review", "ready"];
/** Characters of a return reason. */
export const TEAM_RETURN_REASON_MAX_LENGTH = 2000;

/** One review round of a work item, from its events (an agent's review or a person's return). */
export interface TeamWorkReviewRound {
	eventId: string;
	round: number;
	/** The person's user id, or the agent's session id (the coordinator for agents' rounds). */
	actorId: string | null;
	verdict: TeamReviewVerdict;
	findings: number | null;
	/** `person`: returned by a person, with their reason. */
	by: "agent" | "person" | "system";
	actorName: string | null;
	reason: string | null;
	at: string;
}

/** `GET …/teams/:teamId/work/:itemId`: everything the work item drawer shows but the diff text. */
export interface TeamWorkItemDetail {
	item: TeamBoardItem;
	/** The base branch the item merges into. */
	base: string;
	/** Commits on the branch not in the base; null when git could not tell. */
	aheadBy: number | null;
	stat: TeamWorkDiffStat | null;
	/** At most {@link TEAM_WORK_FILES_LIMIT}, in git's order. */
	files: TeamWorkFileChange[];
	filesMore: boolean;
	/** A file's diff can be read (`…/work/:itemId/diff?path=`). */
	diffAvailable: boolean;
	/** Oldest first. */
	reviews: TeamWorkReviewRound[];
	/** The item's own events, oldest first, at most {@link TEAM_WORK_EVENTS_LIMIT} (the newest). */
	events: TeamActivityEvent[];
	eventsMore: boolean;
	/** The caller may return it now (member, active team, a returnable state). */
	canReturn: boolean;
	/**
	 * D: items of this team that depend on this one, oldest created first, at most
	 * {@link TEAM_WORK_DEPENDENTS_LIMIT}.
	 */
	dependents?: TeamWorkDependencyRef[];
	dependentsMore?: boolean;
}

/** `GET …/teams/:teamId/work/:itemId/diff?path=`: one file's diff, cut at the byte cap. */
export interface TeamWorkFileDiff {
	path: string;
	text: string;
	truncated: boolean;
}

/** `POST …/teams/:teamId/work/:itemId/return`. */
export interface TeamWorkReturnResponse {
	item: TeamBoardItem;
	/** Whether the note reached the coordinator (it relays the reason to the worker). */
	delivered: boolean;
}

// ── D: dependencies between work items ───────────────────────────────────────

/** Most dependencies one work item may have. */
export const TEAM_WORK_DEPENDENCIES_MAX = 20;
/** Most items that depend on one item the drawer lists. */
export const TEAM_WORK_DEPENDENTS_LIMIT = 50;

/**
 * Injection source of the note a coordinator gets when the last dependency of a queued item
 * merged (woken when idle, like `team_return`).
 */
export const TEAM_UNBLOCKED_NOTE_SOURCE = "team_unblocked";

/**
 * Whether a dependency in this state lets its dependent start: only `merged` does. `ready` does
 * not (the dependent's branch would start from a base without it); `cancelled` blocks until the
 * coordinator removes or replaces it.
 */
export function dependencySatisfied(state: TeamWorkItemState): boolean {
	return state === "merged";
}

/** Another work item of the same team, as a dependency or a dependent. */
export interface TeamWorkDependencyRef {
	id: string;
	title: string;
	state: TeamWorkItemState;
}

/** The dependencies an item still waits for (not merged), in the given order. */
export function dependencyBlockers<T extends { state: TeamWorkItemState }>(
	dependsOn: readonly T[] | undefined,
): T[] {
	return (dependsOn ?? []).filter((dependency) => !dependencySatisfied(dependency.state));
}
