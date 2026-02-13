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

/** Run an FTS5 MATCH query or fall back to LIKE for short queries */
function ftsQuery(
	ftsSQL: string,
	likeSQL: string,
	useFts: boolean,
	ftsArgs: unknown[],
	likeArgs: unknown[],
): any[] {
	return useFts
		? (sqlite.prepare(ftsSQL).all(...ftsArgs) as any[])
		: (sqlite.prepare(likeSQL).all(...likeArgs) as any[]);
}

export const searchService = {
	search(options: SearchOptions): SearchResult[] {
		const { query, entities, limit = 50 } = options;
		const results: SearchResult[] = [];

		// Sanitize: remove FTS5 special chars to prevent injection
		const safeQuery = query.replace(/['"*(){}[\]^~@:;!&|,<>\\]/g, "").trim();
		if (!safeQuery) return results;

		// Trigram tokenizer requires >= 3 characters; fall back to LIKE for shorter queries
		const useFts = safeQuery.length >= 3;
		const quoted = `"${safeQuery}"`;
		const like = `%${safeQuery}%`;

		if (entities.includes("chapters")) {
			const rows = ftsQuery(
				`SELECT c.id, c.title, c.project_id,
				  snippet(chapters_fts, 1, '', '', '...', 64) as snippet
				 FROM chapters_fts
				 JOIN chapters c ON c.rowid = chapters_fts.rowid
				 WHERE chapters_fts MATCH ?
				 ORDER BY rank LIMIT ?`,
				`SELECT id, title, project_id,
				  substr(description, 1, 128) as snippet
				 FROM chapters
				 WHERE title LIKE ? OR description LIKE ?
				 LIMIT ?`,
				useFts,
				[quoted, limit],
				[like, like, limit],
			);
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
			const rows = ftsQuery(
				`SELECT m.id, m.narrator_id, m.content_text, n.chapter_id,
				  snippet(narrator_messages_fts, 0, '', '', '...', 64) as snippet
				 FROM narrator_messages_fts
				 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
				 JOIN narrators n ON n.id = m.narrator_id
				 WHERE narrator_messages_fts MATCH ?
				 ORDER BY rank LIMIT ?`,
				`SELECT m.id, m.narrator_id, m.content_text, n.chapter_id,
				  substr(m.content_text, 1, 200) as snippet
				 FROM narrator_messages m
				 JOIN narrators n ON n.id = m.narrator_id
				 WHERE m.content_text LIKE ?
				 LIMIT ?`,
				useFts,
				[quoted, limit],
				[like, limit],
			);
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
			const rows = ftsQuery(
				`SELECT n.id, n.title, n.chapter_id,
				  snippet(narrators_fts, 0, '', '', '...', 64) as snippet
				 FROM narrators_fts
				 JOIN narrators n ON n.rowid = narrators_fts.rowid
				 WHERE narrators_fts MATCH ?
				 ORDER BY rank LIMIT ?`,
				`SELECT id, title, chapter_id
				 FROM narrators
				 WHERE title LIKE ?
				 LIMIT ?`,
				useFts,
				[quoted, limit],
				[like, limit],
			);
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
