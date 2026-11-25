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
	TEAM_LEVEL_EVENT_KINDS,
	TEAM_OVERLAP_EVENT_KINDS,
	TEAM_PERSON_DECISION_EVENT_KINDS,
	TEAM_RETURN_REASON_MAX_LENGTH,
	TEAM_WORK_EVENT_KINDS,
	type TeamActivityEvent,
	type TeamBoardItem,
	type TeamPageSummary,
	type TeamPendingApproval,
	type TeamSummary,
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
			return { key: "queued", values: {}, detail: null, tone: "hollow" };
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

/** A return reason a person typed, trimmed; null when it cannot be sent. */
export function returnReason(text: string): string | null {
	const trimmed = text.trim();
	return trimmed && trimmed.length <= TEAM_RETURN_REASON_MAX_LENGTH ? trimmed : null;
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
