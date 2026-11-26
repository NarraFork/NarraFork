/**
 * The team page's pure rules (docs/PROJECT_TEAMS-PLAN.md §二.11; the redesign R): what waits for
 * the person (「等你处理」) and how many cards show, how the work list groups the items (需要你,
 * 进行中, 评审 · 就绪, then the finished ones as counts), the header's status sentence, the starting
 * and wrap-up states, each row's one line, how an activity entry is worded, how the page polls,
 * and in which order "pause all" stops the tree.
 *
 * Pure: no DOM, no React.
 */
import {
	dependencyBlockers,
	TEAM_LEVEL_EVENT_KINDS,
	TEAM_OVERLAP_EVENT_KINDS,
	TEAM_PERSON_DECISION_EVENT_KINDS,
	TEAM_RETURN_REASON_MAX_LENGTH,
	TEAM_WORK_EVENT_KINDS,
	type TeamActivityEvent,
	type TeamBoardItem,
	type TeamPageSummary,
	type TeamPendingApproval,
	type TeamPrMergeMethod,
	type TeamSummary,
	type TeamWorkDependencyRef,
	type TeamWorkMergeSummary,
} from "@shared/project-teams";

/**
 * The title "pin to sidebar" offers for a team, or undefined when it offers none: the team is not
 * loaded yet, or it is archived (the server keeps no tab of an archived team, so a pin would only
 * fail). `coordinatorStatus` is the page's live summary, which can see the archive first.
 */
export function teamPinTitle(
	team: Pick<TeamSummary, "id" | "name" | "status" | "coordinatorStatus"> | undefined,
	coordinatorStatus?: string,
): string | undefined {
	if (!team || team.status !== "active") return undefined;
	if (team.coordinatorStatus === "archived" || coordinatorStatus === "archived") return undefined;
	return team.name || team.id;
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

/**
 * The coordinator column's header line: how many other sessions of the tree are running, and the
 * coordinator's own state when nothing else runs. The summary's running list does not say which
 * sessions are work-item workers (reviewers and nested subagents run in the same tree), so the
 * line counts sessions, not workers. When the list was cut (`more`) the count is a lower bound,
 * shown as 「N+」: the listed others plus at least one unlisted, so it is never 「0+」.
 */
export function coordinatorLine(
	summary: Pick<TeamPageSummary, "teamId" | "coordinatorStatus" | "runningAgents" | "runningCount">,
):
	| { kind: "running"; count: number; more: boolean }
	| { kind: "status"; status: "working" | "waiting" | "idle" | "archived" } {
	const others = summary.runningAgents.filter((agent) => agent.id !== summary.teamId).length;
	const more = summary.runningCount > summary.runningAgents.length;
	if (more) return { kind: "running", count: others + 1, more };
	if (others > 0) return { kind: "running", count: others, more };
	const status = summary.coordinatorStatus;
	return {
		kind: "status",
		status: status === "working" || status === "waiting" || status === "archived" ? status : "idle",
	};
}

/** "50+" past a capped count (the server counts one past its limit). */
export function cappedCount(count: number, limit: number): string {
	return count > limit ? `${limit}+` : String(count);
}

// ── Activity ────────────────────────────────────────────────────────────────

/**
 * Every event kind the server records has its own wording (a test holds both locales to it). An
 * unknown kind, from a newer server, gets the generic `other` headline, never its raw name.
 */
const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set([
	...TEAM_LEVEL_EVENT_KINDS,
	...TEAM_WORK_EVENT_KINDS,
	...TEAM_OVERLAP_EVENT_KINDS,
	...TEAM_PERSON_DECISION_EVENT_KINDS,
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
		case "work.returned": {
			const reason = text(detail.reason, 600);
			return reason ? { key: "text", values: { text: reason } } : null;
		}
		case "work.dependencies_changed": {
			// The whole set, merged ones included (the event keeps no states): never "waits for N".
			const count = Array.isArray(detail.dependsOn) ? detail.dependsOn.length : null;
			if (count === null) return null;
			return count === 0
				? { key: "dependenciesCleared", values: {} }
				: { key: "dependencies", values: { count } };
		}
		case "work.unblocked":
			return { key: "unblocked", values: {} };
		case "work.merge_requested":
			if (detail.job === "pull_request") return { key: "prRequested", values: {} };
			if (detail.job === "pr_merge")
				return {
					key: "prMergeRequested",
					values: { method: text(detail.method, 20) ?? "merge" },
				};
			return {
				key: detail.job === "fast_forward" ? "mergeFastForward" : "mergeRequested",
				values: {},
			};
		case "work.pr_pushed": {
			const branch = text(detail.branch, 200);
			return branch ? { key: "branch", values: { branch } } : null;
		}
		case "work.pr_opened":
		case "work.pr_closed":
		case "work.pr_queued": {
			const pr = num(detail.pr);
			return pr !== null ? { key: "prNumber", values: { pr } } : null;
		}
		case "work.pr_checks": {
			if (detail.checks === "failing")
				return { key: "prChecksFailing", values: { count: num(detail.failed) ?? 0 } };
			if (detail.review === "CHANGES_REQUESTED") return { key: "prChangesRequested", values: {} };
			if (detail.checks === "passing") return { key: "prChecksPassing", values: {} };
			if (detail.review === "APPROVED") return { key: "prApproved", values: {} };
			return null;
		}
		case "work.merge_failed": {
			if (detail.code === "conflict") {
				const count = Array.isArray(detail.conflicts) ? detail.conflicts.length : 0;
				return {
					key: detail.more === true ? "mergeConflictMore" : "mergeConflict",
					values: { count },
				};
			}
			const message = text(detail.message, 280);
			return message ? { key: "text", values: { text: message } } : null;
		}
		case "work.merge_prepared": {
			const path = text(detail.checkedOutAt, 300);
			return path ? { key: "mergePrepared", values: { path } } : null;
		}
		case "work.merged":
			if (detail.detectedBy === "local_merge")
				return {
					key: detail.fastForwarded === "checkout" ? "mergedFastForward" : "mergedLocal",
					values: {},
				};
			if (detail.detectedBy === "ancestry") return { key: "mergedAncestry", values: {} };
			if (detail.detectedBy === "pull_request") {
				const pr = num(detail.pr);
				return pr !== null ? { key: "mergedPullRequest", values: { pr } } : null;
			}
			return null;
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
		summary.coordinatorMessageCount ?? 0,
		summary.coordinatorStopReason ?? null,
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

// ── People (M1) ─────────────────────────────────────────────────────────────

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

// ── The redesigned page (R) ─────────────────────────────────────────────────

/** A pending call's work item: its worker's, or (for a helper) its worker's parent's. */
export function itemOfApproval(
	approval: Pick<TeamPendingApproval, "agent" | "parentId" | "depth">,
	items: readonly TeamBoardItem[],
): TeamBoardItem | null {
	if (approval.depth === 0) return null;
	const sessions = new Set([approval.agent.id, ...(approval.parentId ? [approval.parentId] : [])]);
	return items.find((item) => item.worker && sessions.has(item.worker.id)) ?? null;
}

/**
 * Where a card comes from when 「等你处理」 sums up more than one team (R2: the project page): the
 * team it belongs to, or an ordinary session and whose it is. The team page leaves it out.
 */
export type AttentionSource =
	| { kind: "team"; teamId: string; name: string }
	| { kind: "session"; narratorId: string; title: string | null; ownerName: string | null };

/** One card of 「等你处理」: a pending call of the tree, or a ready item to accept. */
interface ApprovalEntry<K extends TeamPendingApproval["kind"]> {
	kind: K;
	id: string;
	approval: TeamPendingApproval;
	item: TeamBoardItem | null;
	source?: AttentionSource;
}

export type AttentionEntry =
	| ApprovalEntry<"tool">
	| ApprovalEntry<"question">
	| ApprovalEntry<"plan">
	| ApprovalEntry<"rule">
	| {
			kind: "merge";
			id: string;
			item: TeamBoardItem;
			source?: AttentionSource;
			/** The branch it merges into, when the cards come from several teams. */
			base?: string;
	  };

const isOpen = (item: TeamBoardItem) => item.state !== "merged" && item.state !== "cancelled";

/**
 * What waits for this person, in order: the tree's pending calls (oldest first, as listed), then
 * the ready items (oldest change first). Only members decide: an onlooker gets none.
 */
export function attentionEntries(input: {
	member: boolean;
	approvals: readonly TeamPendingApproval[];
	items: readonly TeamBoardItem[];
}): AttentionEntry[] {
	if (!input.member) return [];
	const entries: AttentionEntry[] = input.approvals.map(
		(approval) =>
			({
				kind: approval.kind,
				id: `approval:${approval.id}`,
				approval,
				item: itemOfApproval(approval, input.items),
			}) as AttentionEntry,
	);
	const ready = input.items
		.filter((item) => item.state === "ready")
		.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	for (const item of ready) entries.push({ kind: "merge", id: `merge:${item.id}`, item });
	return entries;
}

/** Cards 「等你处理」 shows before 「还有 N 条」. */
export const ATTENTION_SHOWN = 3;

export function attentionView<T>(
	entries: readonly T[],
	expanded: boolean,
): { shown: T[]; hidden: number } {
	if (expanded || entries.length <= ATTENTION_SHOWN) return { shown: [...entries], hidden: 0 };
	return { shown: entries.slice(0, ATTENTION_SHOWN), hidden: entries.length - ATTENTION_SHOWN };
}

/** A row of the work list: the item and the call it waits on, if any. */
export interface WorkRow {
	item: TeamBoardItem;
	approval: TeamPendingApproval | null;
	/**
	 * An onlooker's view: the worker is waiting on a person (its status) though the call itself
	 * is for members only; the row says what it waits on from the worker's last tool call.
	 */
	waiting?: boolean;
}

/** The work list's open groups, in the order they show. */
export const WORK_GROUPS = ["needsYou", "inProgress", "review"] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];

/**
 * The open items grouped for a person: 「需要你」 (waiting on a person's decision, or ready to
 * accept), 「进行中」 (in progress, then queued), 「评审 · 就绪」 (in review). An onlooker sees no
 * calls, so their first group holds the ready items (「等成员处理」). Finished items are left out:
 * the list shows them as counts.
 */
export function workGroups(
	items: readonly TeamBoardItem[],
	approvals: readonly TeamPendingApproval[],
	/** Onlookers see no calls: a worker whose status is `waiting` stands for one. */
	workerWaiting?: (item: TeamBoardItem) => boolean,
): Record<WorkGroup, WorkRow[]> {
	const groups: Record<WorkGroup, WorkRow[]> = { needsYou: [], inProgress: [], review: [] };
	const waiting = new Map<string, TeamPendingApproval>();
	for (const approval of approvals) {
		const item = itemOfApproval(approval, items);
		if (item && !waiting.has(item.id)) waiting.set(item.id, approval);
	}
	const byCreated = [...items]
		.filter(isOpen)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	const asked: WorkRow[] = [];
	const ready: WorkRow[] = [];
	const doing: WorkRow[] = [];
	const queued: WorkRow[] = [];
	for (const item of byCreated) {
		const approval = waiting.get(item.id) ?? null;
		if (approval) asked.push({ item, approval });
		else if (workerWaiting?.(item) && item.state !== "ready")
			asked.push({ item, approval: null, waiting: true });
		else if (item.state === "ready") ready.push({ item, approval: null });
		else if (item.state === "in_review") groups.review.push({ item, approval: null });
		else if (item.state === "queued") queued.push({ item, approval: null });
		else doing.push({ item, approval: null });
	}
	// Calls in the order they were asked, then the items to accept.
	const order = new Map(approvals.map((approval, index) => [approval.id, index]));
	asked.sort(
		(a, b) => (order.get(a.approval?.id ?? "") ?? 0) - (order.get(b.approval?.id ?? "") ?? 0),
	);
	groups.needsYou = [...asked, ...ready];
	groups.inProgress = [...doing, ...queued];
	return groups;
}

/** Open (unfinished) items by the summary's counts. */
export function unfinishedCount(summary: Pick<TeamPageSummary, "columnCounts">): number {
	const counts = summary.columnCounts;
	return counts.queued + counts.in_progress + counts.review;
}

export function totalCount(summary: Pick<TeamPageSummary, "columnCounts">): number {
	const counts = summary.columnCounts;
	return unfinishedCount(summary) + counts.done + counts.cancelled;
}

/** A part of the header's status sentence (keys under `teams.page.status.`). */
export interface StatusPart {
	key:
		| "archived"
		| "paused"
		| "idle"
		| "inProgress"
		| "waitingYou"
		| "waitingYouMore"
		| "waitingMembers"
		| "noWork"
		| "done";
	count?: number;
}

export type StatusTone = "archived" | "paused" | "idle" | "active";

/**
 * The header's one sentence: 「3 项进行中 · 1 项等你」, 「空闲 · 7 项已完成」, 「已暂停」, 「已归档」.
 * `waiting` is what waits on people (the member's 「等你处理」 cards; an onlooker's ready items),
 * `waitingItems` how many open items that covers.
 */
export function statusSentence(input: {
	summary: Pick<
		TeamPageSummary,
		"coordinatorStatus" | "columnCounts" | "runningCount" | "coordinatorStopReason"
	>;
	member: boolean;
	waiting: number;
	waitingItems: number;
	/** More calls wait than the list holds: the count is a lower bound ("N+"). */
	waitingMore?: boolean;
}): { tone: StatusTone; parts: StatusPart[] } {
	const { summary } = input;
	if (summary.coordinatorStatus === "archived")
		return { tone: "archived", parts: [{ key: "archived" }] };
	const open = unfinishedCount(summary);
	if (open > 0 && summary.runningCount === 0 && summary.coordinatorStopReason === "user_interrupt")
		return { tone: "paused", parts: [{ key: "paused" }] };
	if (open === 0 && input.waiting === 0 && !input.waitingMore) {
		const done = summary.columnCounts.done;
		const total = totalCount(summary);
		return {
			tone: "idle",
			parts: [
				{ key: "idle" },
				...(total === 0
					? [{ key: "noWork" as const }]
					: done > 0
						? [{ key: "done" as const, count: done }]
						: []),
			],
		};
	}
	const parts: StatusPart[] = [];
	const doing = Math.max(0, open - input.waitingItems);
	if (doing > 0) parts.push({ key: "inProgress", count: doing });
	if (input.waiting > 0)
		parts.push({
			key: !input.member ? "waitingMembers" : input.waitingMore ? "waitingYouMore" : "waitingYou",
			count: input.waiting,
		});
	return { tone: "active", parts };
}

/** What the page body shows besides the conversation and the list. */
export interface TeamPageMode {
	/** Nobody has spoken to the coordinator and there is no work: suggest how to start. */
	starting: boolean;
	/** No work item yet: the list explains where items will appear. */
	emptyWork: boolean;
	/** Work happened and none is open: suggest archiving or disbanding. */
	wrapUp: boolean;
}

export function teamPageMode(
	summary:
		| Pick<TeamPageSummary, "coordinatorStatus" | "columnCounts" | "coordinatorMessageCount">
		| undefined,
): TeamPageMode {
	if (!summary) return { starting: false, emptyWork: false, wrapUp: false };
	const archived = summary.coordinatorStatus === "archived";
	const total = totalCount(summary);
	return {
		starting: !archived && total === 0 && (summary.coordinatorMessageCount ?? 0) === 0,
		emptyWork: total === 0,
		wrapUp: !archived && total > 0 && unfinishedCount(summary) === 0,
	};
}

/** The tint of a row's status dot. */
export type RowTone = "amber" | "green" | "blue" | "hollow" | "gray";

/**
 * What a tool call asks for, in words (R2: 「请求编辑文件」, 「等批准运行命令」): editing a file,
 * running a command, reading a file, opening a web page, or (any other tool) using it by name.
 */
export type ToolVerb = "editFile" | "runCommand" | "readFile" | "fetchWeb" | "useTool";

const TOOL_VERBS: Readonly<Record<string, ToolVerb>> = {
	Edit: "editFile",
	Write: "editFile",
	MultiEdit: "editFile",
	NotebookEdit: "editFile",
	Bash: "runCommand",
	Read: "readFile",
	WebFetch: "fetchWeb",
};

export function toolVerb(toolName: string): ToolVerb {
	return TOOL_VERBS[toolName] ?? "useTool";
}

/** The i18n key (under `teams.page.row.`) of a row waiting for approval of this tool. */
export function waitingToolKey(toolName: string): string {
	return `waitingTools.${toolVerb(toolName)}`;
}

/** A row's second line: an i18n key under `teams.page.row.` and its values. */
export interface RowLine {
	key: string;
	values: Record<string, string | number>;
	/** A command, path or tool input, shown in a monospace font after the words. */
	detail: string | null;
	tone: RowTone;
}

/** What a row says it is doing now, and the colour of its dot. */
export function rowLine(row: WorkRow, workerStatus: string | null, base: string): RowLine {
	const { item, approval } = row;
	if (approval) {
		const detail =
			approval.kind === "question" ? (approval.questions[0] ?? null) : approval.preview || null;
		const key =
			approval.kind === "tool"
				? waitingToolKey(approval.toolName)
				: approval.kind === "question"
					? "waitingAnswer"
					: approval.kind === "plan"
						? "waitingPlan"
						: "waitingRule";
		return { key, values: { tool: approval.toolName }, detail, tone: "amber" };
	}
	if (row.waiting) {
		const tool = item.activity?.toolName ?? "";
		// Not known what it waits on (no tool call read yet): say only that a person is needed.
		if (!tool) return { key: "waitingPerson", values: {}, detail: null, tone: "amber" };
		const kind =
			tool === "AskUserQuestion" ? "question" : tool === "ExitPlanMode" ? "plan" : "tool";
		return {
			key:
				kind === "question"
					? "waitingAnswer"
					: kind === "plan"
						? "waitingPlan"
						: waitingToolKey(tool),
			values: { tool },
			detail: item.activity?.preview || null,
			tone: "amber",
		};
	}
	switch (item.state) {
		case "ready":
			return {
				key: "mergeable",
				values: { round: Math.max(1, item.reviewRounds) },
				detail: null,
				tone: "green",
			};
		case "in_review":
			return item.lastReview === "clear"
				? { key: "reviewClear", values: { round: item.reviewRounds }, detail: null, tone: "blue" }
				: {
						key: "reviewing",
						values: { round: item.reviewRounds + 1 },
						detail: null,
						tone: "blue",
					};
		case "queued":
			return queuedLine(item.dependsOn);
		case "merged":
			return { key: "merged", values: { base }, detail: null, tone: "gray" };
		case "cancelled":
			return { key: "cancelled", values: {}, detail: null, tone: "hollow" };
		default: {
			const running = workerStatus === "working" || workerStatus === "waiting";
			if (running && item.activity)
				return {
					key: "activity",
					values: { tool: item.activity.toolName },
					detail: item.activity.preview || null,
					tone: "blue",
				};
			if (item.lastReview === "blocker")
				return { key: "fixing", values: { round: item.reviewRounds }, detail: null, tone: "blue" };
			if (!item.worker) return { key: "noWorker", values: {}, detail: null, tone: "hollow" };
			return running
				? { key: "working", values: {}, detail: null, tone: "blue" }
				: { key: "workerIdle", values: {}, detail: null, tone: "hollow" };
		}
	}
}

/**
 * D: a queued row's line. Waiting on dependencies it reads 「排队 · 等「A」「B」合并」 (the
 * titles when one or two, else 「等 N 项合并」); a cancelled dependency, which never merges,
 * reads 「排队 · 依赖「A」已取消」 until the coordinator removes or replaces it (the drawer warns).
 */
export function queuedLine(dependsOn: readonly TeamWorkDependencyRef[] | undefined): RowLine {
	const blockers = dependencyBlockers(dependsOn);
	const cancelled = blockers.find((blocker) => blocker.state === "cancelled");
	if (cancelled)
		return {
			key: "queuedBlockedCancelled",
			values: { title: cancelled.title },
			detail: null,
			tone: "hollow",
		};
	const [first, second] = blockers;
	if (!first) return { key: "queued", values: {}, detail: null, tone: "hollow" };
	if (blockers.length === 1)
		return {
			key: "queuedWaitingOne",
			values: { first: first.title },
			detail: null,
			tone: "hollow",
		};
	if (blockers.length === 2 && second)
		return {
			key: "queuedWaitingTwo",
			values: { first: first.title, second: second.title },
			detail: null,
			tone: "hollow",
		};
	return {
		key: "queuedWaitingMany",
		values: { count: blockers.length },
		detail: null,
		tone: "hollow",
	};
}

/** A return reason a person typed, trimmed; null when it cannot be sent. */
export function returnReason(text: string): string | null {
	const trimmed = text.trim();
	return trimmed && trimmed.length <= TEAM_RETURN_REASON_MAX_LENGTH ? trimmed : null;
}

/** Lines a review round's findings show before 「展开」. */
export const REVIEW_FINDINGS_CLAMP_LINES = 3;

/**
 * Whether a round's findings may run past {@link REVIEW_FINDINGS_CLAMP_LINES} lines in the drawer
 * and so get 「展开 / 收起」: more lines than that, or more text than fits them at the drawer's
 * narrowest width (an estimate; a short text never gets the toggle).
 */
export function findingsNeedToggle(text: string): boolean {
	return text.split("\n").length > REVIEW_FINDINGS_CLAMP_LINES || text.length > 140;
}

/** How one line of a unified diff is drawn. */
export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
	if (line.startsWith("@@")) return "hunk";
	if (
		line.startsWith("diff --git") ||
		line.startsWith("index ") ||
		line.startsWith("--- ") ||
		line.startsWith("+++ ") ||
		line.startsWith("new file mode") ||
		line.startsWith("deleted file mode") ||
		line.startsWith("Binary files")
	)
		return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	return "context";
}

/** The page's phone tabs: the conversation and the work (its switch holds the activity). */
export const TEAM_PHONE_TABS = ["conversation", "work"] as const;
export type TeamPhoneTab = (typeof TEAM_PHONE_TABS)[number];

/** Below this frame width the page shows the conversation and the work as tabs. */
export const TEAM_SPLIT_MIN_WIDTH = 860;

export function teamWorkspaceLayout(width: number): "split" | "tabs" {
	return width >= TEAM_SPLIT_MIN_WIDTH ? "split" : "tabs";
}

/** Example goals the starting state offers (keys under `teams.page.start.examples.`). */
export const TEAM_START_EXAMPLES = ["upgrade", "issues", "tests"] as const;

/** For an onlooker: the item's worker is waiting on a person (its live status). */
export function onlookerSeesWaiting(
	item: TeamBoardItem,
	summary: Pick<TeamPageSummary, "runningAgents" | "runningCount"> | undefined,
): boolean {
	return !!item.worker && liveWorkerStatus(item.worker, summary) === "waiting";
}

/**
 * What a worker is doing now: the summary's running list (refreshed with every summary read) when
 * it names the worker, else what the board read. A worker that stopped has no "now".
 */
export function liveActivity(
	item: Pick<TeamBoardItem, "worker" | "activity">,
	summary: Pick<TeamPageSummary, "runningAgents"> | undefined,
): TeamBoardItem["activity"] {
	const listed = item.worker
		? summary?.runningAgents.find((agent) => agent.id === item.worker?.id)
		: undefined;
	if (listed && listed.activity !== undefined) return listed.activity;
	return item.activity ?? null;
}

/** Marks a row and the drawer show besides the state. */
export type ItemMark = "exclusive" | "worktree";

export function itemMarks(
	item: Pick<TeamBoardItem, "state" | "exclusiveKey" | "hasWorktree">,
): ItemMark[] {
	const marks: ItemMark[] = [];
	if (item.exclusiveKey) marks.push("exclusive");
	// Finished but still holding its worktree: the coordinator can clean it up (and the team
	// cannot be disbanded until it does).
	if ((item.state === "merged" || item.state === "cancelled") && item.hasWorktree)
		marks.push("worktree");
	return marks;
}

/** A size worth showing: something changed (a queued item with no commit shows nothing). */
export function showsStat(
	stat: { added: number; removed: number; files?: number } | null | undefined,
): boolean {
	return !!stat && (stat.added > 0 || stat.removed > 0 || (stat.files ?? 0) > 0);
}

/** Ids split into requests of at most `size` (the size endpoint takes 50 at a time). */
export function chunkIds(ids: readonly string[], size: number): string[][] {
	const unique = [...new Set(ids)].sort();
	const chunks: string[][] = [];
	for (let index = 0; index < unique.length; index += size)
		chunks.push(unique.slice(index, index + size));
	return chunks;
}

/** Refusal codes of a return with their own wording (`teams.page.drawer.errors.*`). */
const RETURN_ERROR_CODES = new Set([
	"TEAM_WORK_ITEM_NOT_RETURNABLE",
	"TEAM_WORK_ITEM_CHANGED",
	"TEAM_ARCHIVED",
]);

/** The i18n key of a failed return, or null for a generic message. */
export function returnErrorKey(error: unknown): string | null {
	const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
	return typeof code === "string" && RETURN_ERROR_CODES.has(code)
		? `teams.page.drawer.errors.${code}`
		: null;
}

/** The coordinator's events and reviews are signed 「协调者」, not by the team (its title). */
export function isCoordinator(
	actor: { actorKind: string; actorId: string | null },
	teamId: string,
): boolean {
	return actor.actorKind === "agent" && actor.actorId === teamId;
}

// ── M: merging a ready item ─────────────────────────────────────────────────

/** What the merge control of the drawer's bottom bar and the 等你处理 card shows. */
export interface MergeControlView {
	/**
	 * The button's label key under `teams.page.merge.`: the local merge's, or (GitHub) 「发起 PR」,
	 * 「更新 PR」 after a re-ready, 「重新发起 PR」 when it was closed, and the job's progress.
	 */
	label:
		| "merge"
		| "merging"
		| "fastForwarding"
		| "prepareAgain"
		| "openPr"
		| "updatePr"
		| "reopenPr"
		| "pushing"
		| "opening"
		| "mergingPr";
	/** A job runs: the button shows its progress. */
	busy: boolean;
	enabled: boolean;
	/** Why the button is disabled (an i18n key), or null. */
	disabledKey: string | null;
	/** The newest outcome to show beside it. */
	panel: TeamWorkMergeSummary["outcome"];
}

/**
 * The merge control for an item's merge state; null when the item carries none (not ready), or
 * (GitHub) when its open pull request already carries the ready head: then 「查看 PR」 and
 * 「合并 PR」 ({@link pullRequestControl}) take its place.
 */
export function mergeControl(merge: TeamWorkMergeSummary | undefined): MergeControlView | null {
	if (!merge) return null;
	// G: merging the pull request shows on 「合并 PR」 itself.
	if (merge.mode === "github" && merge.job === "pr_merge" && merge.pr) return null;
	if (merge.phase !== null || merge.job !== null)
		return {
			label: busyLabel(merge),
			busy: true,
			enabled: false,
			disabledKey: null,
			panel: null,
		};
	if (merge.mode === "github") {
		const pr = merge.pr ?? null;
		const open = pr && pr.state !== "CLOSED" && pr.state !== "MERGED";
		if (open && pr.headMatches) return null;
		return {
			label:
				!pr || pr.state === "MERGED" ? "openPr" : pr.state === "CLOSED" ? "reopenPr" : "updatePr",
			busy: false,
			enabled: merge.canMerge,
			disabledKey: merge.disabledReason
				? `teams.page.merge.disabled.${merge.disabledReason}`
				: null,
			panel: merge.outcome,
		};
	}
	return {
		label: merge.outcome === "prepared" ? "prepareAgain" : "merge",
		busy: false,
		enabled: merge.canMerge,
		disabledKey: merge.disabledReason ? `teams.page.merge.disabled.${merge.disabledReason}` : null,
		panel: merge.outcome,
	};
}

function busyLabel(merge: TeamWorkMergeSummary): MergeControlView["label"] {
	if (merge.job === "fast_forward") return "fastForwarding";
	if (merge.job === "pr_merge") return "mergingPr";
	if (merge.job === "pull_request" || merge.mode === "github")
		return merge.phase === "opening" ? "opening" : "pushing";
	return "merging";
}

/** One status label of a pull request (an i18n key under `teams.page.merge.pr.`). */
export interface PullRequestLabel {
	key: string;
	values: Record<string, string | number>;
	color: "green" | "red" | "yellow" | "gray" | "blue" | "orange";
	/** What it is about, for tests and styling. */
	kind: "checks" | "review" | "state" | "queue" | "read";
}

/** An http(s) link to put in an `href`, or null for anything else. */
export function safeHref(link: string | null | undefined): string | null {
	if (!link) return null;
	try {
		const url = new URL(link);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
	} catch {
		return null;
	}
}

/** What 「查看 PR」 / 「合并 PR」 show for an item's pull request (null: it has none). */
export interface PullRequestControlView {
	number: number;
	url: string;
	labels: PullRequestLabel[];
	/** 「合并 PR」 is shown (the pull request is open and carries the ready head). */
	showMerge: boolean;
	mergeEnabled: boolean;
	/** Why 「合并 PR」 is disabled (an i18n key), or null. */
	mergeDisabledKey: string | null;
	/** The methods to pick from (the default first); a menu when there are several. */
	methods: TeamPrMergeMethod[];
	busy: boolean;
	/** The failed checks to list in the drawer. */
	failures: { name: string; link: string | null }[];
	error: string | null;
}

/**
 * The pull request part of the merge control: its link, its status labels — CI (通过 / N 项失败 /
 * N 项进行中 / 无检查), review (需要评审 / 已批准 / 要求修改), conflict / behind / blocked / draft,
 * 已加入合并队列 — and 「合并 PR」, enabled only for CLEAN, HAS_HOOKS or UNSTABLE.
 */
export function pullRequestControl(
	merge: TeamWorkMergeSummary | undefined,
): PullRequestControlView | null {
	const pr = merge?.mode === "github" ? merge.pr : null;
	if (!merge || !pr) return null;
	const labels: PullRequestLabel[] = [];
	if (pr.state === "CLOSED")
		labels.push({ key: "closed", values: {}, color: "gray", kind: "state" });
	else if (pr.state === "MERGED")
		labels.push({ key: "merged", values: {}, color: "blue", kind: "state" });
	if (pr.state === null || pr.refreshing)
		labels.push({ key: "checking", values: {}, color: "gray", kind: "read" });
	if (pr.state === "OPEN") {
		if (!pr.headMatches) labels.push({ key: "stale", values: {}, color: "yellow", kind: "state" });
		const checks = pr.checks;
		if (checks?.state === "passing")
			labels.push({ key: "checksPassing", values: {}, color: "green", kind: "checks" });
		else if (checks?.state === "failing")
			labels.push({
				key: "checksFailing",
				values: { count: checks.fail },
				color: "red",
				kind: "checks",
			});
		else if (checks?.state === "pending")
			labels.push({
				key: "checksPending",
				values: { count: checks.pending },
				color: "yellow",
				kind: "checks",
			});
		else if (checks?.state === "none")
			labels.push({ key: "checksNone", values: {}, color: "gray", kind: "checks" });
		if (pr.review === "APPROVED")
			labels.push({ key: "reviewApproved", values: {}, color: "green", kind: "review" });
		else if (pr.review === "CHANGES_REQUESTED")
			labels.push({ key: "reviewChanges", values: {}, color: "red", kind: "review" });
		else if (pr.review === "REVIEW_REQUIRED")
			labels.push({ key: "reviewRequired", values: {}, color: "yellow", kind: "review" });
		if (pr.isDraft || pr.mergeState === "DRAFT")
			labels.push({ key: "draft", values: {}, color: "gray", kind: "state" });
		else if (pr.mergeState === "DIRTY")
			labels.push({ key: "dirty", values: {}, color: "red", kind: "state" });
		else if (pr.mergeState === "BEHIND")
			labels.push({ key: "behind", values: {}, color: "orange", kind: "state" });
		else if (pr.mergeState === "BLOCKED")
			labels.push({ key: "blocked", values: {}, color: "orange", kind: "state" });
		if (pr.queued) labels.push({ key: "queued", values: {}, color: "blue", kind: "queue" });
	}
	const busy = merge.job === "pr_merge";
	const showMerge = pr.state !== "CLOSED" && pr.state !== "MERGED" && pr.headMatches;
	const reasonKey = merge.disabledReason
		? `teams.page.merge.disabled.${merge.disabledReason}`
		: pr.mergeBlocker
			? `teams.page.merge.prBlocker.${pr.mergeBlocker}`
			: null;
	return {
		number: pr.number,
		url: pr.url,
		labels,
		showMerge,
		mergeEnabled: pr.canMergePr && !busy,
		mergeDisabledKey: pr.canMergePr ? null : reasonKey,
		methods: pr.methods,
		busy,
		failures: pr.checks?.failures ?? [],
		error: pr.error,
	};
}

/** Refusals of a merge request the page words itself (others show the server's text). */
const MERGE_ERROR_CODES = new Set([
	"TEAM_WORK_ITEM_NOT_READY",
	"TEAM_WORK_ITEM_MERGING",
	"TEAM_WORK_ITEM_WORKER_RUNNING",
	"TEAM_PR_GH_MISSING",
	"TEAM_PR_GH_LOGGED_OUT",
	"TEAM_PR_GH_NO_PERMISSION",
	"TEAM_PR_REPO_ARCHIVED",
	"TEAM_PR_GH_UNAVAILABLE",
	"TEAM_PR_NOT_GITHUB",
	"TEAM_PR_REMOTE_CHANGED",
	"TEAM_REMOTE_CONFIG_UNSAFE",
	"TEAM_PR_PUSH_REJECTED",
	"TEAM_PR_PUSH_FAILED",
	"TEAM_PR_BASE_MISMATCH",
	"TEAM_PR_OPEN_FAILED",
	"TEAM_PR_NONE",
	"TEAM_PR_CLOSED",
	"TEAM_PR_HEAD_STALE",
	"TEAM_PR_DRAFT",
	"TEAM_PR_BLOCKED",
	"TEAM_PR_BEHIND",
	"TEAM_PR_STATE_UNKNOWN",
	"TEAM_PR_METHOD_NOT_ALLOWED",
	"TEAM_PR_MERGE_FAILED",
	"TEAM_MERGE_BASE_REMOTE",
	"TEAM_MERGE_NOT_PREPARED",
	"TEAM_ARCHIVED",
	"TEAM_MERGE_BASE_MOVED",
	"TEAM_WORK_ITEM_HEAD_MOVED",
	"TEAM_WORK_ITEM_HEAD_UNAVAILABLE",
	"TEAM_MERGE_GIT_TOO_OLD",
	"TEAM_MERGE_STALE",
	"TEAM_MERGE_CHECKOUT_BLOCKED",
	"TEAM_MERGE_CHECKOUT_BUSY",
	"TEAM_MERGE_FAST_FORWARD_REFUSED",
	"TEAM_MERGE_IDENTITY_UNKNOWN",
	"TEAM_MERGE_FAST_FORWARD_INCOMPLETE",
	"TEAM_MERGE_HOSTING_UNKNOWN",
	"TEAM_MERGE_TIMEOUT",
	"TEAM_GIT_HISTORY_ALTERED",
	"TEAM_GIT_REPLACED_HISTORY",
	"GIT_WORKSPACE_BUSY",
]);

/** The i18n key of a merge refusal or failure code, or null for the server's own words. */
export function mergeErrorKey(code: string | null | undefined): string | null {
	return code && MERGE_ERROR_CODES.has(code) ? `teams.page.merge.errors.${code}` : null;
}

/** The code of a failed merge request (an API error), if any. */
export function mergeRequestCode(error: unknown): string | null {
	const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
	return typeof code === "string" ? code : null;
}

/** Most conflicting files a prefilled 退回 reason names. */
export const MERGE_CONFLICT_REASON_FILES = 20;

/**
 * The files a prefilled 退回 reason names after a conflict: at most
 * {@link MERGE_CONFLICT_REASON_FILES}, one per line, and whether more were left out.
 */
export function conflictReasonFiles(
	conflicts: readonly string[] | undefined,
	more: boolean | undefined,
): { files: string; more: boolean } {
	const list = (conflicts ?? []).slice(0, MERGE_CONFLICT_REASON_FILES);
	return {
		files: list.map((file) => `- ${file}`).join("\n"),
		more: more === true || (conflicts?.length ?? 0) > list.length,
	};
}
