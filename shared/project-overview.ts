/**
 * project-overview.ts — the wire shapes and limits of the redesigned project pages: the project
 * list's per-project summary, the project page's 「等你处理」, its team cards and its session list.
 *
 * Every read behind these shapes is bounded (a cap per query, indexed, no large columns) and
 * SQLite only, like the team and narrator surfaces they read (`server/services/project-overview.ts`).
 */

import type {
	TeamBoardColumn,
	TeamBoardItem,
	TeamPendingApproval,
	TeamSummary,
	TeamWorkerActivity,
} from "./project-teams";

// ── The project list ────────────────────────────────────────────────────────

/** Projects one summary request covers (the list renders at most this many cards). */
export const PROJECT_SUMMARY_PROJECTS_LIMIT = 200;
/** Rows each summary query reads across all projects (running sessions, teams, pending calls). */
export const PROJECT_SUMMARY_ROW_CAP = 500;
/** Recent sessions read, newest first, to find each project's last activity. */
export const PROJECT_SUMMARY_ACTIVITY_SCAN = 2_000;

/** One project card's numbers. Counts are lower bounds when `capped`. */
export interface ProjectListSummary {
	projectId: string;
	/** Readable primary sessions linked to the project that are working or waiting (no coordinators). */
	runningSessionCount: number;
	/** Active teams whose coordinator the caller can read. */
	teamCount: number;
	/** What waits for the caller (pending calls they may decide, ready work items of their teams). */
	waitingCount: number;
	/** The newest change of a readable session of the project, else the project's own update. */
	lastActivityAt: string | null;
	/** A read hit its cap: the counts may be higher. */
	capped: boolean;
}

export interface ProjectListSummaryResponse {
	summaries: ProjectListSummary[];
}

// ── The project page: 「N 位成员」 ───────────────────────────────────────────

/** Members the header counts at most (one more means "more"). */
export const PROJECT_MEMBER_COUNT_LIMIT = 999;

/**
 * `GET /api/projects/:id/members/count`: how many people are members of the project — its owner
 * and everyone holding a project grant — without the list (the settings page reads that).
 */
export interface ProjectMemberCount {
	count: number;
	/** More than {@link PROJECT_MEMBER_COUNT_LIMIT}: `count` is the limit. */
	more: boolean;
}

// ── The project page: 「等你处理」 ───────────────────────────────────────────

/** Pending calls the project's 「等你处理」 lists (one more means "more"). */
export const PROJECT_ATTENTION_LIMIT = 50;
/** Ready work items (可以合并) it lists. */
export const PROJECT_ATTENTION_READY_LIMIT = 20;

/** Where a waiting entry comes from: a team (its tree) or an ordinary session. */
export type ProjectAttentionSource =
	| { kind: "team"; teamId: string; name: string }
	| { kind: "session"; narratorId: string; title: string | null; ownerName: string | null };

export type ProjectAttentionEntry =
	| {
			kind: "approval";
			/** The call, shaped like the team page's (depth 0 = the team's coordinator or the session). */
			approval: TeamPendingApproval;
			source: ProjectAttentionSource;
	  }
	| {
			kind: "merge";
			item: TeamBoardItem;
			/** The team's base branch (the merge card names it). */
			base: string;
			source: Extract<ProjectAttentionSource, { kind: "team" }>;
	  };

export interface ProjectAttentionResponse {
	entries: ProjectAttentionEntry[];
	/** More pending calls (or ready items) wait than listed. */
	more: boolean;
	/** The scan stopped before reading every pending call. */
	unscanned: boolean;
}

// ── The project page: team cards ────────────────────────────────────────────

/** Teams per page when the list carries card numbers (`counts=true`). */
export const PROJECT_TEAM_CARDS_LIMIT = 24;

/** A team card's numbers (the team list with `counts=true`). */
export interface TeamCardCounts {
	columnCounts: Record<TeamBoardColumn, number>;
	/** Items in `ready` (part of the review column). */
	readyCount: number;
	/** Working or waiting sessions of the tree, counted up to 21. */
	runningCount: number;
	/** Visible pending calls, members only (null for onlookers), counted up to 51. */
	pendingApprovalCount: number | null;
	coordinatorStopReason: string | null;
	coordinatorMessageCount: number;
	/** The newest team event (the card's "3 天前"). */
	lastEventAt: string | null;
}

export interface TeamCard extends TeamSummary {
	card?: TeamCardCounts;
}

// ── The project page: sessions ──────────────────────────────────────────────

export const PROJECT_SESSION_VIEWS = ["active", "all", "mine"] as const;
export type ProjectSessionView = (typeof PROJECT_SESSION_VIEWS)[number];

/** Rows per page of the session list. */
export const PROJECT_SESSIONS_PAGE_LIMIT = 30;
/** Each tab's count is counted up to this (then "999+"). */
export const PROJECT_SESSION_COUNT_CAP = 999;
/** 「进行中」 lists running sessions, then the sessions changed in the last this many days. */
export const PROJECT_SESSIONS_RECENT_DAYS = 7;

/** One row of the project's session list. Never carries large columns. */
export interface ProjectSessionRow {
	id: string;
	title: string | null;
	status: string;
	/** `running`: working or waiting now; `recent`: the rest (「最近 7 天」 in the active view). */
	group: "running" | "recent";
	updatedAt: string;
	owner: {
		userId: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	/** A running session's newest tool call (one indexed probe per running row of the page). */
	activity: TeamWorkerActivity | null;
}

export interface ProjectSessionPage {
	items: ProjectSessionRow[];
	nextCursor: string | null;
	/** Each tab's count up to {@link PROJECT_SESSION_COUNT_CAP} + 1; first page only. */
	counts: Record<ProjectSessionView, number> | null;
}
