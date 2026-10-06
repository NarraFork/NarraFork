/**
 * SQLite implementation of the search port: FTS5, `MATCH`, `snippet()`, `rank`.
 *
 * Every SQLite-only piece of NarraFork's text search lives in this file. That is the whole
 * point of the module — before it, the same four capabilities were spread across
 * `search-service.ts`, `knowledge-service.ts` and the Recall tool, so a port had to find
 * them by grepping. The dialect ledger now registers this one file for the search surface.
 *
 * SQL-TEMPLATE CACHING
 * --------------------
 * Each store caches only fixed SQL templates, never database statements. Cache keys use
 * enumerated variants, not user input; the viewer id always travels as a bound parameter.
 * Dynamic ancestry and exclusion-list queries bypass the cache so it cannot grow with user
 * data. Each interpolated value is validated; user text is never interpolated.
 *
 * QUERY-SHAPE FIDELITY
 * --------------------
 * The four callers do not agree on how a query is turned into a match expression, and this
 * file reproduces each one exactly rather than harmonizing them. See the table in
 * `types.ts`. Two specifics worth stating because they look like bugs:
 *
 *   - global search matches the whole sanitized query as ONE quoted phrase (`"a b"`), so it
 *     finds contiguous text and does not do prefix matching. The timeline, Recall and
 *     knowledge paths match each term as a prefix (`"a"* "b"*`).
 *   - the substring fallbacks differ on wildcard escaping: knowledge escapes `%`/`_` and
 *     pairs the pattern with `ESCAPE '\'`; the other three do not, so a user-typed `%`
 *     widens their match. Both behaviours are load-bearing for their existing tests.
 *     widen their match. Both behaviours are load-bearing for their existing tests.
 *
 * ASYNCHRONOUS EXECUTION
 * -----------------------
 * Production queries execute in the SQLite search worker, not the HTTP thread. This module
 * owns SQL construction and row mapping only. Tests may inject an executor for an isolated
 * in-memory database; production never substitutes a synchronous main-thread driver.
 */

import { ValidationError } from "../../lib/errors";
import { narratorReadableSqlFragment } from "../narrator-acl";
import { projectReadableSqlFragment } from "../project-acl";
import type { SearchStore } from "./port";
import {
	escapedContains,
	phraseExpr,
	prefixExpr,
	rawContains,
	snippetCall,
} from "./sqlite-expressions";
import { executeSqliteSearchQuery, type SearchQueryExecutor } from "./sqlite-worker-runner";
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
	TIMELINE_SNIPPET,
	type TimelineSearchQuery,
	type TimelineSearchRow,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Access gates, derived from the shared ACL fragments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Visibility clause for a narrators row aliased `n`, and for a projects row aliased `p`.
 *
 * Derived from the shared ACL fragments rather than written here. A local copy drifted once
 * already: it still queried the deprecated `narrator_grants` table after the ACL layer moved
 * to `acl_grants`, which silently hid shared sessions from search. Deriving means the rules —
 * including the project gate — can only change in one place.
 *
 * Placeholder counts are derived from the rendered text for the same reason: a hard-coded
 * number silently shifts every later parameter when a fragment changes, and a shifted LIMIT
 * reads as a ranking quirk rather than as a bug.
 */
const NARRATOR_GATE_SQL = narratorReadableSqlFragment(false, "n")?.sql ?? "1 = 1";
const NARRATOR_GATE_PARAMS = (NARRATOR_GATE_SQL.match(/\?/g) ?? []).length;
const PROJECT_GATE_SQL = projectReadableSqlFragment(false, "p")?.sql ?? "1 = 1";
const PROJECT_GATE_PARAMS = (PROJECT_GATE_SQL.match(/\?/g) ?? []).length;

/** The user id repeated once per placeholder in a gate clause. */
function gateParams(userId: string, count: number): string[] {
	return Array.from({ length: count }, () => userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached SQL templates
// ─────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: raw driver rows have no static shape
type RawRow = any;
type QueryOptions = NonNullable<Parameters<SearchQueryExecutor>[2]>;
type QueryTemplate = {
	all(options: QueryOptions, ...params: Array<string | number | null>): Promise<RawRow[]>;
};

/** Every executor gets its own bounded set of fixed SQL templates. */
export function createSqliteSearchStore(execute: SearchQueryExecutor): SearchStore {
	const templates = new Map<string, string>();

	function cached(key: string, build: () => string): QueryTemplate {
		let sql = templates.get(key);
		if (!sql) {
			sql = build();
			templates.set(key, sql);
		}
		const templateSql = sql;
		return { all: (options, ...params) => execute(templateSql, params, options) };
	}

	/** Columns every chapter hit needs, plus the project name its gate joins for anyway. */
	const CHAPTER_COLUMNS = `c.id, c.title, substr(c.description, 1, ${PREVIEW_CHARS}) as description, c.status, c.role, c.created_at, c.updated_at,
			  p.name as project_name`;

	const MESSAGE_COLUMNS = `m.id, m.narrator_id, substr(m.content_text, 1, ${PREVIEW_CHARS}) as content_preview,
			  m.role as message_role, m.created_at,
			  n.chapter_id, n.title as narrator_title, n.model,
			  c.title as chapter_title, p.name as project_name`;

	const NARRATOR_COLUMNS = `n.id, n.title, n.chapter_id, n.status, n.model, n.message_count,
			  n.last_message_at, n.created_at, n.updated_at,
			  c.title as chapter_title, p.name as project_name`;

	const KNOWLEDGE_ENTRY_COLUMNS = `e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at`;

	/**
	 * Chapter search.
	 *
	 * `JOIN projects` is an inner join in both strategies, so a chapter whose project row has
	 * vanished is already excluded — a dangling reference must not read as "no project, therefore
	 * no gate".
	 */
	function chapterStmt(
		strategy: "index" | "substring",
		gated: boolean,
		sort: EntitySearchQuery["sort"],
	): QueryTemplate {
		return cached(`chapters:${strategy}:${sort ?? "relevance"}:${gated ? "gated" : "all"}`, () => {
			const gate = gated ? `AND ${PROJECT_GATE_SQL}` : "";
			if (strategy === "index") {
				return `SELECT ${CHAPTER_COLUMNS},
			  ${snippetCall("chapters_fts", 1, GLOBAL_SNIPPET)} as snippet,
			  rank as rank_score
			 FROM chapters_fts
			 JOIN chapters c ON c.rowid = chapters_fts.rowid
			 JOIN projects p ON p.id = c.project_id
			 WHERE chapters_fts MATCH ? ${gate}
			 ORDER BY ${sort === "time" ? "COALESCE(c.updated_at, c.created_at) DESC, c.id ASC" : "rank"} LIMIT ?`;
			}
			return `SELECT ${CHAPTER_COLUMNS},
			  substr(COALESCE(c.description, c.title, ''), 1, ${PREVIEW_CHARS}) as snippet
			 FROM chapters c
			 JOIN projects p ON p.id = c.project_id
			 WHERE (c.title LIKE ? OR c.description LIKE ?) ${gate}
			 ${sort === "time" ? "ORDER BY COALESCE(c.updated_at, c.created_at) DESC, c.id ASC" : ""} LIMIT ?`;
		});
	}

	function messageStmt(
		strategy: "index" | "substring",
		gated: boolean,
		sort: EntitySearchQuery["sort"],
	): QueryTemplate {
		return cached(`messages:${strategy}:${sort ?? "relevance"}:${gated ? "gated" : "all"}`, () => {
			const gate = gated ? `AND ${NARRATOR_GATE_SQL}` : "";
			if (strategy === "index") {
				return `SELECT ${MESSAGE_COLUMNS},
			  ${snippetCall("narrator_messages_fts", 0, GLOBAL_SNIPPET)} as snippet,
			  rank as rank_score
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE narrator_messages_fts MATCH ? ${gate}
			 ORDER BY ${sort === "time" ? "m.created_at DESC, m.id ASC" : "rank"} LIMIT ?`;
			}
			return `SELECT ${MESSAGE_COLUMNS},
			  substr(m.content_text, 1, ${PREVIEW_CHARS}) as snippet
			 FROM narrator_messages m
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE m.content_text LIKE ? ${gate}
			 ${sort === "time" ? "ORDER BY m.created_at DESC, m.id ASC" : ""} LIMIT ?`;
		});
	}

	function narratorStmt(
		strategy: "index" | "substring",
		gated: boolean,
		sort: EntitySearchQuery["sort"],
	): QueryTemplate {
		return cached(`narrators:${strategy}:${sort ?? "relevance"}:${gated ? "gated" : "all"}`, () => {
			const gate = gated ? `AND ${NARRATOR_GATE_SQL}` : "";
			if (strategy === "index") {
				return `SELECT ${NARRATOR_COLUMNS},
			  ${snippetCall("narrators_fts", 0, GLOBAL_SNIPPET)} as snippet,
			  rank as rank_score
			 FROM narrators_fts
			 JOIN narrators n ON n.rowid = narrators_fts.rowid
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE narrators_fts MATCH ? ${gate}
			 ORDER BY ${sort === "time" ? "COALESCE(n.updated_at, n.created_at, n.last_message_at) DESC, n.id ASC" : "rank"} LIMIT ?`;
			}
			// No snippet column at all on this path: the caller falls back to the title, which is
			// the only text this search matches against.
			return `SELECT ${NARRATOR_COLUMNS}
			 FROM narrators n
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE n.title LIKE ? ${gate}
			 ${sort === "time" ? "ORDER BY COALESCE(n.updated_at, n.created_at, n.last_message_at) DESC, n.id ASC" : ""} LIMIT ?`;
		});
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Timeline search
	// ─────────────────────────────────────────────────────────────────────────────

	const TIMELINE_COLUMNS = `m.id, m.role as message_role, m.created_at, r.seq,
			  substr(m.content_text, 1, ${PREVIEW_CHARS}) as content_preview`;

	/**
	 * Ids are interpolated into the ancestry predicate, so the alphabet is pinned here.
	 *
	 * The number of inherited scopes varies per narrator, so that statement cannot be prepared
	 * once and cached. Every interpolated value is therefore checked: ids must match the
	 * generator's alphabet and bounds must be finite integers. Anything else is DROPPED rather
	 * than quoted, so a malformed value can only narrow the search, never alter the statement.
	 */
	const NARRATOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

	function timelineScopeSql(
		narratorId: string,
		scopes: readonly { narratorId: string; upperBoundSeq: number }[],
	) {
		if (!NARRATOR_ID_PATTERN.test(narratorId)) {
			throw new ValidationError("Invalid narrator id");
		}
		const clauses = [`r.narrator_id = '${narratorId}'`];
		for (const scope of scopes) {
			if (!NARRATOR_ID_PATTERN.test(scope.narratorId)) continue;
			if (!Number.isFinite(scope.upperBoundSeq)) continue;
			clauses.push(
				`(r.narrator_id = '${scope.narratorId}' AND r.seq < ${Math.trunc(scope.upperBoundSeq)})`,
			);
		}
		return `(${clauses.join(" OR ")})`;
	}

	/** Index-path timeline SQL for a given ref predicate. */
	function timelineIndexSql(scopeSql: string): string {
		return `SELECT ${TIMELINE_COLUMNS},
			  ${snippetCall("narrator_messages_fts", 0, TIMELINE_SNIPPET)} as snippet
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrator_message_refs r
			   ON r.message_id = m.id AND ${scopeSql} AND r.segment_compact_id IS NULL
			 WHERE narrator_messages_fts MATCH ?
			 ORDER BY r.seq DESC
			 LIMIT ?`;
	}

	/**
	 * Substring-path timeline SQL.
	 *
	 * Starts from the narrator's refs (indexed by narrator_id + seq) and filters the joined
	 * message text, ordered by seq DESC and capped by LIMIT, so it never scans the whole corpus.
	 */
	function timelineSubstringSql(scopeSql: string): string {
		return `SELECT ${TIMELINE_COLUMNS},
			  substr(m.content_text, 1, ${PREVIEW_CHARS}) as snippet
			 FROM narrator_message_refs r
			 JOIN narrator_messages m ON m.id = r.message_id
			 WHERE ${scopeSql} AND r.segment_compact_id IS NULL
			   AND m.content_text LIKE ?
			 ORDER BY r.seq DESC
			 LIMIT ?`;
	}

	/** The no-ancestry case binds the narrator id instead of interpolating it, so it caches. */
	function timelineOwnStmt(strategy: "index" | "substring"): QueryTemplate {
		return cached(`timeline:${strategy}`, () =>
			strategy === "index"
				? timelineIndexSql("r.narrator_id = ? ")
				: timelineSubstringSql("r.narrator_id = ? "),
		);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Recall search
	// ─────────────────────────────────────────────────────────────────────────────

	function recallTimeSuffix(query: RecallSearchQuery): string {
		if (query.createdFrom && query.createdTo) return " AND m.created_at >= ? AND m.created_at <= ?";
		if (query.createdFrom) return " AND m.created_at >= ?";
		if (query.createdTo) return " AND m.created_at <= ?";
		return "";
	}

	function recallTimeKey(query: RecallSearchQuery): string {
		if (query.createdFrom && query.createdTo) return "range";
		if (query.createdFrom) return "from";
		if (query.createdTo) return "to";
		return "none";
	}

	function recallTimeParams(query: RecallSearchQuery): string[] {
		if (query.createdFrom && query.createdTo) return [query.createdFrom, query.createdTo];
		if (query.createdFrom) return [query.createdFrom];
		if (query.createdTo) return [query.createdTo];
		return [];
	}

	/**
	 * Recall's statement.
	 *
	 * Scoped mode joins `narrator_message_refs` and filters by the current narrator, so
	 * fork-shared messages stay visible to the narrator that inherited them. Global mode joins
	 * on the message's owning narrator, which deduplicates a fork-shared message to its origin.
	 */
	function recallStmt(
		strategy: "index" | "substring",
		global: boolean,
		timeKey: string,
		timeSuffix: string,
	): QueryTemplate {
		return cached(`recall:${strategy}:${global ? "global" : "scoped"}:${timeKey}`, () => {
			const source = global
				? `JOIN narrators n ON n.id = m.narrator_id`
				: `JOIN narrator_message_refs r ON r.message_id = m.id
		 JOIN narrators n ON n.id = r.narrator_id`;
			const narratorIdColumn = global ? "n.id AS narrator_id" : "r.narrator_id";
			const scopeFilter = global ? "" : " AND r.narrator_id = ?";
			if (strategy === "index") {
				return `SELECT m.id, ${narratorIdColumn}, m.role, m.created_at,
		        n.title AS narrator_title, n.chapter_id,
		        ${snippetCall("narrator_messages_fts", 0, RECALL_SNIPPET)} AS snippet
		 FROM narrator_messages_fts
		 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
		 ${source}
		 WHERE narrator_messages_fts MATCH ?${scopeFilter}${timeSuffix}
		 ORDER BY rank
		 LIMIT ?`;
			}
			return `SELECT m.id, ${narratorIdColumn}, m.role, m.created_at,
		        n.title AS narrator_title, n.chapter_id,
		        substr(m.content_text, 1, ?) AS snippet
		 FROM narrator_messages m
		 ${source}
		 WHERE m.content_text LIKE ?${scopeFilter}${timeSuffix}
		 ORDER BY m.created_at DESC
		 LIMIT ?`;
		});
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Knowledge search
	// ─────────────────────────────────────────────────────────────────────────────

	/**
	 * Index fields a knowledge search may restrict itself to.
	 *
	 * An allow-list, not a passthrough: the value reaches an FTS5 column filter and a `LIKE`
	 * column reference, so accepting an arbitrary string would let a caller aim the match at any
	 * column — or inject expression syntax. Unknown names are REJECTED rather than ignored,
	 * because silently searching everything is the failure mode passive injection exists to
	 * prevent (it must fire on author-declared keywords only, never on body text).
	 *
	 * Deliberately just the one field that is actually used. Pre-listing `title` /
	 * `current_content` would be speculative: the substring path treats an unrestricted search as
	 * "title OR body", so a restriction to one of them would be a new recall behaviour nothing
	 * has asked for and no test covers.
	 */
	const KNOWLEDGE_FIELDS: ReadonlySet<string> = new Set(["current_keywords"]);

	function knowledgeField(field: string | undefined): string | undefined {
		if (field === undefined) return undefined;
		if (!KNOWLEDGE_FIELDS.has(field)) {
			throw new ValidationError(`Unsupported knowledge search field: ${field}`);
		}
		return field;
	}

	/** `AND e.collection_id IN (…)` restricting to a project's collections plus global ones. */
	function projectClause(projectId: string | undefined): string {
		return projectId
			? `AND e.collection_id IN (
				SELECT id FROM knowledge_collections WHERE project_id = ? OR project_id IS NULL
			)`
			: "";
	}

	/** `AND e.id NOT IN (?,?,…)` plus its bound params. Ids are bound, never interpolated. */
	function excludeClause(ids: readonly string[] | undefined): { clause: string; params: string[] } {
		if (!ids || ids.length === 0) return { clause: "", params: [] };
		return { clause: `AND e.id NOT IN (${ids.map(() => "?").join(",")})`, params: [...ids] };
	}

	interface KnowledgeRawRow {
		id: string;
		collection_id: string;
		title: string;
		slug: string;
		tags_json: string | null;
		status: string;
		created_at: string;
		updated_at: string;
		snippet: string | null;
		drifted?: number | null;
	}

	function toKnowledgeRow(row: KnowledgeRawRow, fromDraft: boolean): KnowledgeSearchRow {
		return {
			id: row.id,
			collectionId: row.collection_id,
			title: row.title,
			slug: row.slug,
			tagsJson: row.tags_json,
			status: row.status,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			snippet: row.snippet ?? "",
			fromDraft,
			drifted: !!row.drifted,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Row mappers for the entity searches
	// ─────────────────────────────────────────────────────────────────────────────

	function rankOf(row: RawRow, strategy: "index" | "substring"): number | null {
		if (strategy !== "index") return null;
		const numeric = typeof row.rank_score === "number" ? row.rank_score : Number(row.rank_score);
		return Number.isFinite(numeric) ? numeric : null;
	}

	return {
		backend: "sqlite",

		async searchChapters(query: EntitySearchQuery): Promise<ChapterSearchRow[]> {
			const gated = !query.viewer.isAdmin;
			const stmt = chapterStmt(query.strategy, gated, query.sort);
			const options = { signal: query.signal, operation: "searchChapters" };
			const gate = gated ? gateParams(query.viewer.userId, PROJECT_GATE_PARAMS) : [];
			const rows: RawRow[] =
				query.strategy === "index"
					? await stmt.all(options, phraseExpr(query.text), ...gate, query.limit)
					: await stmt.all(
							options,
							rawContains(query.text),
							rawContains(query.text),
							...gate,
							query.limit,
						);
			return rows.map((row) => ({
				id: row.id,
				title: row.title ?? null,
				description: row.description ?? null,
				status: row.status ?? null,
				role: row.role ?? null,
				projectName: row.project_name ?? null,
				createdAt: row.created_at ?? null,
				updatedAt: row.updated_at ?? null,
				snippet: row.snippet ?? "",
				rank: rankOf(row, query.strategy),
			}));
		},

		async searchMessages(query: EntitySearchQuery): Promise<MessageSearchRow[]> {
			const gated = !query.viewer.isAdmin;
			const stmt = messageStmt(query.strategy, gated, query.sort);
			const options = { signal: query.signal, operation: "searchMessages" };
			const gate = gated ? gateParams(query.viewer.userId, NARRATOR_GATE_PARAMS) : [];
			const needle = query.strategy === "index" ? phraseExpr(query.text) : rawContains(query.text);
			const rows: RawRow[] = await stmt.all(options, needle, ...gate, query.limit);
			return rows.map((row) => ({
				id: row.id,
				narratorId: row.narrator_id ?? null,
				narratorTitle: row.narrator_title ?? null,
				chapterId: row.chapter_id ?? null,
				chapterTitle: row.chapter_title ?? null,
				projectName: row.project_name ?? null,
				model: row.model ?? null,
				messageRole: row.message_role ?? null,
				createdAt: row.created_at ?? null,
				snippet: row.snippet ?? "",
				preview: row.content_preview ?? "",
				rank: rankOf(row, query.strategy),
			}));
		},

		async searchNarrators(query: EntitySearchQuery): Promise<NarratorSearchRow[]> {
			const gated = !query.viewer.isAdmin;
			const stmt = narratorStmt(query.strategy, gated, query.sort);
			const options = { signal: query.signal, operation: "searchNarrators" };
			const gate = gated ? gateParams(query.viewer.userId, NARRATOR_GATE_PARAMS) : [];
			const needle = query.strategy === "index" ? phraseExpr(query.text) : rawContains(query.text);
			const rows: RawRow[] = await stmt.all(options, needle, ...gate, query.limit);
			return rows.map((row) => ({
				id: row.id,
				title: row.title ?? null,
				chapterId: row.chapter_id ?? null,
				chapterTitle: row.chapter_title ?? null,
				projectName: row.project_name ?? null,
				status: row.status ?? null,
				model: row.model ?? null,
				lastMessageAt: row.last_message_at ?? null,
				createdAt: row.created_at ?? null,
				updatedAt: row.updated_at ?? null,
				snippet: row.snippet ?? "",
				rank: rankOf(row, query.strategy),
			}));
		},

		async searchTimeline(query: TimelineSearchQuery): Promise<TimelineSearchRow[]> {
			const options = { signal: query.signal, operation: "searchTimeline" };
			const needle = query.strategy === "index" ? prefixExpr(query.text) : rawContains(query.text);
			let rows: RawRow[];
			if (query.inheritedScopes.length === 0) {
				rows = await timelineOwnStmt(query.strategy).all(
					options,
					query.narratorId,
					needle,
					query.limit,
				);
			} else {
				// Ancestry shape varies per narrator, so this statement cannot be cached.
				const scopeSql = timelineScopeSql(query.narratorId, query.inheritedScopes);
				const sql =
					query.strategy === "index" ? timelineIndexSql(scopeSql) : timelineSubstringSql(scopeSql);
				rows = await execute(sql, [needle, query.limit], options);
			}
			return rows.map((row) => ({
				messageId: row.id,
				seq: typeof row.seq === "number" ? row.seq : Number(row.seq) || 0,
				role: row.message_role ?? "",
				snippet: row.snippet ?? "",
				preview: row.content_preview ?? "",
				createdAt: row.created_at,
			}));
		},

		async searchRecallMessages(query: RecallSearchQuery): Promise<RecallMessageRow[]> {
			const global = query.narratorId === null;
			const options = { signal: query.signal, operation: "searchRecallMessages" };
			const stmt = recallStmt(
				query.strategy,
				global,
				recallTimeKey(query),
				recallTimeSuffix(query),
			);
			const timeParams = recallTimeParams(query);
			const scope = global ? [] : [query.narratorId as string];
			const rows: RawRow[] =
				query.strategy === "index"
					? await stmt.all(options, prefixExpr(query.text), ...scope, ...timeParams, query.limit)
					: await stmt.all(
							options,
							query.previewChars,
							rawContains(query.text),
							...scope,
							...timeParams,
							query.limit,
						);
			return rows.map((row) => ({
				messageId: row.id,
				narratorId: row.narrator_id,
				narratorTitle: row.narrator_title ?? null,
				chapterId: row.chapter_id ?? null,
				role: row.role,
				createdAt: row.created_at,
				snippet: row.snippet ?? "",
			}));
		},

		async searchKnowledgeEntries(query: KnowledgeSearchQuery): Promise<KnowledgeSearchRow[]> {
			const options = { signal: query.signal, operation: "searchKnowledgeEntries" };
			const project = projectClause(query.projectId);
			const exclude = excludeClause(query.excludeEntryIds);
			const field = knowledgeField(query.field);
			const order = query.sort === "time" ? "e.updated_at DESC, e.id ASC" : "rank";

			if (query.strategy === "index") {
				const params: (string | number | null)[] = [
					prefixExpr(query.indexText, query.match, field),
					query.collectionId ?? null,
					query.collectionId ?? null,
				];
				if (query.projectId) params.push(query.projectId);
				params.push(...exclude.params, query.limit);
				const rows = (await execute(
					`SELECT ${KNOWLEDGE_ENTRY_COLUMNS},
				  ${snippetCall("knowledge_entries_fts", 1, KNOWLEDGE_SNIPPET)} as snippet
				 FROM knowledge_entries_fts
				 JOIN knowledge_entries e ON e.rowid = knowledge_entries_fts.rowid
				 WHERE knowledge_entries_fts MATCH ?
				   AND (? IS NULL OR e.collection_id = ?)
				   ${project}
				   ${exclude.clause}
				 ORDER BY ${order} LIMIT ?`,
					params,
					options,
				)) as unknown as KnowledgeRawRow[];
				return rows.map((row) => toKnowledgeRow(row, false));
			}

			// Short-query fallback (e.g. a 2-character CJK term the trigram index cannot
			// tokenize). When the match is field-restricted, only that column is compared so body
			// text never triggers a hit.
			const pattern = escapedContains(query.substringText);
			const matchExpr = field
				? `e.${field} LIKE ? ESCAPE '\\'`
				: `e.title LIKE ? ESCAPE '\\' OR e.current_content LIKE ? ESCAPE '\\'`;
			const params: (string | number | null)[] = [query.substringText];
			if (field) params.push(pattern);
			else params.push(pattern, pattern);
			params.push(query.collectionId ?? null, query.collectionId ?? null);
			if (query.projectId) params.push(query.projectId);
			params.push(...exclude.params, query.limit);
			const rows = (await execute(
				`SELECT ${KNOWLEDGE_ENTRY_COLUMNS},
			  substr(COALESCE(e.current_content, e.title), 1, ${PREVIEW_CHARS}) as snippet
			 FROM knowledge_entries e
			 WHERE (? = '' OR ${matchExpr})
			   AND (? IS NULL OR e.collection_id = ?)
			   ${project}
			   ${exclude.clause}
			 ORDER BY e.updated_at DESC${query.sort === "time" ? ", e.id ASC" : ""} LIMIT ?`,
				params,
				options,
			)) as unknown as KnowledgeRawRow[];
			return rows.map((row) => toKnowledgeRow(row, false));
		},

		async searchKnowledgeDrafts(query: KnowledgeDraftSearchQuery): Promise<KnowledgeSearchRow[]> {
			const options = { signal: query.signal, operation: "searchKnowledgeDrafts" };
			const project = projectClause(query.projectId);
			// The drafts index has no keyword column, so a field restriction has no meaning here;
			// callers route those searches to the committed path instead.
			const drift = `(d.base_revision_id IS NOT NULL AND d.base_revision_id != e.current_revision_id) as drifted`;
			const columns =
				query.sort === "time"
					? KNOWLEDGE_ENTRY_COLUMNS.replace("e.updated_at", "d.updated_at")
					: KNOWLEDGE_ENTRY_COLUMNS;
			const order = query.sort === "time" ? "d.updated_at DESC, e.id ASC" : "rank";

			if (query.strategy === "index") {
				const params: (string | number | null)[] = [
					prefixExpr(query.indexText, query.match),
					query.authorUserId,
					query.draftStatus,
					query.collectionId ?? null,
					query.collectionId ?? null,
				];
				if (query.projectId) params.push(query.projectId);
				params.push(query.limit);
				const rows = (await execute(
					`SELECT ${columns},
				  ${drift},
				  ${snippetCall("knowledge_drafts_fts", 1, KNOWLEDGE_SNIPPET)} as snippet
				 FROM knowledge_drafts_fts
				 JOIN knowledge_drafts d ON d.rowid = knowledge_drafts_fts.rowid
				 JOIN knowledge_entries e ON e.id = d.entry_id
				 WHERE knowledge_drafts_fts MATCH ?
				   AND d.author_user_id = ?
				   AND d.status = ?
				   AND (? IS NULL OR e.collection_id = ?)
				   ${project}
				 ORDER BY ${order} LIMIT ?`,
					params,
					options,
				)) as unknown as KnowledgeRawRow[];
				return rows.map((row) => toKnowledgeRow(row, true));
			}

			const pattern = escapedContains(query.substringText);
			const params: (string | number | null)[] = [
				query.substringText,
				pattern,
				pattern,
				query.authorUserId,
				query.draftStatus,
				query.collectionId ?? null,
				query.collectionId ?? null,
			];
			if (query.projectId) params.push(query.projectId);
			params.push(query.limit);
			const rows = (await execute(
				`SELECT ${columns},
			  ${drift},
			  substr(COALESCE(d.content, e.title), 1, ${PREVIEW_CHARS}) as snippet
			 FROM knowledge_drafts d
			 JOIN knowledge_entries e ON e.id = d.entry_id
			 WHERE (? = '' OR e.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')
			   AND d.author_user_id = ?
			   AND d.status = ?
			   AND (? IS NULL OR e.collection_id = ?)
			   ${project}
			 ORDER BY d.updated_at DESC${query.sort === "time" ? ", e.id ASC" : ""} LIMIT ?`,
				params,
				options,
			)) as unknown as KnowledgeRawRow[];
			return rows.map((row) => toKnowledgeRow(row, true));
		},

		async listShadowedEntryIds(query: ShadowedEntryQuery): Promise<string[]> {
			const rows = await cached("knowledge:shadowed", () => {
				return `SELECT DISTINCT entry_id FROM knowledge_drafts
			 WHERE author_user_id = ? AND status = ? AND entry_id IS NOT NULL
			 LIMIT ?`;
			}).all(
				{ signal: query.signal, operation: "listShadowedEntryIds" },
				query.authorUserId,
				query.draftStatus,
				query.limit,
			);
			return rows.map((row) => row.entry_id);
		},
	};
}

export const sqliteSearchStore = createSqliteSearchStore(executeSqliteSearchQuery);
