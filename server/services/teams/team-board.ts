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
import { TEAM_CARD_FINISHED_COUNT_CAP, type TeamCardCounts } from "@shared/project-overview";
import {
	boardColumnIsFinished,
	TEAM_ACTIVITY_PREVIEW_CHARS,
	TEAM_APPROVAL_PREVIEW_CHARS,
	TEAM_APPROVALS_LIMIT,
	TEAM_BOARD_COLUMN_STATES,
	TEAM_BOARD_COLUMNS,
	TEAM_CONVERSATION_DETAIL_KEYS,
	TEAM_EVENT_DETAIL_MAX_BYTES,
	TEAM_EVENT_DETAIL_PREVIEW_CHARS,
	TEAM_HELD_WORKTREES_LIMIT,
	TEAM_PAUSE_LIMIT,
	TEAM_QUESTION_OPTIONS_MAX,
	TEAM_RETURN_REASON_MAX_LENGTH,
	TEAM_REVIEW_SUMMARY_MAX_LENGTH,
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
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	lt,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "../../db";
import {
	narrators,
	narratorToolCalls,
	projectTeams,
	teamWorkEvents,
	teamWorkItems,
	users,
} from "../../db/schema";
import { readQuery } from "../../db/worker-read";
import { ValidationError } from "../../lib/errors";
import { canManageNarratorAcl, type NarratorPrincipal } from "../narrator-acl";
import { shouldHidePendingPermission } from "../pending-permission-visibility";
import { readTeamMembers } from "./team-members";
import { canManageProjectOf, canMergeInProject, mergeSummaryOf } from "./team-merge";
import { loadTeamForAccess } from "./team-service";
import { readDependencies } from "./work-item-dependencies";

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

export function agentRef(session: {
	id: string;
	title: string | null;
	status: string;
}): TeamAgentRef {
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

export interface PendingRow {
	id: string;
	narratorId: string;
	toolName: string;
	createdAt: string;
	title: string | null;
	status: string;
	parentNarratorId: string | null;
	/** The asking session's ACL columns (a project's scan judges each one; R2). */
	type: string;
	aclRootNarratorId: string | null;
	ownerUserId: string | null;
	visibility: string;
	writeAudience: string;
	contextProjectId: string | null;
}

/**
 * One keyset page of pending calls in a scope (`where` on the joined narrator), oldest first,
 * after the same visibility rule as the session's own list (a call whose reflection still runs is
 * not waiting for a person). Driven by `idx_toolcalls_status_narrator_created` (status leads, and
 * few calls are pending at any time) joined to the narrator by primary key.
 */
function pendingCallPage(
	scope: SQL | undefined,
	after: { createdAt: string; id: string } | null,
): { visible: PendingRow[]; last: { createdAt: string; id: string } | null; full: boolean } {
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
			type: narrators.type,
			aclRootNarratorId: narrators.aclRootNarratorId,
			ownerUserId: narrators.ownerUserId,
			visibility: narrators.visibility,
			writeAudience: narrators.writeAudience,
			contextProjectId: narrators.contextProjectId,
		})
		.from(narratorToolCalls)
		.innerJoin(narrators, eq(narrators.id, narratorToolCalls.narratorId))
		.where(
			and(
				eq(narratorToolCalls.status, "pending"),
				scope,
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
	const visible: PendingRow[] = [];
	for (const row of batch) {
		if (shouldHidePendingPermission(row.suggestions)) continue;
		const { suggestions: _suggestions, ...rest } = row;
		visible.push(rest);
	}
	const last = batch.at(-1);
	return {
		visible,
		last: last ? { createdAt: last.createdAt, id: last.id } : null,
		full: batch.length >= PENDING_PAGE,
	};
}

/**
 * The visible pending calls of a scope, oldest first, read in keyset pages until `wanted` rows
 * are accepted, at most {@link PENDING_MAX_PAGES} pages. `acceptPage` (default: all) decides a
 * whole page at once, so a caller can judge access once per page — one batch per distinct
 * session, never one check per call. `complete` is false when the pages ran out before the
 * pending calls did. The team tree and the project page (R2) share it.
 */
export async function scanPendingCalls(
	scope: SQL | undefined,
	wanted: number,
	acceptPage?: (rows: readonly PendingRow[]) => Promise<(row: PendingRow) => boolean>,
): Promise<{ rows: PendingRow[]; complete: boolean }> {
	const rows: PendingRow[] = [];
	let after: { createdAt: string; id: string } | null = null;
	for (let page = 0; page < PENDING_MAX_PAGES; page++) {
		const { visible, last, full } = pendingCallPage(scope, after);
		const accepted = acceptPage && visible.length > 0 ? await acceptPage(visible) : () => true;
		for (const row of visible) {
			if (!accepted(row)) continue;
			rows.push(row);
			if (rows.length >= wanted) return { rows, complete: true };
		}
		if (!full || !last) return { rows, complete: true };
		after = last;
	}
	return { rows, complete: false };
}

/**
 * The tree's tool calls waiting for a person: {@link scanPendingCalls} over the tree, without an
 * acceptance step (members see every call of their tree), synchronous for the sidebar's count.
 */
export function visiblePendingCalls(
	teamId: string,
	wanted: number,
): { rows: PendingRow[]; complete: boolean } {
	const rows: PendingRow[] = [];
	let after: { createdAt: string; id: string } | null = null;
	for (let page = 0; page < PENDING_MAX_PAGES; page++) {
		const { visible, last, full } = pendingCallPage(inTree(teamId), after);
		for (const row of visible) {
			rows.push(row);
			if (rows.length >= wanted) return { rows, complete: true };
		}
		if (!full || !last) return { rows, complete: true };
		after = last;
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

/** Items waiting to be accepted (`ready`), counted up to 51 by `(team_id, state, id)` (R2). */
export function teamReadyItemCount(teamId: string): number {
	return db
		.select({ id: teamWorkItems.id })
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, teamId), eq(teamWorkItems.state, "ready")))
		.limit(TEAM_APPROVALS_LIMIT + 1)
		.all().length;
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

/**
 * D: the cards with their dependencies, read for the whole page in one query (never per card).
 * A card without dependencies carries an empty list.
 */
function withDependencies<T extends TeamBoardItem>(items: T[]): T[] {
	const dependencies = readDependencies(items.map((item) => item.id));
	return items.map((item) => ({ ...item, dependsOn: dependencies.get(item.id) ?? [] }));
}

/**
 * M: the ready cards with their merge state (job phase, newest outcome, whether this caller may
 * merge): one indexed outcome read per ready card, no git. Other cards are left as they are.
 */
function withMerge<T extends TeamBoardItem>(
	items: T[],
	teamOf: (item: T) => { teamActive: boolean; baseBranch: string; projectId: string } | null,
	member: boolean,
	manager = false,
): T[] {
	return items.map((item) => {
		if (item.state !== "ready") return item;
		const team = teamOf(item);
		if (!team) return item;
		return {
			...item,
			merge: mergeSummaryOf({
				item: {
					id: item.id,
					state: item.state,
					baseRef: item.baseRef,
					projectId: team.projectId,
					// Abbreviated on a card: compared by prefix with the pull request's head.
					headSha: item.headSha,
				},
				baseBranch: team.baseBranch,
				teamActive: team.teamActive,
				workerRunning: item.worker?.status === "working" || item.worker?.status === "waiting",
				member,
				manager,
			}),
		};
	});
}

/** The teams of some items: active (and coordinator not archived), base, project. */
function teamFacts(teamIds: readonly string[]) {
	const facts = new Map<string, { teamActive: boolean; baseBranch: string; projectId: string }>();
	if (teamIds.length === 0) return facts;
	for (const row of db
		.select({
			id: projectTeams.narratorId,
			status: projectTeams.status,
			baseBranch: projectTeams.baseBranch,
			projectId: projectTeams.projectId,
			coordinator: narrators.status,
		})
		.from(projectTeams)
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(inArray(projectTeams.narratorId, [...new Set(teamIds)]))
		.limit(teamIds.length)
		.all())
		facts.set(row.id, {
			teamActive: row.status === "active" && row.coordinator !== "archived",
			baseBranch: row.baseBranch,
			projectId: row.projectId,
		});
	return facts;
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
	return row ? (withDependencies([boardItemOf(row)])[0] ?? null) : null;
}

/**
 * The ready items (可以合并) of the given teams of a project, oldest change first, at most `limit`
 * (one more is read to say "more"). Driven by `idx_team_work_items_project_state`; each card is
 * read like the board's (R2: the project page's 「等你处理」).
 */
export function readReadyItems(
	projectId: string,
	teamIds: readonly string[],
	limit: number,
): { items: (TeamBoardItem & { teamId: string })[]; more: boolean } {
	if (teamIds.length === 0) return { items: [], more: false };
	const rows = db
		.select({ ...BOARD_ITEM_COLUMNS, teamId: teamWorkItems.teamId })
		.from(teamWorkItems)
		.leftJoin(narrators, eq(narrators.id, teamWorkItems.workerNarratorId))
		.where(
			and(
				eq(teamWorkItems.projectId, projectId),
				eq(teamWorkItems.state, "ready"),
				inArray(teamWorkItems.teamId, [...teamIds]),
			),
		)
		.orderBy(asc(teamWorkItems.updatedAt), asc(teamWorkItems.id))
		.limit(limit + 1)
		.all();
	const items = withDependencies(
		rows.slice(0, limit).map(({ teamId, ...row }) => ({ ...boardItemOf(row), teamId })),
	);
	const facts = teamFacts(items.map((item) => item.teamId));
	// The caller lists the teams the person is a member of.
	return {
		items: withMerge(items, (item) => facts.get(item.teamId) ?? null, true),
		more: rows.length > limit,
	};
}

const OPEN_ITEM_STATES = ["queued", "in_progress", "in_review", "ready"] as const;
const FINISHED_ITEM_STATES = ["merged", "cancelled"] as const;
const CARD_READ_TIMEOUT_MS = 5_000;

/**
 * A team card's numbers for each listed team (R2: the project page's team grid), read on the
 * read worker (5 s timeout) so their cost never lands on the main thread, and bounded by what is
 * open rather than by history:
 * - open items (queued, in progress, in review, ready) counted exactly, grouped, over the
 *   `(team_id, state, id)` index;
 * - finished items (merged, cancelled) counted up to {@link TEAM_CARD_FINISHED_COUNT_CAP} + 1 per
 *   team and state (a `LIMIT` subquery each, one `UNION ALL` statement), so a team with 50,000
 *   merged items costs what one with 1,000 does;
 * - the coordinators' last stop and message count (primary key) with each team's newest event
 *   (a correlated `(team_id, created_at, id)` probe), one statement.
 * Then per team the running count ({@link runningTreeSessions}, at most 21 rows) and, for members
 * only, the pending count the header shows (the same bounded scans the team page and the sidebar
 * run). The caller bounds the number of teams (24).
 */
export async function readTeamCards(
	teams: readonly { id: string; member: boolean }[],
	signal?: AbortSignal,
): Promise<Map<string, TeamCardCounts>> {
	const cards = new Map<string, TeamCardCounts>();
	if (teams.length === 0) return cards;
	const ids = teams.map((team) => team.id);
	const read = (maxRows: number, diagnosticSource: string) => ({
		executionPolicy: "worker-required" as const,
		maxRows,
		timeoutMs: CARD_READ_TIMEOUT_MS,
		signal,
		diagnosticSource,
	});
	const openRows = await readQuery(
		db
			.select({
				teamId: teamWorkItems.teamId,
				state: teamWorkItems.state,
				count: sql<number>`count(*)`,
			})
			.from(teamWorkItems)
			.where(
				and(
					inArray(teamWorkItems.teamId, ids),
					inArray(teamWorkItems.state, [...OPEN_ITEM_STATES]),
				),
			)
			.groupBy(teamWorkItems.teamId, teamWorkItems.state),
		read(ids.length * OPEN_ITEM_STATES.length, "teams.cards.open"),
	);
	const finishedParts = ids.flatMap((teamId) =>
		FINISHED_ITEM_STATES.map((state) =>
			db
				.select({
					teamId: sql<string>`${teamId}`.as("team_id"),
					state: sql<string>`${state}`.as("state"),
					count: sql<number>`count(*)`.as("count"),
				})
				.from(
					db
						.select({ one: sql<number>`1`.as("one") })
						.from(teamWorkItems)
						.where(and(eq(teamWorkItems.teamId, teamId), eq(teamWorkItems.state, state)))
						.limit(TEAM_CARD_FINISHED_COUNT_CAP + 1)
						.as("capped"),
				),
		),
	);
	const [firstFinished, ...moreFinished] = finishedParts;
	const finishedRows = firstFinished
		? await readQuery(
				// biome-ignore lint/suspicious/noExplicitAny: one UNION ALL of same-shaped selects
				moreFinished.reduce<any>((query, part) => query.unionAll(part), firstFinished),
				read(finishedParts.length, "teams.cards.finished"),
			)
		: [];
	const coordinators = new Map(
		(
			await readQuery(
				db
					.select({
						id: narrators.id,
						messageCount: narrators.messageCount,
						stopReason: narrators.lastStopReason,
						// The newest event: one `(team_id, created_at, id)` index probe per team. The outer
						// column is qualified by hand: a one-table select renders bare column names.
						lastEventAt: sql<
							string | null
						>`(select te.created_at from team_work_events te where te.team_id = "narrators"."id" order by te.created_at desc, te.id desc limit 1)`,
					})
					.from(narrators)
					.where(inArray(narrators.id, ids))
					.limit(ids.length),
				read(ids.length, "teams.cards.coordinators"),
			)
		).map((row) => [row.id, row]),
	);
	const stateRows = [
		...openRows,
		...(finishedRows as { teamId: string; state: string; count: number }[]),
	];
	for (const team of teams) {
		const columnCounts = Object.fromEntries(
			TEAM_BOARD_COLUMNS.map((column) => [column, 0]),
		) as Record<TeamBoardColumn, number>;
		let readyCount = 0;
		for (const row of stateRows) {
			if (row.teamId !== team.id) continue;
			const state = row.state as TeamBoardItem["state"];
			if (state === "ready") readyCount += Number(row.count);
			for (const column of TEAM_BOARD_COLUMNS)
				if (TEAM_BOARD_COLUMN_STATES[column].includes(state))
					columnCounts[column] += Number(row.count);
		}
		const running = runningTreeSessions(team.id, TEAM_RUNNING_AGENTS_LIMIT);
		const coordinator = coordinators.get(team.id);
		cards.set(team.id, {
			columnCounts,
			readyCount,
			runningCount: running.agents.length + (running.more ? 1 : 0),
			pendingApprovalCount: team.member ? pendingCount(team.id) : null,
			coordinatorStopReason: coordinator?.stopReason ?? null,
			coordinatorMessageCount: coordinator?.messageCount ?? 0,
			lastEventAt: coordinator?.lastEventAt ?? null,
		});
	}
	return cards;
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
	const { team, coordinator, access } = await loadTeamForAccess(
		teamId,
		principal,
		"read",
		projectId,
	);
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
	const teamActive = team.status === "active" && coordinator.status !== "archived";
	const cards = withDependencies(page.map(boardItemOf));
	// Merging also needs project write: asked only when the page has a ready card.
	const mayMerge =
		access === "write" &&
		cards.some((card) => card.state === "ready") &&
		(await canMergeInProject(team.projectId, principal));
	const manager = mayMerge && (await canManageProjectOf(team.projectId, principal));
	const items: TeamBoardItem[] = withMerge(
		cards,
		() => ({ teamActive, baseBranch: team.baseBranch, projectId: team.projectId }),
		mayMerge,
		manager,
	);
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
	options: { limit: number; cursor?: string; kinds?: readonly string[]; since?: string },
): Promise<TeamActivityPage> {
	await loadTeamForAccess(teamId, principal, "read", projectId);
	const after = decodeCursor(options.cursor);
	// Team mode of the coordinator conversation: a few divider kinds within the loaded window.
	const conversation = options.kinds !== undefined;
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
			// A divider needs no return reason; a long review keeps its verdict through its
			// bounded head (never the findings).
			...(conversation
				? { returnDetail: sql<string | null>`null`, ...reviewHeadColumns }
				: returnedReasonColumns),
			createdAt: teamWorkEvents.createdAt,
		})
		.from(teamWorkEvents)
		.leftJoin(teamWorkItems, eq(teamWorkItems.id, teamWorkEvents.workItemId))
		.where(
			and(
				eq(teamWorkEvents.teamId, teamId),
				options.kinds ? inArray(teamWorkEvents.kind, [...options.kinds]) : undefined,
				options.since ? gte(teamWorkEvents.createdAt, options.since) : undefined,
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
		...(conversation ? conversationDetail(row) : eventDetail(row)),
		createdAt: row.createdAt,
	}));
	const last = page.at(-1);
	return {
		events,
		nextCursor: rows.length > options.limit && last ? encodeCursor(last.createdAt, last.id) : null,
	};
}

/** A divider's detail: only {@link TEAM_CONVERSATION_DETAIL_KEYS}, never reasons or findings. */
function conversationDetail(row: Parameters<typeof eventDetail>[0]): {
	detail: Record<string, unknown> | null;
	detailOmitted: boolean;
} {
	const { detail } = eventDetail(row);
	if (!detail) return { detail: null, detailOmitted: false };
	const kept: Record<string, unknown> = {};
	for (const key of TEAM_CONVERSATION_DETAIL_KEYS) {
		const value = detail[key];
		if (typeof value === "number" || (typeof value === "string" && value.length <= 40))
			kept[key] = value;
	}
	return { detail: kept, detailOmitted: false };
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

/**
 * Longest `work.review` detail read for its findings: a stored detail is at most
 * {@link TEAM_EVENT_DETAIL_MAX_BYTES} UTF-8 bytes, so never more characters than that.
 */
const TEAM_REVIEW_DETAIL_MAX_CHARS = TEAM_EVENT_DETAIL_MAX_BYTES;

/**
 * Characters of a long review's detail read with every row: enough for the fields `recordReview`
 * writes ahead of the findings (`{"round":N,"verdict":"…","findings":N,`), so a round whose
 * findings were not read still has its verdict and count.
 */
const TEAM_REVIEW_HEAD_CHARS = 96;

/**
 * A long review's head: for a `work.review` whose detail is past
 * {@link TEAM_EVENT_DETAIL_PREVIEW_CHARS} (long findings), only its first few characters are read
 * with the page; the findings are read row by row with {@link readReviewDetailText} until the
 * drawer has enough. Plain `case`/`substr`, like the return's column, so the query stays
 * dialect-portable.
 */
export const reviewHeadColumns = {
	reviewHead: sql<
		string | null
	>`case when ${teamWorkEvents.kind} = ${"work.review"} and length(${teamWorkEvents.detailJson}) > ${TEAM_EVENT_DETAIL_PREVIEW_CHARS} then substr(${teamWorkEvents.detailJson}, 1, ${TEAM_REVIEW_HEAD_CHARS}) end`,
};

/** One long review's detail, by primary key, at most {@link TEAM_REVIEW_DETAIL_MAX_CHARS}. */
export function readReviewDetailText(eventId: string): string | null {
	const row = db
		.select({
			text: sql<
				string | null
			>`substr(${teamWorkEvents.detailJson}, 1, ${TEAM_REVIEW_DETAIL_MAX_CHARS})`,
		})
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.id, eventId), eq(teamWorkEvents.kind, "work.review")))
		.limit(1)
		.get();
	return row?.text ?? null;
}

const REVIEW_HEAD = /^\{"round":(\d+),"verdict":"(clear|blocker)","findings":(\d+)[,}]/;

/** The round, verdict and findings count at the start of a review's detail, or null. */
export function reviewHeadDetail(head: string | null | undefined): Record<string, unknown> | null {
	const match = head ? REVIEW_HEAD.exec(head) : null;
	if (!match) return null;
	return { round: Number(match[1]), verdict: match[2], findings: Number(match[3]) };
}

/**
 * An event's detail as sent: whole when small, else omitted, but a return keeps its reason and,
 * where the read asked for it, a review keeps its findings (`reviewDetail`, read on its own) or
 * at least its round, verdict and count (`reviewHead`, {@link reviewHeadColumns}).
 */
export function eventDetail(row: {
	detail: string | null;
	detailLength: number | null;
	returnDetail: string | null;
	reviewDetail?: string | null;
	reviewHead?: string | null;
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
	const review = parseDetail(row.reviewDetail ?? null);
	if (review) {
		const kept: Record<string, unknown> = {};
		for (const key of ["round", "verdict", "findings", "from", "to"])
			if (typeof review[key] === "number" || typeof review[key] === "string")
				kept[key] = review[key];
		if (typeof review.summary === "string")
			kept.summary = review.summary.slice(0, TEAM_REVIEW_SUMMARY_MAX_LENGTH);
		return { detail: kept, detailOmitted: false };
	}
	const head = reviewHeadDetail(row.reviewHead);
	if (head) return { detail: head, detailOmitted: false };
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
 * Pending calls as the approvals list shows them: one bounded read of each call's input prefix
 * and reason (`substr`, by primary key), then the preview, questions and in-place answer form.
 * Shared by the team page and the project page's 「等你处理」 (R2).
 */
export function pendingApprovalsOf(
	shown: readonly PendingRow[],
	depth: (row: PendingRow) => number,
): TeamPendingApproval[] {
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
	return shown.map((row) => {
		const detail = details.get(row.id);
		const kind = teamApprovalKind(row.toolName);
		return {
			id: row.id,
			agent: agentRef({ id: row.narratorId, title: row.title, status: row.status }),
			depth: depth(row),
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
	const approvals = pendingApprovalsOf(rows.slice(0, TEAM_APPROVALS_LIMIT), (row) =>
		depthOf(teamId, { id: row.narratorId, parentNarratorId: row.parentNarratorId }),
	);
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
