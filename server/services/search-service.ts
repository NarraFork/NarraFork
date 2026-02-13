import { sqlite } from "../db";

interface SearchResult {
	type: "chapter" | "message";
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

export const searchService = {
	search(options: SearchOptions): SearchResult[] {
		const { query, entities, limit = 50 } = options;
		const results: SearchResult[] = [];

		// Strip all non-alphanumeric characters except spaces, hyphens, dots, and underscores
		const safeQuery = query.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim();
		if (!safeQuery) return results;

		// Add * for prefix matching
		const ftsQuery = safeQuery
			.split(/\s+/)
			.map((w) => `"${w}"*`)
			.join(" ");

		if (entities.includes("chapters")) {
			const rows = sqlite
				.prepare(
					`SELECT c.id, c.title, c.project_id,
					  snippet(chapters_fts, 1, '', '', '...', 64) as snippet
					 FROM chapters_fts
					 JOIN chapters c ON c.rowid = chapters_fts.rowid
					 WHERE chapters_fts MATCH ?
					 ORDER BY rank
					 LIMIT ?`,
				)
				.all(ftsQuery, limit) as any[];

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
			const rows = sqlite
				.prepare(
					`SELECT m.id, m.narrator_id, m.content_text,
					  snippet(narrator_messages_fts, 0, '', '', '...', 64) as snippet
					 FROM narrator_messages_fts
					 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
					 WHERE narrator_messages_fts MATCH ?
					 ORDER BY rank
					 LIMIT ?`,
				)
				.all(ftsQuery, limit) as any[];

			for (const row of rows) {
				results.push({
					type: "message",
					id: row.id,
					narratorId: row.narrator_id,
					snippet: row.snippet || row.content_text?.slice(0, 200) || "",
				});
			}
		}

		return results;
	},
};
