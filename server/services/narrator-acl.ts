/**
 * Narrator access control.
 *
 * Three sources of authority, checked in this order:
 *   1. admin           — sees and drives everything (operations, storage cleanup,
 *                        troubleshooting all need an entry point).
 *   2. owner           — `narrators.owner_user_id`, the creator. Full read+write and
 *                        the only non-admin principal that may re-share.
 *   3. explicit grant  — an `acl_grants` row scoped to this narrator, read or write.
 *
 * Plus TWO independent audience axes on the narrator row:
 *   - `visibility`    — the broad READ audience (private / project / public).
 *   - `writeAudience` — the broad WRITE audience (owner / project / public).
 *
 * They are separate columns rather than one because they are different decisions:
 * making a session readable shares a view of the work, while handing over the
 * ability to approve a Bash call or a file write is a much larger grant. Read
 * access therefore never implies write. The reverse does hold — see
 * {@link canReadNarrator} — because a session someone may drive but cannot see
 * would be an absurd state.
 *
 * Subagents hold no audience of their own: their decisions delegate to the root
 * narrator via `acl_root_narrator_id` (see {@link resolveJudgedRow}).
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

import { type NarratorWriteAudience, widestWriteAudienceFor } from "@shared/narrator-access";
import { and, eq, type SQL, sql } from "drizzle-orm";
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

/**
 * The narrator columns access decisions are made from — nothing else is read.
 *
 * `type` and `aclRootNarratorId` are required rather than optional on purpose: a
 * caller that selects a narrow `columns:` set and forgets them would hand every
 * subagent an `undefined` type, silently skip delegation, and judge it by its own
 * frozen columns. Making them mandatory turns that into a compile error instead of
 * an access anomaly that only shows up on some endpoints.
 */
export interface NarratorAclRow {
	id: string;
	ownerUserId: string | null;
	visibility: string;
	/** The broad write audience: "owner" | "project" | "public". Unknown values deny. */
	writeAudience: string;
	/** "primary" | "subagent". Subagents delegate their whole decision to the root. */
	type: string;
	/** For subagents, the root to judge by. Null ⇒ undeterminable ⇒ fail closed. */
	aclRootNarratorId: string | null;
	chapterId?: string | null;
	/** Project context for standalone narrators; participates in project resolution. */
	contextProjectId?: string | null;
}

/**
 * The exact `columns:` selection an access check needs, for callers that load a
 * narrow row instead of the whole narrator.
 *
 * Exported as one object so the set lives in a single place. Every one of these is
 * load-bearing, and a caller that omits `type` or `aclRootNarratorId` would hand a
 * subagent an `undefined` type, skip delegation entirely, and judge it against its own
 * frozen columns — an access anomaly visible on some endpoints and not others.
 */
export const NARRATOR_ACL_COLUMNS = {
	id: true,
	ownerUserId: true,
	visibility: true,
	writeAudience: true,
	type: true,
	aclRootNarratorId: true,
	chapterId: true,
	contextProjectId: true,
} as const;

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
 * Only meaningful once the project gate has been passed, and only when the narrator
 * actually resolves to a project: one that belongs to none grants nothing here, since
 * it would otherwise be a way to be visible to everybody with no project constraining
 * it.
 *
 * "Resolves to a project" means `resolveNarratorProjectId` — chapter first, then
 * `contextProjectId`. This used to test `chapterId` directly, which was a fourth
 * private answer to "which project is this?" and disagreed with the one the project
 * gate itself uses: an externally provisioned session carrying only
 * `contextProjectId` was judged by its project at the gate, then treated as
 * project-less here. See `narrator-project.ts` for why divergent copies of that
 * question are a problem.
 */
function visibilityGrantsReadInProject(visibility: string): boolean {
	return visibility === "project";
}

/** This tier opens write to project members holding write. Gate checked by the caller. */
function writeAudienceGrantsWriteInProject(writeAudience: string): boolean {
	return writeAudience === "project";
}

/** This tier opens write to anyone who can pass the gate, with no project tier needed. */
function writeAudienceGrantsWriteToEveryone(writeAudience: string): boolean {
	return writeAudience === "public";
}

/**
 * Whether the write audience alone grants write, given an already-resolved gate.
 *
 * The gate's READ is the shared precondition for both tiers: someone removed from a
 * project must stop driving its sessions immediately, whatever the audience says.
 *
 * `project` additionally requires the gate's WRITE **and** that the narrator really
 * resolves to a project. That second condition is not redundant:
 * `resolveProjectGate(null)` reports `{read: true, write: true}` for a narrator that
 * belongs to no project, meaning "there is no gate at this level" rather than "no
 * restrictions". Testing `gate.write` alone would therefore turn the `project` tier
 * on a standalone session into "anyone may write".
 *
 * Unknown audience values match neither tier, so they deny.
 */
function writeAudienceGrantsWrite(
	row: NarratorAclRow,
	gate: { read: boolean; write: boolean },
	hasProject: boolean,
): boolean {
	if (!gate.read) return false;
	if (writeAudienceGrantsWriteInProject(row.writeAudience)) return hasProject && gate.write;
	return writeAudienceGrantsWriteToEveryone(row.writeAudience);
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
 * The project gate for this narrator, together with the project it resolved to.
 *
 * The `projectId` is returned rather than discarded because the write-audience check
 * needs to distinguish "the gate was passed" from "there was no gate to pass", and
 * deriving that twice from separate lookups is how the two halves of one decision
 * start disagreeing.
 */
async function gateAndProjectFor(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
): Promise<{ gate: { read: boolean; write: boolean }; projectId: string | null }> {
	const projectId = await resolveProjectIdForNarratorId(row.id);
	// A standalone narrator has no project, hence no gate to pass. That is "no gate
	// here", not "unrestricted": the checks below still decide.
	const gate = await resolveProjectGate(projectId, {
		userId: principal.userId,
		isAdmin: principal.isAdmin,
	});
	return { gate, projectId };
}

/**
 * The row access decisions are actually made from.
 *
 * A subagent is part of its parent's work and holds no access state of its own, so
 * every decision about it is made on the ROOT narrator — its audiences, its grants,
 * its project gate. This is what makes a later sharing change on the parent reach
 * its subagents: there is nothing to propagate, because there was never a copy.
 *
 * Returns null when the delegation target cannot be determined — the column is null,
 * or points at a row that no longer exists. Callers must treat that as denial. It
 * must never fall back to judging the subagent by its own columns: those are frozen
 * at their strictest values (and, on rows predating this, are a stale snapshot of the
 * parent), so falling back could be either wider or narrower than the root with no
 * signal either way.
 *
 * Primary narrators — including forks, which carry a `parentNarratorId` but are
 * independent sessions — are judged on themselves. The discriminator is `type`, not
 * "has a parent": keying on the parent link would make every fork permanently follow
 * whatever it was forked from.
 */
async function resolveJudgedRow(row: NarratorAclRow): Promise<NarratorAclRow | null> {
	if (row.type !== "subagent") return row;
	if (!row.aclRootNarratorId) return null;
	const root = await db.query.narrators.findFirst({
		where: eq(narrators.id, row.aclRootNarratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	return root ?? null;
}

/**
 * The root a narrator's access decisions are judged against, for callers outside
 * this module (the sharing surface, which must refuse to edit a subagent's ACL and
 * point at the root instead).
 *
 * Returns the narrator's own id for a primary narrator, and null when a subagent's
 * delegation target is undeterminable.
 */
export async function resolveAclRootId(row: NarratorAclRow): Promise<string | null> {
	return (await resolveJudgedRow(row))?.id ?? null;
}

/**
 * Whether the principal may read this narrator: its timeline, tool calls, spec
 * files and discussion room.
 *
 * Two conjunctive levels. `public` VISIBILITY short-circuits ahead of the gate
 * because it means "anyone signed in", which is deliberately wider than the project;
 * everything else requires the project door first and then the narrator's own ACL.
 *
 * `visibility` alone decides the broad read audience — the write audience is NOT
 * consulted here. That is sound because the two are nested rather than independent
 * (see `@shared/narrator-access`): the write audience can never be wider than the read
 * audience, so anyone it admits is already admitted by one of the branches below.
 *
 * This used to test the write audience as well, back when the pair could disagree, and
 * removing that branch is what makes `visibility` an honest description of who can read
 * a session again. Two things had to be true first, and both must stay true:
 *   - the nesting is enforced on every write path, and
 *   - both sides resolve "which project" identically. They did not: read tested
 *     `chapterId` while write resolved `contextProjectId` too, so a
 *     `project`/`project` session carrying only `contextProjectId` was drivable but
 *     unreadable. Re-introducing that split would resurrect the same hole.
 */
export async function canReadNarrator(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	// A subagent is judged entirely on its root; an undeterminable root denies.
	const judged = await resolveJudgedRow(row);
	if (!judged) return false;
	if (isOwner(judged, principal)) return true;
	if (visibilityGrantsRead(judged.visibility)) return true;

	const { gate, projectId } = await gateAndProjectFor(judged, principal);
	if (!gate.read) return false;

	// Inside the project door, `project` visibility is what makes a session visible to
	// the team. `projectId` comes from the same resolution the gate used, so read and
	// write cannot disagree about which project a session belongs to.
	if (visibilityGrantsReadInProject(judged.visibility) && projectId !== null) return true;

	const own = await ownGrants(judged.id, principal);
	// A write grant implies read: someone who may drive the session can obviously
	// see it, and requiring both rows would make every share a two-row write.
	return own.read || own.write;
}

/**
 * Whether the principal may drive this narrator: send messages, decide permission
 * requests, change models/settings, roll back history, open terminals.
 *
 * `visibility` is intentionally not consulted — that axis is about seeing the work.
 * Write comes from ownership, an explicit write grant, or `writeAudience`, and every
 * non-owner route is behind the project gate.
 */
export async function canWriteNarrator(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	const judged = await resolveJudgedRow(row);
	if (!judged) return false;
	if (isOwner(judged, principal)) return true;
	// The project gate applies to writes too: someone removed from a project must stop
	// being able to drive its sessions, even if an old narrator grant survives.
	const { gate, projectId } = await gateAndProjectFor(judged, principal);
	if (!gate.read) return false;
	if (writeAudienceGrantsWrite(judged, gate, projectId !== null)) return true;
	return (await ownGrants(judged.id, principal)).write;
}

/**
 * Whether the principal may change either audience, add/remove grants, or transfer
 * ownership.
 *
 * Restricted to admin and owner — a write grant lets someone work in the session,
 * not re-share it onwards, and neither does the broad write audience: being allowed
 * to drive a session is not being allowed to decide who else may.
 *
 * For a subagent this resolves to the ROOT's owner, which is what makes a subagent
 * unshareable on its own (the sharing service refuses it outright and points at the
 * root; see `narrator-sharing.ts`). An undeterminable root denies.
 *
 * Consequence worth knowing: narrators that predate access control have a null
 * owner, so only admins can manage them. An admin hands one over with
 * `transfer-owner`, after which the new owner manages it normally.
 */
export async function canManageNarratorAcl(
	row: NarratorAclRow,
	principal: NarratorPrincipal,
): Promise<boolean> {
	if (principal.isAdmin) return true;
	const judged = await resolveJudgedRow(row);
	if (!judged) return false;
	return isOwner(judged, principal);
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

// ── SQL push-down ───────────────────────────────────────────────────────────
//
// The list predicate exists in two surfaces (Drizzle and raw SQL for full-text
// search), and both are generated from the helpers below so they cannot drift from
// each other or from the row-level checks above. A divergence here produces the most
// confusing possible symptom: rows that appear in a list and then 404 on open, or
// rows that should have appeared and silently did not.

/**
 * The project a narrator resolves to, as a SQL scalar — the exact rule
 * `resolveNarratorProjectId` implements.
 *
 * The chapter wins; `context_project_id` is consulted ONLY when there is no chapter.
 * The `case` wrapper is load-bearing: a bare `coalesce` would keep falling through to
 * `context_project_id` when the chapter reference dangles, whereas the row-level
 * resolution reports "no project" in that case. Dropping it makes a narrator with a
 * deleted chapter resolve to a different project in SQL than in memory.
 */
function projectIdOfSql(alias: string): string {
	return `coalesce(
		(select ch.project_id from chapters ch where ch.id = ${alias}.chapter_id),
		case when ${alias}.chapter_id is null then ${alias}.context_project_id end
	)`;
}

/**
 * Whether the principal passes the project gate's READ — the SQL mirror of
 * `canReadProject` behind `resolveProjectGate`.
 *
 * Phrased as "no project stands in the way" so a narrator belonging to no project
 * passes automatically. That is the same "no gate here, which is not the same as no
 * restrictions" rule the row-level code follows, without a second branch that could
 * drift from it.
 *
 * Consumes two `?`, both the requesting user id.
 */
function projectGateReadSql(alias: string): string {
	return `not exists (
		select 1 from projects p
		where p.id = ${projectIdOfSql(alias)}
			and not (
				p.visibility = 'public'
				or p.owner_user_id = ?
				or exists (
					select 1 from acl_grants pg
					where pg.scope_type = 'project'
						and pg.scope_id = p.id
						and pg.capability in ('read','write','manage')
						and pg.domain_kind is null
						and pg.principal_type = 'user'
						and pg.principal_id = ?
				)
			)
	)`;
}

// NOTE: there is deliberately no SQL mirror of the project WRITE gate here. The list
// predicate answers "what may this principal READ", and since the write audience is
// nested inside the read audience it can never admit anyone the read branches do not.
// A write-side predicate would only be needed if the two could disagree — which is
// exactly the state this design removed.

/**
 * The readability rules applied to the judged row, aliased `jn` — the single body
 * shared by both exported predicates.
 *
 * Mirrors {@link canReadNarrator} branch for branch, in the same order. `write_audience`
 * appears nowhere, for the reason given there: it is nested inside `visibility`, so it
 * cannot admit a reader these branches miss.
 *
 * Note the explicit-grant test sits INSIDE the gate branch. An earlier version had it
 * at the top level, which disagreed with the row-level check (where `ownGrants` is
 * only reached after `gate.read` passes) for a narrator in an unreachable project.
 * The gate is documented as necessary for everything inside it, so gated is correct.
 *
 * Every `?` is the requesting user id.
 */
function judgedReadableSql(jn: string): string {
	return `(
		${jn}.owner_user_id = ?
		or ${jn}.visibility = 'public'
		or (
			${projectGateReadSql(jn)}
			and (
				(${jn}.visibility = 'project' and ${projectIdOfSql(jn)} is not null)
				or exists (
					select 1 from acl_grants g
					where g.scope_type = 'narrator'
						and g.scope_id = ${jn}.id
						and g.capability in ('read','write')
						and g.domain_kind is null
						and g.principal_type = 'user'
						and g.principal_id = ?
				)
			)
		)
	)`;
}

/** How many `?` {@link judgedReadableSql} binds. Derived, never hard-coded. */
const JUDGED_READABLE_PARAM_COUNT = (judgedReadableSql("jn").match(/\?/g) ?? []).length;

/**
 * How the judged row is selected, shared by both predicates.
 *
 * A subagent is judged on its root, a primary narrator on itself, and wrapping this
 * in `exists` makes an unresolvable delegation DENY — a null column, or one pointing
 * at a row that is gone, yields no `jn` and therefore false.
 *
 * This must NOT be written as `coalesce(acl_root_narrator_id, id)`: that falls back to
 * judging a subagent by its own columns, which are frozen at their strictest values
 * (and on legacy rows are a stale copy of the parent's). The row-level check denies in
 * that situation, so falling back here would put the list predicate and the row check
 * on opposite sides — in the leaking direction, and only on rows whose backfill
 * failed, which is the hardest set to notice.
 */
function judgedRowJoinSql(outer: string): string {
	return `jn.id = case
			when ${outer}.type = 'subagent' then ${outer}.acl_root_narrator_id
			else ${outer}.id
		end`;
}

/**
 * Bind the user id at each `?` of a raw fragment.
 *
 * Never interpolated: the same text must serve every user (these statements are
 * prepared once and cached), and interpolating an id into SQL is how a predicate
 * becomes an injection site.
 */
function bindUserId(text: string, userId: string): SQL {
	const parts = text.split("?");
	const chunks: SQL[] = [sql.raw(parts[0] ?? "")];
	for (const part of parts.slice(1)) {
		chunks.push(sql`${userId}`, sql.raw(part));
	}
	return sql.join(chunks, sql``);
}

/**
 * A Drizzle condition selecting the narrators this principal may read, for use in
 * list/aggregate queries.
 *
 * Returns `undefined` for admins, which composes with `and(...)` as "no extra
 * restriction" — callers must not treat that as "deny".
 *
 * One correlated `exists` rather than a join, so a narrator with several grants
 * cannot duplicate rows and corrupt pagination (`LIMIT n + 1` stops deciding
 * `hasMore`, and `COUNT(*)` over-reports).
 *
 * The three OUTER references stay in the template as Drizzle column objects so they
 * are rewritten to whatever alias the caller's query uses; everything inside the
 * subquery is literal text, because in a relational-query `where` callback Drizzle
 * rewrites embedded column references to the OUTER alias — which once turned
 * `acl_grants.scope_id` into `narrators.scope_id` and made the story graph fail to
 * prepare.
 */
export function narratorReadableWhere(principal: NarratorPrincipal) {
	if (principal.isAdmin) return undefined;
	return sql`exists (
		select 1 from narrators jn
		where jn.id = case
				when ${narrators.type} = 'subagent' then ${narrators.aclRootNarratorId}
				else ${narrators.id}
			end
			and ${bindUserId(judgedReadableSql("jn"), principal.userId)}
	)`;
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
	// Built from the same two helpers the Drizzle predicate uses, so the two surfaces
	// cannot drift. Every `?` is the requesting user id; callers must bind exactly
	// `narratorReadableSqlParamCount()` of them (search derives the count from the text
	// rather than hard-coding it, which keeps later parameters from shifting).
	return {
		sql: `EXISTS (
			SELECT 1 FROM narrators jn
			WHERE ${judgedRowJoinSql(narratorAlias)}
				AND ${judgedReadableSql("jn")}
		)`,
	};
}

/**
 * How many `?` {@link narratorReadableSqlFragment} binds, all of them the user id.
 *
 * Exported so callers building prepared statements bind the right number without
 * counting placeholders themselves.
 */
export function narratorReadableSqlParamCount(): number {
	return JUDGED_READABLE_PARAM_COUNT;
}

/**
 * Filter an already-loaded set of narrator rows down to the readable ones.
 *
 * For unpaginated callers only (e.g. every narrator of one chapter). Paginated
 * endpoints must use `narratorReadableWhere` instead so `hasMore`/`totalCount` stay
 * truthful.
 *
 * Implemented by asking the database the same question `narratorReadableWhere` asks,
 * restricted to the ids in hand, rather than re-deriving the rules in TypeScript. A
 * second implementation drifted from the SQL one as soon as the project gate landed
 * — it judged project-visible sessions unreadable — and a filter that disagrees with
 * the list predicate produces exactly the confusing pair of symptoms this design is
 * meant to avoid: rows that appear in one view and 404 in another.
 *
 * Chunked because every id becomes its own bind parameter: a chapter's narrator count
 * and the named-narrator list are both driven by user behaviour, so "naturally
 * bounded" was a comment rather than a guarantee, and crossing SQLite's variable
 * ceiling throws instead of degrading. Chunking makes the bound structural.
 */
const READABLE_FILTER_CHUNK_SIZE = 400;

export async function filterReadableNarrators<T extends NarratorAclRow>(
	rows: T[],
	principal: NarratorPrincipal,
): Promise<T[]> {
	if (principal.isAdmin) return rows;
	if (rows.length === 0) return rows;

	const readableIds = new Set<string>();
	for (let offset = 0; offset < rows.length; offset += READABLE_FILTER_CHUNK_SIZE) {
		const ids = rows.slice(offset, offset + READABLE_FILTER_CHUNK_SIZE).map((row) => row.id);
		const readable = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(sql`${narrators.id} IN ${ids}`, narratorReadableWhere(principal)));
		for (const row of readable) readableIds.add(row.id);
	}

	return rows.filter((row) => readableIds.has(row.id));
}

/**
 * The user ids that may read this narrator, for fan-out decisions (notifications,
 * ACL-change broadcasts). Reports `everyone` when the audience is "every
 * authenticated user", which callers should handle without expanding it into a list.
 *
 * Resolved against the judged row, so a subagent reports its root's audience. An
 * undeterminable delegation reports an EMPTY audience, matching the denial the read
 * check makes for the same row (see `resolveJudgedRow`). Falling back to the subagent's
 * own columns would let a pre-backfill row's stale `visibility = 'public'` snapshot
 * report `everyone` while `canReadNarrator` denies every one of those people — and this
 * audience feeds notification fan-out, so the disagreement would push a session's title
 * to users who cannot open it. An empty audience only costs a notification nobody could
 * have acted on.
 *
 * Deliberately CONSERVATIVE for the gated audiences: `visibility = 'project'` and
 * either `project`/`public` write audience return the owner plus explicit grantees
 * rather than expanding project membership. Those audiences are bounded by the project
 * gate, and reporting `everyone` for them would push notifications to people who
 * cannot reach the project at all. Under-reporting only delays a notification;
 * over-reporting is a disclosure. The one safe widening is a `public` write audience
 * on a narrator with no project, where there is genuinely no gate.
 */
export async function listNarratorAudience(
	row: NarratorAclRow,
): Promise<{ everyone: true } | { everyone: false; userIds: string[] }> {
	const judged = await resolveJudgedRow(row);
	if (!judged) return { everyone: false, userIds: [] };
	if (visibilityGrantsRead(judged.visibility)) return { everyone: true };
	if (
		writeAudienceGrantsWriteToEveryone(judged.writeAudience) &&
		(await resolveProjectIdForNarratorId(judged.id)) === null
	) {
		return { everyone: true };
	}
	const grants = await db
		.select({ principalId: aclGrants.principalId })
		.from(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, "narrator"),
				eq(aclGrants.scopeId, judged.id),
				eq(aclGrants.principalType, "user"),
				sql`${aclGrants.domainKind} is null`,
			),
		);
	const userIds = new Set(grants.map((grant) => grant.principalId));
	if (judged.ownerUserId) userIds.add(judged.ownerUserId);
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

/**
 * Default write audience for a newly created narrator, derived from the read audience
 * it will actually have.
 *
 * Takes the visibility rather than the chapter id so the pair cannot start out
 * illegal: the widest write audience a read audience permits is by definition legal
 * with it. Deriving from `chapterId` independently happened to agree for the two
 * default cases, but it would have quietly produced `private` + `project` for any
 * caller that passed an explicit `visibility` of its own.
 *
 * The result is the most collaborative legal setting, which is the point of this axis:
 * a chapter-bound session becomes `project`, so a teammate who can already see the
 * work can pick it up without being granted individually, while a standalone private
 * session stays owner-only because there is no project to bound anything against.
 */
export function defaultWriteAudienceForNarrator(visibility: string): NarratorWriteAudience {
	return widestWriteAudienceFor(visibility);
}
