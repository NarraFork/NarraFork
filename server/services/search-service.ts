import type { Statement } from "bun:sqlite";
import { sqlite } from "../db";

interface SearchResult {
	type: "chapter" | "message" | "narrator";
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
let _messagesFts: Statement | null = null;
let _messagesLike: Statement | null = null;
let _narratorsFts: Statement | null = null;
let _narratorsLike: Statement | null = null;
let _narratorScopedFts: Statement | null = null;
let _narratorScopedLike: Statement | null = null;

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
			 WHERE c.title LIKE ? OR c.description LIKE ?
			 LIMIT ?`,
		);
	}
	return _chaptersLike;
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

export const searchService = {
	search(options: SearchOptions): SearchResult[] {
		const { query, entities, limit = 50 } = options;
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
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const rows: any[] = useFts
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
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const rows: any[] = useFts
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
			const rows: any[] = useFts
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

		return results.sort((a, b) => {
			if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
			const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? b.lastMessageAt ?? "") || 0;
			const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? a.lastMessageAt ?? "") || 0;
			return bTime - aTime;
		});
	},

	/**
	 * Full-text search within a single narrator's own conversation history.
	 * Returns messages on this narrator's timeline (newest first) with the `seq`
	 * needed to jump to each result. Bounded by `limit` (hard cap 100).
	 */
	searchNarratorMessages(
		narratorId: string,
		query: string,
		limit = 60,
	): NarratorMessageSearchResult[] {
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return [];
		const cappedLimit = Math.min(Math.max(1, limit), 100);

		// Trigram tokenizer requires >= 3 characters; fall back to LIKE for shorter queries.
		const useFts = safeQuery.length >= 3;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic row shape
		const rows: any[] = useFts
			? narratorScopedFtsStmt().all(narratorId, buildFtsQuery(safeQuery), cappedLimit)
			: narratorScopedLikeStmt().all(narratorId, `%${safeQuery}%`, cappedLimit);

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
