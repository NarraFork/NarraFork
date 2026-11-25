/**
 * Project and narrator access rules as dialect-neutral SQL text. Both backends can import
 * these fragments without reaching the SQLite bootstrap used by the JS ACL verdicts.
 * The SQL filters before pagination; the JS verdicts define the intended access rules.
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
import { narratorProjectIdSql } from "../../lib/narrator-project-sql";

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

/** Non-admin grants are the union of the user's grants and the `user` role's grants. */
export function grantPrincipalText(alias: string): string {
	return `((${alias}.principal_type = 'user' and ${alias}.principal_id = ?)
		or (${alias}.principal_type = 'role' and ${alias}.principal_id = 'user'))`;
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
				and ${grantPrincipalText("pg")}
		)
	)`;
}

/**
 * The same rule applied to an expression that yields a project id, for queries over a table
 * that merely references one.
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
 * The project a narrator resolves to, as a scalar — the same rule as
 * `resolveNarratorProjectId`: the explicit project, else the primary link (an index
 * lookup on the partial unique primary-link index).
 */
export function narratorProjectIdText(alias: string): string {
	return narratorProjectIdSql(alias);
}

/**
 * Whether no project stands in the way of reading this narrator — the project GATE.
 *
 * No project means there is no gate, not that there are no restrictions. A project id must
 * resolve to a readable row: a dangling reference or private project with NULL owner and
 * no grant cannot pass (the latter makes the owner comparison UNKNOWN, not FALSE).
 */
export function narratorProjectGateReadText(alias: string): string {
	const project = narratorProjectIdText(alias);
	return `(${project} is null or ${projectReadableForIdText(project)})`;
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
						and ${grantPrincipalText("g")}
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
	return withJudgedNarratorText(narratorAlias, "jn", narratorJudgedReadableText("jn"));
}

function withJudgedNarratorText(alias: string, judgedAlias: string, predicate: string): string {
	return `exists (
		select 1 from narrators ${judgedAlias}
		where ${judgedAlias}.id = case
				when ${alias}.type = 'subagent' then ${alias}.acl_root_narrator_id
				else ${alias}.id
			end
			and ${predicate}
	)`;
}

/** SQL mirror of canWriteNarrator for a non-admin; each `?` binds the requesting user id. */
export function narratorWritableText(alias: string): string {
	const project = narratorProjectIdText("cw");
	return withJudgedNarratorText(
		alias,
		"cw",
		`(cw.owner_user_id = ? or (
			${narratorProjectGateReadText("cw")}
			and (
				cw.write_audience = 'public'
				or (cw.write_audience = 'project' and exists (
					select 1 from projects wp
					where wp.id = ${project} and (wp.owner_user_id = ? or exists (
						select 1 from acl_grants wg
						where wg.scope_type = 'project' and wg.scope_id = wp.id
							and wg.domain_kind is null and wg.capability in ('write','manage')
							and ${grantPrincipalText("wg")}
					))
				))
				or exists (
					select 1 from acl_grants cg
					where cg.scope_type = 'narrator' and cg.scope_id = cw.id
						and cg.domain_kind is null and cg.capability = 'write'
						and ${grantPrincipalText("cg")}
				)
			)
		))`,
	);
}
