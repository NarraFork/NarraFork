import type { Statement } from "bun:sqlite";
import { sqlite } from "../db";

interface SearchResult {
	type: "chapter" | "message" | "narrator";
	id: string;
	title?: string;
	snippet: string;
	chapterId?: string;
	narratorId?: string;
}

interface SearchOptions {
	query: string;
	entities: string[];
	limit?: number;
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

function chaptersFtsStmt() {
	if (!_chaptersFts) {
		_chaptersFts = sqlite.prepare(
			`SELECT c.id, c.title, c.project_id,
			  snippet(chapters_fts, 1, '', '', '...', 64) as snippet
			 FROM chapters_fts
			 JOIN chapters c ON c.rowid = chapters_fts.rowid
			 WHERE chapters_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _chaptersFts;
}
function chaptersLikeStmt() {
	if (!_chaptersLike) {
		_chaptersLike = sqlite.prepare(
			`SELECT id, title, project_id,
			  substr(description, 1, 128) as snippet
			 FROM chapters
			 WHERE title LIKE ? OR description LIKE ?
			 LIMIT ?`,
		);
	}
	return _chaptersLike;
}
function messagesFtsStmt() {
	if (!_messagesFts) {
		_messagesFts = sqlite.prepare(
			`SELECT m.id, m.narrator_id, m.content_text, n.chapter_id,
			  snippet(narrator_messages_fts, 0, '', '', '...', 64) as snippet
			 FROM narrator_messages_fts
			 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
			 JOIN narrators n ON n.id = m.narrator_id
			 WHERE narrator_messages_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _messagesFts;
}
function messagesLikeStmt() {
	if (!_messagesLike) {
		_messagesLike = sqlite.prepare(
			`SELECT m.id, m.narrator_id, m.content_text, n.chapter_id,
			  substr(m.content_text, 1, 200) as snippet
			 FROM narrator_messages m
			 JOIN narrators n ON n.id = m.narrator_id
			 WHERE m.content_text LIKE ?
			 LIMIT ?`,
		);
	}
	return _messagesLike;
}
function narratorsFtsStmt() {
	if (!_narratorsFts) {
		_narratorsFts = sqlite.prepare(
			`SELECT n.id, n.title, n.chapter_id,
			  snippet(narrators_fts, 0, '', '', '...', 64) as snippet
			 FROM narrators_fts
			 JOIN narrators n ON n.rowid = narrators_fts.rowid
			 WHERE narrators_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		);
	}
	return _narratorsFts;
}
function narratorsLikeStmt() {
	if (!_narratorsLike) {
		_narratorsLike = sqlite.prepare(
			`SELECT id, title, chapter_id
			 FROM narrators
			 WHERE title LIKE ?
			 LIMIT ?`,
		);
	}
	return _narratorsLike;
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
					snippet: row.snippet || "",
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
					chapterId: row.chapter_id ?? undefined,
					snippet: row.snippet || row.content_text?.slice(0, 200) || "",
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
					snippet: row.snippet || row.title || "",
				});
			}
		}

		return results;
	},
};
