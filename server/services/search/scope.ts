/**
 * SQL predicates for {@link MessageSearchScope} and {@link SearchFilters}, shared by the
 * SQLite and PostgreSQL stores.
 *
 * Portable SQL only. Scope predicates are built from the scope's booleans alone, so each is
 * one of a handful of fixed strings: safe to interpolate and safe to key a cached template
 * on. Filter predicates carry user values, so they come back with `?` placeholders and the
 * values to bind in order; their `key` names only which filters are present. The aliases are
 * the stores' own (`n` narrators, `m` messages, `b` blocks).
 */

import { narratorProjectIdText } from "../read/acl-sql";
import { FULL_MESSAGE_SCOPE, type MessageSearchScope, type SearchFilters } from "./types";

/** Stable cache-key fragment for a scope. */
export function scopeKey(scope: MessageSearchScope = FULL_MESSAGE_SCOPE): string {
	return `${scope.subagents ? "S" : "s"}${scope.system ? "Y" : "y"}${scope.tools ? "T" : "t"}${
		scope.archived ? "A" : "a"
	}`;
}

/** Clauses restricting a narrators row aliased `n`. */
function narratorClauses(scope: MessageSearchScope): string[] {
	const clauses: string[] = [
		// 系统内部叙述者（ModelTrace 舱）不参与搜索；traits 判断保留给尚未回填的历史行。
		"n.hidden_from_lists = 0",
		`COALESCE(n.traits, '[]') NOT LIKE '%"modeltrace"%'`,
	];
	if (!scope.subagents) clauses.push("n.type <> 'subagent'");
	if (!scope.archived) clauses.push("n.status <> 'archived'");
	return clauses;
}

function and(clauses: readonly string[]): string {
	return clauses.length === 0 ? "" : `AND ${clauses.join(" AND ")}`;
}

/** `AND …` restricting a narrators row aliased `n`; model traces are always excluded. */
export function narratorScopeSql(scope: MessageSearchScope = FULL_MESSAGE_SCOPE): string {
	return and(narratorClauses(scope));
}

/**
 * `AND …` restricting a narrator_messages row aliased `m` (joined to `n`).
 *
 * System content is recognized by role (`sys`, `system`, `disp` rows are written by the
 * runtime) and by origin (`system`: automation prompts sent as `user`). A null origin
 * predates the column and counts as a person, as everywhere else. An envelope's text never
 * holds tool input or output, so `tools` has nothing to exclude here; see
 * {@link blockScopeSql}.
 */
export function messageScopeSql(scope: MessageSearchScope = FULL_MESSAGE_SCOPE): string {
	const clauses = narratorClauses(scope);
	if (!scope.system) {
		clauses.push("m.role IN ('user', 'assistant')");
		clauses.push("COALESCE(m.origin, 'user') <> 'system'");
	}
	return and(clauses);
}

/** `AND …` restricting a narrator_blocks row aliased `b` and its envelope `m`/`n`. */
export function blockScopeSql(scope: MessageSearchScope = FULL_MESSAGE_SCOPE): string {
	const kinds: string[] = [];
	if (!scope.system) kinds.push("'context'");
	if (!scope.tools) kinds.push("'tool'");
	const kindClause = kinds.length === 0 ? "" : `AND b.kind NOT IN (${kinds.join(", ")})`;
	return [messageScopeSql(scope), kindClause].filter(Boolean).join(" ");
}

/** Which entity a filter predicate restricts, and so which columns it reads. */
export type FilterTarget = "narrator" | "message";

/** A bound predicate: `sql` has one `?` per entry of `values`, in order. */
export interface BoundSql {
	sql: string;
	values: string[];
	/** Which filters are present, for cache keys; never contains a value. */
	key: string;
}

/** Activity time each target's time bounds compare against. */
const TIME_COLUMN: Record<FilterTarget, string> = {
	narrator: "COALESCE(n.last_message_at, n.updated_at, n.created_at)",
	message: "m.created_at",
};

/**
 * `AND …` applying {@link SearchFilters} to one target. Both targets need `n`; the project is
 * resolved by the shared `narratorProjectIdText` rule, so it agrees with the narrator gate.
 */
export function filterSql(filters: SearchFilters | undefined, target: FilterTarget): BoundSql {
	const clauses: string[] = [];
	const values: string[] = [];
	let key = "";
	if (filters?.projectId) {
		clauses.push(`${narratorProjectIdText("n")} = ?`);
		values.push(filters.projectId);
		key += "p";
	}
	if (filters?.from) {
		clauses.push(`${TIME_COLUMN[target]} >= ?`);
		values.push(filters.from);
		key += "f";
	}
	if (filters?.to) {
		clauses.push(`${TIME_COLUMN[target]} <= ?`);
		values.push(filters.to);
		key += "t";
	}
	if (filters?.ownerUserId) {
		clauses.push("n.owner_user_id = ?");
		values.push(filters.ownerUserId);
		key += "o";
	}
	return { sql: and(clauses), values, key: key || "-" };
}
