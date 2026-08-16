/**
 * Narrator access control.
 *
 * Three sources of authority, checked in this order:
 *   1. admin           — sees and drives everything (operations, storage cleanup,
 *                        troubleshooting all need an entry point).
 *   2. owner           — `narrators.owner_user_id`, the creator. Full read+write and
 *                        the only non-admin principal that may re-share.
 *   3. explicit grant  — an `acl_grants` row scoped to this narrator, read or write.
 * Plus a broad read audience from `narrators.visibility` (never write).
 *
 * Grant storage and principal resolution now live in the shared kernel
 * (`services/acl/`), which the knowledge base and project layer use too. The
 * functions exported here keep their original signatures on purpose: this module
 * has a large number of callers, and changing the shape of the boundary at the same
 * time as changing what is underneath it would make a behaviour regression
 * indistinguishable from a refactoring mistake.
 *
 * Two levels, conjunctive. A chapter-bound narrator sits inside a project, and the
 * project is a GATE: passing it is necessary for anything inside, never sufficient.
 * So a project member has to get through the project door AND satisfy the narrator's
 * own ACL. That is why a teammate's `private` session stays invisible to fellow
 * members — the gate never contributes read to the narrator itself.
 *
 * Deliberate shape: a single-row check is a point lookup, and the list predicate is
 * pushed down into SQL. Filtering a fetched page instead would break
 * `LIMIT n + 1` as the "hasMore" signal and make `totalCount` wrong.
 *
 * Every ambiguous case resolves to "no access": an unknown visibility value, a
 * missing row, or an anonymous caller.
 */

import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { aclGrants, narrators } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import type { AclPrincipal } from "./acl/acl-core";
import { resolveCaps } from "./acl/acl-core";
import { resolveProjectIdForNarratorId } from "./narrator-project";
import { resolveProjectGate } from "./project-acl";

/** What an operation needs from the caller. */
export type NarratorAccessNeed = "read" | "write";

/**
 * The authenticated principal, as every route already has it from
 * `c.get("user")`. Kept to these two fields so callers never have to build
 * anything heavier, and so tests can construct one literally.
 */
export interface NarratorPrincipal {
	userId: string;
	isAdmin: boolean;
}

/** The narrator columns access decisions are made from — nothing else is read. */
export interface NarratorAclRow {
	id: string;
	ownerUserId: string | null;
	visibility: string;
	chapterId?: string | null;
}

/** Bridge to the kernel's principal shape, which carries the role verbatim. */
function toAclPrincipal(principal: NarratorPrincipal): AclPrincipal {
	return { userId: principal.userId, role: principal.isAdmin ? "admin" : "user" };
}

/**
 * Whether `visibility` alone opens read to any authenticated user, with no project
 * gate in the way.
 *
 * Only `public` does. `project` used to be treated the same, which was honest while
 * every signed-in user could reach every project; now that projects have members it
 * would be a hole, so `project` is handled by {@link visibilityGrantsReadInProject}
 * behind the gate instead.
 *
 * Unknown values return false (fail closed).
 */
function visibilityGrantsRead(visibility: string): boolean {
	return visibility === "public";
}

/**
 * Whether `visibility` opens read to the members of the narrator's project.
 *
 * Only meaningful once the project gate has been passed. A standalone narrator has
 * no project, so `project` visibility on one grants nothing — it would otherwise be
 * a way to be visible to everybody with no project to constrain it.
 */
function visibilityGrantsReadInProject(visibility: string): boolean {
	return visibility === "project";
}

/** Whether the principal owns this narrator. Null owner is never "everyone's". */
function isOwner(row: NarratorAclRow, principal: NarratorPrincipal): boolean {
	return row.ownerUserId !== null && row.ownerUserId === principal.userId;
}

/**
 * What the principal was granted on this narrator specifically.
 *
 * Goes through the kernel so there is one implementation of "which grants apply to
 * whom" (user grants ∪ role grants, no deny rules, no precedence). Only `own` is
 * consulted: ancestor scopes are gates, and a gate never authorizes on its own.
 */
async function ownGrants(
	narratorId: string,
	principal: NarratorPrincipal,
): Promise<{ read: boolean; write: boolean; manage: boolean }> {
	const caps = await resolveCaps(toAclPrincipal(principal), {
		type: "narrator",
		id: narratorId,
	});
	return caps.own;
}

/**
 * The project this narrator belongs to, or null when it belongs to none.
 *
 * Resolved from the row when it carries a chapter, which is the common case, so most
 * decisions need no extra lookup beyond the chapter → project hop.
 */
async function gateFor(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
): Promise<{ read: boolean; write: boolean }> {
	const projectId = await resolveProjectIdForNarratorId(row.id);
	// A standalone narrator has no project, hence no gate to pass. That is "no gate
	// here", not "unrestricted": the checks below still decide.
	return await resolveProjectGate(projectId, {
		userId: principal.userId,
		isAdmin: principal.isAdmin,
	});
}

/**
 * Whether the principal may read this narrator: its timeline, tool calls, spec
 * files and discussion room.
 *
 * Two conjunctive levels. `public` short-circuits ahead of the gate because it means
 * "anyone signed in", which is deliberately wider than the project; everything else
 * requires the project door first and then the narrator's own ACL.
 */
export async function canReadNarrator(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	if (isOwner(row, principal)) return true;
	if (visibilityGrantsRead(row.visibility)) return true;

	const gate = await gateFor(row, principal);
	if (!gate.read) return false;

	// Inside the project door, `project` visibility is what makes a chapter-bound
	// session visible to the team.
	if (visibilityGrantsReadInProject(row.visibility) && row.chapterId) return true;

	const own = await ownGrants(row.id, principal);
	// A write grant implies read: someone who may drive the session can obviously
	// see it, and requiring both rows would make every share a two-row write.
	return own.read || own.write;
}

/**
 * Whether the principal may drive this narrator: send messages, decide permission
 * requests, change models/settings, roll back history, open terminals.
 *
 * `visibility` is intentionally not consulted. Making a narrator public shares a
 * view of the work; it must never hand strangers the ability to issue commands
 * through it or approve a dangerous tool call.
 */
export async function canWriteNarrator(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	if (isOwner(row, principal)) return true;
	// The project gate applies to writes too: someone removed from a project must stop
	// being able to drive its sessions, even if an old narrator grant survives.
	if (!(await gateFor(row, principal)).read) return false;
	return (await ownGrants(row.id, principal)).write;
}

/**
 * Whether the principal may change visibility, add/remove grants, or transfer
 * ownership.
 *
 * Restricted to admin and owner — a write grant lets someone work in the session,
 * not re-share it onwards.
 *
 * Consequence worth knowing: narrators that predate access control have a null
 * owner, so only admins can manage them. An admin hands one over with
 * `transfer-owner`, after which the new owner manages it normally.
 */
export function canManageNarratorAcl(row: NarratorAclRow, principal: NarratorPrincipal): boolean {
	return principal.isAdmin || isOwner(row, principal);
}

/** Whether the principal holds the requested level of access. */
export async function hasNarratorAccess(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
	need: NarratorAccessNeed,
): Promise<boolean> {
	return need === "write"
		? await canWriteNarrator(row, principal)
		: await canReadNarrator(row, principal);
}

/**
 * Throw unless the principal holds `need` on this narrator.
 *
 * Reports `NotFoundError`, not a 403: a distinct "forbidden" would confirm that an
 * id exists, turning any endpoint into an enumeration oracle. Same choice as
 * `requireActiveOAuthResourceBinding` on the external surface.
 */
export async function assertNarratorAccess(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
	need: NarratorAccessNeed,
): Promise<void> {
	if (await hasNarratorAccess(row, principal, need)) return;
	throw new NotFoundError("Narrator", row.id);
}

/** Load a narrator by id and assert access, or throw NotFoundError. */
export async function loadNarratorForAccess(
	narratorId: string,
	principal: NarratorPrincipal,
	need: NarratorAccessNeed,
) {
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
	if (!row) throw new NotFoundError("Narrator", narratorId);
	await assertNarratorAccess(row, principal, need);
	return row;
}

/**
 * A Drizzle condition selecting the narrators this principal may read, for use in
 * list/aggregate queries.
 *
 * Returns `undefined` for admins, which composes with `and(...)` as "no extra
 * restriction" — callers must not treat that as "deny".
 *
 * The grant test is an `EXISTS` subquery rather than a join so a narrator with
 * several grants cannot duplicate rows and corrupt pagination.
 */
export function narratorReadableWhere(principal: NarratorPrincipal) {
	if (principal.isAdmin) return undefined;
	return or(
		eq(narrators.visibility, "public"),
		eq(narrators.ownerUserId, principal.userId),
		// `project` visibility now requires membership of the owning project, resolved
		// through the chapter. Written as one correlated subquery so a narrator with
		// several grants cannot duplicate rows and corrupt pagination.
		sql`(
			${narrators.visibility} = 'project'
			and exists (
				select 1 from chapters ch
				join projects p on p.id = ch.project_id
				where ch.id = ${narrators.chapterId}
					and (
						p.visibility = 'public'
						or p.owner_user_id = ${principal.userId}
						or exists (
							select 1 from acl_grants pg
							where pg.scope_type = 'project'
								and pg.scope_id = p.id
								and pg.capability in ('read','write','manage')
								and pg.domain_kind is null
								and pg.principal_type = 'user'
								and pg.principal_id = ${principal.userId}
						)
					)
			)
		)`,
		// Column names are written literally rather than through the Drizzle column
		// objects. In a relational-query `where` callback (used by
		// `db.query.narrators.findMany`) Drizzle rewrites embedded column references to
		// the OUTER query's alias, which turned `acl_grants.scope_id` into
		// `narrators.scope_id` and made the whole query fail to prepare.
		//
		// `domain_kind is null` restricts this to capability rows: a knowledge domain
		// credential must never be read as narrator access.
		sql`exists (
			select 1 from acl_grants
			where acl_grants.scope_type = 'narrator'
				and acl_grants.scope_id = ${narrators.id}
				and acl_grants.capability in ('read','write')
				and acl_grants.domain_kind is null
				and acl_grants.principal_type = 'user'
				and acl_grants.principal_id = ${principal.userId}
		)`,
	);
}

/**
 * The same predicate as raw SQL, for the handful of hot paths built on
 * `sqlite.prepare` instead of Drizzle (full-text search).
 *
 * `narratorAlias` is the alias the narrators table carries in the caller's query.
 * The user id is bound as a parameter, never interpolated: these statements are
 * prepared once and cached for the process lifetime, so the SQL text must be the
 * same for every user. Admins get `null`, meaning "add no clause".
 */
export function narratorReadableSqlFragment(
	isAdmin: boolean,
	narratorAlias: string,
): { sql: string } | null {
	if (isAdmin) return null;
	return {
		sql: `(
			${narratorAlias}.visibility = 'public'
			OR ${narratorAlias}.owner_user_id = ?
			OR (
				${narratorAlias}.visibility = 'project'
				AND EXISTS (
					SELECT 1 FROM chapters ch
					JOIN projects p ON p.id = ch.project_id
					WHERE ch.id = ${narratorAlias}.chapter_id
						AND (
							p.visibility = 'public'
							OR p.owner_user_id = ?
							OR EXISTS (
								SELECT 1 FROM acl_grants pg
								WHERE pg.scope_type = 'project'
									AND pg.scope_id = p.id
									AND pg.capability IN ('read','write','manage')
									AND pg.domain_kind IS NULL
									AND pg.principal_type = 'user'
									AND pg.principal_id = ?
							)
						)
				)
			)
			OR EXISTS (
				SELECT 1 FROM acl_grants g
				WHERE g.scope_type = 'narrator'
					AND g.scope_id = ${narratorAlias}.id
					AND g.capability IN ('read','write')
					AND g.domain_kind IS NULL
					AND g.principal_type = 'user'
					AND g.principal_id = ?
			)
		)`,
	};
}

/**
 * Filter an already-loaded set of narrator rows down to the readable ones.
 *
 * For unpaginated callers only (e.g. every narrator of one chapter), where the
 * result size is naturally bounded. Paginated endpoints must use
 * `narratorReadableWhere` instead so `hasMore`/`totalCount` stay truthful.
 *
 * Implemented by asking the database the same question `narratorReadableWhere` asks,
 * restricted to the ids in hand, rather than re-deriving the rules in TypeScript. A
 * second implementation drifted from the SQL one as soon as the project gate landed
 * — it judged project-visible sessions unreadable — and a filter that disagrees with
 * the list predicate produces exactly the confusing pair of symptoms this design is
 * meant to avoid: rows that appear in one view and 404 in another.
 */
export async function filterReadableNarrators<T extends NarratorAclRow>(
	rows: T[],
	principal: NarratorPrincipal,
): Promise<T[]> {
	if (principal.isAdmin) return rows;
	if (rows.length === 0) return rows;

	const readableIds = new Set(
		(
			await db
				.select({ id: narrators.id })
				.from(narrators)
				.where(
					and(
						sql`${narrators.id} IN ${rows.map((row) => row.id)}`,
						narratorReadableWhere(principal),
					),
				)
		).map((row) => row.id),
	);

	return rows.filter((row) => readableIds.has(row.id));
}

/**
 * The user ids that may read this narrator, for fan-out decisions (notifications,
 * ACL-change broadcasts). Returns null when the audience is "every authenticated
 * user", which callers should handle without expanding it into a list.
 */
export async function listNarratorAudience(
	row: NarratorAclRow,
): Promise<{ everyone: true } | { everyone: false; userIds: string[] }> {
	if (visibilityGrantsRead(row.visibility)) return { everyone: true };
	const grants = await db
		.select({ principalId: aclGrants.principalId })
		.from(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, "narrator"),
				eq(aclGrants.scopeId, row.id),
				eq(aclGrants.principalType, "user"),
				sql`${aclGrants.domainKind} is null`,
			),
		);
	const userIds = new Set(grants.map((grant) => grant.principalId));
	if (row.ownerUserId) userIds.add(row.ownerUserId);
	return { everyone: false, userIds: [...userIds] };
}

/**
 * Default visibility for a newly created narrator.
 *
 * Standalone sessions are private: they are personal work and nothing else refers
 * to them. Chapter-bound ones are project-visible, because a chapter is a shared
 * artifact — teammates who fork, review or merge it would otherwise face nodes on
 * the story graph they cannot open.
 */
export function defaultVisibilityForNarrator(
	chapterId: string | null | undefined,
): "private" | "project" {
	return chapterId ? "project" : "private";
}
