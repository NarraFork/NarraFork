/**
 * The project and narrator readability rules as DIALECT-NEUTRAL SQL text.
 *
 * Why this module exists at all: `services/project-acl.ts` and `services/narrator-acl.ts`
 * already own these rules, but both import `server/db` — the SQLite bootstrap, complete
 * with migrations, the instance lock and the clean-shutdown marker. The PostgreSQL read
 * adapter must not drag that in (see `server/db/backend/__tests__/port-purity.test.ts` for
 * what happens when a backend-neutral module reaches the bootstrap), so it cannot import
 * either ACL module to reuse their SQL.
 *
 * What keeps this from becoming a second, drifting copy of the rules:
 * `server/services/read/__tests__/acl-sql-parity.test.ts` compares the text produced here,
 * whitespace-insensitively, against `projectReadableSqlFragment` and
 * `narratorReadableSqlFragment`. Changing either ACL module without changing this one fails
 * that test. A drifted copy is the worst possible outcome here — it either hides rows a
 * user may read or, in the other direction, hands out sessions the row-level check denies
 * — so the coupling is asserted rather than left to a comment.
 *
 * Everything below is ANSI SQL that both SQLite and PostgreSQL parse identically:
 * `exists`, `case`, `coalesce`, `in (...)` and plain string comparison. No dialect
 * functions, no quoting styles that differ, and column/table names are the ones both
 * schemas share (`server/db/schema.ts` and `server/db/postgres-schema.ts` are column for
 * column identical here).
 *
 * The requesting user id is always a BOUND PARAMETER, never interpolated. That is not only
 * an injection boundary: interpolating it would make the statement text differ per user and
 * defeat statement caching on both backends.
 */

import { type SQL, sql } from "drizzle-orm";

/**
 * Bind `value` at every `?` of a neutral fragment, producing a Drizzle SQL node.
 *
 * Dialect-neutral by construction: the literal chunks go through `sql.raw` and the values
 * through `sql` parameters, so the SQLite dialect renders `?` and the PostgreSQL dialect
 * renders `$n`. Building `$n` by hand here would be a second numbering scheme that breaks
 * the moment a caller composes the fragment with anything else.
 */
export function bindPlaceholders(text: string, value: string): SQL {
	const parts = text.split("?");
	const chunks: SQL[] = [sql.raw(parts[0] ?? "")];
	for (const part of parts.slice(1)) {
		chunks.push(sql`${value}`, sql.raw(part));
	}
	return sql.join(chunks, sql``);
}

/**
 * Whether the principal may read the project row carried by `projectAlias`.
 *
 * Mirrors `projectReadableSqlFragment`. `domain_kind is null` is load-bearing: knowledge
 * credentials share `acl_grants` and carry a placeholder capability, so without it a
 * clearance grant would read as project membership.
 *
 * Consumes two `?`, both the requesting user id.
 */
export function projectReadableText(projectAlias: string): string {
	return `(
		${projectAlias}.visibility = 'public'
		or ${projectAlias}.owner_user_id = ?
		or exists (
			select 1 from acl_grants pg
			where pg.scope_type = 'project'
				and pg.scope_id = ${projectAlias}.id
				and pg.capability in ('read','write','manage')
				and pg.domain_kind is null
				and pg.principal_type = 'user'
				and pg.principal_id = ?
		)
	)`;
}

/**
 * The same rule applied to an expression that yields a project id, for queries over a table
 * that merely references one (chapters, container instances, graph aggregates).
 *
 * `exists` rather than a join so several grants on one project cannot duplicate rows and
 * corrupt `limit n + 1` paging.
 */
export function projectReadableForIdText(projectIdExpression: string): string {
	return `exists (
		select 1 from projects p
		where p.id = ${projectIdExpression}
			and ${projectReadableText("p")}
	)`;
}

/**
 * The project a narrator resolves to, as a scalar. Chapter first, then
 * `context_project_id` — and only when there is no chapter at all.
 *
 * The `case` wrapper is not decoration: a bare `coalesce` would fall through to
 * `context_project_id` when the chapter reference dangles, while the row-level resolution
 * reports "no project" there. Dropping it makes a narrator with a deleted chapter resolve
 * to a different project in SQL than in memory.
 */
function narratorProjectIdText(alias: string): string {
	return `coalesce(
		(select ch.project_id from chapters ch where ch.id = ${alias}.chapter_id),
		case when ${alias}.chapter_id is null then ${alias}.context_project_id end
	)`;
}

/**
 * Whether no project stands in the way of reading this narrator — the project GATE.
 *
 * Phrased as a negative so a narrator belonging to no project passes automatically: that is
 * "there is no gate here", which is not the same as "no restrictions" (the narrator's own
 * ACL still decides below).
 */
function narratorProjectGateReadText(alias: string): string {
	return `not exists (
		select 1 from projects p
		where p.id = ${narratorProjectIdText(alias)}
			and not ${projectReadableText("p")}
	)`;
}

/**
 * The readability rules applied to the JUDGED narrator row.
 *
 * `write_audience` appears nowhere on purpose: it is nested inside `visibility`, so it
 * cannot admit a reader these branches miss.
 *
 * The explicit-grant test sits INSIDE the gate branch, matching `canReadNarrator`, where
 * grants are only consulted after the gate passes. Hoisting it would let a narrator grant
 * survive removal from the project.
 */
function narratorJudgedReadableText(jn: string): string {
	return `(
		${jn}.owner_user_id = ?
		or ${jn}.visibility = 'public'
		or (
			${narratorProjectGateReadText(jn)}
			and (
				(${jn}.visibility = 'project' and ${narratorProjectIdText(jn)} is not null)
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

/**
 * Whether the principal may read the narrator row carried by `narratorAlias`.
 *
 * A subagent is judged entirely on its ACL root; the `exists` wrapper makes an
 * unresolvable delegation DENY. It must NOT be written as
 * `coalesce(acl_root_narrator_id, id)`: that falls back to judging a subagent by its own
 * columns, which are frozen at their strictest values and, on rows predating the backfill,
 * are a stale copy of the parent's — putting the list predicate and the row-level check on
 * opposite sides, in the leaking direction, on exactly the rows nobody looks at.
 *
 * Mirrors `narratorReadableSqlFragment`. Every `?` is the requesting user id.
 */
export function narratorReadableText(narratorAlias: string): string {
	return `exists (
		select 1 from narrators jn
		where jn.id = case
				when ${narratorAlias}.type = 'subagent' then ${narratorAlias}.acl_root_narrator_id
				else ${narratorAlias}.id
			end
			and ${narratorJudgedReadableText("jn")}
	)`;
}
