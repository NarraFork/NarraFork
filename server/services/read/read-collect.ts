/**
 * Walking a cursor-paged adapter read to completion, with a ceiling.
 *
 * Two rules are in tension here and this module is where they are reconciled:
 *
 *  - Every SQL statement must be bounded. An unbounded `findMany` on the HTTP thread is the
 *    "all requests stop responding" failure the backend rules describe, and both the project
 *    list and the chapter list used to be exactly that.
 *  - The RESPONSES are bare JSON arrays that existing clients consume whole. `GET /api/projects`
 *    and `GET /api/chapters?projectId=` are called with no paging parameters by the dashboard,
 *    the project page, the merge modal and the scheduled-task editor. Serving them one 200-row
 *    page would silently hide the rest, and "silently" is the part that matters: the project
 *    list then reads as "you have 200 projects" and the merge modal offers a target list with
 *    chapters missing from it.
 *
 * So the query stays bounded and the RESPONSE is assembled from as many bounded pages as it
 * takes, up to `maxRows`. Reaching that ceiling is reported rather than papered over: the
 * caller sets a truncation header, and the last cursor stays usable to fetch the rest.
 *
 * The ceiling is not a performance guess dressed up as a limit — it is the point past which a
 * single JSON array is the wrong transport regardless of how fast the database answered.
 */

import type { ReadPage, ReadPageResult } from "./project-read-adapter";

/**
 * Rows one response may carry. Ten pages of `projectPage`/`chapterPage`, which is far above
 * any real project or chapter count and still a bounded amount of JSON to serialize.
 */
export const COLLECT_MAX_ROWS = 2000;

export interface CollectedRows<T> {
	rows: T[];
	/**
	 * Set when {@link COLLECT_MAX_ROWS} was reached and more rows remain — never when the walk
	 * simply finished. Callers hand it to the client so a bounded read cannot masquerade as a
	 * complete set.
	 */
	nextCursor: string | null;
	/** Present only when rows were left behind. */
	truncated?: true;
}

/**
 * Read every page a caller can see, or `maxRows` of them.
 *
 * `pageSize` is left to the adapter (it clamps to its own maximum), so this cannot ask for a
 * page larger than the backend is willing to serve.
 */
export async function collectAllPages<T>(
	read: (page: ReadPage) => Promise<ReadPageResult<T>>,
	maxRows: number = COLLECT_MAX_ROWS,
): Promise<CollectedRows<T>> {
	const rows: T[] = [];
	let cursor: string | undefined;
	// A cursor that fails to advance would spin here forever, so the loop is bounded by the row
	// ceiling itself: every iteration must add at least one row or the walk stops.
	while (rows.length < maxRows) {
		const page = await read({ cursor });
		rows.push(...page.rows);
		if (!page.nextCursor || page.rows.length === 0) return { rows, nextCursor: null };
		cursor = page.nextCursor;
	}
	return { rows: rows.slice(0, maxRows), nextCursor: cursor ?? null, truncated: true };
}

/**
 * One page, when the caller explicitly asked for paging (`?limit`/`?cursor`).
 *
 * Kept next to the walk so both shapes report a continuation the same way.
 */
export function singlePage<T>(page: ReadPageResult<T>): CollectedRows<T> {
	return {
		rows: page.rows,
		nextCursor: page.nextCursor,
		...(page.nextCursor ? { truncated: true as const } : {}),
	};
}

/** Parse `?limit`, ignoring absent and non-positive values. */
export function parseLimitQuery(value: string | undefined): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
