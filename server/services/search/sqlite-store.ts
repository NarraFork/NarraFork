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
 *   - global search matches each term as a prefix (`"a"* "b"*`), like the timeline, Recall
 *     and knowledge paths; unlike them, a term too short for the trigram index becomes a
 *     `LIKE` filter on the indexed rows instead of a MATCH term that could never match.
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

import { isEnvelopeIndexRetired } from "../../db/fts";
import { ValidationError } from "../../lib/errors";
import { narratorReadableSqlFragment } from "../narrator-acl";
import { narratorProjectIdText } from "../read/acl-sql";
import type { SearchStore } from "./port";
import { globalQueryTerms } from "./query";
import {
	type BoundSql,
	blockScopeSql,
	filterSql,
	messageScopeSql,
	narratorScopeSql,
	scopeKey,
} from "./scope";
import { escapedContains, prefixExpr, rawContains, snippetCall } from "./sqlite-expressions";
import { executeSqliteSearchQuery, type SearchQueryExecutor } from "./sqlite-worker-runner";
import {
	type EntitySearchQuery,
	GLOBAL_SNIPPET,
	groupSessionAggregates,
	KNOWLEDGE_SNIPPET,
	type KnowledgeDraftSearchQuery,
	type KnowledgeSearchQuery,
	type KnowledgeSearchRow,
	latestHitCount,
	type MessageSearchRow,
	type MessageSearchScope,
	type NarratorSearchRow,
	orderSessionAggregates,
	PREVIEW_CHARS,
	RECALL_SNIPPET,
	type RecallMessageRow,
	type RecallSearchQuery,
	type SessionAggregateQuery,
	type SessionAggregateRow,
	type SessionHitDetailsQuery,
	type SessionHitsQuery,
	type ShadowedEntryQuery,
	TIMELINE_SNIPPET,
	type TimelineSearchQuery,
	type TimelineSearchRow,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Access gates, derived from the shared ACL fragments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Visibility clause for a narrators row aliased `n`.
 *
 * Derived from the shared ACL fragments rather than written here. A local copy drifted once
 * already: it still queried the deprecated `narrator_grants` table after the ACL layer moved
 * to `acl_grants`, which silently hid shared sessions from search. Deriving means the rules —
 * including the project gate inside it — can only change in one place.
 *
 * Placeholder counts are derived from the rendered text for the same reason: a hard-coded
 * number silently shifts every later parameter when a fragment changes, and a shifted LIMIT
 * reads as a ranking quirk rather than as a bug.
 */
const NARRATOR_GATE_SQL = narratorReadableSqlFragment(false, "n")?.sql ?? "1 = 1";
const NARRATOR_GATE_PARAMS = (NARRATOR_GATE_SQL.match(/\?/g) ?? []).length;

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

/**
 * Merge block hits into envelope hits (docs/BLOCK_STORAGE-DESIGN.md §4.6). Until the envelope
 * index retires (P3) both are live: an envelope hit keeps its excerpt and rank and gains the
 * id of its first block hit; a message only its blocks match (a tool's input or result) is
 * added. `blockHits` arrive in the order their first hit should win. With no block hits the
 * envelope hits come back unchanged.
 */
function mergeBlockHits<T extends { blockId?: string }>(
	hits: readonly T[],
	blockHits: readonly T[],
	key: (row: T) => string,
	order: (a: T, b: T) => number,
	limit: number,
): T[] {
	if (blockHits.length === 0) return [...hits];
	const merged = new Map(hits.map((row) => [key(row), row]));
	for (const hit of blockHits) {
		const existing = merged.get(key(hit));
		if (!existing) merged.set(key(hit), hit);
		else if (!existing.blockId) merged.set(key(hit), { ...existing, blockId: hit.blockId });
	}
	return [...merged.values()].sort(order).slice(0, limit);
}

/** Characters of context a substring-path session excerpt keeps before the match. */
const SUBSTRING_LEAD = 60;

/** How much of a block's stored text an excerpt searches; matches the block index's cap. */
/** Ceiling on the hits one details read returns: a page of sessions' worth. */
const MAX_HIT_DETAILS = 500;
const BLOCK_EXCERPT_SOURCE_CHARS = 64 * 1024;

/**
 * Readable text from an excerpt cut out of stored JSON (a tool's input or output): the
 * common escapes are undone and whitespace collapsed. A cut can split an escape; what is
 * left of it is harmless in a one-line excerpt.
 */
export function jsonExcerptText(excerpt: string): string {
	return excerpt
		.replace(/\\[nrt]/g, " ")
		.replace(/\\(["\\/])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** Binary string order, as SQLite compares TEXT. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every executor gets its own bounded set of fixed SQL templates. `blockOnly` says whether the
 * envelope index (`narrator_messages_fts`) has retired, so index queries read blocks alone
 * (docs/BLOCK_STORAGE-DESIGN.md §4.6, P3c); `ensureFts` decides that at startup.
 */
export function createSqliteSearchStore(
	execute: SearchQueryExecutor,
	mode: { blockOnly: () => boolean } = { blockOnly: isEnvelopeIndexRetired },
): SearchStore {
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

	/**
	 * The project a hit's narrator resolves to, by the one shared rule (`narratorProjectIdText`).
	 * The join only supplies the name shown on a hit; it gates nothing (the narrator gate already
	 * covers the project), so a narrator without a project, or whose project row is gone, is
	 * still a hit.
	 */
	const PROJECT_JOIN = `LEFT JOIN projects p ON p.id = ${narratorProjectIdText("n")}`;

	const MESSAGE_COLUMNS = `m.id, m.narrator_id, substr(m.content_text, 1, ${PREVIEW_CHARS}) as content_preview,
			  m.role as message_role, m.created_at,
			  n.title as narrator_title, n.model, p.name as project_name`;

	const NARRATOR_COLUMNS = `n.id, n.title, n.type, n.subagent_type, n.status, n.model,
			  n.message_count, n.last_message_at, n.created_at, n.updated_at,
			  p.id as project_id, p.name as project_name`;

	const KNOWLEDGE_ENTRY_COLUMNS = `e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at`;

	/**
	 * What a global query binds: a `MATCH` expression of its indexed terms (each a prefix, all
	 * required) and one contains-pattern per term the index cannot check. On the substring
	 * path every term is a pattern. See `globalQueryTerms`.
	 */
	function globalNeedles(query: Pick<EntitySearchQuery, "text" | "strategy">): {
		match: string | null;
		likes: string[];
	} {
		const { indexed, short } = globalQueryTerms(query.text);
		if (query.strategy === "index" && indexed.length > 0) {
			return { match: prefixExpr(indexed.join(" ")), likes: short.map(rawContains) };
		}
		return { match: null, likes: [...indexed, ...short].map(rawContains) };
	}

	/** `AND col LIKE ?` once per pattern; the count is bounded by `MAX_GLOBAL_QUERY_TERMS`. */
	function likeSql(column: string, count: number): string {
		return Array.from({ length: count }, () => `AND ${column} LIKE ?`).join(" ");
	}

	function messageStmt(
		strategy: "index" | "substring",
		gated: boolean,
		sort: EntitySearchQuery["sort"],
		scope: MessageSearchScope | undefined,
		filter: BoundSql,
		likes: number,
	): QueryTemplate {
		const key = `messages:${strategy}:${sort ?? "relevance"}:${gated ? "gated" : "all"}:${scopeKey(scope)}:${filter.key}:${likes}`;
		return cached(key, () => {
			const gate = `${gated ? `AND ${NARRATOR_GATE_SQL}` : ""} ${messageScopeSql(scope)} ${filter.sql}`;
			if (strategy === "index") {
				return `SELECT ${MESSAGE_COLUMNS},
			  ${snippetCall("narrator_messages_fts", 0, GLOBAL_SNIPPET)} as snippet,
			  rank as rank_score
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrators n ON n.id = m.narrator_id
			 ${PROJECT_JOIN}
			 WHERE narrator_messages_fts MATCH ? ${likeSql("m.content_text", likes)} ${gate}
			 ORDER BY ${sort === "time" ? "m.created_at DESC, m.id ASC" : "rank"} LIMIT ?`;
			}
			return `SELECT ${MESSAGE_COLUMNS},
			  substr(m.content_text, 1, ${PREVIEW_CHARS}) as snippet
			 FROM narrator_messages m
			 JOIN narrators n ON n.id = m.narrator_id
			 ${PROJECT_JOIN}
			 WHERE 1 = 1 ${likeSql("m.content_text", likes)} ${gate}
			 ${sort === "time" ? "ORDER BY m.created_at DESC, m.id ASC" : ""} LIMIT ?`;
		});
	}

	/**
	 * Block hits for message search (index path only). The block index is contentless, so these
	 * rows carry no excerpt; {@link mergeBlockHits} keeps the envelope's where it has one.
	 *
	 * Contentless also means a term too short for the index cannot be checked against a block,
	 * so callers skip block hits for queries that have such terms rather than return blocks
	 * that may not contain them.
	 */
	function messageBlockStmt(
		gated: boolean,
		sort: EntitySearchQuery["sort"],
		scope: MessageSearchScope | undefined,
		filter: BoundSql,
	): QueryTemplate {
		const key = `messages:blocks:${sort ?? "relevance"}:${gated ? "gated" : "all"}:${scopeKey(scope)}:${filter.key}`;
		return cached(key, () => {
			const gate = `${gated ? `AND ${NARRATOR_GATE_SQL}` : ""} ${blockScopeSql(scope)} ${filter.sql}`;
			return `SELECT ${MESSAGE_COLUMNS}, b.id as block_id,
			  rank as rank_score
			 FROM narrator_blocks_fts
			 JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
			 JOIN narrator_messages m ON m.id = b.message_id
			 JOIN narrators n ON n.id = m.narrator_id
			 ${PROJECT_JOIN}
			 WHERE narrator_blocks_fts MATCH ? ${gate}
			 ORDER BY ${sort === "time" ? "m.created_at DESC, m.id ASC, b.ordinal ASC" : "rank"} LIMIT ?`;
		});
	}

	function narratorStmt(
		strategy: "index" | "substring",
		gated: boolean,
		sort: EntitySearchQuery["sort"],
		scope: MessageSearchScope | undefined,
		filter: BoundSql,
		likes: number,
	): QueryTemplate {
		const key = `narrators:${strategy}:${sort ?? "relevance"}:${gated ? "gated" : "all"}:${scopeKey(scope)}:${filter.key}:${likes}`;
		return cached(key, () => {
			const gate = `${gated ? `AND ${NARRATOR_GATE_SQL}` : ""} ${narratorScopeSql(scope)} ${filter.sql}`;
			if (strategy === "index") {
				return `SELECT ${NARRATOR_COLUMNS},
			  ${snippetCall("narrators_fts", 0, GLOBAL_SNIPPET)} as snippet,
			  rank as rank_score
			 FROM narrators_fts
			 JOIN narrators n ON n.rowid = narrators_fts.rowid
			 ${PROJECT_JOIN}
			 WHERE narrators_fts MATCH ? ${likeSql("n.title", likes)} ${gate}
			 ORDER BY ${sort === "time" ? "COALESCE(n.updated_at, n.created_at, n.last_message_at) DESC, n.id ASC" : "rank"} LIMIT ?`;
			}
			// No snippet column at all on this path: the caller falls back to the title, which is
			// the only text this search matches against.
			return `SELECT ${NARRATOR_COLUMNS}
			 FROM narrators n
			 ${PROJECT_JOIN}
			 WHERE 1 = 1 ${likeSql("n.title", likes)} ${gate}
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

	/** Index-path timeline SQL for a given ref predicate; `likes` short terms filter its rows. */
	function timelineIndexSql(scopeSql: string, likes: number): string {
		return `SELECT ${TIMELINE_COLUMNS},
			  ${snippetCall("narrator_messages_fts", 0, TIMELINE_SNIPPET)} as snippet
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrator_message_refs r
			   ON r.message_id = m.id AND ${scopeSql} AND r.segment_compact_id IS NULL
			 WHERE narrator_messages_fts MATCH ? ${likeSql("m.content_text", likes)}
			 ORDER BY r.seq DESC
			 LIMIT ?`;
	}

	/**
	 * Substring-path timeline SQL: one contains-pattern per term, all required.
	 *
	 * Starts from the narrator's refs (indexed by narrator_id + seq) and filters the joined
	 * message text, ordered by seq DESC and capped by LIMIT, so it never scans the whole corpus.
	 */
	function timelineSubstringSql(scopeSql: string, likes: number): string {
		return `SELECT ${TIMELINE_COLUMNS},
			  substr(m.content_text, 1, ${PREVIEW_CHARS}) as snippet
			 FROM narrator_message_refs r
			 JOIN narrator_messages m ON m.id = r.message_id
			 WHERE ${scopeSql} AND r.segment_compact_id IS NULL
			   ${likeSql("m.content_text", likes)}
			 ORDER BY r.seq DESC
			 LIMIT ?`;
	}

	/** Block hits in a timeline: each message's first matching block, in timeline order. */
	function timelineBlockSql(scopeSql: string): string {
		return `SELECT ${TIMELINE_COLUMNS}, b.id as block_id
			 FROM narrator_blocks_fts
			 JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
			 JOIN narrator_messages m ON m.id = b.message_id
			 JOIN narrator_message_refs r
			   ON r.message_id = m.id AND ${scopeSql} AND r.segment_compact_id IS NULL
			 WHERE narrator_blocks_fts MATCH ?
			 ORDER BY r.seq DESC, b.ordinal ASC
			 LIMIT ?`;
	}

	/**
	 * The no-ancestry case binds the narrator id instead of interpolating it, so it caches.
	 * `likes` is bounded by `MAX_GLOBAL_QUERY_TERMS`, so the cache stays small.
	 */
	function timelineOwnStmt(
		strategy: "index" | "substring" | "blocks",
		likes: number,
	): QueryTemplate {
		return cached(`timeline:${strategy}:${likes}`, () =>
			strategy === "index"
				? timelineIndexSql("r.narrator_id = ? ", likes)
				: strategy === "blocks"
					? timelineBlockSql("r.narrator_id = ? ")
					: timelineSubstringSql("r.narrator_id = ? ", likes),
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

	/** How Recall reaches a message's narrator; see {@link recallStmt}. */
	function recallSource(global: boolean) {
		return {
			source: global
				? `JOIN narrators n ON n.id = m.narrator_id ${narratorScopeSql()}`
				: `JOIN narrator_message_refs r ON r.message_id = m.id
		 JOIN narrators n ON n.id = r.narrator_id ${narratorScopeSql()}`,
			narratorIdColumn: global ? "n.id AS narrator_id" : "r.narrator_id",
			scopeFilter: global ? "" : " AND r.narrator_id = ?",
		};
	}

	/**
	 * Recall's statement.
	 *
	 * Scoped mode joins `narrator_message_refs` and filters by the current narrator, so
	 * fork-shared messages stay visible to the narrator that inherited them. Global mode joins
	 * on the message's owning narrator, which deduplicates a fork-shared message to its origin.
	 * Terms match on their own as in global search: `likes` short-term filters follow the
	 * MATCH, or make up the whole match on the substring path.
	 */
	function recallStmt(
		strategy: "index" | "substring",
		global: boolean,
		timeKey: string,
		timeSuffix: string,
		likes: number,
	): QueryTemplate {
		const key = `recall:${strategy}:${global ? "global" : "scoped"}:${timeKey}:${likes}`;
		return cached(key, () => {
			const { source, narratorIdColumn, scopeFilter } = recallSource(global);
			if (strategy === "index") {
				return `SELECT m.id, ${narratorIdColumn}, m.role, m.created_at,
		        n.title AS narrator_title,
		        ${snippetCall("narrator_messages_fts", 0, RECALL_SNIPPET)} AS snippet
		 FROM narrator_messages_fts
		 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
		 ${source}
		 WHERE narrator_messages_fts MATCH ? ${likeSql("m.content_text", likes)}${scopeFilter}${timeSuffix}
		 ORDER BY rank
		 LIMIT ?`;
			}
			return `SELECT m.id, ${narratorIdColumn}, m.role, m.created_at,
		        n.title AS narrator_title,
		        substr(m.content_text, 1, ?) AS snippet
		 FROM narrator_messages m
		 ${source}
		 WHERE 1 = 1 ${likeSql("m.content_text", likes)}${scopeFilter}${timeSuffix}
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
		collection_id: string | null;
		personal_entry_id?: string | null;
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
			...(row.personal_entry_id ? { personalEntryId: row.personal_entry_id } : {}),
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
	// Session search: message hits rolled up per narrator
	// ─────────────────────────────────────────────────────────────────────────────

	/**
	 * `WITH …` defining `per_msg`: one row per matching message (id, narrator_id, created_at,
	 * r, block_id), gated, scoped and filtered, plus the values its placeholders bind in order.
	 *
	 * The index path reads both the envelope index and the block index; a message matched by
	 * both counts once, keeping its best rank and naming one matching block. `extra` narrows
	 * further (the narrator page of a hits query) and comes with its own values.
	 */
	function sessionHitsCte(
		query: EntitySearchQuery,
		blockOnly: boolean,
		extra: { sql: string; values: readonly string[] } = { sql: "", values: [] },
	): { sql: string; values: Array<string | number> } {
		const gated = !query.viewer.isAdmin;
		const gate = gated ? `AND ${NARRATOR_GATE_SQL}` : "";
		const gateValues = gated ? gateParams(query.viewer.userId, NARRATOR_GATE_PARAMS) : [];
		const filter = filterSql(query.filters, "message");
		const tail = [...gateValues, ...filter.values, ...extra.values];
		const { match, likes } = globalNeedles(query);
		const contains = likeSql("m.content_text", likes.length);
		if (match === null) {
			return {
				sql: `WITH per_msg AS (
				SELECT m.id, m.narrator_id, m.created_at, NULL AS r, NULL AS block_id
				 FROM narrator_messages m
				 JOIN narrators n ON n.id = m.narrator_id
				 WHERE 1 = 1 ${contains} ${gate} ${messageScopeSql(query.scope)} ${filter.sql} ${extra.sql}
			)`,
				values: [...likes, ...tail],
			};
		}
		if (blockOnly) {
			const where = (scope: string): Bound => ({
				sql: `${gate} ${scope} ${filter.sql} ${extra.sql}`,
				values: tail,
			});
			const hits = blockOnlyHits(query, {
				join: { sql: "JOIN narrators n ON n.id = m.narrator_id", values: [] },
				blockWhere: where(blockScopeSql(query.scope)),
				legacyWhere: where(messageScopeSql(query.scope)),
			});
			return {
				sql: `WITH hits AS (${hits.sql}), per_msg AS (
				SELECT hits.id, m.narrator_id, m.created_at, hits.r, hits.block_id
				 FROM hits JOIN narrator_messages m ON m.id = hits.id
			)`,
				values: hits.values,
			};
		}
		const envelope = `SELECT m.id, m.narrator_id, m.created_at, narrator_messages_fts.rank AS r, NULL AS block_id
				 FROM narrator_messages_fts
				 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
				 JOIN narrators n ON n.id = m.narrator_id
				 WHERE narrator_messages_fts MATCH ? ${contains} ${gate} ${messageScopeSql(query.scope)} ${filter.sql} ${extra.sql}`;
		// Blocks cannot be checked for terms the index cannot tokenize; see messageBlockStmt.
		const blocks =
			likes.length > 0
				? ""
				: `UNION ALL
				SELECT m.id, m.narrator_id, m.created_at, narrator_blocks_fts.rank AS r, b.id AS block_id
				 FROM narrator_blocks_fts
				 JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
				 JOIN narrator_messages m ON m.id = b.message_id
				 JOIN narrators n ON n.id = m.narrator_id
				 WHERE narrator_blocks_fts MATCH ? ${gate} ${blockScopeSql(query.scope)} ${filter.sql} ${extra.sql}`;
		return {
			sql: `WITH hits AS (
				${envelope}
				${blocks}
			), per_msg AS (
				SELECT id, narrator_id, MAX(created_at) AS created_at, MIN(r) AS r, MIN(block_id) AS block_id
				 FROM hits GROUP BY id, narrator_id
			)`,
			values: [match, ...likes, ...tail, ...(blocks ? [match, ...tail] : [])],
		};
	}

	/**
	 * An excerpt from a matching block, for hits whose message text does not contain the
	 * term (a tool's input or output, an injected context). The block index is contentless,
	 * so the text is read back from where it lives: the block's model text, the latest
	 * attempt's tool output, then the block payload (a tool's input). Each source is cut to
	 * {@link BLOCK_EXCERPT_SOURCE_CHARS} first, so a huge tool output costs a bounded scan.
	 * The first term is looked up as a plain substring, which every index match contains.
	 */
	function blockExcerptSql(query: Pick<EntitySearchQuery, "text">): {
		sql: string;
		values: string[];
	} {
		const { indexed, short } = globalQueryTerms(query.text);
		const term = [...indexed, ...short][0] ?? query.text;
		const cut = (expr: string) => `substr(${expr}, 1, ${BLOCK_EXCERPT_SOURCE_CHARS})`;
		return {
			sql: `(SELECT CASE WHEN pos > ${SUBSTRING_LEAD}
					 THEN '...' || substr(src, pos - ${SUBSTRING_LEAD}, ${PREVIEW_CHARS})
					 ELSE substr(src, 1, ${PREVIEW_CHARS}) END
				 FROM (
					SELECT src, instr(lower(src), lower(?)) AS pos, ord FROM (
						SELECT 1 AS ord, ${cut("bb.model_text")} AS src
						UNION ALL SELECT 2, ${cut(`(SELECT tc.output_json FROM narrator_tool_calls tc
							WHERE tc.block_id = bb.id ORDER BY tc.created_at DESC LIMIT 1)`)}
						UNION ALL SELECT 3, ${cut("bb.payload")}
					)
				 )
				 WHERE bb.id IS NOT NULL AND pos > 0
				 ORDER BY ord LIMIT 1)`,
			values: [term],
		};
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Block-only search (docs/BLOCK_STORAGE-DESIGN.md §4.6, P3c)
	// ─────────────────────────────────────────────────────────────────────────────

	/** SQL with the values its placeholders bind, in textual order. */
	type Bound = { sql: string; values: Array<string | number> };
	const NONE: Bound = { sql: "", values: [] };

	/**
	 * `SELECT id, r, block_id` for the messages an index query matches once only blocks are
	 * indexed, one row each:
	 *   - a message one of whose blocks holds every indexed term, with its best rank and the
	 *     block that has it;
	 *   - a legacy envelope (no blocks yet: imported, written with block writes off, or not
	 *     decodable) whose text contains every term; `idx_messages_legacy_body` holds the few
	 *     the backfill has not converted. It has no rank.
	 * Short terms filter the message text in both, as they did on the envelope index. `join`
	 * adds what the predicates read (aliases `m`, `n`, `r`); `blockWhere` applies to block hits
	 * (alias `b` too), `legacyWhere` to legacy ones.
	 */
	function blockOnlyHits(
		query: Pick<EntitySearchQuery, "text" | "strategy">,
		parts: { join: Bound; blockWhere: Bound; legacyWhere: Bound },
	): Bound {
		const { match, likes } = globalNeedles(query);
		const terms = globalQueryTerms(query.text).indexed.map(rawContains);
		return {
			sql: `SELECT id, MIN(r) AS r, block_id FROM (
				SELECT b.message_id AS id, narrator_blocks_fts.rank AS r, b.id AS block_id
				 FROM narrator_blocks_fts
				 JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
				 JOIN narrator_messages m ON m.id = b.message_id
				 ${parts.join.sql}
				 WHERE narrator_blocks_fts MATCH ? ${likeSql("m.content_text", likes.length)} ${parts.blockWhere.sql}
				UNION ALL
				SELECT m.id, NULL, NULL
				 FROM narrator_messages m
				 ${parts.join.sql}
				 WHERE m.body_format = 1 ${likeSql("m.content_text", terms.length + likes.length)} ${parts.legacyWhere.sql}
			) GROUP BY id`,
			values: [
				...parts.join.values,
				match ?? "",
				...likes,
				...parts.blockWhere.values,
				...parts.join.values,
				...terms,
				...likes,
				...parts.legacyWhere.values,
			],
		};
	}

	/**
	 * An excerpt of `m.content_text` around the first term's first occurrence, or NULL when
	 * the text does not hold it (the hit is a block's: a tool's input or output, a context).
	 * `mark` brackets the occurrence, as Recall's FTS5 snippet did.
	 */
	function textWindowSql(
		query: Pick<EntitySearchQuery, "text">,
		length: number,
		mark?: { open: string; close: string },
	): Bound {
		const chars = Math.max(1, Math.trunc(length) || PREVIEW_CHARS);
		const { indexed, short } = globalQueryTerms(query.text);
		const term = [...indexed, ...short][0] ?? query.text;
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		const lead = `CASE WHEN pos > ${SUBSTRING_LEAD} THEN '...' ELSE '' END`;
		const start = `max(1, pos - ${SUBSTRING_LEAD})`;
		const body = mark
			? `${lead} || substr(t, ${start}, pos - ${start}) || ${quote(mark.open)}
				 || substr(t, pos, len) || ${quote(mark.close)} || substr(t, pos + len, ${chars})`
			: `${lead} || substr(t, ${start}, ${chars})`;
		return {
			sql: `(SELECT CASE WHEN pos = 0 THEN NULL ELSE ${body} END
				 FROM (SELECT m.content_text AS t, instr(lower(m.content_text), lower(?)) AS pos,
					length(?) AS len))`,
			values: [term, term],
		};
	}

	function toSessionAggregate(row: RawRow, strategy: "index" | "substring"): SessionAggregateRow {
		return {
			narratorId: row.narrator_id,
			bestRank: rankOf({ rank_score: row.best_rank }, strategy),
			hitCount: Number(row.hit_count) || 0,
			lastHitAt: row.last_hit_at ?? null,
			title: row.title ?? null,
			type: row.type ?? null,
			subagentType: row.subagent_type ?? null,
			status: row.status ?? null,
			projectId: row.project_id ?? null,
			projectName: row.project_name ?? null,
			lastMessageAt: row.last_message_at ?? null,
			createdAt: row.created_at ?? null,
			updatedAt: row.updated_at ?? null,
			latestHits: [],
		};
	}

	/** A session hit row: the message text's own excerpt when its text matched, otherwise
	 *  the matching block's, which is the only place a tool-only hit's term appears. */
	function toHitRow(row: RawRow, rank: number | null): MessageSearchRow {
		return {
			id: row.id,
			narratorId: row.narrator_id ?? null,
			narratorTitle: row.narrator_title ?? null,
			projectName: row.project_name ?? null,
			model: row.model ?? null,
			messageRole: row.message_role ?? null,
			createdAt: row.created_at ?? null,
			snippet: row.snippet || (row.block_snippet ? jsonExcerptText(row.block_snippet) : ""),
			preview: row.content_preview ?? "",
			rank,
			...(row.block_id ? { blockId: row.block_id } : {}),
			...(row.block_kind === "tool" && row.tool_use_id
				? { toolUseId: row.tool_use_id, toolName: row.block_subtype ?? undefined }
				: {}),
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

		async searchMessages(query: EntitySearchQuery): Promise<MessageSearchRow[]> {
			const gated = !query.viewer.isAdmin;
			const filter = filterSql(query.filters, "message");
			const { match, likes } = globalNeedles(query);
			const strategy = match === null ? "substring" : "index";
			const stmt = messageStmt(strategy, gated, query.sort, query.scope, filter, likes.length);
			const options = { signal: query.signal, operation: "searchMessages" };
			const gate = [
				...(gated ? gateParams(query.viewer.userId, NARRATOR_GATE_PARAMS) : []),
				...filter.values,
			];
			const toRow = (row: RawRow): MessageSearchRow => ({
				id: row.id,
				narratorId: row.narrator_id ?? null,
				narratorTitle: row.narrator_title ?? null,
				projectName: row.project_name ?? null,
				model: row.model ?? null,
				messageRole: row.message_role ?? null,
				createdAt: row.created_at ?? null,
				snippet: row.snippet || (row.block_snippet ? jsonExcerptText(row.block_snippet) : ""),
				preview: row.content_preview ?? "",
				rank: rankOf(row, query.strategy),
				...(row.block_id ? { blockId: row.block_id } : {}),
			});
			if (match !== null && mode.blockOnly()) {
				const where = (scope: string): Bound => ({
					sql: `${gated ? `AND ${NARRATOR_GATE_SQL}` : ""} ${scope} ${filter.sql}`,
					values: gate,
				});
				const hits = blockOnlyHits(query, {
					join: { sql: "JOIN narrators n ON n.id = m.narrator_id", values: [] },
					blockWhere: where(blockScopeSql(query.scope)),
					legacyWhere: where(messageScopeSql(query.scope)),
				});
				const window = textWindowSql(query, PREVIEW_CHARS);
				const excerpt = blockExcerptSql(query);
				const order =
					query.sort === "time"
						? "m.created_at DESC, m.id ASC"
						: "hits.r IS NULL, hits.r ASC, m.created_at DESC, m.id ASC";
				const rows: RawRow[] = await execute(
					`WITH hits AS (${hits.sql})
					SELECT ${MESSAGE_COLUMNS}, hits.block_id, hits.r AS rank_score,
					  ${window.sql} AS snippet, ${excerpt.sql} AS block_snippet
					 FROM hits
					 JOIN narrator_messages m ON m.id = hits.id
					 JOIN narrators n ON n.id = m.narrator_id
					 ${PROJECT_JOIN}
					 LEFT JOIN narrator_blocks bb ON bb.id = hits.block_id
					 ORDER BY ${order} LIMIT ?`,
					[...hits.values, ...window.values, ...excerpt.values, query.limit],
					options,
				);
				return rows.map(toRow);
			}
			const needles = match === null ? likes : [match, ...likes];
			const rows: RawRow[] = await stmt.all(options, ...needles, ...gate, query.limit);
			// Blocks cannot be checked for terms the index cannot tokenize; see messageBlockStmt.
			if (match === null || likes.length > 0) return rows.map(toRow);
			const blockRows: RawRow[] = await messageBlockStmt(
				gated,
				query.sort,
				query.scope,
				filter,
			).all(options, match, ...gate, query.limit);
			return mergeBlockHits(
				rows.map(toRow),
				blockRows.map(toRow),
				(row) => row.id,
				query.sort === "time"
					? (a, b) => compareText(b.createdAt ?? "", a.createdAt ?? "") || compareText(a.id, b.id)
					: (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
				query.limit,
			);
		},

		async searchNarrators(query: EntitySearchQuery): Promise<NarratorSearchRow[]> {
			const gated = !query.viewer.isAdmin;
			const filter = filterSql(query.filters, "narrator");
			const { match, likes } = globalNeedles(query);
			const strategy = match === null ? "substring" : "index";
			const stmt = narratorStmt(strategy, gated, query.sort, query.scope, filter, likes.length);
			const options = { signal: query.signal, operation: "searchNarrators" };
			const gate = [
				...(gated ? gateParams(query.viewer.userId, NARRATOR_GATE_PARAMS) : []),
				...filter.values,
			];
			const needles = match === null ? likes : [match, ...likes];
			const rows: RawRow[] = await stmt.all(options, ...needles, ...gate, query.limit);
			return rows.map((row) => ({
				id: row.id,
				title: row.title ?? null,
				type: row.type ?? null,
				subagentType: row.subagent_type ?? null,
				projectId: row.project_id ?? null,
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

		async searchSessionAggregates(query: SessionAggregateQuery): Promise<SessionAggregateRow[]> {
			const blockOnly = globalNeedles(query).match !== null && mode.blockOnly();
			const cte = sessionHitsCte(query, blockOnly);
			const latest = latestHitCount(query);
			// One pass: every hit is counted per narrator, and the newest few are kept by id.
			// Ordering and the narrator cap run in JS (orderSessionAggregates), on one row per
			// narrator per kept hit.
			const rows: RawRow[] = await execute(
				`${cte.sql}, ranked AS (
				SELECT id, narrator_id, created_at, block_id,
					  ROW_NUMBER() OVER newest AS rn,
					  COUNT(*) OVER whole AS hit_count,
					  MIN(r) OVER whole AS best_rank,
					  MAX(created_at) OVER whole AS last_hit_at
				 FROM per_msg
				 WINDOW whole AS (PARTITION BY narrator_id),
					newest AS (PARTITION BY narrator_id ORDER BY created_at DESC, id ASC)
			)
			SELECT ranked.narrator_id, ranked.best_rank, ranked.hit_count, ranked.last_hit_at,
				  ranked.rn, ranked.id AS hit_id, ranked.block_id AS hit_block_id,
				  ranked.created_at AS hit_created_at,
				  n.title, n.type, n.subagent_type, n.status, n.last_message_at,
				  n.created_at, n.updated_at, p.id AS project_id, p.name AS project_name
			 FROM ranked
			 JOIN narrators n ON n.id = ranked.narrator_id
			 ${PROJECT_JOIN}
			 WHERE ranked.rn <= ?
			 ORDER BY ranked.narrator_id ASC, ranked.rn ASC`,
				[...cte.values, Math.max(1, latest)],
				{ signal: query.signal, operation: "searchSessionAggregates" },
			);
			return orderSessionAggregates(
				groupSessionAggregates(rows, latest, (row) => toSessionAggregate(row, query.strategy)),
				query.sort,
				query.limit,
			);
		},

		async searchSessionHitDetails(query: SessionHitDetailsQuery): Promise<MessageSearchRow[]> {
			const refs = query.refs.slice(0, MAX_HIT_DETAILS);
			if (refs.length === 0) return [];
			// Reads by primary key only; the ids come from a gated search the caller already ran.
			const snippet = textWindowSql(query, PREVIEW_CHARS);
			const blockExcerpt = blockExcerptSql(query);
			const rows: RawRow[] = await execute(
				`WITH refs(id, block_id, ord) AS (VALUES ${refs.map(() => "(?, ?, ?)").join(", ")})
			SELECT ${MESSAGE_COLUMNS}, refs.block_id,
				  ${snippet.sql} AS snippet,
				  bb.kind AS block_kind, bb.wire_id AS tool_use_id, bb.subtype AS block_subtype,
				  ${blockExcerpt.sql} AS block_snippet
			 FROM refs
			 JOIN narrator_messages m ON m.id = refs.id
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN narrator_blocks bb ON bb.id = refs.block_id
			 ${PROJECT_JOIN}
			 ORDER BY refs.ord`,
				[
					...refs.flatMap((ref, ord) => [ref.id, ref.blockId, ord]),
					...snippet.values,
					...blockExcerpt.values,
				],
				{ signal: query.signal, operation: "searchSessionHitDetails" },
			);
			return rows.map((row) => toHitRow(row, null));
		},

		async searchSessionHits(query: SessionHitsQuery): Promise<MessageSearchRow[]> {
			const ids = query.narratorIds.filter((id) => NARRATOR_ID_PATTERN.test(id));
			if (ids.length === 0) return [];
			// The id list varies per page, so this statement is not cached; ids are bound.
			const blockOnly = globalNeedles(query).match !== null && mode.blockOnly();
			const cte = sessionHitsCte(query, blockOnly, {
				sql: `AND m.narrator_id IN (${ids.map(() => "?").join(", ")})`,
				values: ids,
			});
			const order =
				query.sort === "time"
					? "created_at DESC, id ASC"
					: "r IS NULL, r ASC, created_at DESC, id ASC";
			const snippet = textWindowSql(query, PREVIEW_CHARS);
			const blockExcerpt = blockExcerptSql(query);
			const offset = Math.max(0, Math.trunc(query.offset ?? 0));
			const rows: RawRow[] = await execute(
				`${cte.sql}, ranked AS (
				SELECT per_msg.*, ROW_NUMBER() OVER (PARTITION BY narrator_id ORDER BY ${order}) AS rn
				 FROM per_msg
			)
			SELECT ${MESSAGE_COLUMNS}, ranked.block_id, ranked.r AS rank_score,
				  ${snippet.sql} AS snippet,
				  bb.kind AS block_kind, bb.wire_id AS tool_use_id, bb.subtype AS block_subtype,
				  ${blockExcerpt.sql} AS block_snippet
			 FROM ranked
			 JOIN narrator_messages m ON m.id = ranked.id
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN narrator_blocks bb ON bb.id = ranked.block_id
			 ${PROJECT_JOIN}
			 WHERE ranked.rn > ? AND ranked.rn <= ?
			 ORDER BY ranked.narrator_id ASC, ranked.rn ASC`,
				[
					...cte.values,
					...snippet.values,
					...blockExcerpt.values,
					offset,
					offset + query.perSession,
				],
				{ signal: query.signal, operation: "searchSessionHits" },
			);
			return rows.map((row) => toHitRow(row, rankOf(row, query.strategy)));
		},

		async searchTimeline(query: TimelineSearchQuery): Promise<TimelineSearchRow[]> {
			const options = { signal: query.signal, operation: "searchTimeline" };
			// Gate the requested timeline, not the owner of its fork-shared messages.
			const target = await execute(
				`SELECT n.id FROM narrators n WHERE n.id = ? ${narratorScopeSql()}`,
				[query.narratorId],
				options,
			);
			if (target.length === 0) return [];
			// The same term rules as global search: a term too short for the trigram index
			// would silently match nothing in MATCH, so it filters the indexed rows instead.
			const { match, likes } = globalNeedles(query);
			const mainStrategy = match === null ? "substring" : "index";
			const run = (strategy: "index" | "substring" | "blocks"): Promise<RawRow[]> => {
				const needles =
					strategy === "blocks" ? [match] : match === null ? likes : [match, ...likes];
				const likeCount = strategy === "blocks" ? 0 : likes.length;
				if (query.inheritedScopes.length === 0)
					return timelineOwnStmt(strategy, likeCount).all(
						options,
						query.narratorId,
						...needles,
						query.limit,
					);
				// Ancestry shape varies per narrator, so this statement cannot be cached.
				const scopeSql = timelineScopeSql(query.narratorId, query.inheritedScopes);
				const sql =
					strategy === "index"
						? timelineIndexSql(scopeSql, likeCount)
						: strategy === "blocks"
							? timelineBlockSql(scopeSql)
							: timelineSubstringSql(scopeSql, likeCount);
				return execute(sql, [...needles, query.limit], options);
			};
			const toRow = (row: RawRow): TimelineSearchRow => ({
				messageId: row.id,
				seq: typeof row.seq === "number" ? row.seq : Number(row.seq) || 0,
				role: row.message_role ?? "",
				snippet: row.snippet || (row.block_snippet ? jsonExcerptText(row.block_snippet) : ""),
				preview: row.content_preview ?? "",
				createdAt: row.created_at,
				...(row.block_id ? { blockId: row.block_id } : {}),
			});
			if (match !== null && mode.blockOnly()) {
				const scope: Bound =
					query.inheritedScopes.length === 0
						? { sql: "r.narrator_id = ?", values: [query.narratorId] }
						: { sql: timelineScopeSql(query.narratorId, query.inheritedScopes), values: [] };
				const refs: Bound = {
					sql: `JOIN narrator_message_refs r
					   ON r.message_id = m.id AND ${scope.sql} AND r.segment_compact_id IS NULL`,
					values: scope.values,
				};
				const hits = blockOnlyHits(query, { join: refs, blockWhere: NONE, legacyWhere: NONE });
				const window = textWindowSql(query, PREVIEW_CHARS);
				const excerpt = blockExcerptSql(query);
				const rows: RawRow[] = await execute(
					`WITH hits AS (${hits.sql})
					SELECT ${TIMELINE_COLUMNS}, hits.block_id,
					  ${window.sql} AS snippet, ${excerpt.sql} AS block_snippet
					 FROM hits
					 JOIN narrator_messages m ON m.id = hits.id
					 ${refs.sql}
					 LEFT JOIN narrator_blocks bb ON bb.id = hits.block_id
					 ORDER BY r.seq DESC LIMIT ?`,
					[...hits.values, ...window.values, ...excerpt.values, ...refs.values, query.limit],
					options,
				);
				return rows.map(toRow);
			}
			const rows = (await run(mainStrategy)).map(toRow);
			// Blocks cannot be checked for terms the index cannot tokenize; see messageBlockStmt.
			if (match === null || likes.length > 0) return rows;
			return mergeBlockHits(
				rows,
				(await run("blocks")).map(toRow),
				(row) => `${row.messageId}:${row.seq}`,
				(a, b) => b.seq - a.seq,
				query.limit,
			);
		},

		async searchRecallMessages(query: RecallSearchQuery): Promise<RecallMessageRow[]> {
			const global = query.narratorId === null;
			const options = { signal: query.signal, operation: "searchRecallMessages" };
			const { match, likes } = globalNeedles(query);
			const stmt = recallStmt(
				match === null ? "substring" : "index",
				global,
				recallTimeKey(query),
				recallTimeSuffix(query),
				likes.length,
			);
			const timeParams = recallTimeParams(query);
			const scope = global ? [] : [query.narratorId as string];
			const toRow = (row: RawRow): RecallMessageRow => ({
				messageId: row.id,
				narratorId: row.narrator_id,
				narratorTitle: row.narrator_title ?? null,
				role: row.role,
				createdAt: row.created_at,
				snippet: row.snippet || (row.block_snippet ? jsonExcerptText(row.block_snippet) : ""),
			});
			if (match !== null && mode.blockOnly()) {
				const { source, narratorIdColumn, scopeFilter } = recallSource(global);
				const where: Bound = {
					sql: `${scopeFilter}${recallTimeSuffix(query)}`,
					values: [...scope, ...timeParams],
				};
				const hits = blockOnlyHits(query, {
					join: { sql: source, values: [] },
					blockWhere: where,
					legacyWhere: where,
				});
				const window = textWindowSql(query, query.previewChars, RECALL_SNIPPET);
				const excerpt = blockExcerptSql(query);
				const rows: RawRow[] = await execute(
					`WITH hits AS (${hits.sql})
					SELECT m.id, ${narratorIdColumn}, m.role, m.created_at, n.title AS narrator_title,
					  ${window.sql} AS snippet, ${excerpt.sql} AS block_snippet
					 FROM hits
					 JOIN narrator_messages m ON m.id = hits.id
					 ${source}
					 LEFT JOIN narrator_blocks bb ON bb.id = hits.block_id
					 WHERE 1 = 1 ${scopeFilter}
					 ORDER BY hits.r IS NULL, hits.r ASC, m.created_at DESC LIMIT ?`,
					[...hits.values, ...window.values, ...excerpt.values, ...scope, query.limit],
					options,
				);
				return rows.map(toRow);
			}
			const rows: RawRow[] =
				match === null
					? await stmt.all(
							options,
							query.previewChars,
							...likes,
							...scope,
							...timeParams,
							query.limit,
						)
					: await stmt.all(options, match, ...likes, ...scope, ...timeParams, query.limit);
			return rows.map(toRow);
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
			const collection = query.includeStandalone
				? "COALESCE(e.collection_id, d.target_collection_id)"
				: "e.collection_id";
			const title = query.includeStandalone ? "COALESCE(e.title, d.title, '')" : "e.title";
			const join = query.includeStandalone ? "LEFT JOIN" : "JOIN";
			const project = query.projectId
				? `AND (${query.includeStandalone ? "(d.entry_id IS NULL AND d.target_collection_id IS NULL) OR " : ""}${collection} IN (
					SELECT id FROM knowledge_collections WHERE project_id = ? OR project_id IS NULL
				))`
				: "";
			// The drafts index has no keyword column, so a field restriction has no meaning here;
			// callers route those searches to the committed path instead.
			const drift = `(d.base_revision_id IS NOT NULL AND d.base_revision_id != e.current_revision_id) as drifted`;
			const columns = query.includeStandalone
				? `COALESCE(e.id, d.id) AS id, ${collection} AS collection_id,
					${title} AS title, COALESCE(e.slug, '') AS slug, e.tags_json,
					COALESCE(e.status, d.status) AS status, COALESCE(e.created_at, d.created_at) AS created_at,
					${query.sort === "time" ? "d.updated_at" : "COALESCE(e.updated_at, d.updated_at)"} AS updated_at,
					CASE WHEN d.entry_id IS NULL THEN d.id END AS personal_entry_id`
				: query.sort === "time"
					? KNOWLEDGE_ENTRY_COLUMNS.replace("e.updated_at", "d.updated_at")
					: KNOWLEDGE_ENTRY_COLUMNS;
			const idOrder = query.includeStandalone ? "COALESCE(e.id, d.id)" : "e.id";
			const order = query.sort === "time" ? `d.updated_at DESC, ${idOrder} ASC` : "rank";

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
				 ${join} knowledge_entries e ON e.id = d.entry_id
				 WHERE knowledge_drafts_fts MATCH ?
				   AND d.author_user_id = ?
				   AND d.status = ?
				   AND (? IS NULL OR ${collection} = ?)
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
			  substr(COALESCE(d.content, ${title}), 1, ${PREVIEW_CHARS}) as snippet
			 FROM knowledge_drafts d
			 ${join} knowledge_entries e ON e.id = d.entry_id
			 WHERE (? = '' OR ${title} LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')
			   AND d.author_user_id = ?
			   AND d.status = ?
			   AND (? IS NULL OR ${collection} = ?)
			   ${project}
			 ORDER BY d.updated_at DESC${query.sort === "time" ? `, ${idOrder} ASC` : ""} LIMIT ?`,
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
