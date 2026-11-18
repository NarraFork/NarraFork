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
	TEAM_BOARD_COLUMNS,
	type TeamActivityEvent,
	type TeamBoardColumn,
	type TeamBoardItem,
	type TeamPageSummary,
	type TeamWorkItemState,
} from "@shared/project-teams";

export { boardColumnOf, TEAM_BOARD_COLUMNS } from "@shared/project-teams";

/** A work item state as the outline's state badge (icon on a tinted background). */
export const WORK_ITEM_STATUS_ICON: Record<TeamWorkItemState, OutlineStatusKey> = {
	queued: "todo",
	in_progress: "doing",
	in_review: "waiting",
	ready: "newly_done",
	merged: "done",
	cancelled: "cancelled",
};

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

/** What the board and the activity depend on: a change refetches them. */
export function boardSignature(summary: TeamPageSummary | undefined): string {
	if (!summary) return "";
	return JSON.stringify([
		summary.lastEventId,
		summary.columnCounts,
		summary.runningAgents.map((agent) => [agent.id, agent.status]),
	]);
}

/** Everything the top bar shows: a change resets the poll backoff. */
export function summarySignature(summary: TeamPageSummary | undefined): string {
	if (!summary) return "";
	return JSON.stringify([
		boardSignature(summary),
		summary.coordinatorStatus,
		summary.runningCount,
		summary.pendingApprovalCount,
	]);
}

/**
 * The sessions "pause all" stops, coordinator first (so it hands out no new work while its
 * workers stop), then the workers before their helpers as listed.
 */
export function pauseOrder(teamId: string, summary: TeamPageSummary | undefined): string[] {
	if (!summary) return [];
	const ids = summary.runningAgents.map((agent) => agent.id);
	return [...ids.filter((id) => id === teamId), ...ids.filter((id) => id !== teamId)];
}

/** The page's narrow-screen tabs. */
export const TEAM_PAGE_TABS = ["conversation", "board", "activity"] as const;
export type TeamPageTab = (typeof TEAM_PAGE_TABS)[number];
