/**
 * Project access control — the outermost gate of the ACL chain.
 *
 * Authority comes from four places, checked cheapest first:
 *   1. admin      — operations and troubleshooting need one entry point that a
 *                   user's own sharing choices cannot lock out.
 *   2. owner      — `projects.owner_user_id`, the creator.
 *   3. visibility — `public` opens read to every signed-in user. This is what the
 *                   migration assigns to pre-ACL projects so an upgrade hides
 *                   nothing.
 *   4. grant      — an `acl_grants` row scoped to the project, read/write/manage.
 *
 * Reaching a project is NECESSARY but never SUFFICIENT for anything inside it. A
 * project read member has passed the door; whether they can open a particular
 * narrator or knowledge entry is still decided by that resource's own ACL. That is
 * why a teammate's private session stays invisible to fellow project members — the
 * gate never contributes read to the resource itself.
 *
 * Chapters deliberately have no ACL of their own and inherit the project verdict
 * wholesale: every chapter worktree lives inside the same git repository, so
 * anything with filesystem access to one chapter can read every branch through
 * `git` or a `../` path. Per-chapter isolation would be fiction, and fiction in an
 * access-control layer is worse than an honest coarse boundary.
 */

import { eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { type AclPrincipal, resolveCaps } from "./acl/acl-core";

/** What an operation needs from the caller. */
export type ProjectAccessNeed = "read" | "write" | "manage";

export interface ProjectPrincipal {
	userId: string;
	isAdmin: boolean;
}

/** The project columns access decisions are made from — nothing else is read. */
export interface ProjectAclRow {
	id: string;
	ownerUserId: string | null;
	visibility: string;
}

function toAclPrincipal(principal: ProjectPrincipal): AclPrincipal {
	return { userId: principal.userId, role: principal.isAdmin ? "admin" : "user" };
}

/** Whether visibility alone opens read to any authenticated user. Fails closed. */
function visibilityGrantsRead(visibility: string): boolean {
	return visibility === "public";
}

/** Null owner is never "everyone's" — it means admin-managed. */
function isOwner(row: ProjectAclRow, principal: ProjectPrincipal): boolean {
	return row.ownerUserId !== null && row.ownerUserId === principal.userId;
}

/**
 * What the principal holds on this project specifically.
 *
 * Only `own` is consulted. A project's ancestor is `global`, and a global grant is
 * instance-wide authorization rather than a gate, so it arrives here as `own`
 * anyway via the kernel's chain resolution.
 */
async function ownCaps(
	projectId: string,
	principal: ProjectPrincipal,
): Promise<{ read: boolean; write: boolean; manage: boolean }> {
	const caps = await resolveCaps(toAclPrincipal(principal), { type: "project", id: projectId });
	return caps.own;
}

/**
 * Whether the principal may see the project: its chapters, story graph, commits and
 * settings.
 *
 * A write or manage grant implies read — someone who may change a project can
 * obviously see it, and requiring separate rows would make every membership a
 * multi-row write.
 */
export async function canReadProject(
	row: ProjectAclRow,
	principal: ProjectPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	if (isOwner(row, principal)) return true;
	if (visibilityGrantsRead(row.visibility)) return true;
	const own = await ownCaps(row.id, principal);
	return own.read || own.write || own.manage;
}

/**
 * Whether the principal may act in the project: create chapters, commit, merge,
 * run containers, edit skills.
 *
 * `visibility` is deliberately not consulted. Making a project public shares a view
 * of the work; it must not hand every signed-in user the ability to merge into the
 * trunk or delete a chapter's worktree.
 */
export async function canWriteProject(
	row: ProjectAclRow,
	principal: ProjectPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	if (isOwner(row, principal)) return true;
	const own = await ownCaps(row.id, principal);
	return own.write || own.manage;
}

/**
 * Whether the principal may change project membership, visibility or ownership —
 * and delete the project.
 *
 * `manage` is the third tier of the read/write/manage model: a write member works
 * in the project but cannot decide who else may. Deletion belongs here rather than
 * in `write` because it cascades through every chapter, worktree, container and
 * conversation.
 */
export async function canManageProject(
	row: ProjectAclRow,
	principal: ProjectPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	if (isOwner(row, principal)) return true;
	return (await ownCaps(row.id, principal)).manage;
}

export async function hasProjectAccess(
	row: ProjectAclRow,
	principal: ProjectPrincipal,
	need: ProjectAccessNeed,
): Promise<boolean> {
	if (need === "manage") return await canManageProject(row, principal);
	if (need === "write") return await canWriteProject(row, principal);
	return await canReadProject(row, principal);
}

/**
 * Throw unless the principal holds `need` on this project.
 *
 * Reports `NotFoundError` rather than a distinct "forbidden", so an id cannot be
 * probed for existence. Same rule as the narrator surface.
 */
export async function assertProjectAccess(
	row: ProjectAclRow,
	principal: ProjectPrincipal,
	need: ProjectAccessNeed,
): Promise<void> {
	if (await hasProjectAccess(row, principal, need)) return;
	throw new NotFoundError("Project", row.id);
}

/** Load a project by id and assert access, or throw NotFoundError. */
export async function loadProjectForAccess(
	projectId: string,
	principal: ProjectPrincipal,
	need: ProjectAccessNeed,
) {
	const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
	if (!row) throw new NotFoundError("Project", projectId);
	await assertProjectAccess(row, principal, need);
	return row;
}

/**
 * Assert access to the project owning a chapter.
 *
 * Chapters have no ACL of their own, so this is the whole chapter authorization
 * story. A chapter whose project has vanished is reported as not found: a dangling
 * reference must not read as "no project, therefore nothing to enforce".
 */
export async function assertChapterProjectAccess(
	chapterId: string,
	principal: ProjectPrincipal,
	need: ProjectAccessNeed,
): Promise<{ projectId: string }> {
	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
		columns: { projectId: true },
	});
	if (!chapter?.projectId) throw new NotFoundError("Chapter", chapterId);
	await loadProjectForAccess(chapter.projectId, principal, need);
	return { projectId: chapter.projectId };
}

/**
 * Whether the principal passes the project gate, for the kernel's
 * `withResolvedGate`.
 *
 * Exists because project membership is not purely grant-driven — `visibility` and
 * ownership open the door too, and the kernel must not reach into project columns
 * to discover that. A null `projectId` means the resource belongs to no project, so
 * there is no gate to pass: reported as open, since the resource's own ACL is what
 * decides. That is not a hole; it is the difference between "no gate here" and "no
 * restrictions".
 */
export async function resolveProjectGate(
	projectId: string | null | undefined,
	principal: ProjectPrincipal,
): Promise<{ read: boolean; write: boolean }> {
	if (!projectId) return { read: true, write: true };
	if (principal.isAdmin) return { read: true, write: true };
	const row = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { id: true, ownerUserId: true, visibility: true },
	});
	// A dangling project reference fails closed: the chain claimed a gate exists, and
	// we cannot show it was passed.
	if (!row) return { read: false, write: false };
	return {
		read: await canReadProject(row, principal),
		write: await canWriteProject(row, principal),
	};
}

/**
 * A Drizzle condition selecting the projects this principal may read.
 *
 * Returns `undefined` for admins, which composes with `and(...)` as "no extra
 * restriction" — callers must not read that as "deny".
 *
 * `EXISTS` rather than a join so several grants on one project cannot duplicate
 * rows and corrupt pagination. Column names inside the subquery are literal because
 * Drizzle rewrites embedded column references to the outer query's alias inside
 * relational-query `where` callbacks. `domain_kind is null` keeps knowledge
 * credentials — which share this table and carry a placeholder capability — from
 * ever reading as project access.
 */
export function projectReadableWhere(principal: ProjectPrincipal) {
	if (principal.isAdmin) return undefined;
	return or(
		eq(projects.visibility, "public"),
		eq(projects.ownerUserId, principal.userId),
		sql`exists (
			select 1 from acl_grants
			where acl_grants.scope_type = 'project'
				and acl_grants.scope_id = ${projects.id}
				and acl_grants.capability in ('read','write','manage')
				and acl_grants.domain_kind is null
				and acl_grants.principal_type = 'user'
				and acl_grants.principal_id = ${principal.userId}
		)`,
	);
}

/**
 * The same predicate against an arbitrary column holding a project id, for queries
 * that filter a different table (chapters, scheduled tasks, graph aggregates).
 */
export function projectReadableWhereForColumn(
	principal: ProjectPrincipal,
	projectIdColumn: unknown,
) {
	if (principal.isAdmin) return undefined;
	return sql`exists (
		select 1 from projects p
		where p.id = ${projectIdColumn}
			and (
				p.visibility = 'public'
				or p.owner_user_id = ${principal.userId}
				or exists (
					select 1 from acl_grants
					where acl_grants.scope_type = 'project'
						and acl_grants.scope_id = p.id
						and acl_grants.capability in ('read','write','manage')
						and acl_grants.domain_kind is null
						and acl_grants.principal_type = 'user'
						and acl_grants.principal_id = ${principal.userId}
				)
			)
	)`;
}

/**
 * The same predicate as raw SQL, for the hot paths built on `sqlite.prepare`
 * instead of Drizzle (full-text search).
 *
 * `projectAlias` is the alias the projects table carries in the caller's query.
 * The user id is bound as a parameter, never interpolated: these statements are
 * prepared once and cached for the process lifetime, so the SQL text must be the
 * same for every user. Admins get `null`, meaning "add no clause".
 *
 * Exported rather than hand-written at the call site for the same reason the
 * narrator fragment is: a local copy of the rules drifts, and a drifted copy in
 * search either hides readable rows or leaks unreadable ones.
 */
export function projectReadableSqlFragment(
	isAdmin: boolean,
	projectAlias: string,
): { sql: string } | null {
	if (isAdmin) return null;
	return {
		sql: `(
			${projectAlias}.visibility = 'public'
			OR ${projectAlias}.owner_user_id = ?
			OR EXISTS (
				SELECT 1 FROM acl_grants pg
				WHERE pg.scope_type = 'project'
					AND pg.scope_id = ${projectAlias}.id
					AND pg.capability IN ('read','write','manage')
					AND pg.domain_kind IS NULL
					AND pg.principal_type = 'user'
					AND pg.principal_id = ?
			)
		)`,
	};
}

/**
 * Filter already-loaded project rows down to the readable ones.
 *
 * For unpaginated callers only; paginated endpoints must push
 * `projectReadableWhere` into SQL so `hasMore`/`totalCount` stay truthful.
 */
export async function filterReadableProjects<T extends ProjectAclRow>(
	rows: T[],
	principal: ProjectPrincipal,
): Promise<T[]> {
	if (principal.isAdmin) return rows;
	const out: T[] = [];
	for (const row of rows) {
		if (await canReadProject(row, principal)) out.push(row);
	}
	return out;
}
