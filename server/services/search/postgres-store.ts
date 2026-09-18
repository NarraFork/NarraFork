/**
 * PostgreSQL implementation of the search port: pg_trgm GIN indexes + `ILIKE`.
 *
 * RETRIEVAL MODEL (and why it is NOT a second query language)
 * -----------------------------------------------------------
 * FTS5's trigram tokenizer turns a `MATCH` into a case-insensitive substring match — this
 * was verified empirically against SQLite before this file was written (a quoted phrase
 * matches contiguous text; a `"term"*` prefix query matches the term anywhere; two Han
 * characters never match because they form no trigram). PostgreSQL's `ILIKE '%term%'` is
 * exactly that predicate, and the `pg_trgm` GIN indexes installed by `server/db/pg-fts.ts`
 * accelerate it. So this store contains NO tsquery, no `to_tsvector`, no ranking config:
 * the query shapes in `types.ts` are reproduced with the same semantics the SQLite store
 * documents, and the parity suite compares result sets between the two backends.
 *
 * RANKING
 * -------
 * The port requires a raw relevance value, lower-is-better, and forbids the backend from
 * choosing the scoring curve. `pg_trgm`'s `similarity()` (0..1, higher better) is reported
 * as `1 - similarity(...)` against the query text. That is a different SIGNAL than FTS5's
 * `rank` — the contract allows it (rank values are backend-specific; the caller's score
 * bands are calibrated per strategy, not per backend) — but it means cross-backend ORDER
 * can differ on rows whose match strength differs subtly. The parity tests pin set
 * equality and leave ordering backend-specific by design.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT IMPORT
 * -------------------------------------------
 * Nothing from `bun:sqlite`, `server/db` (the SQLite handle), or `sqlite-expressions.ts`
 * (whose header says a second backend writes its own equivalents). The SQL below is plain
 * PostgreSQL executed through a structural executor (`unsafe(text, params)`), so the store
 * is testable against any client and the dialect guard sees no SQLite surface here. The
 * ACL gate SQL is DERIVED from the shared fragments in `narrator-acl` / `project-acl` —
 * the same source the SQLite store uses, so the gate cannot drift between backends. Those
 * modules currently import the SQLite `db` handle transitively; untangling that is the
 * startup-wiring batch's job, not this one's (see the module header of `backend.ts`).
 */

import type { PgExecutor } from "../../db/pg-fts";
import { AppError, ValidationError } from "../../lib/errors";
import { narratorReadableSqlFragment } from "../narrator-acl";
import { projectReadableSqlFragment } from "../project-acl";
import type { SearchStore } from "./port";
import {
	type ChapterSearchRow,
	type EntitySearchQuery,
	GLOBAL_SNIPPET,
	KNOWLEDGE_SNIPPET,
	type KnowledgeDraftSearchQuery,
	type KnowledgeSearchQuery,
	type KnowledgeSearchRow,
	type MessageSearchRow,
	type NarratorSearchRow,
	PREVIEW_CHARS,
	RECALL_SNIPPET,
	type RecallMessageRow,
	type RecallSearchQuery,
	type ShadowedEntryQuery,
	type SnippetFormat,
	TIMELINE_SNIPPET,
	type TimelineSearchQuery,
	type TimelineSearchRow,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Query construction helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Positional parameter collector: `$1..$n`, values bound in order, never interpolated. */
class Params {
	private readonly values: unknown[] = [];
	add(value: unknown): string {
		this.values.push(value);
		return `$${this.values.length}`;
	}
	get list(): unknown[] {
		return this.values;
	}
}

type Row = Record<string, unknown>;

/**
 * The ACL gate clauses, derived from the same shared fragments the SQLite store uses.
 *
 * The fragments use `?` placeholders (they are shared with `sqlite.prepare`); this store
 * renumbers them to positional `$n` at query-build time via {@link gateClause}. The SQL
 * itself (EXISTS / CASE WHEN / IN-lists of literals) is standard and runs unchanged on
 * PostgreSQL.
 */
const NARRATOR_GATE_SQL = narratorReadableSqlFragment(false, "n")?.sql ?? "1 = 1";
const PROJECT_GATE_SQL = projectReadableSqlFragment(false, "p")?.sql ?? "1 = 1";

/** Splice a `?`-style fragment into the query, binding the user id once per placeholder. */
function gateClause(fragment: string, userId: string, params: Params): string {
	const parts = fragment.split("?");
	let out = parts[0] ?? "";
	for (const part of parts.slice(1)) out += params.add(userId) + part;
	return out;
}

/** Whitespace-separated query terms — the prefix-path unit (`"a"* "b"*`). */
function queryTerms(text: string): string[] {
	return text.split(/\s+/).filter(Boolean);
}

/**
 * Contains-pattern with NO wildcard escaping, mirroring `rawContains`: a user-typed `%`
 * or `_` widens the match on the global, timeline and Recall paths, by design.
 */
function rawContains(text: string): string {
	return `%${text}%`;
}

/**
 * Contains-pattern with `%`, `_` and `\` escaped, mirroring `escapedContains`. Paired with
 * `ESCAPE '\'` on the knowledge paths only.
 */
function escapedContains(text: string): string {
	return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** `(col ILIKE $p OR …)` for one phrase needle, or the single-column form. */
function phraseClause(columns: readonly string[], text: string, params: Params): string {
	const p = params.add(rawContains(text));
	const cols = columns.map((c) => `${c} ILIKE ${p}`);
	return cols.length === 1 ? (cols[0] as string) : `(${cols.join(" OR ")})`;
}

/**
 * Per-term contains clauses joined by the match mode. A term matches when it appears in
 * ANY of the given columns — FTS5 matches a term against every indexed column, and the
 * field-restricted form simply passes one column.
 */
function termsClause(
	columns: readonly string[],
	terms: readonly string[],
	match: "and" | "or",
	params: Params,
): string {
	if (terms.length === 0) {
		// Callers must not send an empty index expression (SQLite's MATCH rejects it); the
		// defensive rejection here keeps the contract identical across backends.
		throw new ValidationError("Empty full-text expression");
	}
	const perTerm = terms.map((term) => {
		const p = params.add(rawContains(term));
		const cols = columns.map((c) => `${c} ILIKE ${p}`);
		return cols.length === 1 ? (cols[0] as string) : `(${cols.join(" OR ")})`;
	});
	return perTerm.join(match === "or" ? " OR " : " AND ");
}

/**
 * Backend-reported relevance, lower-is-better: `1 - pg_trgm similarity` of the best column.
 *
 * Compared against the whole query text. Scoring is the caller's business; this only has
 * to be finite and monotonic in match strength so the caller's band mapping stays sane.
 */
function rankSql(columns: readonly string[], textParam: string): string {
	const sims = columns.map((c) => `similarity(lower(COALESCE(${c}, '')), lower(${textParam}))`);
	return `(1 - GREATEST(${sims.join(", ")}))`;
}

/**
 * A bounded excerpt around the first needle occurrence, cut server-side.
 *
 * Mirrors what FTS5's `snippet()` produces for the same fixed column: when the needle is
 * absent from this column the head of the text is returned (FTS5 excerpts the column even
 * when another column matched); `tokens` is approximated as characters, which is exact for
 * the trigram tokenizer (N overlapping trigrams span N+2 characters). Match markers
 * (open/close) are applied in {@link markSnippet} after the row arrives, because they must
 * bracket the needle inside the already-cut window.
 */
function snippetSql(
	column: string,
	needles: readonly string[],
	format: SnippetFormat,
	params: Params,
): string {
	const half = Math.floor(format.tokens / 2);
	const win = format.tokens + 2;
	const ellipsis = `'${format.ellipsis.replaceAll("'", "''")}'`;
	if (needles.length === 0) {
		return `left(COALESCE(${column}, ''), ${win})`;
	}
	const positions = needles.map(
		(n) => `NULLIF(strpos(lower(COALESCE(${column}, '')), lower(${params.add(n)})), 0)`,
	);
	const pos = positions.length === 1 ? positions[0] : `LEAST(${positions.join(", ")})`;
	return `CASE
		WHEN ${column} IS NULL THEN NULL
		WHEN ${pos} IS NULL
			THEN left(${column}, ${win}) || CASE WHEN length(${column}) > ${win} THEN ${ellipsis} ELSE '' END
		ELSE (CASE WHEN ${pos} > ${half + 1} THEN ${ellipsis} ELSE '' END)
			|| substr(${column}, GREATEST(1, ${pos} - ${half}), ${win})
			|| (CASE WHEN GREATEST(1, ${pos} - ${half}) + ${win} - 1 < length(${column}) THEN ${ellipsis} ELSE '' END)
	END`;
}

/** Wrap every needle occurrence in the excerpt with the format's match markers. */
function markSnippet(
	snippet: string | null,
	needles: readonly string[],
	format: SnippetFormat,
): string {
	if (snippet === null || snippet === undefined) return "";
	if (format.open === "" && format.close === "") return snippet;
	const terms = [...new Set(needles.filter((n) => n.length > 0))].sort(
		(a, b) => b.length - a.length,
	);
	if (terms.length === 0) return snippet;
	const lowered = terms.map((t) => t.toLowerCase());
	const haystack = snippet.toLowerCase();
	let out = "";
	let i = 0;
	while (i < snippet.length) {
		let best = -1;
		let bestLen = 0;
		for (const term of lowered) {
			const idx = haystack.indexOf(term, i);
			if (idx !== -1 && (best === -1 || idx < best)) {
				best = idx;
				bestLen = term.length;
			}
		}
		if (best === -1) {
			out += snippet.slice(i);
			break;
		}
		out +=
			snippet.slice(i, best) + format.open + snippet.slice(best, best + bestLen) + format.close;
		i = best + bestLen;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Column lists (same selection as the SQLite store, so rows map identically)
// ─────────────────────────────────────────────────────────────────────────────

const CHAPTER_COLUMNS = `c.id, c.title, c.description, c.status, c.role, c.created_at, c.updated_at,
		  p.name AS project_name`;

const MESSAGE_COLUMNS = `m.id, m.narrator_id, substr(m.content_text, 1, ${PREVIEW_CHARS}) AS content_preview,
		  m.role AS message_role, m.created_at,
		  n.chapter_id, n.title AS narrator_title, n.model,
		  c.title AS chapter_title, p.name AS project_name`;

const NARRATOR_COLUMNS = `n.id, n.title, n.chapter_id, n.status, n.model, n.message_count,
		  n.last_message_at, n.created_at, n.updated_at,
		  c.title AS chapter_title, p.name AS project_name`;

const KNOWLEDGE_ENTRY_COLUMNS = `e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
		  e.created_at, e.updated_at`;

const TIMELINE_COLUMNS = `m.id, m.role AS message_role, m.created_at, r.seq,
		  substr(m.content_text, 1, ${PREVIEW_CHARS}) AS content_preview`;

// ─────────────────────────────────────────────────────────────────────────────
// Row helpers
// ─────────────────────────────────────────────────────────────────────────────

function str(row: Row, key: string): string | null {
	const v = row[key];
	return v === null || v === undefined ? null : String(v);
}

function strOr(row: Row, key: string, fallback: string): string {
	return str(row, key) ?? fallback;
}

function rankOf(row: Row, strategy: "index" | "substring"): number | null {
	if (strategy !== "index") return null;
	const numeric = Number(row.rank_score);
	return Number.isFinite(numeric) ? numeric : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ids the ancestry predicate binds. The SQLite store interpolates them after validating
 * against this alphabet; this store BINDS them as parameters (strictly safer), but keeps
 * the same validation so the error contract — invalid narrator id rejects, invalid scope
 * entries are dropped — is identical.
 */
const NARRATOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function timelineScopeSql(query: TimelineSearchQuery, params: Params): string {
	if (!NARRATOR_ID_PATTERN.test(query.narratorId)) {
		throw new ValidationError("Invalid narrator id");
	}
	const clauses = [`r.narrator_id = ${params.add(query.narratorId)}`];
	for (const scope of query.inheritedScopes) {
		if (!NARRATOR_ID_PATTERN.test(scope.narratorId)) continue;
		if (!Number.isFinite(scope.upperBoundSeq)) continue;
		clauses.push(
			`(r.narrator_id = ${params.add(scope.narratorId)} AND r.seq < ${params.add(
				Math.trunc(scope.upperBoundSeq),
			)})`,
		);
	}
	return `(${clauses.join(" OR ")})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index fields a knowledge search may restrict itself to. Same allow-list as the SQLite
 * store: an unrecognized name is REJECTED, never interpolated.
 */
const KNOWLEDGE_FIELDS: ReadonlySet<string> = new Set(["current_keywords"]);

function knowledgeField(field: string | undefined): string | undefined {
	if (field === undefined) return undefined;
	if (!KNOWLEDGE_FIELDS.has(field)) {
		throw new ValidationError(`Unsupported knowledge search field: ${field}`);
	}
	return field;
}

/** Restrict to a project's collections plus project-less (global) ones. */
function projectClause(projectId: string | undefined, params: Params): string {
	return projectId
		? `AND e.collection_id IN (
			SELECT id FROM knowledge_collections WHERE project_id = ${params.add(projectId)} OR project_id IS NULL
		)`
		: "";
}

/** `AND e.id NOT IN ($…)` with every id bound. */
function excludeClause(ids: readonly string[] | undefined, params: Params): string {
	if (!ids || ids.length === 0) return "";
	return `AND e.id NOT IN (${ids.map((id) => params.add(id)).join(", ")})`;
}

/** `AND e.collection_id = $x` when a collection restriction is given. */
function collectionClause(collectionId: string | undefined, params: Params): string {
	return collectionId ? `AND e.collection_id = ${params.add(collectionId)}` : "";
}

function toKnowledgeRow(row: Row, fromDraft: boolean, snippet: string): KnowledgeSearchRow {
	return {
		id: strOr(row, "id", ""),
		collectionId: strOr(row, "collection_id", ""),
		title: strOr(row, "title", ""),
		slug: strOr(row, "slug", ""),
		tagsJson: str(row, "tags_json"),
		status: strOr(row, "status", ""),
		createdAt: strOr(row, "created_at", ""),
		updatedAt: strOr(row, "updated_at", ""),
		snippet,
		fromDraft,
		drifted: row.drifted === true || row.drifted === 1,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a PostgreSQL search store over the given executor.
 *
 * The executor is Bun's `SQL` in production (`sql.unsafe(text, params)`); tests may pass
 * any object with that shape. All state is per-query — there is no prepared-statement
 * cache to scope, because a networked driver prepares server-side.
 */
export function createPostgresSearchStore(client: PgExecutor): SearchStore {
	const run = async (text: string, params: Params): Promise<Row[]> =>
		client.unsafe(text, params.list);

	return {
		backend: "postgres",

		async searchChapters(query: EntitySearchQuery): Promise<ChapterSearchRow[]> {
			const params = new Params();
			const gate = query.viewer.isAdmin
				? ""
				: `AND ${gateClause(PROJECT_GATE_SQL, query.viewer.userId, params)}`;
			let rows: Row[];
			if (query.strategy === "index") {
				const where = phraseClause(["f.title", "f.description"], query.text, params);
				const snippet = snippetSql("f.description", [query.text], GLOBAL_SNIPPET, params);
				const rank = rankSql(["f.title", "f.description"], params.add(query.text));
				rows = await run(
					`SELECT ${CHAPTER_COLUMNS}, ${snippet} AS snippet, ${rank} AS rank_score
					 FROM search_chapters f
					 JOIN chapters c ON c.id = f.id
					 JOIN projects p ON p.id = c.project_id
					 WHERE ${where} ${gate}
					 ORDER BY rank_score LIMIT ${params.add(query.limit)}`,
					params,
				);
			} else {
				const needle = params.add(rawContains(query.text));
				rows = await run(
					`SELECT ${CHAPTER_COLUMNS},
						substr(COALESCE(c.description, c.title, ''), 1, ${PREVIEW_CHARS}) AS snippet
					 FROM chapters c
					 JOIN projects p ON p.id = c.project_id
					 WHERE (c.title ILIKE ${needle} OR c.description ILIKE ${needle}) ${gate}
					 LIMIT ${params.add(query.limit)}`,
					params,
				);
			}
			return rows.map((row) => ({
				id: strOr(row, "id", ""),
				title: str(row, "title"),
				description: str(row, "description"),
				status: str(row, "status"),
				role: str(row, "role"),
				projectName: str(row, "project_name"),
				createdAt: str(row, "created_at"),
				updatedAt: str(row, "updated_at"),
				snippet: str(row, "snippet") ?? "",
				rank: rankOf(row, query.strategy),
			}));
		},

		async searchMessages(query: EntitySearchQuery): Promise<MessageSearchRow[]> {
			const params = new Params();
			const gate = query.viewer.isAdmin
				? ""
				: `AND ${gateClause(NARRATOR_GATE_SQL, query.viewer.userId, params)}`;
			let rows: Row[];
			if (query.strategy === "index") {
				const where = phraseClause(["f.content_text"], query.text, params);
				const snippet = snippetSql("f.content_text", [query.text], GLOBAL_SNIPPET, params);
				const rank = rankSql(["f.content_text"], params.add(query.text));
				rows = await run(
					`SELECT ${MESSAGE_COLUMNS}, ${snippet} AS snippet, ${rank} AS rank_score
					 FROM search_narrator_messages f
					 JOIN narrator_messages m ON m.id = f.id
					 JOIN narrators n ON n.id = m.narrator_id
					 LEFT JOIN chapters c ON c.id = n.chapter_id
					 LEFT JOIN projects p ON p.id = c.project_id
					 WHERE ${where} ${gate}
					 ORDER BY rank_score LIMIT ${params.add(query.limit)}`,
					params,
				);
			} else {
				const needle = params.add(rawContains(query.text));
				rows = await run(
					`SELECT ${MESSAGE_COLUMNS},
						substr(m.content_text, 1, ${PREVIEW_CHARS}) AS snippet
					 FROM narrator_messages m
					 JOIN narrators n ON n.id = m.narrator_id
					 LEFT JOIN chapters c ON c.id = n.chapter_id
					 LEFT JOIN projects p ON p.id = c.project_id
					 WHERE m.content_text ILIKE ${needle} ${gate}
					 LIMIT ${params.add(query.limit)}`,
					params,
				);
			}
			return rows.map((row) => ({
				id: strOr(row, "id", ""),
				narratorId: str(row, "narrator_id"),
				narratorTitle: str(row, "narrator_title"),
				chapterId: str(row, "chapter_id"),
				chapterTitle: str(row, "chapter_title"),
				projectName: str(row, "project_name"),
				model: str(row, "model"),
				messageRole: str(row, "message_role"),
				createdAt: str(row, "created_at"),
				snippet: str(row, "snippet") ?? "",
				preview: str(row, "content_preview") ?? "",
				rank: rankOf(row, query.strategy),
			}));
		},

		async searchNarrators(query: EntitySearchQuery): Promise<NarratorSearchRow[]> {
			const params = new Params();
			const gate = query.viewer.isAdmin
				? ""
				: `AND ${gateClause(NARRATOR_GATE_SQL, query.viewer.userId, params)}`;
			let rows: Row[];
			if (query.strategy === "index") {
				const where = phraseClause(["f.title"], query.text, params);
				const snippet = snippetSql("f.title", [query.text], GLOBAL_SNIPPET, params);
				const rank = rankSql(["f.title"], params.add(query.text));
				rows = await run(
					`SELECT ${NARRATOR_COLUMNS}, ${snippet} AS snippet, ${rank} AS rank_score
					 FROM search_narrators f
					 JOIN narrators n ON n.id = f.id
					 LEFT JOIN chapters c ON c.id = n.chapter_id
					 LEFT JOIN projects p ON p.id = c.project_id
					 WHERE ${where} ${gate}
					 ORDER BY rank_score LIMIT ${params.add(query.limit)}`,
					params,
				);
			} else {
				// No snippet column on this path, exactly like SQLite: the caller falls back
				// to the title, the only text this search matches against.
				const needle = params.add(rawContains(query.text));
				rows = await run(
					`SELECT ${NARRATOR_COLUMNS}
					 FROM narrators n
					 LEFT JOIN chapters c ON c.id = n.chapter_id
					 LEFT JOIN projects p ON p.id = c.project_id
					 WHERE n.title ILIKE ${needle} ${gate}
					 LIMIT ${params.add(query.limit)}`,
					params,
				);
			}
			return rows.map((row) => ({
				id: strOr(row, "id", ""),
				title: str(row, "title"),
				chapterId: str(row, "chapter_id"),
				chapterTitle: str(row, "chapter_title"),
				projectName: str(row, "project_name"),
				status: str(row, "status"),
				model: str(row, "model"),
				lastMessageAt: str(row, "last_message_at"),
				createdAt: str(row, "created_at"),
				updatedAt: str(row, "updated_at"),
				snippet: str(row, "snippet") ?? "",
				rank: rankOf(row, query.strategy),
			}));
		},

		async searchTimeline(query: TimelineSearchQuery): Promise<TimelineSearchRow[]> {
			const params = new Params();
			const scopeSql = timelineScopeSql(query, params);
			let rows: Row[];
			if (query.strategy === "index") {
				const terms = queryTerms(query.text);
				const where = termsClause(["f.content_text"], terms, "and", params);
				const snippet = snippetSql("f.content_text", terms, TIMELINE_SNIPPET, params);
				rows = await run(
					`SELECT ${TIMELINE_COLUMNS}, ${snippet} AS snippet
					 FROM search_narrator_messages f
					 JOIN narrator_messages m ON m.id = f.id
					 JOIN narrator_message_refs r
					   ON r.message_id = m.id AND ${scopeSql} AND r.segment_compact_id IS NULL
					 WHERE ${where}
					 ORDER BY r.seq DESC
					 LIMIT ${params.add(query.limit)}`,
					params,
				);
				return rows.map((row) => ({
					messageId: strOr(row, "id", ""),
					seq: Number(row.seq) || 0,
					role: strOr(row, "message_role", ""),
					snippet: markSnippet(str(row, "snippet"), terms, TIMELINE_SNIPPET),
					preview: str(row, "content_preview") ?? "",
					createdAt: strOr(row, "created_at", ""),
				}));
			}
			const needle = params.add(rawContains(query.text));
			rows = await run(
				`SELECT ${TIMELINE_COLUMNS},
					substr(m.content_text, 1, ${PREVIEW_CHARS}) AS snippet
				 FROM narrator_message_refs r
				 JOIN narrator_messages m ON m.id = r.message_id
				 WHERE ${scopeSql} AND r.segment_compact_id IS NULL
				   AND m.content_text ILIKE ${needle}
				 ORDER BY r.seq DESC
				 LIMIT ${params.add(query.limit)}`,
				params,
			);
			return rows.map((row) => ({
				messageId: strOr(row, "id", ""),
				seq: Number(row.seq) || 0,
				role: strOr(row, "message_role", ""),
				snippet: str(row, "snippet") ?? "",
				preview: str(row, "content_preview") ?? "",
				createdAt: strOr(row, "created_at", ""),
			}));
		},

		async searchRecallMessages(query: RecallSearchQuery): Promise<RecallMessageRow[]> {
			const params = new Params();
			const global = query.narratorId === null;
			const source = global
				? `JOIN narrators n ON n.id = m.narrator_id`
				: `JOIN narrator_message_refs r ON r.message_id = m.id
			 JOIN narrators n ON n.id = r.narrator_id`;
			const narratorIdColumn = global ? "n.id AS narrator_id" : "r.narrator_id";
			const scopeFilter = global ? "" : ` AND r.narrator_id = ${params.add(query.narratorId)}`;
			let timeSuffix = "";
			if (query.createdFrom) timeSuffix += ` AND m.created_at >= ${params.add(query.createdFrom)}`;
			if (query.createdTo) timeSuffix += ` AND m.created_at <= ${params.add(query.createdTo)}`;
			let rows: Row[];
			if (query.strategy === "index") {
				const terms = queryTerms(query.text);
				const where = termsClause(["f.content_text"], terms, "and", params);
				const snippet = snippetSql("f.content_text", terms, RECALL_SNIPPET, params);
				rows = await run(
					`SELECT m.id, ${narratorIdColumn}, m.role, m.created_at,
						n.title AS narrator_title, n.chapter_id,
						${snippet} AS snippet
					 FROM search_narrator_messages f
					 JOIN narrator_messages m ON m.id = f.id
					 ${source}
					 WHERE ${where}${scopeFilter}${timeSuffix}
					 ORDER BY m.created_at DESC
					 LIMIT ${params.add(query.limit)}`,
					params,
				);
				return rows.map((row) => ({
					messageId: strOr(row, "id", ""),
					narratorId: strOr(row, "narrator_id", ""),
					narratorTitle: str(row, "narrator_title"),
					chapterId: str(row, "chapter_id"),
					role: strOr(row, "role", ""),
					createdAt: strOr(row, "created_at", ""),
					snippet: markSnippet(str(row, "snippet"), terms, RECALL_SNIPPET),
				}));
			}
			const needle = params.add(rawContains(query.text));
			rows = await run(
				`SELECT m.id, ${narratorIdColumn}, m.role, m.created_at,
					n.title AS narrator_title, n.chapter_id,
					substr(m.content_text, 1, ${params.add(query.previewChars)}) AS snippet
				 FROM narrator_messages m
				 ${source}
				 WHERE m.content_text ILIKE ${needle}${scopeFilter}${timeSuffix}
				 ORDER BY m.created_at DESC
				 LIMIT ${params.add(query.limit)}`,
				params,
			);
			return rows.map((row) => ({
				messageId: strOr(row, "id", ""),
				narratorId: strOr(row, "narrator_id", ""),
				narratorTitle: str(row, "narrator_title"),
				chapterId: str(row, "chapter_id"),
				role: strOr(row, "role", ""),
				createdAt: strOr(row, "created_at", ""),
				snippet: str(row, "snippet") ?? "",
			}));
		},

		async searchKnowledgeEntries(query: KnowledgeSearchQuery): Promise<KnowledgeSearchRow[]> {
			const field = knowledgeField(query.field);
			const params = new Params();
			// Clauses are assembled before the match predicate so parameter order in the
			// final text is irrelevant — every value is bound positionally by construction.
			const scope =
				collectionClause(query.collectionId, params) +
				projectClause(query.projectId, params) +
				excludeClause(query.excludeEntryIds, params);

			if (query.strategy === "index") {
				const terms = queryTerms(query.indexText);
				const columns = field ? ["f.current_keywords"] : ENTRY_INDEX_COLUMNS;
				const where = termsClause(columns, terms, query.match, params);
				const snippet = snippetSql("f.current_content", terms, KNOWLEDGE_SNIPPET, params);
				const rank = rankSql(columns, params.add(query.indexText));
				const rows = await run(
					`SELECT ${KNOWLEDGE_ENTRY_COLUMNS}, ${snippet} AS snippet_raw, ${rank} AS rank_score
					 FROM search_knowledge_entries f
					 JOIN knowledge_entries e ON e.id = f.id
					 WHERE ${where} ${scope}
					 ORDER BY rank_score LIMIT ${params.add(query.limit)}`,
					params,
				);
				return rows.map((row) =>
					toKnowledgeRow(
						row,
						false,
						markSnippet(str(row, "snippet_raw"), terms, KNOWLEDGE_SNIPPET),
					),
				);
			}

			// Short-query fallback: when field-restricted, only that column is compared so
			// body text never fires a hit (passive injection's contract).
			const raw = params.add(query.substringText);
			const pattern = params.add(escapedContains(query.substringText));
			const matchExpr = field
				? `e.current_keywords ILIKE ${pattern} ESCAPE '\\'`
				: `(e.title ILIKE ${pattern} ESCAPE '\\' OR e.current_content ILIKE ${pattern} ESCAPE '\\')`;
			const rows = await run(
				`SELECT ${KNOWLEDGE_ENTRY_COLUMNS},
					substr(COALESCE(e.current_content, e.title), 1, ${PREVIEW_CHARS}) AS snippet_raw
				 FROM knowledge_entries e
				 WHERE (${raw} = '' OR ${matchExpr}) ${scope}
				 ORDER BY e.updated_at DESC LIMIT ${params.add(query.limit)}`,
				params,
			);
			return rows.map((row) => toKnowledgeRow(row, false, str(row, "snippet_raw") ?? ""));
		},

		async searchKnowledgeDrafts(query: KnowledgeDraftSearchQuery): Promise<KnowledgeSearchRow[]> {
			const params = new Params();
			const scope =
				collectionClause(query.collectionId, params) + projectClause(query.projectId, params);
			const drift = `(d.base_revision_id IS NOT NULL AND d.base_revision_id != e.current_revision_id) AS drifted`;

			if (query.strategy === "index") {
				const terms = queryTerms(query.indexText);
				const where = termsClause(["f.title", "f.content"], terms, query.match, params);
				const snippet = snippetSql("f.content", terms, KNOWLEDGE_SNIPPET, params);
				const rank = rankSql(["f.title", "f.content"], params.add(query.indexText));
				const rows = await run(
					`SELECT ${KNOWLEDGE_ENTRY_COLUMNS}, ${drift},
						${snippet} AS snippet_raw, ${rank} AS rank_score
					 FROM search_knowledge_drafts f
					 JOIN knowledge_drafts d ON d.id = f.id
					 JOIN knowledge_entries e ON e.id = d.entry_id
					 WHERE ${where}
					   AND d.author_user_id = ${params.add(query.authorUserId)}
					   AND d.status = ${params.add(query.draftStatus)} ${scope}
					 ORDER BY rank_score LIMIT ${params.add(query.limit)}`,
					params,
				);
				return rows.map((row) =>
					toKnowledgeRow(row, true, markSnippet(str(row, "snippet_raw"), terms, KNOWLEDGE_SNIPPET)),
				);
			}

			const raw = params.add(query.substringText);
			const pattern = params.add(escapedContains(query.substringText));
			const rows = await run(
				`SELECT ${KNOWLEDGE_ENTRY_COLUMNS}, ${drift},
					substr(COALESCE(d.content, e.title), 1, ${PREVIEW_CHARS}) AS snippet_raw
				 FROM knowledge_drafts d
				 JOIN knowledge_entries e ON e.id = d.entry_id
				 WHERE (${raw} = '' OR e.title ILIKE ${pattern} ESCAPE '\\' OR d.content ILIKE ${pattern} ESCAPE '\\')
				   AND d.author_user_id = ${params.add(query.authorUserId)}
				   AND d.status = ${params.add(query.draftStatus)} ${scope}
				 ORDER BY d.updated_at DESC LIMIT ${params.add(query.limit)}`,
				params,
			);
			return rows.map((row) => toKnowledgeRow(row, true, str(row, "snippet_raw") ?? ""));
		},

		async listShadowedEntryIds(query: ShadowedEntryQuery): Promise<string[]> {
			const params = new Params();
			const rows = await run(
				`SELECT DISTINCT entry_id FROM knowledge_drafts
				 WHERE author_user_id = ${params.add(query.authorUserId)}
				   AND status = ${params.add(query.draftStatus)}
				   AND entry_id IS NOT NULL
				 LIMIT ${params.add(query.limit)}`,
				params,
			);
			return rows.map((row) => strOr(row, "entry_id", ""));
		},
	};
}

/** Columns the unrestricted knowledge index path matches a term against. */
const ENTRY_INDEX_COLUMNS = ["f.title", "f.current_content", "f.current_keywords"];

// ─────────────────────────────────────────────────────────────────────────────
// The registered singleton
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The process-wide PostgreSQL search store, bound late.
 *
 * `backend.ts` registers this object at module load — registration is what makes
 * `resolveSearchStore("postgres")` answer — but the PostgreSQL CONNECTION is wired by the
 * startup path, which does not exist yet. Until {@link bindPostgresSearchClient} runs,
 * every method fails closed with `SEARCH_BACKEND_UNAVAILABLE`: a registered store that
 * cannot reach its database must be a loud error, never an empty result that reads as
 * "no hits".
 */
let boundClient: PgExecutor | null = null;

export function bindPostgresSearchClient(client: PgExecutor): void {
	boundClient = client;
}

/** Visible for tests: whether the singleton has a connection behind it. */
export function isPostgresSearchBound(): boolean {
	return boundClient !== null;
}

/**
 * TEST-ONLY: release the module-level binding so the fail-closed behaviour is restored.
 *
 * The composition test binds a stub executor through `composePostgresStores`; without this
 * seam the binding survives `afterAll` and any later test in the same process (e.g. the
 * search-backend contract's "fails closed before binding") would observe a bound client.
 * Production code has no reason to unbind: a once-wired connection is never unwired by the
 * startup path, and closing is handled by the runtime, not this module.
 */
export function unbindPostgresSearchClientForTests(): void {
	boundClient = null;
}

export const postgresSearchStore: SearchStore = createPostgresSearchStore({
	unsafe: (query: string, params?: unknown[]) => {
		if (!boundClient) {
			throw new AppError(
				"PostgreSQL search store is registered but not bound to a connection yet. " +
					"The startup path must call bindPostgresSearchClient before postgres search is used.",
				500,
				"SEARCH_BACKEND_UNAVAILABLE",
			);
		}
		return boundClient.unsafe(query, params);
	},
});
