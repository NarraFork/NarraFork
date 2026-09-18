import { db } from "../db";
import { knowledgeService } from "./knowledge-service";
import { searchStore } from "./search/backend";
import { canUseIndex, sanitizeQuery } from "./search/query";
import type { InheritedSearchScope, SearchStrategy } from "./search/types";

export { sanitizeQuery } from "./search/query";
export type { InheritedSearchScope } from "./search/types";

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

/**
 * Which retrieval path a sanitized query must take.
 *
 * The threshold itself lives in `search/query.ts` (it is shared with the knowledge service).
 * The mapping to a strategy stays on this side because the score bands below are calibrated
 * to it: a backend that chose for itself would change scores with no caller aware of it.
 */
function strategyFor(safeQuery: string): SearchStrategy {
	return canUseIndex(safeQuery) ? "index" : "substring";
}

/**
 * Relevance rank → display score, with a per-entity fallback.
 *
 * `null` means the backend had no relevance signal (the substring path), which is why the
 * caller supplies the flat band. The curve is deliberately NOT normalized inside the backend:
 * it is shared product behaviour, so two backends must not be able to disagree about which
 * hit sorts first while both "passing".
 */
function scoreFromRank(rank: number | null, fallback: number): number {
	if (rank === null) return fallback;
	return Math.max(0, Math.round(1000 - rank * 1000));
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
	async search(options: SearchOptions): Promise<SearchResult[]> {
		const { query, entities, limit = 50, principal } = options;
		const results: SearchResult[] = [];

		// Sanitize: remove FTS5 special chars to prevent injection
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return results;

		const strategy = strategyFor(safeQuery);
		const safeQueryLower = safeQuery.toLowerCase();
		// One query object for all three entity searches: the viewer travels with it, so a
		// branch cannot accidentally run ungated.
		const base = { text: safeQuery, strategy, limit, viewer: principal };

		if (entities.includes("chapters")) {
			// A chapter hit exposes its title, description snippet and project name, so the
			// backend gates it by the owning project inside the query.
			for (const row of await searchStore.searchChapters(base)) {
				results.push({
					type: "chapter",
					id: row.id,
					title: row.title ?? undefined,
					projectName: row.projectName ?? undefined,
					status: row.status ?? undefined,
					role: row.role ?? undefined,
					createdAt: row.createdAt ?? undefined,
					updatedAt: row.updatedAt ?? undefined,
					matchField: row.title?.toLowerCase().includes(safeQueryLower) ? "title" : "description",
					matchScore: scoreFromRank(row.rank, strategy === "index" ? 760 : 520),
					snippet: row.snippet || row.description || "",
				});
			}
		}

		if (entities.includes("messages")) {
			// A message hit exposes a transcript snippet, so the backend gates it by the
			// owning narrator's visibility.
			for (const row of await searchStore.searchMessages(base)) {
				results.push({
					type: "message",
					id: row.id,
					narratorId: row.narratorId ?? undefined,
					narratorTitle: row.narratorTitle ?? undefined,
					chapterId: row.chapterId ?? undefined,
					chapterTitle: row.chapterTitle ?? undefined,
					projectName: row.projectName ?? undefined,
					model: row.model ?? undefined,
					messageRole: row.messageRole ?? undefined,
					createdAt: row.createdAt ?? undefined,
					matchField: "message",
					matchScore: scoreFromRank(row.rank, strategy === "index" ? 700 : 500),
					snippet: row.snippet || row.preview || "",
				});
			}
		}

		if (entities.includes("narrators")) {
			for (const row of await searchStore.searchNarrators(base)) {
				results.push({
					type: "narrator",
					id: row.id,
					title: row.title ?? undefined,
					chapterId: row.chapterId ?? undefined,
					chapterTitle: row.chapterTitle ?? undefined,
					projectName: row.projectName ?? undefined,
					status: row.status ?? undefined,
					model: row.model ?? undefined,
					createdAt: row.createdAt ?? undefined,
					updatedAt: row.updatedAt ?? undefined,
					lastMessageAt: row.lastMessageAt,
					matchField: "title",
					matchScore: scoreFromRank(row.rank, strategy === "index" ? 820 : 620),
					snippet: row.snippet || row.title || "",
				});
			}
		}

		return sortSearchResults(results);
	},

	/**
	 * Knowledge-base entries as global-search results.
	 *
	 * Kept separate from `search()` because its visibility gate differs in kind: knowledge
	 * visibility is a dual-axis (clearance + controlled tag) check that reads grants, so it
	 * cannot be expressed as a SQL fragment the way the narrator/project gates are. The
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
		const rows = await knowledgeService.search({
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
			matchScore: strategyFor(safeQuery) === "index" ? 780 : 540,
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
	async searchNarratorMessages(
		narratorId: string,
		query: string,
		limit = 60,
		inheritedScopes: InheritedSearchScope[] = [],
	): Promise<NarratorMessageSearchResult[]> {
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return [];

		return searchStore.searchTimeline({
			narratorId,
			text: safeQuery,
			strategy: strategyFor(safeQuery),
			limit: Math.min(Math.max(1, limit), 100),
			inheritedScopes,
		});
	},
};
