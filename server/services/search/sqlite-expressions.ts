/**
 * FTS5 / LIKE expression builders for the SQLite search store.
 *
 * Split out from `sqlite-store.ts` for one reason: these are pure string functions, and this
 * module imports no database. The query SHAPES are the part of search most easily changed by
 * accident and hardest to notice — a phrase quietly becoming a prefix match changes which
 * rows come back, not whether the code runs — so they need tests that pin them exactly, and
 * those tests should not have to open a database to run.
 *
 * Everything here is SQLite-specific by design. A second backend writes its own equivalents;
 * it does not reuse these.
 */

import type { SnippetFormat } from "./types";

/** Match all terms, or any one of them. */
export type MatchMode = "and" | "or";

/**
 * The whole query as ONE FTS5 phrase.
 *
 * Global search's shape: it finds contiguous text and does NOT prefix-match, so "auth mid"
 * does not find "authentication middleware". That asymmetry with the other three paths is
 * long-standing behaviour their tests are written against, so it is reproduced rather than
 * fixed here — changing recall is a product decision, not a porting one.
 */
export function phraseExpr(text: string): string {
	return `"${text}"`;
}

/**
 * Each whitespace-separated term as a prefix match.
 *
 * The timeline / Recall / knowledge shape. `column` renders FTS5's column filter
 * (`{col} : (expr)`), which restricts the WHOLE expression to one indexed column; callers use
 * it so passive injection can fire on author-declared keywords without ever matching body
 * text. Returns an empty string for input with no terms, which callers must not send to
 * `MATCH` — FTS5 rejects an empty expression.
 */
export function prefixExpr(text: string, match: MatchMode = "and", column?: string): string {
	const terms = text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => `"${word}"*`);
	if (terms.length === 0) return "";
	const joined = terms.join(match === "or" ? " OR " : " ");
	return column ? `{${column}} : (${joined})` : joined;
}

/**
 * Contains-pattern with NO wildcard escaping — global search, timeline and Recall.
 *
 * A `%` or `_` the user typed therefore acts as a wildcard and widens the match. That is the
 * existing behaviour of those three paths and is preserved deliberately; `escapedContains`
 * below is the other, stricter convention, used where a statement pairs it with `ESCAPE`.
 */
export function rawContains(text: string): string {
	return `%${text}%`;
}

/**
 * Contains-pattern with `%`, `_` and the escape character itself escaped.
 *
 * For statements that pair the pattern with `ESCAPE '\'` (the knowledge searches), so a
 * wildcard the user typed matches literally instead of broadening the pattern.
 */
export function escapedContains(text: string): string {
	return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Render an FTS5 `snippet()` call.
 *
 * The delimiters come from a `SnippetFormat` constant, never from caller input, so
 * interpolating them cannot carry user text into SQL. Quotes are doubled regardless — the
 * cost is nothing and it removes the need to re-audit this if a future format contains one.
 */
export function snippetCall(table: string, columnIndex: number, format: SnippetFormat): string {
	const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
	return `snippet(${table}, ${columnIndex}, ${quote(format.open)}, ${quote(format.close)}, ${quote(format.ellipsis)}, ${format.tokens})`;
}
