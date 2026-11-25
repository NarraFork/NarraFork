/**
 * Read models of the redesigned project pages (R2): the project list's per-project numbers, the
 * project page's 「等你处理」, and its session list.
 *
 * Everything here is read-only and bounded. Every statement has a LIMIT, reads by primary key or
 * an index (`narrators(status)`, `narrators(variant, updated_at, id)`,
 * `narrator_project_links(project_id, narrator_id)` and its primary key,
 * `project_teams(project_id, status, narrator_id)`, `team_work_items(project_id, state, id)`,
 * `narrator_tool_calls(status, narrator_id, created_at)`), and no response carries a large column
 * (a tool call's input is read as a 4 KB prefix, as on the team page). The aggregate joins run on
 * the read worker (`readQuery`, `worker-required`); the pending-call scan is the team page's
 * (`teams/team-board.ts:scanPendingCalls`), generalized to a project scope.
 *
 * Access follows the project and narrator ACL: a project the caller cannot read is not found;
 * the session list and the counts only include sessions the caller can read
 * (`narratorReadableWhere`); 「等你处理」 is for project members (write) and lists only calls
 * the caller may decide (`canWriteNarrator`) and ready items of teams they are a member of.
 *
 * SQLite only, like the narrator and team surfaces these read; the routes refuse PostgreSQL with
 * 503 before anything else. The SQL stays dialect-portable (no JSON functions, no `indexed by`).
 */

import {
	PROJECT_ATTENTION_LIMIT,
	PROJECT_ATTENTION_READY_LIMIT,
	PROJECT_SESSION_COUNT_CAP,
	PROJECT_SESSIONS_PAGE_LIMIT,
	PROJECT_SESSIONS_RECENT_DAYS,
	PROJECT_SUMMARY_ACTIVITY_SCAN,
	PROJECT_SUMMARY_PROJECTS_LIMIT,
	PROJECT_SUMMARY_ROW_CAP,
	type ProjectAttentionEntry,
	type ProjectAttentionResponse,
	type ProjectListSummary,
	type ProjectSessionPage,
	type ProjectSessionRow,
	type ProjectSessionView,
} from "@shared/project-overview";
import { and, desc, eq, inArray, lt, ne, notInArray, or, type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorProjectLinks, narrators, projectTeams, teamWorkItems, users } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { ForbiddenError, ValidationError } from "../lib/errors";
import { canWriteNarrator, type NarratorPrincipal, narratorReadableWhere } from "./narrator-acl";
import {
	canWriteProject,
	loadProjectForAccess,
	type ProjectAclRow,
	type ProjectPrincipal,
} from "./project-acl";
import { projectReadAdapter } from "./read";
import {
	depthOf,
	type PendingRow,
	pendingApprovalsOf,
	readReadyItems,
	scanPendingCalls,
	workerActivity,
} from "./teams/team-board";

const READ_TIMEOUT_MS = 5_000;
const RUNNING: ("working" | "waiting")[] = ["working", "waiting"];
/** Teams of one project whose membership 「等你处理」 checks for ready items. */
const ATTENTION_TEAM_SCAN = 200;

const workerRead = (maxRows: number, diagnosticSource: string, signal?: AbortSignal) => ({
	executionPolicy: "worker-required" as const,
	maxRows,
	timeoutMs: READ_TIMEOUT_MS,
	signal,
	diagnosticSource,
});

// ── Scopes ──────────────────────────────────────────────────────────────────

/**
 * The session a narrator row stands for in a project: a subagent's ACL root (a worker belongs to
 * its team, a helper to its session), else itself.
 */
const rootIdSql = sql`case when ${narrators.type} = 'subagent' and ${narrators.aclRootNarratorId} is not null then ${narrators.aclRootNarratorId} else ${narrators.id} end`;

/**
 * Narrators of these projects, as the project page lists them: the root session has a link to
 * one of them (any role; the link table's primary key leads with the narrator) or names one as
 * its explicit project.
 */
function inProjects(projectIds: readonly string[]): SQL | undefined {
	return or(
		sql`exists (select 1 from ${narratorProjectLinks} where ${narratorProjectLinks.narratorId} = ${rootIdSql} and ${inArray(narratorProjectLinks.projectId, [...projectIds])})`,
		inArray(narrators.contextProjectId, [...projectIds]),
	);
}

/** Not a team's coordinator: those belong to the team cards, not the session list. */
const notCoordinator = sql`not exists (select 1 from ${projectTeams} where ${projectTeams.narratorId} = ${narrators.id})`;

/** Primary sessions a project page lists (one project): linked, or explicitly in it. */
function sessionOfProject(projectId: string): SQL {
	return sql`${narrators.id} in (select npl.narrator_id from narrator_project_links npl where npl.project_id = ${projectId} union select n2.id from narrators n2 where n2.context_project_id = ${projectId})`;
}

const rootOf = (row: Pick<PendingRow, "type" | "aclRootNarratorId" | "narratorId">) =>
	row.type === "subagent" && row.aclRootNarratorId ? row.aclRootNarratorId : row.narratorId;

/** Whether the caller may decide a call: write on its session, read once per session. */
function decider(principal: NarratorPrincipal) {
	const cache = new Map<string, Promise<boolean>>();
	return (row: PendingRow): Promise<boolean> => {
		let verdict = cache.get(row.narratorId);
		if (!verdict) {
			verdict = canWriteNarrator(
				{
					id: row.narratorId,
					ownerUserId: row.ownerUserId,
					visibility: row.visibility,
					writeAudience: row.writeAudience,
					type: row.type,
					aclRootNarratorId: row.aclRootNarratorId,
					contextProjectId: row.contextProjectId,
				},
				principal,
			);
			cache.set(row.narratorId, verdict);
		}
		return verdict;
	};
}

// ── The project list ────────────────────────────────────────────────────────

function add(map: Map<string, Set<string>>, key: string, value: string): void {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	set.add(value);
}

/**
 * The numbers of the caller's project cards: their first {@link PROJECT_SUMMARY_PROJECTS_LIMIT}
 * readable projects in the list's order (newest update first). Each query reads at most
 * {@link PROJECT_SUMMARY_ROW_CAP} + 1 rows across all of them; past it the counts are lower
 * bounds (`capped`). Waiting counts only for projects the caller is a member of.
 */
export async function readProjectSummaries(
	principal: ProjectPrincipal,
	signal?: AbortSignal,
): Promise<ProjectListSummary[]> {
	const page = await projectReadAdapter().listProjects(principal, {
		limit: PROJECT_SUMMARY_PROJECTS_LIMIT,
	});
	const rows = page.rows as (ProjectAclRow & { updatedAt: string })[];
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);
	const readable = narratorReadableWhere(principal);

	// Running sessions (no coordinators), driven by the status index: by link, then by explicit
	// project (a session created from a project page, before the index links it).
	const runningWhere = and(
		inArray(narrators.status, RUNNING),
		eq(narrators.variant, "primary"),
		eq(narrators.hiddenFromLists, false),
		notCoordinator,
		readable,
	);
	const linkedRunning = await readQuery(
		db
			.select({ projectId: narratorProjectLinks.projectId, id: narrators.id })
			.from(narratorProjectLinks)
			.innerJoin(narrators, eq(narrators.id, narratorProjectLinks.narratorId))
			.where(and(inArray(narratorProjectLinks.projectId, ids), runningWhere))
			.limit(PROJECT_SUMMARY_ROW_CAP + 1),
		workerRead(PROJECT_SUMMARY_ROW_CAP + 1, "projects.summaries.running", signal),
	);
	const explicitRunning = await readQuery(
		db
			.select({ projectId: narrators.contextProjectId, id: narrators.id })
			.from(narrators)
			.where(and(inArray(narrators.contextProjectId, ids), runningWhere))
			.limit(PROJECT_SUMMARY_ROW_CAP + 1),
		workerRead(PROJECT_SUMMARY_ROW_CAP + 1, "projects.summaries.running-explicit", signal),
	);
	const sessionRows = [
		...linkedRunning,
		...explicitRunning.flatMap((row) =>
			row.projectId ? [{ projectId: row.projectId, id: row.id }] : [],
		),
	];
	const teamRows = await readQuery(
		db
			.select({ projectId: projectTeams.projectId, id: projectTeams.narratorId })
			.from(projectTeams)
			.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
			.where(
				and(
					inArray(projectTeams.projectId, ids),
					eq(projectTeams.status, "active"),
					ne(narrators.status, "archived"),
					readable,
				),
			)
			.limit(PROJECT_SUMMARY_ROW_CAP + 1),
		workerRead(PROJECT_SUMMARY_ROW_CAP + 1, "projects.summaries.teams", signal),
	);

	// Last activity: the newest sessions overall (bounded index walk), then which of them are
	// readable sessions of these projects.
	const recent = await readQuery(
		db
			.select({
				id: narrators.id,
				updatedAt: narrators.updatedAt,
				projectId: narrators.contextProjectId,
			})
			.from(narrators)
			.where(and(eq(narrators.variant, "primary"), eq(narrators.hiddenFromLists, false)))
			.orderBy(desc(narrators.updatedAt), desc(narrators.id))
			.limit(PROJECT_SUMMARY_ACTIVITY_SCAN),
		workerRead(PROJECT_SUMMARY_ACTIVITY_SCAN, "projects.summaries.recent", signal),
	);
	const lastActivity = new Map<string, string>();
	const projectSet = new Set(ids);
	const explicitRecent = recent.filter((row) => row.projectId && projectSet.has(row.projectId));
	if (explicitRecent.length > 0) {
		const visible = new Set(
			(
				await readQuery(
					db
						.select({ id: narrators.id })
						.from(narrators)
						.where(
							and(
								inArray(
									narrators.id,
									explicitRecent.map((row) => row.id),
								),
								readable,
							),
						)
						.limit(explicitRecent.length),
					workerRead(explicitRecent.length, "projects.summaries.activity-explicit", signal),
				)
			).map((row) => row.id),
		);
		for (const row of explicitRecent) {
			if (!row.projectId || !visible.has(row.id)) continue;
			const seen = lastActivity.get(row.projectId);
			if (!seen || row.updatedAt > seen) lastActivity.set(row.projectId, row.updatedAt);
		}
	}
	for (let index = 0; index < recent.length; index += 500) {
		const chunk = recent.slice(index, index + 500).map((row) => row.id);
		const linked = await readQuery(
			db
				.select({ projectId: narratorProjectLinks.projectId, updatedAt: narrators.updatedAt })
				.from(narrators)
				.innerJoin(narratorProjectLinks, eq(narratorProjectLinks.narratorId, narrators.id))
				.where(
					and(inArray(narrators.id, chunk), inArray(narratorProjectLinks.projectId, ids), readable),
				)
				.limit(chunk.length * 4),
			workerRead(chunk.length * 4, "projects.summaries.activity", signal),
		);
		for (const row of linked) {
			const seen = lastActivity.get(row.projectId);
			if (!seen || row.updatedAt > seen) lastActivity.set(row.projectId, row.updatedAt);
		}
	}

	// What waits: pending calls the caller may decide, then ready items of their teams; counted
	// only in projects they are a member of.
	const waiting = new Map<string, Set<string>>();
	const pending = await scanPendingCalls(
		inProjects(ids),
		PROJECT_SUMMARY_ROW_CAP + 1,
		decider(principal),
	);
	const pendingRows = pending.rows.slice(0, PROJECT_SUMMARY_ROW_CAP);
	if (pendingRows.length > 0) {
		const roots = [...new Set(pendingRows.map(rootOf))];
		const rootProjects = new Map<string, Set<string>>();
		const links = await readQuery(
			db
				.select({ id: narratorProjectLinks.narratorId, projectId: narratorProjectLinks.projectId })
				.from(narratorProjectLinks)
				.where(
					and(
						inArray(narratorProjectLinks.narratorId, roots),
						inArray(narratorProjectLinks.projectId, ids),
					),
				)
				.limit(roots.length * ids.length),
			workerRead(roots.length * ids.length, "projects.summaries.pending-links", signal),
		);
		for (const link of links) add(rootProjects, link.id, link.projectId);
		const explicit = await readQuery(
			db
				.select({ id: narrators.id, projectId: narrators.contextProjectId })
				.from(narrators)
				.where(and(inArray(narrators.id, roots), inArray(narrators.contextProjectId, ids)))
				.limit(roots.length),
			workerRead(roots.length, "projects.summaries.pending-explicit", signal),
		);
		for (const row of explicit) if (row.projectId) add(rootProjects, row.id, row.projectId);
		for (const row of pendingRows)
			for (const projectId of rootProjects.get(rootOf(row)) ?? []) add(waiting, projectId, row.id);
	}
	const ready = await readQuery(
		db
			.select({
				id: teamWorkItems.id,
				projectId: teamWorkItems.projectId,
				teamId: teamWorkItems.teamId,
				coordinator: {
					id: narrators.id,
					ownerUserId: narrators.ownerUserId,
					visibility: narrators.visibility,
					writeAudience: narrators.writeAudience,
					type: narrators.type,
					aclRootNarratorId: narrators.aclRootNarratorId,
					contextProjectId: narrators.contextProjectId,
				},
			})
			.from(teamWorkItems)
			.innerJoin(narrators, eq(narrators.id, teamWorkItems.teamId))
			.where(and(inArray(teamWorkItems.projectId, ids), eq(teamWorkItems.state, "ready")))
			.limit(PROJECT_SUMMARY_ROW_CAP + 1),
		workerRead(PROJECT_SUMMARY_ROW_CAP + 1, "projects.summaries.ready", signal),
	);
	const memberOf = new Map<string, Promise<boolean>>();
	for (const item of ready.slice(0, PROJECT_SUMMARY_ROW_CAP)) {
		let member = memberOf.get(item.teamId);
		if (!member) {
			member = canWriteNarrator(item.coordinator, principal);
			memberOf.set(item.teamId, member);
		}
		if (await member) add(waiting, item.projectId, `merge:${item.id}`);
	}

	const capped =
		linkedRunning.length > PROJECT_SUMMARY_ROW_CAP ||
		explicitRunning.length > PROJECT_SUMMARY_ROW_CAP ||
		teamRows.length > PROJECT_SUMMARY_ROW_CAP ||
		pending.rows.length > PROJECT_SUMMARY_ROW_CAP ||
		!pending.complete ||
		ready.length > PROJECT_SUMMARY_ROW_CAP;
	const running = new Map<string, Set<string>>();
	for (const row of sessionRows) add(running, row.projectId, row.id);
	const teams = new Map<string, Set<string>>();
	for (const row of teamRows.slice(0, PROJECT_SUMMARY_ROW_CAP)) add(teams, row.projectId, row.id);

	const summaries: ProjectListSummary[] = [];
	for (const row of rows) {
		// A waiting badge is a member's: a reader cannot act on what waits there.
		const waits = waiting.get(row.id)?.size ?? 0;
		const member = waits > 0 ? await canWriteProject(row, principal) : false;
		summaries.push({
			projectId: row.id,
			runningSessionCount: running.get(row.id)?.size ?? 0,
			teamCount: teams.get(row.id)?.size ?? 0,
			waitingCount: member ? waits : 0,
			lastActivityAt: lastActivity.get(row.id) ?? row.updatedAt ?? null,
			capped,
		});
	}
	return summaries;
}

// ── The project page: 「等你处理」 ───────────────────────────────────────────

/**
 * What waits for this member across the project's sessions and teams: the pending calls they
 * may decide (oldest first, at most {@link PROJECT_ATTENTION_LIMIT}), each with the team or
 * session it comes from, then the ready items of the teams they are a member of (oldest change
 * first, at most {@link PROJECT_ATTENTION_READY_LIMIT}). Members only: a reader gets 403, a
 * stranger 404. Each call is decided through the ordinary permission routes, which check write
 * access on its session again.
 */
export async function readProjectAttention(
	projectId: string,
	principal: ProjectPrincipal,
	signal?: AbortSignal,
): Promise<ProjectAttentionResponse> {
	const project = await loadProjectForAccess(projectId, principal, "read");
	if (!(await canWriteProject(project, principal)))
		throw new ForbiddenError("Only project members see what waits for them here");

	const { rows, complete } = await scanPendingCalls(
		inProjects([projectId]),
		PROJECT_ATTENTION_LIMIT + 1,
		decider(principal),
	);
	const shown = rows.slice(0, PROJECT_ATTENTION_LIMIT);
	const roots = [...new Set(shown.map(rootOf))];
	const teamOf = new Map<string, { name: string; baseBranch: string }>();
	const sessionOf = new Map<string, { title: string | null; ownerName: string | null }>();
	if (roots.length > 0) {
		const rootRows = await readQuery(
			db
				.select({
					id: narrators.id,
					title: sql<string | null>`substr(${narrators.title}, 1, 160)`,
					ownerName: users.username,
					teamProject: projectTeams.projectId,
					baseBranch: projectTeams.baseBranch,
				})
				.from(narrators)
				.leftJoin(users, eq(users.id, narrators.ownerUserId))
				.leftJoin(projectTeams, eq(projectTeams.narratorId, narrators.id))
				.where(inArray(narrators.id, roots))
				.limit(roots.length),
			workerRead(roots.length, "projects.attention.roots", signal),
		);
		for (const row of rootRows) {
			if (row.teamProject === projectId)
				teamOf.set(row.id, { name: row.title || row.id, baseBranch: row.baseBranch ?? "main" });
			else sessionOf.set(row.id, { title: row.title, ownerName: row.ownerName ?? null });
		}
	}
	const approvals = pendingApprovalsOf(shown, (row) => {
		const root = rootOf(row);
		if (teamOf.has(root))
			return depthOf(root, { id: row.narratorId, parentNarratorId: row.parentNarratorId });
		return row.narratorId === root ? 0 : 1;
	});
	const entries: ProjectAttentionEntry[] = approvals.map((approval, index) => {
		const root = rootOf(shown[index] as PendingRow);
		const team = teamOf.get(root);
		const session = sessionOf.get(root);
		return {
			kind: "approval",
			approval,
			source: team
				? { kind: "team", teamId: root, name: team.name }
				: {
						kind: "session",
						narratorId: root,
						title: session?.title ?? null,
						ownerName: session?.ownerName ?? null,
					},
		};
	});

	// Ready items of the teams this person is a member of.
	const teamRows = await readQuery(
		db
			.select({
				id: narrators.id,
				title: sql<string | null>`substr(${narrators.title}, 1, 160)`,
				baseBranch: projectTeams.baseBranch,
				ownerUserId: narrators.ownerUserId,
				visibility: narrators.visibility,
				writeAudience: narrators.writeAudience,
				type: narrators.type,
				aclRootNarratorId: narrators.aclRootNarratorId,
				contextProjectId: narrators.contextProjectId,
			})
			.from(projectTeams)
			.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
			.where(
				and(
					eq(projectTeams.projectId, projectId),
					eq(projectTeams.status, "active"),
					ne(narrators.status, "archived"),
				),
			)
			.limit(ATTENTION_TEAM_SCAN),
		workerRead(ATTENTION_TEAM_SCAN, "projects.attention.teams", signal),
	);
	const memberTeams = new Map<string, { name: string; baseBranch: string }>();
	for (const team of teamRows)
		if (await canWriteNarrator(team, principal))
			memberTeams.set(team.id, { name: team.title || team.id, baseBranch: team.baseBranch });
	const ready = readReadyItems(projectId, [...memberTeams.keys()], PROJECT_ATTENTION_READY_LIMIT);
	for (const item of ready.items) {
		const team = memberTeams.get(item.teamId);
		if (!team) continue;
		const { teamId, ...card } = item;
		entries.push({
			kind: "merge",
			item: card,
			base: card.baseRef ?? team.baseBranch,
			source: { kind: "team", teamId, name: team.name },
		});
	}
	return {
		entries,
		more: rows.length > PROJECT_ATTENTION_LIMIT || ready.more,
		unscanned: !complete && rows.length <= PROJECT_ATTENTION_LIMIT,
	};
}

// ── The project page: sessions ──────────────────────────────────────────────

type SessionCursor = { phase: "running" | "recent" | "all"; at: string; id: string };

function encodeSessionCursor(cursor: SessionCursor): string {
	return Buffer.from(JSON.stringify([cursor.phase, cursor.at, cursor.id]), "utf8").toString(
		"base64url",
	);
}

function decodeSessionCursor(value: string | undefined): SessionCursor | null {
	if (!value) return null;
	if (value.length <= 512) {
		try {
			const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
			if (
				Array.isArray(parsed) &&
				parsed.length === 3 &&
				(parsed[0] === "running" || parsed[0] === "recent" || parsed[0] === "all") &&
				typeof parsed[1] === "string" &&
				typeof parsed[2] === "string"
			)
				return { phase: parsed[0], at: parsed[1], id: parsed[2] };
		} catch {
			// fall through
		}
	}
	throw new ValidationError("Invalid cursor");
}

const sessionColumns = {
	id: narrators.id,
	title: sql<string | null>`substr(${narrators.title}, 1, 200)`,
	status: narrators.status,
	updatedAt: narrators.updatedAt,
	ownerUserId: narrators.ownerUserId,
	username: users.username,
	avatarColor: users.avatarColor,
	avatarImageId: users.avatarImageId,
};

/** The newest-first keyset after a cursor. */
const after = (cursor: SessionCursor | null) =>
	cursor
		? or(
				lt(narrators.updatedAt, cursor.at),
				and(eq(narrators.updatedAt, cursor.at), lt(narrators.id, cursor.id)),
			)
		: undefined;

/** A tab's count, counted up to the cap + 1 (a bounded subquery, never the whole history). */
async function cappedCount(where: SQL | undefined, signal?: AbortSignal): Promise<number> {
	const inner = db
		.select({ one: sql<number>`1`.as("one") })
		.from(narrators)
		.where(where)
		.limit(PROJECT_SESSION_COUNT_CAP + 1)
		.as("capped");
	const [row] = await readQuery(
		db.select({ count: sql<number>`count(*)` }).from(inner),
		workerRead(1, "projects.sessions.count", signal),
	);
	return Number(row?.count ?? 0);
}

/**
 * One page of the project's session list: primary, listed, unarchived sessions the caller can
 * read, linked to the project (any role, or explicitly in it), never a team's coordinator (it is
 * on the team cards) nor a subagent (workers and helpers). Views:
 * - `active` (进行中): working and waiting sessions newest first, then the others changed in the
 *   last {@link PROJECT_SESSIONS_RECENT_DAYS} days;
 * - `all`: every one, newest change first;
 * - `mine`: the caller's own, newest change first.
 * Keyset-paged (`(updated_at, id)` descending, the active view's cursor carries its phase);
 * the first page also counts each tab up to {@link PROJECT_SESSION_COUNT_CAP} + 1.
 */
export async function readProjectSessions(
	projectId: string,
	principal: ProjectPrincipal,
	options: { view: ProjectSessionView; cursor?: string; limit?: number; now?: Date },
	signal?: AbortSignal,
): Promise<ProjectSessionPage> {
	await loadProjectForAccess(projectId, principal, "read");
	const limit = Math.min(Math.max(options.limit ?? PROJECT_SESSIONS_PAGE_LIMIT, 1), 100);
	const cursor = decodeSessionCursor(options.cursor);
	const since = new Date(
		(options.now ?? new Date()).getTime() - PROJECT_SESSIONS_RECENT_DAYS * 86_400_000,
	).toISOString();
	const base = and(
		eq(narrators.variant, "primary"),
		eq(narrators.hiddenFromLists, false),
		ne(narrators.status, "archived"),
		narratorReadableWhere(principal),
		sessionOfProject(projectId),
		notCoordinator,
	);
	const running = and(base, inArray(narrators.status, RUNNING));
	const recent = and(
		base,
		notInArray(narrators.status, RUNNING),
		sql`${narrators.updatedAt} >= ${since}`,
	);
	const mine = and(base, eq(narrators.ownerUserId, principal.userId));

	const readPage = (where: SQL | undefined, rows: number) =>
		readQuery(
			db
				.select(sessionColumns)
				.from(narrators)
				.leftJoin(users, eq(users.id, narrators.ownerUserId))
				.where(where)
				.orderBy(desc(narrators.updatedAt), desc(narrators.id))
				.limit(rows),
			workerRead(rows, "projects.sessions.page", signal),
		);

	type Row = Awaited<ReturnType<typeof readPage>>[number];
	const picked: { row: Row; phase: SessionCursor["phase"] }[] = [];
	let more = false;
	if (options.view === "active") {
		if (!cursor || cursor.phase === "running") {
			const rows = await readPage(and(running, after(cursor)), limit + 1);
			for (const row of rows.slice(0, limit)) picked.push({ row, phase: "running" });
			more = rows.length > limit;
		}
		if (!more && picked.length < limit + 1) {
			const room = limit - picked.length;
			const rows = await readPage(
				and(recent, cursor?.phase === "recent" ? after(cursor) : undefined),
				room + 1,
			);
			for (const row of rows.slice(0, room)) picked.push({ row, phase: "recent" });
			more = rows.length > room;
		}
	} else {
		if (cursor && cursor.phase !== "all") throw new ValidationError("Invalid cursor");
		const rows = await readPage(
			and(options.view === "mine" ? mine : base, after(cursor)),
			limit + 1,
		);
		for (const row of rows.slice(0, limit)) picked.push({ row, phase: "all" });
		more = rows.length > limit;
	}

	const items: ProjectSessionRow[] = picked.map(({ row }) => {
		const live = RUNNING.includes(row.status as "working" | "waiting");
		return {
			id: row.id,
			title: row.title,
			status: row.status,
			group: live ? "running" : "recent",
			updatedAt: row.updatedAt,
			owner:
				row.ownerUserId && row.username
					? {
							userId: row.ownerUserId,
							username: row.username,
							avatarColor: row.avatarColor ?? null,
							avatarImageId: row.avatarImageId ?? null,
						}
					: null,
			// What a running session is doing: its newest tool call, one indexed probe.
			activity: live ? workerActivity(row.id) : null,
		};
	});
	const last = picked.at(-1);
	const counts = cursor
		? null
		: {
				active: Math.min(
					PROJECT_SESSION_COUNT_CAP + 1,
					(await cappedCount(running, signal)) + (await cappedCount(recent, signal)),
				),
				all: await cappedCount(base, signal),
				mine: await cappedCount(mine, signal),
			};
	return {
		items,
		nextCursor:
			more && last
				? encodeSessionCursor({ phase: last.phase, at: last.row.updatedAt, id: last.row.id })
				: null,
		counts,
	};
}
