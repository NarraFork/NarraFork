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

import {
	boardColumnIsFinished,
	TEAM_APPROVAL_PREVIEW_CHARS,
	TEAM_APPROVALS_LIMIT,
	TEAM_BOARD_COLUMN_STATES,
	TEAM_BOARD_COLUMNS,
	TEAM_EVENT_DETAIL_PREVIEW_CHARS,
	TEAM_RUNNING_AGENTS_LIMIT,
	TEAM_TREE_LIMIT,
	type TeamActivityEvent,
	type TeamActivityPage,
	type TeamAgentRef,
	type TeamApprovalsResponse,
	type TeamBoardColumn,
	type TeamBoardColumnPage,
	type TeamBoardItem,
	type TeamEventActorKind,
	type TeamPageSummary,
	type TeamPendingApproval,
} from "@shared/project-teams";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
	narrators,
	narratorToolCalls,
	teamWorkEvents,
	teamWorkItems,
	users,
} from "../../db/schema";
import { ValidationError } from "../../lib/errors";
import type { NarratorPrincipal } from "../narrator-acl";
import { shouldHidePendingPermission } from "../pending-permission-visibility";
import { loadTeamForAccess } from "./team-service";

const RUNNING_STATUSES = ["working", "waiting"];

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

interface TreeSession {
	id: string;
	title: string | null;
	status: string;
	parentNarratorId: string | null;
}

/**
 * The sessions of a team tree that are not archived: the coordinator first, then subagents by
 * the ACL-root index, at most {@link TEAM_TREE_LIMIT}.
 */
function liveTreeSessions(teamId: string): TreeSession[] {
	const columns = {
		id: narrators.id,
		title: narrators.title,
		status: narrators.status,
		parentNarratorId: narrators.parentNarratorId,
	};
	const coordinator = db
		.select(columns)
		.from(narrators)
		.where(eq(narrators.id, teamId))
		.limit(1)
		.get();
	const subagents = db
		.select(columns)
		.from(narrators)
		.where(
			and(
				eq(narrators.aclRootNarratorId, teamId),
				eq(narrators.type, "subagent"),
				ne(narrators.status, "archived"),
			),
		)
		.limit(TEAM_TREE_LIMIT)
		.all();
	return [...(coordinator && coordinator.status !== "archived" ? [coordinator] : []), ...subagents];
}

function agentRef(session: { id: string; title: string | null; status: string }): TeamAgentRef {
	return { id: session.id, title: session.title, status: session.status };
}

function depthOf(teamId: string, session: TreeSession): number {
	if (session.id === teamId) return 0;
	return session.parentNarratorId === teamId ? 1 : 2;
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

function pendingRows(sessionIds: string[], limit: number) {
	if (sessionIds.length === 0) return [];
	return db
		.select({
			id: narratorToolCalls.id,
			narratorId: narratorToolCalls.narratorId,
			toolName: narratorToolCalls.toolName,
			suggestions: narratorToolCalls.permissionSuggestions,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.where(
			and(
				inArray(narratorToolCalls.narratorId, sessionIds),
				eq(narratorToolCalls.status, "pending"),
			),
		)
		.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id))
		.limit(limit)
		.all()
		.filter((row) => !shouldHidePendingPermission(row.suggestions));
}

/** The top bar: running agents, pending approvals (members only), column counts, last event. */
export async function readTeamPageSummary(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
): Promise<TeamPageSummary> {
	const { coordinator, access } = await loadTeamForAccess(teamId, principal, "read", projectId);
	const tree = liveTreeSessions(teamId);
	const running = tree.filter((session) => RUNNING_STATUSES.includes(session.status));
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
		runningAgents: running.slice(0, TEAM_RUNNING_AGENTS_LIMIT).map(agentRef),
		runningCount: Math.min(running.length, TEAM_RUNNING_AGENTS_LIMIT + 1),
		pendingApprovalCount:
			access === "write"
				? pendingRows(
						tree.map((session) => session.id),
						TEAM_APPROVALS_LIMIT + 1,
					).length
				: null,
		columnCounts: columnCounts(teamId),
		lastEventId: lastEvent?.id ?? null,
		lastEventAt: lastEvent?.createdAt ?? null,
	};
}

// ── Board ───────────────────────────────────────────────────────────────────

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 12) : null);

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
		.select({
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
		})
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
	const items: TeamBoardItem[] = page.map((row) => ({
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
	}));
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
		detail: parseDetail(row.detail),
		detailOmitted: row.detail === null && row.detailLength !== null,
		createdAt: row.createdAt,
	}));
	const last = page.at(-1);
	return {
		events,
		nextCursor: rows.length > options.limit && last ? encodeCursor(last.createdAt, last.id) : null,
	};
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
	const tree = liveTreeSessions(teamId);
	const byId = new Map(tree.map((session) => [session.id, session]));
	const pending = pendingRows([...byId.keys()], TEAM_APPROVALS_LIMIT + 1);
	const shown = pending.slice(0, TEAM_APPROVALS_LIMIT);
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
	const approvals: TeamPendingApproval[] = [];
	for (const row of shown) {
		const session = byId.get(row.narratorId);
		if (!session) continue;
		const detail = details.get(row.id);
		approvals.push({
			id: row.id,
			agent: agentRef(session),
			depth: depthOf(teamId, session),
			toolName: row.toolName,
			preview: approvalPreview(detail?.input ?? null),
			decisionReason: detail?.reason ?? null,
			createdAt: row.createdAt,
		});
	}
	return { approvals, more: pending.length > TEAM_APPROVALS_LIMIT };
}
