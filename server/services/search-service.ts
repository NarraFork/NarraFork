import type { Statement } from "bun:sqlite";
import { db, sqlite } from "../db";
import { ValidationError } from "../lib/errors";
import { knowledgeService } from "./knowledge-service";
import { narratorReadableSqlFragment } from "./narrator-acl";
import { projectReadableSqlFragment } from "./project-acl";

interface SearchResult {
	type: "chapter" | "message" | "narrator" | "knowledge";
	id: string;
	title?: string;
	snippet: string;
	chapterId?: string;
	chapterTitle?: string;
	narratorId?: string;
	narratorTitle?: string;
	projectName?: string;
	status?: string;
	role?: string;
	model?: string;
	messageRole?: string;
	/** Knowledge hits: the collection the entry lives in. */
	collectionId?: string;
	collectionName?: string;
	tags?: string[];
	createdAt?: string;
	updatedAt?: string;
	lastMessageAt?: string | null;
	matchField?: string;
	matchScore: number;
}

interface SearchOptions {
	query: string;
	entities: string[];
	limit?: number;
	/**
	 * The searching user, so narrator and message hits are limited to what they may
	 * read. Required rather than optional: an omitted principal used to mean "see
	 * everything", and a caller that simply forgot would silently reopen the leak.
	 */
	principal: { userId: string; isAdmin: boolean };
}

export interface NarratorMessageSearchResult {
	messageId: string;
	seq: number;
	role: string;
	snippet: string;
	preview: string;
	createdAt: string;
}

/** Sanitize: remove FTS5 special chars to prevent injection */
export function sanitizeQuery(query: string): string {
	return query.replace(/['"*(){}[\]^~@:;!&|,<>\\]/g, "").trim();
}

/** Build an FTS5 prefix query from sanitized input */
export function buildFtsQuery(safeQuery: string): string {
	return safeQuery
		.split(/\s+/)
		.map((w) => `"${w}"*`)
		.join(" ");
}

// --- Cached prepared statements (lazy-initialized) ---
// Avoids creating a new Statement object on every search call.

let _chaptersFts: Statement | null = null;
let _chaptersLike: Statement | null = null;
let _chaptersFtsAcl: Statement | null = null;
let _chaptersLikeAcl: Statement | null = null;
let _messagesFts: Statement | null = null;
let _messagesLike: Statement | null = null;
let _narratorsFts: Statement | null = null;
let _narratorsLike: Statement | null = null;
let _narratorScopedFts: Statement | null = null;
let _narratorScopedLike: Statement | null = null;
// Non-admin variants of the two narrator-derived searches. Kept as separate cached
// statements rather than one string built per request, because these are prepared
// once for the process lifetime: the SQL text must not vary by user. The user id
// travels as a bound parameter.
let _messagesFtsAcl: Statement | null = null;
let _messagesLikeAcl: Statement | null = null;
let _narratorsFtsAcl: Statement | null = null;
let _narratorsLikeAcl: Statement | null = null;

/**
 * Visibility clause for a narrators row aliased as `n`, matching
 * `narratorReadableWhere` in narrator-acl.ts. Two `?` placeholders, both the
 * requesting user id.
 *
 * Search is the one place a leak is hardest to notice: a hit exposes a private
 * narrator's title and a snippet of its transcript without ever opening it.
 */
/**
 * Built from the shared ACL fragment rather than hand-written here.
 *
 * A local copy drifted once already: it still queried the deprecated
 * `narrator_grants` table after the ACL layer moved to `acl_grants`, which silently
 * hid shared sessions from search. Deriving it means the visibility rules — including
 * the project gate — can only be changed in one place.
 *
 * Placeholder count is whatever the fragment declares; see PARAM_COUNT below.
 */
const NARRATOR_VISIBILITY_FRAGMENT = narratorReadableSqlFragment(false, "n");
const NARRATOR_VISIBILITY_SQL = NARRATOR_VISIBILITY_FRAGMENT?.sql ?? "1 = 1";
/**
 * How many bound parameters `NARRATOR_VISIBILITY_SQL` consumes, all of them the
 * requesting user id. Derived from the string so the two can never disagree: a
 * hard-coded number silently shifts every later parameter when the fragment changes,
 * and a shifted LIMIT is the kind of bug that looks like a ranking quirk.
 */
const NARRATOR_VISIBILITY_PARAM_COUNT = (NARRATOR_VISIBILITY_SQL.match(/\?/g) ?? []).length;

/** The user id repeated once per placeholder in the visibility clause. */
function visibilityParams(userId: string): string[] {
	return Array.from({ length: NARRATOR_VISIBILITY_PARAM_COUNT }, () => userId);
}

/**
 * Project gate for a projects row aliased as `p`, for the chapter searches.
 *
 * A chapter hit exposes its title, description snippet and the name of the project
 * it lives in, so it is gated by the project the same way a narrator hit is gated by
 * narrator visibility. Derived from `projectReadableSqlFragment` so the rules cannot
 * drift from the ones the project routes enforce.
 */
const PROJECT_VISIBILITY_SQL = projectReadableSqlFragment(false, "p")?.sql ?? "1 = 1";
const PROJECT_VISIBILITY_PARAM_COUNT = (PROJECT_VISIBILITY_SQL.match(/\?/g) ?? []).length;

/** The user id repeated once per placeholder in the project gate. */
function projectGateParams(userId: string): string[] {
	return Array.from({ length: PROJECT_VISIBILITY_PARAM_COUNT }, () => userId);
}

function chaptersFtsStmt() {
	if (!_chaptersFts) {
		_chaptersFts = sqlite.prepare(
			`SELECT c.id, c.title, c.description, c.status, c.role, c.created_at, c.updated_at,
			  p.name as project_name,
			  snippet(chapters_fts, 1, '', '', '...', 96) as snippet,
			  rank as rank_score
			 FROM chapters_fts
			 JOIN chapters c ON c.rowid = chapters_fts.rowid
			 JOIN projects p ON p.id = c.project_id
			 WHERE chapters_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _chaptersFts;
}
function chaptersLikeStmt() {
	if (!_chaptersLike) {
		_chaptersLike = sqlite.prepare(
			`SELECT c.id, c.title, c.description, c.status, c.role, c.created_at, c.updated_at,
			  p.name as project_name,
			  substr(COALESCE(c.description, c.title, ''), 1, 240) as snippet
			 FROM chapters c
			 JOIN projects p ON p.id = c.project_id
			 WHERE (c.title LIKE ? OR c.description LIKE ?)
			 LIMIT ?`,
		);
	}
	return _chaptersLike;
}
/**
 * Non-admin chapter search. The `JOIN projects` is an inner join in both variants,
 * so a chapter whose project row has vanished is already excluded — a dangling
 * reference must not read as "no project, therefore no gate".
 */
function chaptersFtsAclStmt() {
	if (!_chaptersFtsAcl) {
		_chaptersFtsAcl = sqlite.prepare(
			`SELECT c.id, c.title, c.description, c.status, c.role, c.created_at, c.updated_at,
			  p.name as project_name,
			  snippet(chapters_fts, 1, '', '', '...', 96) as snippet,
			  rank as rank_score
			 FROM chapters_fts
			 JOIN chapters c ON c.rowid = chapters_fts.rowid
			 JOIN projects p ON p.id = c.project_id
			 WHERE chapters_fts MATCH ? AND ${PROJECT_VISIBILITY_SQL}
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _chaptersFtsAcl;
}
function chaptersLikeAclStmt() {
	if (!_chaptersLikeAcl) {
		_chaptersLikeAcl = sqlite.prepare(
			`SELECT c.id, c.title, c.description, c.status, c.role, c.created_at, c.updated_at,
			  p.name as project_name,
			  substr(COALESCE(c.description, c.title, ''), 1, 240) as snippet
			 FROM chapters c
			 JOIN projects p ON p.id = c.project_id
			 WHERE (c.title LIKE ? OR c.description LIKE ?) AND ${PROJECT_VISIBILITY_SQL}
			 LIMIT ?`,
		);
	}
	return _chaptersLikeAcl;
}
function messagesFtsStmt() {
	if (!_messagesFts) {
		_messagesFts = sqlite.prepare(
			`SELECT m.id, m.narrator_id, substr(m.content_text, 1, 240) as content_preview,
			  m.role as message_role, m.created_at,
			  n.chapter_id, n.title as narrator_title, n.model,
			  c.title as chapter_title, p.name as project_name,
			  snippet(narrator_messages_fts, 0, '', '', '...', 96) as snippet,
			  rank as rank_score
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE narrator_messages_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _messagesFts;
}
function messagesLikeStmt() {
	if (!_messagesLike) {
		_messagesLike = sqlite.prepare(
			`SELECT m.id, m.narrator_id, substr(m.content_text, 1, 240) as content_preview,
			  m.role as message_role, m.created_at,
			  n.chapter_id, n.title as narrator_title, n.model,
			  c.title as chapter_title, p.name as project_name,
			  substr(m.content_text, 1, 240) as snippet
			 FROM narrator_messages m
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE m.content_text LIKE ?
			 LIMIT ?`,
		);
	}
	return _messagesLike;
}
function narratorsFtsStmt() {
	if (!_narratorsFts) {
		_narratorsFts = sqlite.prepare(
			`SELECT n.id, n.title, n.chapter_id, n.status, n.model, n.message_count,
			  n.last_message_at, n.created_at, n.updated_at,
			  c.title as chapter_title, p.name as project_name,
			  snippet(narrators_fts, 0, '', '', '...', 96) as snippet,
			  rank as rank_score
			 FROM narrators_fts
			 JOIN narrators n ON n.rowid = narrators_fts.rowid
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE narrators_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _narratorsFts;
}
function narratorsLikeStmt() {
	if (!_narratorsLike) {
		_narratorsLike = sqlite.prepare(
			`SELECT n.id, n.title, n.chapter_id, n.status, n.model, n.message_count,
			  n.last_message_at, n.created_at, n.updated_at,
			  c.title as chapter_title, p.name as project_name
			 FROM narrators n
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE n.title LIKE ?
			 LIMIT ?`,
		);
	}
	return _narratorsLike;
}

/**
 * Access-filtered twins of the four narrator-derived statements above.
 *
 * Separate statements rather than a conditional clause because the visibility SQL
 * adds two placeholders; keeping the admin path on the original statements means
 * the common case pays nothing.
 */
function messagesFtsAclStmt() {
	if (!_messagesFtsAcl) {
		_messagesFtsAcl = sqlite.prepare(
			`SELECT m.id, m.narrator_id, substr(m.content_text, 1, 240) as content_preview,
			  m.role as message_role, m.created_at,
			  n.chapter_id, n.title as narrator_title, n.model,
			  c.title as chapter_title, p.name as project_name,
			  snippet(narrator_messages_fts, 0, '', '', '...', 96) as snippet,
			  rank as rank_score
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE narrator_messages_fts MATCH ? AND ${NARRATOR_VISIBILITY_SQL}
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _messagesFtsAcl;
}
function messagesLikeAclStmt() {
	if (!_messagesLikeAcl) {
		_messagesLikeAcl = sqlite.prepare(
			`SELECT m.id, m.narrator_id, substr(m.content_text, 1, 240) as content_preview,
			  m.role as message_role, m.created_at,
			  n.chapter_id, n.title as narrator_title, n.model,
			  c.title as chapter_title, p.name as project_name,
			  substr(m.content_text, 1, 240) as snippet
			 FROM narrator_messages m
			 JOIN narrators n ON n.id = m.narrator_id
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE m.content_text LIKE ? AND ${NARRATOR_VISIBILITY_SQL}
			 LIMIT ?`,
		);
	}
	return _messagesLikeAcl;
}
function narratorsFtsAclStmt() {
	if (!_narratorsFtsAcl) {
		_narratorsFtsAcl = sqlite.prepare(
			`SELECT n.id, n.title, n.chapter_id, n.status, n.model, n.message_count,
			  n.last_message_at, n.created_at, n.updated_at,
			  c.title as chapter_title, p.name as project_name,
			  snippet(narrators_fts, 0, '', '', '...', 96) as snippet,
			  rank as rank_score
			 FROM narrators_fts
			 JOIN narrators n ON n.rowid = narrators_fts.rowid
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE narrators_fts MATCH ? AND ${NARRATOR_VISIBILITY_SQL}
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _narratorsFtsAcl;
}
function narratorsLikeAclStmt() {
	if (!_narratorsLikeAcl) {
		_narratorsLikeAcl = sqlite.prepare(
			`SELECT n.id, n.title, n.chapter_id, n.status, n.model, n.message_count,
			  n.last_message_at, n.created_at, n.updated_at,
			  c.title as chapter_title, p.name as project_name
			 FROM narrators n
			 LEFT JOIN chapters c ON c.id = n.chapter_id
			 LEFT JOIN projects p ON p.id = c.project_id
			 WHERE n.title LIKE ? AND ${NARRATOR_VISIBILITY_SQL}
			 LIMIT ?`,
		);
	}
	return _narratorsLikeAcl;
}

/**
 * FTS search scoped to a single narrator's own timeline.
 *
 * Joins the message-refs junction (indexed by narrator_id) so only messages
 * visible in THIS narrator's timeline match, and returns each ref's `seq` so
 * the client can resolve the message location and jump to it. Excludes
 * segment-compacted (hidden) refs. Reads only small columns (no content_json).
 */
function narratorScopedFtsStmt() {
	if (!_narratorScopedFts) {
		_narratorScopedFts = sqlite.prepare(
			`SELECT m.id, m.role as message_role, m.created_at, r.seq,
			  substr(m.content_text, 1, 240) as content_preview,
			  snippet(narrator_messages_fts, 0, '', '', '...', 32) as snippet
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrator_message_refs r
			   ON r.message_id = m.id AND r.narrator_id = ? AND r.segment_compact_id IS NULL
			 WHERE narrator_messages_fts MATCH ?
			 ORDER BY r.seq DESC
			 LIMIT ?`,
		);
	}
	return _narratorScopedFts;
}
/**
 * One ancestor a lazily-forked narrator still borrows older refs from.
 * `upperBoundSeq` is exclusive — refs at or above it were produced by that
 * ancestor after the fork diverged and must not surface in the child's search.
 */
export type InheritedSearchScope = { narratorId: string; upperBoundSeq: number };

/**
 * Render the narrator + its inherited ancestry as a single ref predicate.
 *
 * Built by interpolation rather than bound parameters because the number of
 * scopes varies per narrator, so the statement cannot be prepared once and
 * cached. Every interpolated value is therefore checked here: ids must match the
 * generator's alphabet and bounds must be finite integers. Anything else is
 * dropped rather than quoted, so a malformed value can only narrow the search,
 * never alter the statement.
 */
const NARRATOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function buildInheritedScopeSql(narratorId: string, scopes: InheritedSearchScope[]): string {
	if (!NARRATOR_ID_PATTERN.test(narratorId)) {
		throw new ValidationError("Invalid narrator id");
	}
	const clauses = [`r.narrator_id = '${narratorId}'`];
	for (const scope of scopes) {
		if (!NARRATOR_ID_PATTERN.test(scope.narratorId)) continue;
		if (!Number.isFinite(scope.upperBoundSeq)) continue;
		const bound = Math.trunc(scope.upperBoundSeq);
		clauses.push(`(r.narrator_id = '${scope.narratorId}' AND r.seq < ${bound})`);
	}
	return `(${clauses.join(" OR ")})`;
}

function inheritedFtsSql(scopeSql: string): string {
	return `SELECT m.id, m.role as message_role, m.created_at, r.seq,
		  substr(m.content_text, 1, 240) as content_preview,
		  snippet(narrator_messages_fts, 0, '', '', '...', 32) as snippet
		 FROM narrator_messages_fts
		 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
		 JOIN narrator_message_refs r
		   ON r.message_id = m.id AND ${scopeSql} AND r.segment_compact_id IS NULL
		 WHERE narrator_messages_fts MATCH ?
		 ORDER BY r.seq DESC
		 LIMIT ?`;
}

function inheritedLikeSql(scopeSql: string): string {
	return `SELECT m.id, m.role as message_role, m.created_at, r.seq,
		  substr(m.content_text, 1, 240) as content_preview,
		  substr(m.content_text, 1, 240) as snippet
		 FROM narrator_message_refs r
		 JOIN narrator_messages m ON m.id = r.message_id
		 WHERE ${scopeSql} AND r.segment_compact_id IS NULL
		   AND m.content_text LIKE ?
		 ORDER BY r.seq DESC
		 LIMIT ?`;
}

function narratorScopedLikeStmt() {
	if (!_narratorScopedLike) {
		// Short-query fallback: start from the narrator's refs (indexed by
		// narrator_id + seq) and LIKE-filter the joined message text. Ordered by
		// seq DESC and capped by LIMIT so it never scans the whole corpus.
		_narratorScopedLike = sqlite.prepare(
			`SELECT m.id, m.role as message_role, m.created_at, r.seq,
			  substr(m.content_text, 1, 240) as content_preview,
			  substr(m.content_text, 1, 240) as snippet
			 FROM narrator_message_refs r
			 JOIN narrator_messages m ON m.id = r.message_id
			 WHERE r.narrator_id = ? AND r.segment_compact_id IS NULL
			   AND m.content_text LIKE ?
			 ORDER BY r.seq DESC
			 LIMIT ?`,
		);
	}
	return _narratorScopedLike;
}

function scoreFromRank(rank: unknown, fallback: number): number {
	const numeric = typeof rank === "number" ? rank : Number(rank);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.max(0, Math.round(1000 - numeric * 1000));
}

/**
 * Collection display names for knowledge hits, batch-loaded by id.
 *
 * One query for the whole result page rather than per row: a knowledge search can
 * return up to the hard cap, and the collection name is only used as a badge.
 */
async function collectionNameMap(collectionIds: string[]): Promise<Map<string, string>> {
	const ids = [...new Set(collectionIds.filter(Boolean))];
	if (ids.length === 0) return new Map();
	const rows = await db.query.knowledgeCollections.findMany({
		where: (c, { inArray }) => inArray(c.id, ids),
		columns: { id: true, name: true },
	});
	return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The one ordering used by every search response: score first, then recency.
 *
 * Exported because knowledge hits are resolved on a separate (async) path and
 * merged in by the route — a second local sort there would drift from this one.
 */
export function sortSearchResults(results: SearchResult[]): SearchResult[] {
	return results.sort((a, b) => {
		if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
		const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? b.lastMessageAt ?? "") || 0;
		const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? a.lastMessageAt ?? "") || 0;
		return bTime - aTime;
	});
}

export const searchService = {
	search(options: SearchOptions): SearchResult[] {
		const { query, entities, limit = 50, principal } = options;
		const userId = principal.userId;
		const aclFiltered = !principal.isAdmin;
		const results: SearchResult[] = [];

		// Sanitize: remove FTS5 special chars to prevent injection
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return results;

		// Trigram tokenizer requires >= 3 characters; fall back to LIKE for shorter queries
		const useFts = safeQuery.length >= 3;
		const quoted = `"${safeQuery}"`;
		const like = `%${safeQuery}%`;
		const safeQueryLower = safeQuery.toLowerCase();

		if (entities.includes("chapters")) {
			// A chapter hit exposes its title, description snippet and project name, so
			// it is filtered by the owning project's gate.
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const rows: any[] = aclFiltered
				? useFts
					? chaptersFtsAclStmt().all(quoted, ...projectGateParams(userId), limit)
					: chaptersLikeAclStmt().all(like, like, ...projectGateParams(userId), limit)
				: useFts
					? chaptersFtsStmt().all(quoted, limit)
					: chaptersLikeStmt().all(like, like, limit);
			for (const row of rows) {
				results.push({
					type: "chapter",
					id: row.id,
					title: row.title,
					projectName: row.project_name ?? undefined,
					status: row.status,
					role: row.role,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					matchField: row.title?.toLowerCase().includes(safeQueryLower) ? "title" : "description",
					matchScore: useFts ? scoreFromRank(row.rank_score, 760) : 520,
					snippet: row.snippet || row.description || "",
				});
			}
		}

		if (entities.includes("messages")) {
			// A message hit exposes a transcript snippet, so it is filtered by the
			// owning narrator's visibility.
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const rows: any[] = aclFiltered
				? useFts
					? messagesFtsAclStmt().all(quoted, ...visibilityParams(userId), limit)
					: messagesLikeAclStmt().all(like, ...visibilityParams(userId), limit)
				: useFts
					? messagesFtsStmt().all(quoted, limit)
					: messagesLikeStmt().all(like, limit);
			for (const row of rows) {
				results.push({
					type: "message",
					id: row.id,
					narratorId: row.narrator_id,
					narratorTitle: row.narrator_title ?? undefined,
					chapterId: row.chapter_id ?? undefined,
					chapterTitle: row.chapter_title ?? undefined,
					projectName: row.project_name ?? undefined,
					model: row.model ?? undefined,
					messageRole: row.message_role ?? undefined,
					createdAt: row.created_at,
					matchField: "message",
					matchScore: useFts ? scoreFromRank(row.rank_score, 700) : 500,
					snippet: row.snippet || row.content_preview || "",
				});
			}
		}

		if (entities.includes("narrators")) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const rows: any[] = aclFiltered
				? useFts
					? narratorsFtsAclStmt().all(quoted, ...visibilityParams(userId), limit)
					: narratorsLikeAclStmt().all(like, ...visibilityParams(userId), limit)
				: useFts
					? narratorsFtsStmt().all(quoted, limit)
					: narratorsLikeStmt().all(like, limit);
			for (const row of rows) {
				results.push({
					type: "narrator",
					id: row.id,
					title: row.title,
					chapterId: row.chapter_id ?? undefined,
					chapterTitle: row.chapter_title ?? undefined,
					projectName: row.project_name ?? undefined,
					status: row.status,
					model: row.model ?? undefined,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					lastMessageAt: row.last_message_at,
					matchField: "title",
					matchScore: useFts ? scoreFromRank(row.rank_score, 820) : 620,
					snippet: row.snippet || row.title || "",
				});
			}
		}

		return sortSearchResults(results);
	},

	/**
	 * Knowledge-base entries as global-search results.
	 *
	 * Async and therefore separate from `search()`: knowledge visibility is a
	 * dual-axis (clearance + controlled tag) check that reads grants, so it cannot
	 * be expressed as a SQL fragment the way the narrator/project gates are. The
	 * matched rows are post-filtered by `knowledgeService.filterReadable`, which
	 * fails closed — the same gate the knowledge routes use.
	 *
	 * Results carry `updatedAt`, so the "newest" sort in the UI orders them
	 * alongside the other entity types without special-casing.
	 */
	async searchKnowledge(options: {
		query: string;
		limit?: number;
		principal: { userId: string; isAdmin: boolean };
	}): Promise<SearchResult[]> {
		const { query, limit = 50, principal } = options;
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return [];

		// The caller's own personal versions shadow the committed one, mirroring what
		// they see in the knowledge UI: a hit on text they only have locally must not
		// be reported against the main body it replaced.
		const rows = knowledgeService.search({
			q: safeQuery,
			limit,
			draftUserId: principal.userId || undefined,
		});
		if (rows.length === 0) return [];

		const readable = await knowledgeService.filterReadable(
			principal.userId
				? { userId: principal.userId, role: principal.isAdmin ? "admin" : "user" }
				: undefined,
			rows,
		);
		if (readable.length === 0) return [];

		const collectionNames = await collectionNameMap(readable.map((r) => r.collectionId));
		const safeQueryLower = safeQuery.toLowerCase();
		return readable.map((row) => ({
			type: "knowledge" as const,
			id: row.id,
			title: row.title,
			collectionId: row.collectionId,
			collectionName: collectionNames.get(row.collectionId),
			tags: row.tags,
			status: row.status,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			matchField: row.title?.toLowerCase().includes(safeQueryLower) ? "title" : "content",
			// Knowledge search returns rank-ordered rows without exposing the raw rank,
			// so score by position within a band that keeps titles above body matches.
			matchScore: safeQuery.length >= 3 ? 780 : 540,
			snippet: row.snippet || row.title || "",
		}));
	},

	/**
	 * Full-text search within a single narrator's own conversation history.
	 * Returns messages on this narrator's timeline (newest first) with the `seq`
	 * needed to jump to each result. Bounded by `limit` (hard cap 100).
	 *
	 * `inheritedScopes` widens the search across a lazy fork's ancestry: a fork
	 * only materializes refs after its parent's last compact, so older history is
	 * still owned by an ancestor. Each scope carries the seq bound that ancestor
	 * was inherited up to, which keeps out messages the ancestor produced *after*
	 * the fork diverged. Callers obtain these from `resolveLazyLineage`; passing
	 * none reproduces the single-narrator behaviour exactly.
	 */
	searchNarratorMessages(
		narratorId: string,
		query: string,
		limit = 60,
		inheritedScopes: InheritedSearchScope[] = [],
	): NarratorMessageSearchResult[] {
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return [];
		const cappedLimit = Math.min(Math.max(1, limit), 100);

		// Trigram tokenizer requires >= 3 characters; fall back to LIKE for shorter queries.
		const useFts = safeQuery.length >= 3;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic row shape
		let rows: any[];
		if (inheritedScopes.length === 0) {
			rows = useFts
				? narratorScopedFtsStmt().all(narratorId, buildFtsQuery(safeQuery), cappedLimit)
				: narratorScopedLikeStmt().all(narratorId, `%${safeQuery}%`, cappedLimit);
		} else {
			const scopeSql = buildInheritedScopeSql(narratorId, inheritedScopes);
			rows = useFts
				? sqlite.prepare(inheritedFtsSql(scopeSql)).all(buildFtsQuery(safeQuery), cappedLimit)
				: sqlite.prepare(inheritedLikeSql(scopeSql)).all(`%${safeQuery}%`, cappedLimit);
		}

		return rows.map((row) => ({
			messageId: row.id,
			seq: typeof row.seq === "number" ? row.seq : Number(row.seq) || 0,
			role: row.message_role ?? "",
			snippet: row.snippet || row.content_preview || "",
			preview: row.content_preview || "",
			createdAt: row.created_at,
		}));
	},
};
