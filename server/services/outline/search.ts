/**
 * Full-text search over the live blocks of the spaces a caller may read.
 *
 * HOW A SEARCH RUNS
 * -----------------
 *   1. The query is sanitized and split into terms the way global search does it
 *      (`services/search/query.ts`): terms of 3+ characters go to the trigram index, shorter ones
 *      (most two-character Chinese words, for one) are required as substrings of what the index
 *      returned. A query with no indexable term scans the spaces' blocks for the substrings.
 *      Filtering by space happens in SQL, before the candidate limit.
 *   2. A block whose alias is exactly the query is a candidate too.
 *   3. Each candidate's ancestors are read (titles for its path; tasks above it make it process).
 *   4. Candidates are ordered by how well they match (the alias or title is the query; the title
 *      holds every term; the content holds the whole query; the rest), then facts before process,
 *      then the backend's relevance, and the first `limit` (at most 50) are returned.
 *
 * Snippets and paths are cut here, the same way on both backends.
 */
import { ValidationError } from "@server/lib/errors";
import { blockTitle, isAlias } from "@shared/outline";
import { globalQueryTerms, sanitizeQuery } from "../search/query";
import { OUTLINE_TEXT } from "./messages";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineSearchRow } from "./store/read-port";
import { isProcessBlock } from "./tree";

export const OUTLINE_SEARCH_LIMITS = {
	maxResults: 50,
	defaultResults: 20,
	/** Candidates read from the index before ranking. */
	candidates: 100,
	/** Spaces one search may cover. */
	maxSpaces: 2000,
	/** Ancestor levels read for a result's path; deeper ancestors are left out of it. */
	maxPathDepth: 64,
	/** Characters of a snippet. */
	snippetChars: 160,
	/** Characters of one title in a path. */
	titleChars: 80,
} as const;

export interface OutlineSearchRequest {
	query: string;
	/** Spaces to search: those the caller may read. Nothing outside them is returned. */
	spaceIds: readonly string[];
	/** The space the search is made from; session content of other spaces ranks as process. */
	contextSpaceId?: string | null;
	/** Default 20, at most 50. */
	limit?: number;
	store?: OutlineStore;
}

export interface OutlineSearchHit {
	blockId: string;
	spaceId: string;
	spaceKey: string;
	sid: string;
	/** `key/sid`. */
	address: string;
	pageId: string;
	alias: string | null;
	title: string;
	snippet: string;
	/** Titles of the ancestors, the page first. */
	path: string[];
	/** A task, under one, or session content read from another space. */
	process: boolean;
	/** The task at or nearest above the block, if any. */
	task: { blockId: string; address: string; title: string } | null;
}

interface Ancestry {
	id: string;
	sid: string;
	parentId: string | null;
	content: string;
	isTask: boolean;
}

/** Candidates that match better sort first; see the module header. */
function matchTier(row: OutlineSearchRow, query: string, terms: readonly string[]): number {
	const title = blockTitle(row.content).toLowerCase();
	if (row.alias === query || title === query.toLowerCase()) return 0;
	if (terms.every((term) => title.includes(term))) return 1;
	if (row.content.toLowerCase().includes(query.toLowerCase())) return 2;
	return 3;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Characters of `text` as code points, so a cut never splits a surrogate pair. */
function cut(text: string, start: number, length: number): string {
	return Array.from(text)
		.slice(start, start + length)
		.join("");
}

/** At most `max` characters of the content around the first term found, on one line. */
export function searchSnippet(
	content: string,
	terms: readonly string[],
	max: number = OUTLINE_SEARCH_LIMITS.snippetChars,
): string {
	const flat = content.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	if (chars.length <= max) return flat;
	let at = -1;
	for (const term of terms) {
		const match = new RegExp(escapeRegExp(term), "iu").exec(flat);
		if (match && (at < 0 || match.index < at)) at = match.index;
	}
	// The match offset is in UTF-16 units; count the code points before it.
	const before = at < 0 ? 0 : Array.from(flat.slice(0, at)).length;
	const start = Math.max(0, Math.min(before - Math.floor(max / 3), chars.length - max));
	const head = start > 0 ? "…" : "";
	const tail = start + max < chars.length ? "…" : "";
	return head + cut(flat, start, max) + tail;
}

function shortTitle(content: string): string {
	const title = blockTitle(content);
	const chars = Array.from(title);
	return chars.length <= OUTLINE_SEARCH_LIMITS.titleChars
		? title
		: `${chars.slice(0, OUTLINE_SEARCH_LIMITS.titleChars - 1).join("")}…`;
}

/**
 * Live blocks of `spaceIds` matching the query, best first: at most `limit` (50), each with a
 * snippet and its path. An empty query finds nothing.
 */
export async function searchOutline(request: OutlineSearchRequest): Promise<OutlineSearchHit[]> {
	const store = request.store ?? outlineStore;
	const safe = sanitizeQuery(request.query);
	const spaceIds = [...new Set(request.spaceIds)];
	if (spaceIds.length > OUTLINE_SEARCH_LIMITS.maxSpaces) {
		throw new ValidationError(
			OUTLINE_TEXT.errors.tooManySpaces(OUTLINE_SEARCH_LIMITS.maxSpaces, spaceIds.length),
		);
	}
	if (safe === "" || spaceIds.length === 0) return [];
	const limit = Math.max(
		1,
		Math.min(
			OUTLINE_SEARCH_LIMITS.maxResults,
			Math.floor(request.limit ?? OUTLINE_SEARCH_LIMITS.defaultResults),
		),
	);
	const { indexed, short } = globalQueryTerms(safe);
	const rows = await store.searchBlocks({
		spaceIds,
		indexed,
		short,
		limit: OUTLINE_SEARCH_LIMITS.candidates,
	});
	const candidates = new Map(rows.map((row) => [row.id, row]));
	const exact = request.query.trim();
	if (isAlias(exact)) {
		for (const block of await store.findLiveBlocks(spaceIds, { alias: exact }, limit)) {
			if (!candidates.has(block.id)) {
				candidates.set(block.id, { ...block, rank: Number.NEGATIVE_INFINITY });
			}
		}
	}
	if (candidates.size === 0) return [];

	// Ancestors, level by level, for paths and the tasks above each candidate.
	const known = new Map<string, Ancestry>();
	for (const row of candidates.values()) {
		known.set(row.id, {
			id: row.id,
			sid: row.sid,
			parentId: row.parentId,
			content: row.content,
			isTask: row.taskJson !== null,
		});
	}
	let frontier = [...known.values()].map((a) => a.parentId);
	for (let depth = 0; depth < OUTLINE_SEARCH_LIMITS.maxPathDepth; depth++) {
		const missing = [
			...new Set(frontier.filter((id): id is string => id !== null && !known.has(id))),
		];
		if (missing.length === 0) break;
		const parents = await store.getBlocks(missing);
		for (const block of parents) {
			known.set(block.id, {
				id: block.id,
				sid: block.sid,
				parentId: block.parentId,
				content: block.content,
				isTask: block.taskJson !== null,
			});
		}
		frontier = parents.map((b) => b.parentId);
	}

	const spaces = new Map<string, OutlineSpaceRow | null>();
	for (const row of candidates.values()) {
		if (!spaces.has(row.spaceId)) spaces.set(row.spaceId, await store.getSpace(row.spaceId));
	}

	const terms = [...indexed, ...short].map((t) => t.toLowerCase());
	const ranked = [...candidates.values()]
		.map((row) => {
			const chain: Ancestry[] = [];
			for (
				let id = row.parentId, depth = 0;
				id !== null && depth < OUTLINE_SEARCH_LIMITS.maxPathDepth;
				depth++
			) {
				const parent = known.get(id);
				if (!parent) break;
				chain.push(parent);
				id = parent.parentId;
			}
			chain.reverse();
			const self = known.get(row.id) as Ancestry;
			const task = [...chain, self].reverse().find((a) => a.isTask) ?? null;
			const space = spaces.get(row.spaceId) ?? null;
			const process = isProcessBlock({
				underTask: task !== null,
				spaceKind: space?.kind ?? "project",
				spaceId: row.spaceId,
				contextSpaceId: request.contextSpaceId,
			});
			return { row, chain, task, space, process, tier: matchTier(row, exact, terms) };
		})
		.filter((hit) => hit.space !== null)
		.sort(
			(a, b) =>
				a.tier - b.tier ||
				Number(a.process) - Number(b.process) ||
				a.row.rank - b.row.rank ||
				(a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
		)
		.slice(0, limit);

	return ranked.map(({ row, chain, task, space, process }) => {
		const key = (space as OutlineSpaceRow).key;
		return {
			blockId: row.id,
			spaceId: row.spaceId,
			spaceKey: key,
			sid: row.sid,
			address: `${key}/${row.sid}`,
			pageId: row.pageId,
			alias: row.alias,
			title: shortTitle(row.content),
			snippet: searchSnippet(row.content, terms),
			path: chain.map((a) => shortTitle(a.content)),
			process,
			task: task
				? { blockId: task.id, address: `${key}/${task.sid}`, title: shortTitle(task.content) }
				: null,
		};
	});
}
