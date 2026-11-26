/**
 * The redesigned project pages' pure rules (R2): the path tail the header and cards show, how the
 * project's 「等你处理」 entries become the team page's attention cards, how the session list
 * groups its rows (进行中 first, then 「最近 7 天」), what a session row says it is doing, the
 * team cards' numbers and status sentence (the team page's `statusSentence`), and the project
 * list's order (waiting first, then the most recent activity).
 *
 * Pure: no DOM, no React.
 */
import type {
	ProjectAttentionEntry,
	ProjectListSummary,
	ProjectSessionRow,
	ProjectSessionView,
	TeamCard,
} from "@shared/project-overview";
import {
	type AttentionEntry,
	type RowTone,
	type StatusPart,
	type StatusTone,
	statusSentence,
	waitingToolKey,
} from "../teams/team-page-model";

/** The last `segments` parts of a path, after 「…/」 when anything was cut off. */
export function pathTail(path: string | null | undefined, segments = 2): string {
	if (!path) return "";
	const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
	const parts = path.split(/[\\/]+/).filter(Boolean);
	if (parts.length <= segments) return path;
	return `…${separator}${parts.slice(-segments).join(separator)}`;
}

// ── 「等你处理」 ─────────────────────────────────────────────────────────────

/**
 * The project's waiting entries as the team page's attention cards, in the server's order (calls
 * oldest first, then ready items): each keeps where it comes from, so a card names its team or
 * session. Ids are unique across teams (the call's or the item's id).
 */
export function projectAttentionEntries(
	entries: readonly ProjectAttentionEntry[],
): AttentionEntry[] {
	return entries.map((entry) =>
		entry.kind === "merge"
			? {
					kind: "merge",
					id: `merge:${entry.item.id}`,
					item: entry.item,
					source: entry.source,
					base: entry.base,
				}
			: ({
					kind: entry.approval.kind,
					id: `approval:${entry.approval.id}`,
					approval: entry.approval,
					item: null,
					source: entry.source,
				} as AttentionEntry),
	);
}

/** The team a ready item belongs to (the merge card's buttons open that team's page). */
export function teamOfItem(
	entries: readonly ProjectAttentionEntry[],
	itemId: string,
): string | null {
	for (const entry of entries)
		if (entry.kind === "merge" && entry.item.id === itemId) return entry.source.teamId;
	return null;
}

/**
 * What a decision on the project page makes stale (the query keys to refetch): its 「等你处理」,
 * the project list's numbers, the project's team cards and session list, and the team's own page
 * (approvals, summary) when the call came from a team.
 */
export function projectDecisionKeys(projectId: string, entry: AttentionEntry): unknown[][] {
	const keys: unknown[][] = [
		["project-overview", projectId, "attention"],
		["project-overview", "summaries"],
		["teams", "project", projectId],
		["narrators", "project", projectId],
	];
	if (entry.source?.kind === "team") keys.push(["teams", "page", entry.source.teamId]);
	return keys;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface SessionSection {
	/** `running` (no heading), `recent` (「最近 7 天」), or `all` (the 全部 / 我的 tabs). */
	key: "running" | "recent" | "all";
	rows: ProjectSessionRow[];
}

/**
 * The rows of a tab in sections: 进行中 splits into the running sessions and 「最近 7 天」 (in the
 * server's order, which already puts running ones first); 全部 and 我的 are one list. Rows already
 * shown keep their place when a later page repeats one (a status changed between pages).
 */
export function sessionSections(
	rows: readonly ProjectSessionRow[],
	view: ProjectSessionView,
): SessionSection[] {
	const seen = new Set<string>();
	const unique = rows.filter((row) => {
		if (seen.has(row.id)) return false;
		seen.add(row.id);
		return true;
	});
	if (view !== "active") return unique.length ? [{ key: "all", rows: unique }] : [];
	const running = unique.filter((row) => row.group === "running");
	const recent = unique.filter((row) => row.group !== "running");
	const sections: SessionSection[] = [];
	if (running.length) sections.push({ key: "running", rows: running });
	if (recent.length) sections.push({ key: "recent", rows: recent });
	return sections;
}

/** A tab's count: 「999+」 past the server's cap. */
export function sessionCountLabel(count: number | undefined, cap: number): string {
	if (count === undefined) return "";
	return count > cap ? `${cap}+` : String(count);
}

/** A session row's dot: the session status colours (blue running, amber waiting). */
export function sessionTone(status: string): RowTone {
	if (status === "waiting") return "amber";
	if (status === "working") return "blue";
	return "hollow";
}

/** What a session row says it is doing (keys under `teams.page.row.`), or nothing. */
export interface SessionLine {
	key: string;
	values: Record<string, string>;
	detail: string | null;
	/** The verb is a tool's (`teams.page.row.tools.<tool>`). */
	tool: boolean;
	tone: RowTone;
}

export function sessionLine(
	row: Pick<ProjectSessionRow, "status" | "activity">,
): SessionLine | null {
	const activity = row.activity;
	if (row.status === "waiting") {
		const tool = activity?.toolName ?? "";
		if (!tool)
			return { key: "waitingPerson", values: {}, detail: null, tool: false, tone: "amber" };
		const key =
			tool === "AskUserQuestion"
				? "waitingAnswer"
				: tool === "ExitPlanMode"
					? "waitingPlan"
					: waitingToolKey(tool);
		return { key, values: { tool }, detail: activity?.preview || null, tool: false, tone: "amber" };
	}
	if (row.status === "working") {
		if (!activity) return { key: "working", values: {}, detail: null, tool: false, tone: "blue" };
		return {
			key: "activity",
			values: { tool: activity.toolName },
			detail: activity.preview || null,
			tool: true,
			tone: "blue",
		};
	}
	return null;
}

// ── Team cards ──────────────────────────────────────────────────────────────

/**
 * The cards shown: active teams whose coordinator is not archived. The list asks for active
 * teams, but a cached page can outlive an archive (the server keeps no tab of one either).
 */
export function liveTeamCards<T extends Pick<TeamCard, "status" | "coordinatorStatus">>(
	teams: readonly T[],
): T[] {
	return teams.filter((team) => team.status === "active" && team.coordinatorStatus !== "archived");
}

/** A card's three numbers: 进行中 (queued, in progress, in review), 就绪 (ready), 完成 (merged). */
export function teamCardNumbers(card: TeamCard["card"]): {
	inProgress: number;
	ready: number;
	done: number;
} {
	if (!card) return { inProgress: 0, ready: 0, done: 0 };
	const counts = card.columnCounts;
	return {
		inProgress: counts.queued + counts.in_progress + Math.max(0, counts.review - card.readyCount),
		ready: card.readyCount,
		done: counts.done,
	};
}

/** What waits on people in a team: a member's calls and items to accept; an onlooker's items. */
export function teamCardWaiting(team: TeamCard): number {
	const card = team.card;
	if (!card) return 0;
	const member = team.access === "write";
	return (member ? (card.pendingApprovalCount ?? 0) : 0) + card.readyCount;
}

/**
 * The card's status sentence, worded like the team page's header (`statusSentence`): 「4 项进行中
 * · 3 项等你」, 「已暂停 · 2 项进行中」 is the header's 「已暂停」, 「空闲」 with what is done.
 */
export function teamCardStatus(team: TeamCard): { tone: StatusTone; parts: StatusPart[] } | null {
	const card = team.card;
	if (!card) return null;
	const member = team.access === "write";
	const pending = card.pendingApprovalCount ?? 0;
	return statusSentence({
		summary: {
			coordinatorStatus: team.coordinatorStatus,
			columnCounts: card.columnCounts,
			runningCount: card.runningCount,
			coordinatorStopReason: card.coordinatorStopReason,
		},
		member,
		waiting: teamCardWaiting(team),
		// The calls' own items are not known here: only the items to accept are subtracted.
		waitingItems: card.readyCount,
		waitingMore: member && pending > 50,
	});
}

/** The card's amber badge: what waits on this member (none for onlookers). */
export function teamCardBadge(team: TeamCard): number {
	return team.access === "write" ? teamCardWaiting(team) : 0;
}

// ── The project list ────────────────────────────────────────────────────────

export interface ProjectListRow {
	id: string;
	name: string;
	updatedAt?: string | null;
}

/**
 * The list's order: projects with something waiting on you first, then the most recent activity
 * (the summary's, else the project's own update), then the list's own order. Projects without a
 * summary (past the first 200, or before it loads) sort by their own update.
 */
export function sortProjects<T extends ProjectListRow>(
	projects: readonly T[],
	summaries: ReadonlyMap<string, ProjectListSummary>,
): T[] {
	const activity = (project: T) =>
		summaries.get(project.id)?.lastActivityAt ?? project.updatedAt ?? "";
	const waiting = (project: T) => ((summaries.get(project.id)?.waitingCount ?? 0) > 0 ? 1 : 0);
	return projects
		.map((project, index) => ({ project, index }))
		.sort(
			(a, b) =>
				waiting(b.project) - waiting(a.project) ||
				activity(b.project).localeCompare(activity(a.project)) ||
				a.index - b.index,
		)
		.map((entry) => entry.project);
}

/** When a project last changed, as the list card words it (keys under `list.activity.`). */
export function activityAgo(
	iso: string | null | undefined,
	now: Date,
): {
	key: "justNow" | "minutes" | "hours" | "yesterday" | "days" | "date" | "never";
	count: number;
} {
	const at = iso ? new Date(iso).getTime() : Number.NaN;
	if (Number.isNaN(at)) return { key: "never", count: 0 };
	const minutes = Math.floor(Math.max(0, now.getTime() - at) / 60_000);
	if (minutes < 1) return { key: "justNow", count: 0 };
	if (minutes < 60) return { key: "minutes", count: minutes };
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return { key: "hours", count: hours };
	const days = Math.floor(hours / 24);
	if (days === 1) return { key: "yesterday", count: 1 };
	if (days < 7) return { key: "days", count: days };
	return { key: "date", count: days };
}
