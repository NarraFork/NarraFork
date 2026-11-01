/**
 * The reads outline access decisions are made from, written once in SQL that SQLite and
 * PostgreSQL both run unchanged.
 *
 * WHY NOT CALL THE ACL MODULES
 * ----------------------------
 * `project-acl.ts` and `narrator-acl.ts` own the project and narrator rules, but they read
 * through the SQLite handle, which throws while PostgreSQL is active. The outline store already
 * runs on both backends, so its access checks have to as well. This module therefore reads only
 * the facts those rules are decided from (a narrator's audiences, a project's visibility and
 * owner, grant rows, user roles, public share links), and `access.ts` states the rules over
 * them. `access-parity.test.ts` holds the restated rules to the originals on SQLite, so a change
 * to either side that the other does not follow fails a test instead of drifting.
 *
 * Which project a narrator belongs to is still answered by `resolveNarratorProjectId`, the one
 * place that question is answered; on PostgreSQL it knows only the explicit project, because the
 * working-directory link index lives in SQLite so far.
 *
 * The space listing reuses the dialect-neutral readability predicates of `read/acl-sql.ts`, the
 * same text the project and narrator list queries are built from; so does the candidate listing
 * a session's readable spaces are judged from (`session-scope.ts`).
 *
 * THE EXECUTOR
 * ------------
 * Queries go through {@link OutlineAccessExecutor}: the SQLite handle by default, the
 * PostgreSQL client once the composition seam (`postgres-composition.ts`) injects one, exactly
 * like the outline store. A PostgreSQL process without an injected executor fails loudly rather
 * than reading SQLite.
 *
 * Every statement is small, indexed and bounded: point lookups by primary key, grant rows of one
 * scope (`idx_acl_grant_scope`), or id lists the caller has already bounded, each with a LIMIT.
 * The user id is always a bound parameter.
 */
import { type SQL, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { activeDatabaseBackend, db } from "../../db";
import {
	bindPlaceholders,
	narratorProjectIdText,
	narratorReadableText,
	projectReadableForIdText,
	projectReadableText,
} from "../read/acl-sql";
import type { OutlineSpaceKind } from "./model";
import { chunked, type OutlineSpaceRow } from "./store/port";

type Row = Record<string, unknown>;

/** Runs one read statement and returns its rows as plain objects keyed by column name. */
export interface OutlineAccessExecutor {
	readonly dialect: "sqlite" | "postgres";
	all(query: SQL): Promise<Row[]>;
}

const sqliteExecutor: OutlineAccessExecutor = {
	dialect: "sqlite",
	async all(query) {
		return db.all<Row>(query);
	},
};

/** The executor for a PostgreSQL client; the composition seam injects it. */
export function createPostgresOutlineAccessExecutor(pg: BunSQLDatabase): OutlineAccessExecutor {
	return {
		dialect: "postgres",
		async all(query) {
			return (await pg.execute(query)) as unknown as Row[];
		},
	};
}

let injected: OutlineAccessExecutor | undefined;

/** Swap the executor (composition root and tests); `undefined` restores the SQLite default. */
export function setOutlineAccessExecutor(executor: OutlineAccessExecutor | undefined): void {
	injected = executor;
}

function executor(): OutlineAccessExecutor {
	if (injected) return injected;
	if (activeDatabaseBackend !== "sqlite") {
		throw new Error("PostgreSQL is active but no outline access executor was injected");
	}
	return sqliteExecutor;
}

/** The backend outline access facts are read from. */
export function outlineAccessBackend(): OutlineAccessExecutor["dialect"] {
	return executor().dialect;
}

async function all(query: SQL): Promise<Row[]> {
	return await executor().all(query);
}

function text(row: Row, column: string): string {
	const value = row[column];
	if (typeof value !== "string") throw new Error(`outline access read: ${column} is not text`);
	return value;
}

function textOrNull(row: Row, column: string): string | null {
	const value = row[column];
	return value === null || value === undefined ? null : String(value);
}

function idList(ids: readonly string[]): SQL {
	return sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Narrators, projects, users
// ─────────────────────────────────────────────────────────────────────────────

/** The narrator columns its access is decided from; the same set as `NARRATOR_ACL_COLUMNS`. */
export interface NarratorAccessRow {
	id: string;
	ownerUserId: string | null;
	visibility: string;
	writeAudience: string;
	type: string;
	aclRootNarratorId: string | null;
	contextProjectId: string | null;
}

/** The project columns its access is decided from. */
export interface ProjectAccessRow {
	id: string;
	ownerUserId: string | null;
	visibility: string;
}

export async function readNarrator(id: string): Promise<NarratorAccessRow | null> {
	const rows = await all(sql`
		select id, owner_user_id, visibility, write_audience, type, acl_root_narrator_id,
			context_project_id
		from narrators where id = ${id} limit 1
	`);
	const row = rows[0];
	if (!row) return null;
	return {
		id: text(row, "id"),
		ownerUserId: textOrNull(row, "owner_user_id"),
		visibility: text(row, "visibility"),
		writeAudience: text(row, "write_audience"),
		type: text(row, "type"),
		aclRootNarratorId: textOrNull(row, "acl_root_narrator_id"),
		contextProjectId: textOrNull(row, "context_project_id"),
	};
}

/**
 * The narrator `row`'s access is judged on, as `resolveJudgedRow` in `narrator-acl.ts` decides
 * it: a primary narrator (forks included) is judged on itself, a subagent on its ACL root. Null
 * when a subagent's root is not recorded or no longer exists; that denies everyone but admins,
 * and is never answered by falling back to the subagent's own columns.
 */
export async function readJudgedNarrator(
	row: NarratorAccessRow,
): Promise<NarratorAccessRow | null> {
	if (row.type !== "subagent") return row;
	if (!row.aclRootNarratorId) return null;
	return await readNarrator(row.aclRootNarratorId);
}

export async function readProject(id: string): Promise<ProjectAccessRow | null> {
	const rows = await all(sql`
		select id, owner_user_id, visibility from projects where id = ${id} limit 1
	`);
	const row = rows[0];
	if (!row) return null;
	return {
		id: text(row, "id"),
		ownerUserId: textOrNull(row, "owner_user_id"),
		visibility: text(row, "visibility"),
	};
}

/** A project's name, for naming its space to people and agents. */
export async function readProjectName(id: string): Promise<string | null> {
	const rows = await all(sql`select name from projects where id = ${id} limit 1`);
	return rows[0] ? textOrNull(rows[0], "name") : null;
}

/** A narrator's title, for naming its session space to people and agents. */
export async function readNarratorTitle(id: string): Promise<string | null> {
	const rows = await all(sql`select title from narrators where id = ${id} limit 1`);
	return rows[0] ? textOrNull(rows[0], "title") : null;
}

export async function readUserExists(id: string): Promise<boolean> {
	const rows = await all(sql`select id from users where id = ${id} limit 1`);
	return rows.length > 0;
}

/**
 * Which of `ids` are existing users without the admin role. Admins can read everything, so they
 * never narrow what a session may read; an unknown role counts as not admin.
 */
export async function readNonAdminUserIds(ids: readonly string[]): Promise<Set<string>> {
	const out = new Set<string>();
	for (const chunk of chunked([...new Set(ids)])) {
		const rows = await all(sql`
			select id from users where id in (${idList(chunk)}) and role <> 'admin'
			limit ${chunk.length}
		`);
		for (const row of rows) out.add(text(row, "id"));
	}
	return out;
}

/** Whether the narrator has a public share link that has not been revoked. */
export async function readHasActivePublicShare(narratorId: string): Promise<boolean> {
	const rows = await all(sql`
		select id from narrator_public_shares
		where narrator_id = ${narratorId} and revoked_at is null
		limit 1
	`);
	return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grants
// ─────────────────────────────────────────────────────────────────────────────

export type AccessScope = { type: "project" | "narrator"; id: string };

/**
 * Capability grants on one scope: those held by any of `userIds`, and those held by the `user`
 * role, which every non-admin principal holds. Grants to the `admin` role are not read: admins
 * pass every check before grants are consulted.
 *
 * Domain credentials (`domain_kind` set) share the table and carry a placeholder capability;
 * they are never read as capabilities.
 */
export interface ScopeGrants {
	/** Capabilities per user id, for the users asked about. */
	users: Map<string, Set<string>>;
	/** Capabilities the `user` role holds here. */
	everyUser: Set<string>;
}

/** Capability rows one principal can hold on one scope (read, write, manage). */
const CAPABILITIES_PER_PRINCIPAL = 3;

export async function readScopeGrants(
	scope: AccessScope,
	userIds: readonly string[],
): Promise<ScopeGrants> {
	const out: ScopeGrants = { users: new Map(), everyUser: new Set() };
	const role = await all(sql`
		select capability from acl_grants
		where scope_type = ${scope.type} and scope_id = ${scope.id} and domain_kind is null
			and principal_type = 'role' and principal_id = 'user'
		limit ${CAPABILITIES_PER_PRINCIPAL}
	`);
	for (const row of role) out.everyUser.add(text(row, "capability"));
	for (const chunk of chunked([...new Set(userIds)])) {
		const rows = await all(sql`
			select principal_id, capability from acl_grants
			where scope_type = ${scope.type} and scope_id = ${scope.id} and domain_kind is null
				and principal_type = 'user' and principal_id in (${idList(chunk)})
			limit ${chunk.length * CAPABILITIES_PER_PRINCIPAL}
		`);
		for (const row of rows) {
			const userId = text(row, "principal_id");
			const caps = out.users.get(userId) ?? new Set<string>();
			caps.add(text(row, "capability"));
			out.users.set(userId, caps);
		}
	}
	return out;
}

/**
 * Existing non-admin users holding any of `capabilities` on the scope through a user grant, at
 * most `limit` of them. A caller asks for one more than it can handle to learn that there are
 * too many.
 */
export async function readNonAdminGrantees(
	scope: AccessScope,
	capabilities: readonly string[],
	limit: number,
): Promise<string[]> {
	const rows = await all(sql`
		select distinct g.principal_id from acl_grants g
		join users u on u.id = g.principal_id
		where g.scope_type = ${scope.type} and g.scope_id = ${scope.id} and g.domain_kind is null
			and g.principal_type = 'user' and g.capability in (${idList(capabilities)})
			and u.role <> 'admin'
		limit ${limit}
	`);
	return rows.map((row) => text(row, "principal_id"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Display names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Names to show for ids the caller has already been allowed to see: project names, narrator
 * titles and usernames, by id. Not access facts; they live here because they are read through
 * the same executor. Missing ids (deleted rows) are simply absent from the result.
 */
export async function readDisplayNames(ids: {
	projectIds?: readonly string[];
	narratorIds?: readonly string[];
	userIds?: readonly string[];
}): Promise<{
	projects: Map<string, string>;
	narrators: Map<string, string | null>;
	users: Map<string, string>;
}> {
	const out = {
		projects: new Map<string, string>(),
		narrators: new Map<string, string | null>(),
		users: new Map<string, string>(),
	};
	for (const chunk of chunked([...new Set(ids.projectIds ?? [])])) {
		const rows = await all(sql`
			select id, name from projects where id in (${idList(chunk)}) limit ${chunk.length}
		`);
		for (const row of rows) out.projects.set(text(row, "id"), text(row, "name"));
	}
	for (const chunk of chunked([...new Set(ids.narratorIds ?? [])])) {
		const rows = await all(sql`
			select id, title from narrators where id in (${idList(chunk)}) limit ${chunk.length}
		`);
		for (const row of rows) out.narrators.set(text(row, "id"), textOrNull(row, "title"));
	}
	for (const chunk of chunked([...new Set(ids.userIds ?? [])])) {
		const rows = await all(sql`
			select id, username from users where id in (${idList(chunk)}) limit ${chunk.length}
		`);
		for (const row of rows) out.users.set(text(row, "id"), text(row, "username"));
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spaces
// ─────────────────────────────────────────────────────────────────────────────

function toSpace(row: Row): OutlineSpaceRow {
	return {
		id: text(row, "id"),
		key: text(row, "key"),
		kind: text(row, "kind") as OutlineSpaceKind,
		projectId: textOrNull(row, "project_id"),
		narratorId: textOrNull(row, "narrator_id"),
		ownerUserId: textOrNull(row, "owner_user_id"),
		nextSeq: Number(row.next_seq),
		createdAt: text(row, "created_at"),
		inProcessEpoch: Number(row.in_process_epoch ?? 0),
	};
}

/**
 * A page of spaces the principal can read, in id order after `afterId`.
 *
 * Non-admins: their own personal space, project spaces of projects they can read, and session
 * spaces of narrators they can read (subagents judged on their root), by the readability
 * predicates the project and narrator lists use. Orphaned spaces are never listed for them.
 *
 * Admins: every space except other users' personal spaces, orphaned ones included.
 *
 * Ids are compared in byte order on both backends, so a cursor means the same thing on either.
 */
export async function readReadableSpacePage(
	principal: { userId: string; isAdmin: boolean },
	options: { kind?: OutlineSpaceKind; afterId?: string; limit: number },
): Promise<OutlineSpaceRow[]> {
	const pg = executor().dialect === "postgres";
	const id = pg ? sql.raw(`s.id collate "C"`) : sql.raw("s.id");
	const visible = principal.isAdmin
		? sql`(s.kind <> 'personal' or s.owner_user_id is null or s.owner_user_id = ${principal.userId})`
		: sql`(
				(s.kind = 'personal' and s.owner_user_id = ${principal.userId})
				or (s.kind = 'project' and ${bindPlaceholders(
					projectReadableForIdText("s.project_id"),
					principal.userId,
				)})
				or (s.kind = 'session' and exists (
					select 1 from narrators n
					where n.id = s.narrator_id
						and ${bindPlaceholders(narratorReadableText("n"), principal.userId)}
				))
			)`;
	const rows = await all(sql`
		select s.id, s.key, s.kind, s.project_id, s.narrator_id, s.owner_user_id, s.next_seq,
			s.in_process_epoch,
			s.created_at
		from outline_spaces s
		where ${visible}
			${options.kind ? sql`and s.kind = ${options.kind}` : sql``}
			${options.afterId !== undefined ? sql`and ${id} > ${options.afterId}` : sql``}
		order by ${id}
		limit ${options.limit}
	`);
	return rows.map(toSpace);
}

/**
 * Where the spaces a session might read are looked for (`session-scope.ts` judges each one):
 *
 *   - `reader`: what one reader of the session might read (see {@link readSpaceCandidatePage});
 *   - `open`: project spaces every signed-in user can read (public, or granted to the `user`
 *     role); never a session space;
 *   - `all`: every space of the kind with an owner left (sessions only admins read).
 */
export type OutlineSpaceCandidates =
	| { kind: "reader"; userId: string }
	| { kind: "open" }
	| { kind: "all" };

/** A project every signed-in user can read: the rule of `projectOpenToEveryone`. */
function openProjectText(projectAlias: string): string {
	return `(
		${projectAlias}.visibility = 'public'
		or exists (
			select 1 from acl_grants rg
			where rg.scope_type = 'project' and rg.scope_id = ${projectAlias}.id
				and rg.domain_kind is null and rg.principal_type = 'role' and rg.principal_id = 'user'
				and rg.capability in ('read','write','manage')
		)
	)`;
}

/**
 * The narrator of session space `s` (judged on its root, as every decision about a subagent is),
 * when the person (every `?`) might read it: `narratorUsersWith` widened so that it never leaves
 * out a narrator that rule admits. The owner; a public narrator; otherwise past the project gate,
 * a narrator visible to its project or granted to the person or to the `user` role. The gate
 * passes a project the person reads or every signed-in user reads (a grant to the `user` role
 * opens it in the rule, though not in the per-person list predicates).
 *
 * The gate's project is the one `resolveNarratorProjectId` gives on each backend
 * (`gateProject`): on SQLite the explicit project, else the primary working-directory link
 * (`narratorProjectIdText`), so sessions filed under someone's private project by their working
 * directory, the usual way, are not offered to everyone; on PostgreSQL, which knows only the
 * explicit project so far, that one alone.
 */
function sessionCandidateText(gateProject: string): string {
	return `exists (
		select 1 from narrators n
		join narrators jn
			on jn.id = case when n.type = 'subagent' then n.acl_root_narrator_id else n.id end
		where n.id = s.narrator_id
			and (
				jn.owner_user_id = ?
				or jn.visibility = 'public'
				or (
					not exists (
						select 1 from projects gp
						where gp.id = ${gateProject}
							and not (${projectReadableText("gp")} or ${openProjectText("gp")})
					)
					and (
						jn.visibility = 'project'
						or exists (
							select 1 from acl_grants ng
							where ng.scope_type = 'narrator' and ng.scope_id = jn.id
								and ng.domain_kind is null and ng.capability in ('read','write')
								and (
									(ng.principal_type = 'user' and ng.principal_id = ?)
									or (ng.principal_type = 'role' and ng.principal_id = 'user')
								)
						)
					)
				)
			)
	)`;
}

/**
 * A page of project or session spaces a session might read, in id order after `afterId`. The
 * filter runs in SQL, before the LIMIT. Candidates only, and always a SUPERSET of what the
 * verdicts of `session-scope.ts` admit (the access matrix holds it to that): a session reads
 * only what each of its readers reads, so what one reader (`reader`) might read covers it.
 *   - project spaces: projects the reader reads by the per-person predicate (owner, public, a
 *     user grant), and projects every signed-in user reads (a grant to the `user` role);
 *   - session spaces: {@link sessionCandidateText}.
 */
export async function readSpaceCandidatePage(
	from: OutlineSpaceCandidates,
	options: { kind: "project" | "session"; afterId?: string; limit: number },
): Promise<OutlineSpaceRow[]> {
	const pg = executor().dialect === "postgres";
	const id = pg ? sql.raw(`s.id collate "C"`) : sql.raw("s.id");
	let filter: SQL;
	if (options.kind === "project") {
		const open = sql.raw(
			`exists (select 1 from projects op where op.id = s.project_id and ${openProjectText("op")})`,
		);
		filter =
			from.kind === "all"
				? sql`s.project_id is not null`
				: from.kind === "open"
					? open
					: sql`(${bindPlaceholders(projectReadableForIdText("s.project_id"), from.userId)} or ${open})`;
	} else {
		if (from.kind === "open") return [];
		filter =
			from.kind === "all"
				? sql`s.narrator_id is not null`
				: bindPlaceholders(
						sessionCandidateText(pg ? "jn.context_project_id" : narratorProjectIdText("jn")),
						from.userId,
					);
	}
	const rows = await all(sql`
		select s.id, s.key, s.kind, s.project_id, s.narrator_id, s.owner_user_id, s.next_seq,
			s.created_at
		from outline_spaces s
		where s.kind = ${options.kind} and ${filter}
			${options.afterId !== undefined ? sql`and ${id} > ${options.afterId}` : sql``}
		order by ${id}
		limit ${options.limit}
	`);
	return rows.map(toSpace);
}
