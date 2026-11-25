/**
 * Read models of the team page (docs/PROJECT_TEAMS-PLAN.md §二.4, §二.11, §二.12; P4).
 *
 * Everything here is read-only and bounded: every statement is a primary-key probe or an index
 * range (`(team_id, state, id)`, `(team_id, created_at, id)`, `narrators(acl_root_narrator_id)`,
 * `narrator_tool_calls(narrator_id, status)`) with a LIMIT, and no response carries a large
 * column — not the changed paths, not a tool call's full input, not an event detail above
 * {@link TEAM_EVENT_DETAIL_PREVIEW_CHARS} characters.
 *
 * Access is the coordinator's narrator ACL (`loadTeamForAccess`): readers see the board and the
 * activity, only members (writers) see the pending approvals. The tree is the coordinator plus
 * every subagent whose ACL root is the coordinator (both subagent levels carry it there).
 *
 * SQLite only, like the rest of the team surface; the routes refuse PostgreSQL with 503.
 */

import { coerceAskQuestionShape } from "@shared/ask-user-question-shape";
import {
	boardColumnIsFinished,
	TEAM_ACTIVITY_PREVIEW_CHARS,
	TEAM_APPROVAL_PREVIEW_CHARS,
	TEAM_APPROVALS_LIMIT,
	TEAM_BOARD_COLUMN_STATES,
	TEAM_BOARD_COLUMNS,
	TEAM_EVENT_DETAIL_PREVIEW_CHARS,
	TEAM_HELD_WORKTREES_LIMIT,
	TEAM_PAUSE_LIMIT,
	TEAM_QUESTION_OPTIONS_MAX,
	TEAM_RETURN_REASON_MAX_LENGTH,
	TEAM_RUNNING_AGENTS_LIMIT,
	TEAM_WORK_RETURNED_EVENT_KIND,
	type TeamActivityEvent,
	type TeamActivityPage,
	type TeamAgentRef,
	type TeamApprovalsResponse,
	type TeamBoardColumn,
	type TeamBoardColumnPage,
	type TeamBoardItem,
	type TeamEventActorKind,
	type TeamMembersResponse,
	type TeamPageSummary,
	type TeamPendingApproval,
	type TeamQuestionForm,
	type TeamRunningResponse,
	type TeamWorkerActivity,
	teamApprovalKind,
} from "@shared/project-teams";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
	narrators,
	narratorToolCalls,
	teamWorkEvents,
	teamWorkItems,
	users,
} from "../../db/schema";
import { ValidationError } from "../../lib/errors";
import { canManageNarratorAcl, type NarratorPrincipal } from "../narrator-acl";
import { shouldHidePendingPermission } from "../pending-permission-visibility";
import { readTeamMembers } from "./team-members";
import { loadTeamForAccess } from "./team-service";

const RUNNING_STATUSES: ("working" | "waiting")[] = ["working", "waiting"];

// ── Cursors ─────────────────────────────────────────────────────────────────

/** An opaque keyset cursor: the sort key and the id of the last row of a page. */
function encodeCursor(key: string, id: string): string {
	return Buffer.from(JSON.stringify([key, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { key: string; id: string } | null {
	if (!cursor) return null;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			Array.isArray(value) &&
			value.length === 2 &&
			typeof value[0] === "string" &&
			typeof value[1] === "string"
		)
			return { key: value[0], id: value[1] };
	} catch {
		// fall through
	}
	throw new ValidationError("Invalid cursor");
}

// ── Tree ────────────────────────────────────────────────────────────────────

/**
 * The tree of a team is the coordinator plus every subagent whose ACL root is the coordinator
 * (both subagent levels carry it there). The tree can hold thousands of finished sessions, so
 * nothing here lists the whole tree: each read asks for exactly what it shows, filtered in SQL
 * before its LIMIT.
 */
const inTree = (teamId: string) =>
	or(
		eq(narrators.id, teamId),
		and(eq(narrators.aclRootNarratorId, teamId), eq(narrators.type, "subagent")),
	);

/**
 * The working or waiting sessions of a tree: the coordinator first, then the newest first
 * (creation time, id), at most `limit`; `more` when there are others. Driven by the status
 * index (only running sessions qualify), then filtered to the tree.
 */
export function runningTreeSessions(
	teamId: string,
	limit: number,
): { agents: TeamAgentRef[]; more: boolean } {
	const rows = db
		.select({ id: narrators.id, title: narrators.title, status: narrators.status })
		.from(narrators)
		.where(and(inArray(narrators.status, RUNNING_STATUSES), inTree(teamId)))
		.orderBy(desc(sql`${narrators.id} = ${teamId}`), desc(narrators.createdAt), desc(narrators.id))
		.limit(limit + 1)
		.all();
	return { agents: rows.slice(0, limit).map(agentRef), more: rows.length > limit };
}

function agentRef(session: { id: string; title: string | null; status: string }): TeamAgentRef {
	return { id: session.id, title: session.title, status: session.status };
}

/** 0 = the coordinator, 1 = a worker (its parent is the coordinator, or unknown), 2 = a helper. */
export function depthOf(teamId: string, session: { id: string; parentNarratorId: string | null }) {
	if (session.id === teamId) return 0;
	if (!session.parentNarratorId || session.parentNarratorId === teamId) return 1;
	return 2;
}

// ── Summary ─────────────────────────────────────────────────────────────────

function columnCounts(teamId: string): Record<TeamBoardColumn, number> {
	// One index-only range per team: `(team_id, state, id)`.
	const rows = db
		.select({ state: teamWorkItems.state, count: sql<number>`count(*)` })
		.from(teamWorkItems)
		.where(eq(teamWorkItems.teamId, teamId))
		.groupBy(teamWorkItems.state)
		.all();
	const counts = Object.fromEntries(TEAM_BOARD_COLUMNS.map((column) => [column, 0])) as Record<
		TeamBoardColumn,
		number
	>;
	for (const row of rows)
		for (const column of TEAM_BOARD_COLUMNS)
			if (TEAM_BOARD_COLUMN_STATES[column].includes(row.state)) counts[column] += Number(row.count);
	return counts;
}

/** Rows of pending calls read per page while hidden ones (a reflection still running) are skipped. */
const PENDING_PAGE = 100;
/** Pages read at most: past this many hidden calls the list says "more" instead of counting on. */
const PENDING_MAX_PAGES = 5;

interface PendingRow {
	id: string;
	narratorId: string;
	toolName: string;
	createdAt: string;
	title: string | null;
	status: string;
	parentNarratorId: string | null;
}

/**
 * The tree's tool calls waiting for a person, oldest first, after the same visibility rule as
 * the session's own list (a call whose reflection still runs is not waiting for a person).
 * Driven by `idx_toolcalls_status_narrator_created` (status leads, and few calls are pending at
 * any time) joined to the narrator by primary key; read in keyset pages until `wanted` visible
 * rows are found, at most {@link PENDING_MAX_PAGES} pages. `complete` is false when the pages
 * ran out before the pending calls did.
 */
export function visiblePendingCalls(
	teamId: string,
	wanted: number,
): { rows: PendingRow[]; complete: boolean } {
	const rows: PendingRow[] = [];
	let after: { createdAt: string; id: string } | null = null;
	for (let page = 0; page < PENDING_MAX_PAGES; page++) {
		const batch = db
			.select({
				id: narratorToolCalls.id,
				narratorId: narratorToolCalls.narratorId,
				toolName: narratorToolCalls.toolName,
				suggestions: narratorToolCalls.permissionSuggestions,
				createdAt: narratorToolCalls.createdAt,
				title: narrators.title,
				status: narrators.status,
				parentNarratorId: narrators.parentNarratorId,
			})
			.from(narratorToolCalls)
			.innerJoin(narrators, eq(narrators.id, narratorToolCalls.narratorId))
			.where(
				and(
					eq(narratorToolCalls.status, "pending"),
					inTree(teamId),
					after
						? or(
								gt(narratorToolCalls.createdAt, after.createdAt),
								and(
									eq(narratorToolCalls.createdAt, after.createdAt),
									gt(narratorToolCalls.id, after.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id))
			.limit(PENDING_PAGE)
			.all();
		for (const row of batch) {
			if (shouldHidePendingPermission(row.suggestions)) continue;
			const { suggestions: _suggestions, ...visible } = row;
			rows.push(visible);
			if (rows.length >= wanted) return { rows, complete: true };
		}
		if (batch.length < PENDING_PAGE) return { rows, complete: true };
		const last = batch.at(-1);
		if (!last) return { rows, complete: true };
		after = { createdAt: last.createdAt, id: last.id };
	}
	return { rows, complete: false };
}

/**
 * Visible pending approvals counted up to the limit + 1. Only visible calls count: calls hidden
 * by a running reflection never inflate it, even when there are so many that the scan stops.
 */
function pendingCount(teamId: string): number {
	return visiblePendingCalls(teamId, TEAM_APPROVALS_LIMIT + 1).rows.length;
}

/**
 * The same count for a sidebar team tab (`recent-tab-teams.ts`). No access check: the caller
 * shows it to members only, as the top bar does.
 */
export function teamPendingApprovalCount(teamId: string): number {
	return pendingCount(teamId);
}

/** The top bar: running agents, pending approvals (members only), column counts, last event. */
export async function readTeamPageSummary(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
): Promise<TeamPageSummary> {
	const { coordinator, access } = await loadTeamForAccess(teamId, principal, "read", projectId);
	const running = runningTreeSessions(teamId, TEAM_RUNNING_AGENTS_LIMIT);
	// What each running session (at most the limit) did last, so rows stay live between board
	// reads: one `(narrator_id, created_at)` probe each.
	const runningAgents = running.agents.map((agent) =>
		agent.id === teamId ? agent : { ...agent, activity: workerActivity(agent.id) },
	);
	const held = db
		.select({ id: teamWorkItems.id })
		.from(teamWorkItems)
		.where(
			and(
				eq(teamWorkItems.teamId, teamId),
				inArray(teamWorkItems.state, ["merged", "cancelled"]),
				isNotNull(teamWorkItems.worktreeResourceId),
			),
		)
		.limit(TEAM_HELD_WORKTREES_LIMIT + 1)
		.all().length;
	const conversation = db
		.select({ messageCount: narrators.messageCount, stopReason: narrators.lastStopReason })
		.from(narrators)
		.where(eq(narrators.id, teamId))
		.limit(1)
		.get();
	const lastEvent = db
		.select({ id: teamWorkEvents.id, createdAt: teamWorkEvents.createdAt })
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.teamId, teamId))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get();
	return {
		teamId,
		access,
		coordinatorStatus: coordinator.status,
		runningAgents,
		runningCount: running.agents.length + (running.more ? 1 : 0),
		pendingApprovalCount: access === "write" ? pendingCount(teamId) : null,
		columnCounts: columnCounts(teamId),
		lastEventId: lastEvent?.id ?? null,
		lastEventAt: lastEvent?.createdAt ?? null,
		coordinatorMessageCount: conversation?.messageCount ?? 0,
		coordinatorStopReason: conversation?.stopReason ?? null,
		heldWorktreeCount: held,
	};
}

// ── Board ───────────────────────────────────────────────────────────────────

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 12) : null);

const BOARD_ITEM_COLUMNS = {
	id: teamWorkItems.id,
	title: teamWorkItems.title,
	kind: teamWorkItems.kind,
	state: teamWorkItems.state,
	branch: teamWorkItems.branchName,
	baseRef: teamWorkItems.baseRef,
	headSha: teamWorkItems.headSha,
	reviewRounds: teamWorkItems.reviewRounds,
	lastReview: teamWorkItems.lastReview,
	worktreeResourceId: teamWorkItems.worktreeResourceId,
	exclusiveKey: teamWorkItems.exclusiveKey,
	createdAt: teamWorkItems.createdAt,
	updatedAt: teamWorkItems.updatedAt,
	worker: {
		id: narrators.id,
		title: narrators.title,
		status: narrators.status,
	},
};

type BoardItemRow = {
	id: string;
	title: string;
	kind: string;
	state: TeamBoardItem["state"];
	branch: string | null;
	baseRef: string | null;
	headSha: string | null;
	reviewRounds: number;
	lastReview: TeamBoardItem["lastReview"];
	worktreeResourceId: string | null;
	exclusiveKey: string | null;
	createdAt: string;
	updatedAt: string;
	worker: { id: string; title: string | null; status: string } | null;
};

/** A card from its row; a working or waiting worker's newest tool call is read here (R). */
function boardItemOf(row: BoardItemRow): TeamBoardItem {
	return {
		id: row.id,
		title: row.title,
		kind: row.kind,
		state: row.state,
		branch: row.branch,
		baseRef: row.baseRef,
		headSha: shortSha(row.headSha),
		worker: row.worker?.id ? agentRef(row.worker) : null,
		reviewRounds: row.reviewRounds,
		lastReview: row.lastReview,
		hasWorktree: row.worktreeResourceId !== null,
		exclusiveKey: row.exclusiveKey,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		activity:
			row.worker?.id && RUNNING_STATUSES.includes(row.worker.status as "working" | "waiting")
				? workerActivity(row.worker.id)
				: null,
	};
}

/** One work item of a team as its card shows it (primary key), or null when it is not there. */
export function readBoardItem(teamId: string, itemId: string): TeamBoardItem | null {
	const row = db
		.select(BOARD_ITEM_COLUMNS)
		.from(teamWorkItems)
		.leftJoin(narrators, eq(narrators.id, teamWorkItems.workerNarratorId))
		.where(and(eq(teamWorkItems.id, itemId), eq(teamWorkItems.teamId, teamId)))
		.limit(1)
		.get();
	return row ? boardItemOf(row) : null;
}

/**
 * One page of one board column. Open columns run oldest first (their queue order), finished
 * columns newest change first; both page by a `(sort key, id)` keyset cursor.
 */
export async function readTeamBoardColumn(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	options: { column: TeamBoardColumn; limit: number; cursor?: string },
): Promise<TeamBoardColumnPage> {
	await loadTeamForAccess(teamId, principal, "read", projectId);
	const states = [...TEAM_BOARD_COLUMN_STATES[options.column]];
	const finished = boardColumnIsFinished(options.column);
	const sortColumn = finished ? teamWorkItems.updatedAt : teamWorkItems.createdAt;
	const after = decodeCursor(options.cursor);
	const keyset = after
		? finished
			? or(
					lt(sortColumn, after.key),
					and(eq(sortColumn, after.key), lt(teamWorkItems.id, after.id)),
				)
			: or(
					gt(sortColumn, after.key),
					and(eq(sortColumn, after.key), gt(teamWorkItems.id, after.id)),
				)
		: undefined;
	const rows = db
		.select(BOARD_ITEM_COLUMNS)
		.from(teamWorkItems)
		.leftJoin(narrators, eq(narrators.id, teamWorkItems.workerNarratorId))
		.where(and(eq(teamWorkItems.teamId, teamId), inArray(teamWorkItems.state, states), keyset))
		.orderBy(
			finished ? desc(sortColumn) : asc(sortColumn),
			finished ? desc(teamWorkItems.id) : asc(teamWorkItems.id),
		)
		.limit(options.limit + 1)
		.all();
	const page = rows.slice(0, options.limit);
	const items: TeamBoardItem[] = page.map(boardItemOf);
	const last = page.at(-1);
	return {
		column: options.column,
		items,
		nextCursor:
			rows.length > options.limit && last
				? encodeCursor(finished ? last.updatedAt : last.createdAt, last.id)
				: null,
	};
}

/**
 * What a running worker did last (R): its newest tool call, by the `(narrator_id, created_at)`
 * index, one row, the input read as a bounded prefix.
 */
export function workerActivity(narratorId: string): TeamWorkerActivity | null {
	const row = db
		.select({
			toolName: narratorToolCalls.toolName,
			input: sql<string | null>`substr(${narratorToolCalls.inputJson}, 1, ${PREVIEW_SOURCE_CHARS})`,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.narratorId, narratorId))
		.orderBy(desc(narratorToolCalls.createdAt))
		.limit(1)
		.get();
	if (!row) return null;
	const kind = teamApprovalKind(row.toolName);
	const preview =
		kind === "question"
			? (questionPreview(row.input)[0] ?? "")
			: kind === "plan"
				? planTitle(row.input)
				: approvalPreview(row.input);
	return {
		toolName: row.toolName,
		preview: clipText(preview.replace(/\s+/g, " "), TEAM_ACTIVITY_PREVIEW_CHARS),
		at: row.createdAt,
	};
}

const clipText = (value: string, max: number) =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value;

// ── Activity ────────────────────────────────────────────────────────────────

/** The team's events, newest first, one page; actor names resolved per page. */
export async function readTeamActivity(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	options: { limit: number; cursor?: string },
): Promise<TeamActivityPage> {
	await loadTeamForAccess(teamId, principal, "read", projectId);
	const after = decodeCursor(options.cursor);
	const rows = db
		.select({
			id: teamWorkEvents.id,
			kind: teamWorkEvents.kind,
			workItemId: teamWorkEvents.workItemId,
			workItemTitle: teamWorkItems.title,
			actorKind: teamWorkEvents.actorKind,
			actorId: teamWorkEvents.actorId,
			detailLength: sql<number | null>`length(${teamWorkEvents.detailJson})`,
			detail: sql<
				string | null
			>`case when length(${teamWorkEvents.detailJson}) <= ${TEAM_EVENT_DETAIL_PREVIEW_CHARS} then ${teamWorkEvents.detailJson} end`,
			...returnedReasonColumns,
			createdAt: teamWorkEvents.createdAt,
		})
		.from(teamWorkEvents)
		.leftJoin(teamWorkItems, eq(teamWorkItems.id, teamWorkEvents.workItemId))
		.where(
			and(
				eq(teamWorkEvents.teamId, teamId),
				after
					? or(
							lt(teamWorkEvents.createdAt, after.key),
							and(eq(teamWorkEvents.createdAt, after.key), lt(teamWorkEvents.id, after.id)),
						)
					: undefined,
			),
		)
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(options.limit + 1)
		.all();
	const page = rows.slice(0, options.limit);
	const names = actorNames(page);
	const events: TeamActivityEvent[] = page.map((row) => ({
		id: row.id,
		kind: row.kind,
		workItemId: row.workItemId,
		workItemTitle: row.workItemTitle ?? null,
		actorKind: row.actorKind as TeamEventActorKind,
		actorId: row.actorId,
		actorName: row.actorId ? (names.get(`${row.actorKind}:${row.actorId}`) ?? null) : null,
		...eventDetail(row),
		createdAt: row.createdAt,
	}));
	const last = page.at(-1);
	return {
		events,
		nextCursor: rows.length > options.limit && last ? encodeCursor(last.createdAt, last.id) : null,
	};
}

/**
 * Longest `work.returned` detail ever written: a {@link TEAM_RETURN_REASON_MAX_LENGTH}-character
 * reason JSON-escapes to at most six characters per character (`\u00XX`), plus a few short
 * fields. Bounded so a corrupt row can't make one page read unbounded text.
 */
const TEAM_RETURN_DETAIL_MAX_CHARS = TEAM_RETURN_REASON_MAX_LENGTH * 6 + 1024;

/**
 * A return's detail read on its own: a reason with many quotes or newlines can serialize past
 * {@link TEAM_EVENT_DETAIL_PREVIEW_CHARS}, and a return must never lose its reason. Plain
 * `case`/`substr` rather than JSON functions so the query stays dialect-portable.
 */
export const returnedReasonColumns = {
	returnDetail: sql<
		string | null
	>`case when ${teamWorkEvents.kind} = ${TEAM_WORK_RETURNED_EVENT_KIND} then substr(${teamWorkEvents.detailJson}, 1, ${TEAM_RETURN_DETAIL_MAX_CHARS}) end`,
};

/** An event's detail as sent: whole when small, else omitted, but a return keeps its reason. */
export function eventDetail(row: {
	detail: string | null;
	detailLength: number | null;
	returnDetail: string | null;
}): { detail: Record<string, unknown> | null; detailOmitted: boolean } {
	const detail = parseDetail(row.detail);
	if (detail || row.detailLength === null) return { detail, detailOmitted: false };
	const returned = parseDetail(row.returnDetail);
	if (returned && typeof returned.reason === "string")
		return {
			detail: {
				reason: returned.reason.slice(0, TEAM_RETURN_REASON_MAX_LENGTH),
				verdict: "blocker",
				...(typeof returned.round === "number" ? { round: returned.round } : {}),
			},
			detailOmitted: false,
		};
	return { detail: null, detailOmitted: true };
}

function parseDetail(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Usernames and session titles of one page's actors (two primary-key `IN` lookups). */
function actorNames(rows: { actorKind: string; actorId: string | null }[]): Map<string, string> {
	const people = new Set<string>();
	const agents = new Set<string>();
	for (const row of rows) {
		if (!row.actorId) continue;
		if (row.actorKind === "person") people.add(row.actorId);
		else if (row.actorKind === "agent") agents.add(row.actorId);
	}
	const names = new Map<string, string>();
	if (people.size > 0)
		for (const user of db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(inArray(users.id, [...people]))
			.all())
			names.set(`person:${user.id}`, user.username);
	if (agents.size > 0)
		for (const agent of db
			.select({ id: narrators.id, title: narrators.title })
			.from(narrators)
			.where(and(inArray(narrators.id, [...agents]), isNotNull(narrators.title)))
			.all())
			if (agent.title) names.set(`agent:${agent.id}`, agent.title);
	return names;
}

// ── Approvals ───────────────────────────────────────────────────────────────

/** Input keys worth showing, most telling first. */
const PREVIEW_KEYS = [
	"command",
	"file_path",
	"path",
	"notebook_path",
	"url",
	"pattern",
	"action",
	"description",
	"prompt",
] as const;

/** Bytes of a tool call's input read for its preview. */
const PREVIEW_SOURCE_CHARS = 4096;

/**
 * A short view of a tool call's input from a bounded prefix of its JSON: the first telling
 * string field when the prefix parses, else the same field picked out of the prefix text.
 */
export function approvalPreview(prefix: string | null): string {
	if (!prefix) return "";
	const clip = (value: string) =>
		value.length > TEAM_APPROVAL_PREVIEW_CHARS
			? `${value.slice(0, TEAM_APPROVAL_PREVIEW_CHARS - 1)}…`
			: value;
	try {
		const parsed = JSON.parse(prefix) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			for (const key of PREVIEW_KEYS) {
				const value = record[key];
				if (typeof value === "string" && value.trim()) return clip(value.trim());
			}
		}
		return clip(prefix);
	} catch {
		for (const key of PREVIEW_KEYS) {
			const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(prefix);
			if (match?.[1]) {
				let text = match[1];
				try {
					text = JSON.parse(`"${text}"`) as string;
				} catch {
					// keep the raw escaped text of a cut-off string
				}
				if (text.trim()) return clip(text.trim());
			}
		}
		return clip(prefix);
	}
}

/**
 * The title of a plan (ExitPlanMode) from a bounded prefix of its input: the first non-empty
 * line of `plan`, without its heading marks.
 */
export function planTitle(prefix: string | null): string {
	if (!prefix) return "";
	let plan = "";
	try {
		const parsed = JSON.parse(prefix) as { plan?: unknown };
		if (typeof parsed.plan === "string") plan = parsed.plan;
	} catch {
		const match = /"plan"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(prefix);
		if (match?.[1]) {
			try {
				plan = JSON.parse(`"${match[1]}"`) as string;
			} catch {
				// A string cut off mid-escape: drop the broken tail.
				try {
					plan = JSON.parse(`"${match[1].replace(/\\[^"]*$/, "")}"`) as string;
				} catch {
					plan = "";
				}
			}
		}
	}
	const line = plan
		.split("\n")
		.map((text) => text.replace(/^#+\s*/, "").trim())
		.find(Boolean);
	return line ? clipText(line, TEAM_APPROVAL_PREVIEW_CHARS) : "";
}

/**
 * The in-place answer form of an AskUserQuestion call (R): only when the bounded prefix is the
 * whole input and it asks exactly one question with options; the same normalization as the
 * session's form, so the answer key is the header that form would send.
 */
export function questionForm(prefix: string | null): TeamQuestionForm | null {
	if (!prefix) return null;
	let parsed: { questions?: unknown };
	try {
		parsed = JSON.parse(prefix) as { questions?: unknown };
	} catch {
		return null;
	}
	const questions = coerceAskQuestionShape(parsed.questions);
	const only = questions.length === 1 ? questions[0] : undefined;
	if (!only || only.options.length === 0 || only.options.length > TEAM_QUESTION_OPTIONS_MAX)
		return null;
	// The same normalized shape the session's form renders: title, prompt, options with their
	// explanations. All of it comes from the bounded prefix, which parsed whole.
	return {
		header: only.header,
		description: only.description?.trim() || null,
		optionDescriptions: only.options.map((option) => option.description?.trim() || null),
		// The answer value is the option's whole title: never shortened (the page clips only what
		// it shows). The prefix this reads is bounded, so the titles are too.
		options: only.options.map((option) => option.header),
		multiSelect: only.multiSelect === true,
	};
}

/** Questions shown per AskUserQuestion call, and characters per question. */
const QUESTIONS_SHOWN = 3;
const QUESTION_CHARS = 200;

/**
 * The questions of an AskUserQuestion call from a bounded prefix of its input: parsed when the
 * prefix is whole, else each `"question": "…"` picked out of the text.
 */
export function questionPreview(prefix: string | null): string[] {
	if (!prefix) return [];
	const clip = (value: string) =>
		value.length > QUESTION_CHARS ? `${value.slice(0, QUESTION_CHARS - 1)}…` : value;
	let texts: string[] = [];
	try {
		const parsed = JSON.parse(prefix) as { questions?: unknown };
		// The normalized shape (legacy `question` bodies included): the prompt, else the title.
		texts = coerceAskQuestionShape(parsed.questions).map(
			(question) => question.description?.trim() || question.header,
		);
	} catch {
		// A cut-off input (its session has the full form): the legacy `question` bodies it shows.
		// Not `description` / `header`: options carry those keys too.
		for (const match of prefix.matchAll(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
			try {
				texts.push(JSON.parse(`"${match[1]}"`) as string);
			} catch {
				texts.push(match[1] ?? "");
			}
		}
	}
	return texts
		.map((text) => text.trim())
		.filter(Boolean)
		.slice(0, QUESTIONS_SHOWN)
		.map(clip);
}

/**
 * The tool calls of the team tree waiting for a person, oldest first, at most
 * {@link TEAM_APPROVALS_LIMIT}. Members only: an onlooker gets 403 (a stranger 404). Each one
 * is decided through the ordinary permission routes, which check write access on its session.
 */
export async function readTeamApprovals(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
): Promise<TeamApprovalsResponse> {
	await loadTeamForAccess(teamId, principal, "write", projectId);
	const { rows, complete } = visiblePendingCalls(teamId, TEAM_APPROVALS_LIMIT + 1);
	const shown = rows.slice(0, TEAM_APPROVALS_LIMIT);
	const details =
		shown.length > 0
			? new Map(
					db
						.select({
							id: narratorToolCalls.id,
							input: sql<
								string | null
							>`substr(${narratorToolCalls.inputJson}, 1, ${PREVIEW_SOURCE_CHARS})`,
							reason: sql<
								string | null
							>`substr(${narratorToolCalls.permissionDecisionReason}, 1, ${TEAM_APPROVAL_PREVIEW_CHARS})`,
						})
						.from(narratorToolCalls)
						.where(
							inArray(
								narratorToolCalls.id,
								shown.map((row) => row.id),
							),
						)
						.all()
						.map((row) => [row.id, row]),
				)
			: new Map<string, { input: string | null; reason: string | null }>();
	const approvals: TeamPendingApproval[] = shown.map((row) => {
		const detail = details.get(row.id);
		const kind = teamApprovalKind(row.toolName);
		return {
			id: row.id,
			agent: agentRef({ id: row.narratorId, title: row.title, status: row.status }),
			depth: depthOf(teamId, { id: row.narratorId, parentNarratorId: row.parentNarratorId }),
			toolName: row.toolName,
			kind,
			parentId: row.parentNarratorId,
			preview:
				kind === "question"
					? ""
					: kind === "plan"
						? planTitle(detail?.input ?? null)
						: approvalPreview(detail?.input ?? null),
			questions: kind === "question" ? questionPreview(detail?.input ?? null) : [],
			answerForm: kind === "question" ? questionForm(detail?.input ?? null) : null,
			decisionReason: detail?.reason ?? null,
			createdAt: row.createdAt,
		};
	});
	return {
		approvals,
		// "More" only when visible calls were cut off; an unfinished scan is said apart.
		more: rows.length > TEAM_APPROVALS_LIMIT,
		unscanned: !complete && rows.length <= TEAM_APPROVALS_LIMIT,
	};
}

// ── Members (M1) ────────────────────────────────────────────────────────────

/**
 * The team's people for the members drawer: members (write on the coordinator) and onlookers
 * (read), with when each last spoke. Members and onlookers may read it; others get 404.
 * `canManage` says whether the caller may grant and revoke access, which goes through the
 * ordinary narrator sharing routes on the coordinator.
 */
export async function readTeamMembersPage(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
): Promise<TeamMembersResponse> {
	const { coordinator } = await loadTeamForAccess(teamId, principal, "read", projectId);
	const read = await readTeamMembers(teamId, { viewer: principal });
	return {
		members: read?.members ?? [],
		more: read?.more ?? false,
		visibility: read?.visibility ?? coordinator.visibility,
		writeAudience: read?.writeAudience ?? coordinator.writeAudience,
		canManage: await canManageNarratorAcl(coordinator, principal),
	};
}

/** The running sessions of the tree for "pause all", at most {@link TEAM_PAUSE_LIMIT}. Members only. */
export async function readTeamRunning(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
): Promise<TeamRunningResponse> {
	await loadTeamForAccess(teamId, principal, "write", projectId);
	return runningTreeSessions(teamId, TEAM_PAUSE_LIMIT);
}
