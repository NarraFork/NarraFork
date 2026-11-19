/**
 * The team page's pure rules (docs/PROJECT_TEAMS-PLAN.md §二.4, §二.11; P4): which icon a work
 * item state is drawn with, which marks a card carries, how an activity entry is worded, how the
 * page polls, and in which order "pause all" stops the tree.
 *
 * Status marks are icons, never text glyphs: a work item state is drawn with the outline's state
 * badge (`OutlineStatusIcon`, the single source in `shared/outline-status.ts` +
 * `outline-icons.ts`), mapped here.
 *
 * Pure: no DOM, no React.
 */
import type { OutlineStatusKey } from "@shared/outline-status";
import {
	boardColumnIsFinished,
	boardColumnOf,
	TEAM_BOARD_COLUMNS,
	type TeamActivityEvent,
	type TeamBoardColumn,
	type TeamBoardItem,
	type TeamPageSummary,
	type TeamPersonDecisionEventKind,
	type TeamWorkItemState,
} from "@shared/project-teams";

export { boardColumnOf, TEAM_BOARD_COLUMNS };

/** A work item state as the outline's state badge (icon on a tinted background). */
export const WORK_ITEM_STATUS_ICON: Record<TeamWorkItemState, OutlineStatusKey> = {
	queued: "todo",
	in_progress: "doing",
	in_review: "waiting",
	// An arrow handing on (not a check: a ready item is not done until merged back).
	ready: "delegated",
	merged: "done",
	cancelled: "cancelled",
};

/**
 * The state a column is named after. A card whose state differs (a ready item in the review
 * column) also says its state in words, so its icon is never read as the column's.
 */
export const BOARD_COLUMN_PRIMARY_STATE: Record<TeamBoardColumn, TeamWorkItemState> = {
	queued: "queued",
	in_progress: "in_progress",
	review: "in_review",
	done: "merged",
	cancelled: "cancelled",
};

export function cardNeedsStateChip(item: Pick<TeamBoardItem, "state">): boolean {
	return BOARD_COLUMN_PRIMARY_STATE[boardColumnOf(item.state)] !== item.state;
}

/**
 * A card's worker status, kept current without refetching the board: the summary lists every
 * running session (when it is not capped), so a worker in it has that status and a worker the
 * card last saw running but that is no longer listed has stopped.
 */
export function liveWorkerStatus(
	worker: { id: string; status: string },
	summary: Pick<TeamPageSummary, "runningAgents" | "runningCount"> | undefined,
): string {
	if (!summary) return worker.status;
	const listed = summary.runningAgents.find((agent) => agent.id === worker.id);
	if (listed) return listed.status;
	const complete = summary.runningCount <= summary.runningAgents.length;
	if (complete && (worker.status === "working" || worker.status === "waiting")) return "idle";
	return worker.status;
}

/** A board column's header badge. */
export const BOARD_COLUMN_STATUS_ICON: Record<TeamBoardColumn, OutlineStatusKey> = {
	queued: "todo",
	in_progress: "doing",
	review: "waiting",
	done: "done",
	cancelled: "cancelled",
};

/**
 * Extra facts a card shows besides its state and last review verdict. The integration marks of
 * plan §二.4 ("in dev", "old commit in dev", "conflict") come with the integration PRs.
 */
export type CardMark = "exclusive" | "cleanable";

export function cardMarks(item: TeamBoardItem): CardMark[] {
	const marks: CardMark[] = [];
	if (item.exclusiveKey) marks.push("exclusive");
	// Finished but still holding its worktree: someone can clean it up (plan §四.10).
	if ((item.state === "merged" || item.state === "cancelled") && item.hasWorktree)
		marks.push("cleanable");
	return marks;
}

/** Whether a column is folded by default (finished work does not need attention). */
export function columnStartsFolded(column: TeamBoardColumn): boolean {
	return boardColumnIsFinished(column);
}

/** Column total for a header: the summary's count, or the loaded cards before it arrives. */
export function columnTotal(
	column: TeamBoardColumn,
	summary: Pick<TeamPageSummary, "columnCounts"> | undefined,
	loaded: number,
): number {
	return summary ? summary.columnCounts[column] : loaded;
}

export function emptyColumnCounts(): Record<TeamBoardColumn, number> {
	return Object.fromEntries(TEAM_BOARD_COLUMNS.map((column) => [column, 0])) as Record<
		TeamBoardColumn,
		number
	>;
}

/** "50+" past a capped count (the server counts one past its limit). */
export function cappedCount(count: number, limit: number): string {
	return count > limit ? `${limit}+` : String(count);
}

// ── Activity ────────────────────────────────────────────────────────────────

/** Event kinds with their own wording; anything else is shown by its kind. */
const KNOWN_EVENT_KINDS = new Set([
	"team.created",
	"team.brief",
	"team.settings",
	"team.archived",
	"team.unarchived",
	"team.decision",
	"team.checkin",
	"work.created",
	"work.started",
	"work.start_failed",
	"work.review",
	"work.ready",
	"work.sync",
	"work.cancelled",
	"work.cleanup",
	"approval.allowed",
	"approval.denied",
	"question.answered",
	"question.dismissed",
	"question.ignored",
	"question.supplemented",
	"question.deferred",
	"question.answered_by_ai",
]);

/** The i18n key (under `teams.event.`) of an event's headline. */
export function eventLabelKey(kind: string): string {
	if (kind.startsWith("coordinator.overrun.")) return "overrun";
	return KNOWN_EVENT_KINDS.has(kind) ? kind.replace(".", "_") : "other";
}

const text = (value: unknown, max = 280): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The second line of an activity entry: an i18n key (under `teams.eventNote.`) with its values,
 * or the decision's own words. Values from agents are shown as plain text.
 */
export function eventNote(
	event: Pick<TeamActivityEvent, "kind" | "detail">,
): { key: string; values: Record<string, string | number> } | null {
	const detail = event.detail;
	if (!detail) return null;
	switch (event.kind) {
		case "team.decision": {
			const summary = text(detail.summary, 600);
			return summary ? { key: "text", values: { text: summary } } : null;
		}
		case "work.review": {
			const verdict = detail.verdict === "blocker" ? "blocker" : "clear";
			return {
				key: verdict === "blocker" ? "reviewBlocker" : "reviewClear",
				values: { round: num(detail.round) ?? 0, findings: num(detail.findings) ?? 0 },
			};
		}
		case "work.cancelled": {
			if (detail.reason === "no_changes") return { key: "cancelledNoChanges", values: {} };
			const reason = text(detail.reason);
			return reason ? { key: "text", values: { text: reason } } : null;
		}
		case "work.sync": {
			if (detail.outcome === "up_to_date") return { key: "syncUpToDate", values: {} };
			if (detail.outcome === "handed_off")
				return { key: detail.delivered ? "syncHandedOff" : "syncNotDelivered", values: {} };
			return null;
		}
		case "team.checkin": {
			const minutes = num(detail.minutes);
			return minutes !== null ? { key: "checkin", values: { minutes } } : null;
		}
		case "work.created": {
			const branch = text(detail.branch, 200);
			return branch ? { key: "branch", values: { branch } } : null;
		}
		case "approval.allowed":
		case "approval.denied":
		case "question.answered":
		case "question.dismissed":
		case "question.ignored":
		case "question.supplemented":
		case "question.deferred":
		case "question.answered_by_ai": {
			// A plan is named as such, never by its tool's name (ExitPlanMode).
			const tool = detail.approvalKind === "plan" ? null : (text(detail.tool, 120) ?? "");
			const agent = text(detail.agentTitle, 120);
			const depth = num(detail.depth) ?? 1;
			if (tool === null) {
				if (depth === 0) return { key: "decisionPlanCoordinator", values: {} };
				return agent
					? { key: "decisionPlan", values: { agent } }
					: { key: "decisionPlanAgent", values: {} };
			}
			// The coordinator's own call is named as such; a subagent's by its session title.
			if (depth === 0) return { key: "decisionCoordinator", values: { tool } };
			return agent
				? { key: "decision", values: { tool, agent } }
				: { key: "decisionAgent", values: { tool } };
		}
		default:
			if (event.kind.startsWith("coordinator.overrun.")) {
				const size = num(detail.size);
				const limit = num(detail.limit);
				const tool = text(detail.tool, 60) ?? "";
				return size !== null && limit !== null
					? { key: "overrun", values: { tool, size, limit } }
					: null;
			}
			return null;
	}
}

// ── Live updates ────────────────────────────────────────────────────────────

/** First and longest delay between summary polls. */
export const SUMMARY_POLL_MIN_MS = 4_000;
export const SUMMARY_POLL_MAX_MS = 60_000;

/** Poll again soon after a change; back off (doubling, capped) while nothing changes. */
export function nextPollDelay(previous: number, changed: boolean): number {
	if (changed) return SUMMARY_POLL_MIN_MS;
	return Math.min(SUMMARY_POLL_MAX_MS, Math.max(SUMMARY_POLL_MIN_MS, previous * 2));
}

/**
 * What the board's cards depend on: work item changes (every one writes an event; counts move
 * with states). Agent statuses are not in it: cards take those from the summary.
 */
export function boardSignature(summary: TeamPageSummary | undefined): string {
	if (!summary) return "";
	return JSON.stringify([summary.lastEventId, summary.columnCounts]);
}

/** Everything the top bar shows: a change resets the poll backoff. */
export function summarySignature(summary: TeamPageSummary | undefined): string {
	if (!summary) return "";
	return JSON.stringify([
		boardSignature(summary),
		summary.runningAgents.map((agent) => [agent.id, agent.status]),
		summary.coordinatorStatus,
		summary.runningCount,
		summary.pendingApprovalCount,
	]);
}

/** Coalescing of socket nudges: 400 ms after the last frame, but never more than 2 s after the first. */
export const NUDGE_DEBOUNCE_MS = 400;
export const NUDGE_MAX_WAIT_MS = 2_000;

/** How long to wait before refetching, given how long ago the first pending frame came. */
export function nudgeDelay(sinceFirstMs: number): number {
	return Math.max(0, Math.min(NUDGE_DEBOUNCE_MS, NUDGE_MAX_WAIT_MS - sinceFirstMs));
}

/**
 * The sessions "pause all" stops, coordinator first (so it hands out no new work while its
 * workers stop), then the others in the order listed.
 */
export function pauseOrder(teamId: string, running: readonly { id: string }[]): string[] {
	const ids = running.map((agent) => agent.id);
	return [...ids.filter((id) => id === teamId), ...ids.filter((id) => id !== teamId)];
}

/**
 * What "pause all" did: sessions whose turn it stopped, sessions that had already stopped by
 * the time it got there, requests that failed; `more` when over the 500 it reads.
 */
export interface PauseOutcome {
	stopped: number;
	alreadyIdle: number;
	failed: number;
	more: boolean;
}

/** The notice after "pause all": paused only when every running session was stopped. */
export function pauseNotice(outcome: PauseOutcome): {
	color: "green" | "red" | "yellow";
	key: "paused" | "pausedSomeIdle" | "pausePartial" | "pauseNothing" | "pauseMore";
} {
	if (outcome.failed > 0) return { color: "red", key: "pausePartial" };
	if (outcome.more) return { color: "yellow", key: "pauseMore" };
	if (outcome.stopped === 0) return { color: "yellow", key: "pauseNothing" };
	if (outcome.alreadyIdle > 0) return { color: "green", key: "pausedSomeIdle" };
	return { color: "green", key: "paused" };
}

/** Widths of the team page's columns (px). */
export const TEAM_TEAMS_WIDTH = 232;
export const TEAM_SIDE_WIDTH = 380;
/** The conversation never gets narrower than this beside other columns. */
export const TEAM_CONVERSATION_MIN_WIDTH = 480;

export type TeamWorkspaceLayout = "columns" | "split" | "tabs";

/** The layout for the frame's own width (not the viewport's: the app sidebar takes some). */
export function teamWorkspaceLayout(width: number): TeamWorkspaceLayout {
	if (width >= TEAM_TEAMS_WIDTH + TEAM_CONVERSATION_MIN_WIDTH + TEAM_SIDE_WIDTH) return "columns";
	if (width >= TEAM_CONVERSATION_MIN_WIDTH + TEAM_SIDE_WIDTH) return "split";
	return "tabs";
}

/** The page's narrow-screen tabs. */
export const TEAM_PAGE_TABS = ["conversation", "board", "activity"] as const;
export type TeamPageTab = (typeof TEAM_PAGE_TABS)[number];

// ── People (M1) ─────────────────────────────────────────────────────────────

/** The i18n key (under `teams.approvals.recent.`) of a recent decision's line. */
export function recentDecisionKey(kind: TeamPersonDecisionEventKind): RecentDecisionKey {
	return RECENT_DECISION_KEYS[kind] ?? "allowed";
}

/**
 * The i18n key (under `teams.approvals.recent.`) of a recent decision's line: a plan's approval
 * or return has its own wording ("approved a plan"), anything else names its tool.
 */
export function recentDecisionTextKey(
	kind: TeamPersonDecisionEventKind,
	approvalKind: string,
): string {
	const key = recentDecisionKey(kind);
	return approvalKind === "plan" && (key === "allowed" || key === "denied") ? `${key}Plan` : key;
}

const RECENT_DECISION_KEYS = {
	"approval.allowed": "allowed",
	"approval.denied": "denied",
	"question.answered": "answered",
	"question.dismissed": "dismissed",
	"question.ignored": "ignored",
	"question.supplemented": "supplemented",
	"question.deferred": "deferred",
	"question.answered_by_ai": "answeredByAi",
} as const satisfies Record<TeamPersonDecisionEventKind, string>;
export type RecentDecisionKey = (typeof RECENT_DECISION_KEYS)[TeamPersonDecisionEventKind];

/**
 * What the members drawer says about the coordinator's broad audiences (keys under
 * `teams.members.audience.`): who is a member or an onlooker without being listed by name.
 */
export function audienceNotes(visibility: string, writeAudience: string): string[] {
	const notes: string[] = [];
	if (writeAudience === "project") notes.push("projectWrite");
	if (writeAudience === "public") notes.push("publicWrite");
	if (visibility === "project" && writeAudience !== "public") notes.push("projectRead");
	if (visibility === "public") notes.push("publicRead");
	return notes;
}
