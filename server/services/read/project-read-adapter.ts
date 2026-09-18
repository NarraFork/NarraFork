import type { ProjectPrincipal } from "../project-acl";

export type ReadPage = { limit?: number; cursor?: string };

export type ReadPageResult<T> = { rows: T[]; nextCursor: string | null };

/** Read adapters reject absent/invalid principals rather than treating them as public. */
export function isReadablePrincipal(principal: ProjectPrincipal): boolean {
	return Boolean(principal && typeof principal.userId === "string" && principal.userId.length > 0);
}

/**
 * The row ceilings every read adapter obeys, so PostgreSQL and SQLite bound a result set
 * at the same place.
 *
 * They exist because these queries run on the HTTP thread and a project's chapter count is
 * user-driven: an unbounded `findMany` is the "all requests hang" failure mode the backend
 * rules warn about. What matters as much as the numbers is that hitting one is REPORTED —
 * a bounded read that looks like a complete set makes missing chapters read as deleted
 * branches, and a story graph silently loses every edge attached to the rows it dropped.
 *
 * Each list therefore fetches `limit + 1` rows: the extra row is never returned, it only
 * answers "is there more". That is cheaper and more honest than a `COUNT(*)` over the
 * whole ACL-filtered set.
 */
export const READ_LIMITS = {
	/** Projects per page, and the default when a caller names no limit. */
	projectPage: 200,
	/** Chapters per page of the chapter listing. */
	chapterPage: 200,
	/** Chapters in one story-graph payload. */
	graphChapters: 200,
	/** Edges in one story-graph payload. */
	graphEdges: 400,
	/**
	 * Auxiliary graph rows (narrators are the only unbounded one: a chapter may hold any
	 * number of sessions, and the graph asks about up to `graphChapters` chapters at once).
	 */
	auxiliaryRows: 2000,
} as const;

/**
 * Split ids into batches no larger than `size`.
 *
 * Every id in an `in (...)` list becomes its own bind parameter, and both drivers have a
 * ceiling on those (SQLite throws rather than degrading). The auxiliary graph reads take a
 * caller-supplied id list, so the bound has to be structural rather than a comment — and
 * batching keeps it without dropping ids, which is the one outcome that would turn "your
 * project has more chapters than we read" into "those chapters have no sessions".
 */
export function chunkIds(ids: readonly string[], size: number): string[][] {
	if (ids.length <= size) return ids.length === 0 ? [] : [[...ids]];
	const batches: string[][] = [];
	for (let index = 0; index < ids.length; index += size) {
		batches.push([...ids.slice(index, index + size)]);
	}
	return batches;
}

/** The narrator columns the story graph needs: a badge, a status and nothing else. */
export type GraphNarratorRow = {
	id: string;
	chapterId: string | null;
	status: string | null;
	substatus: string | null;
	ownerUserId: string | null;
	visibility: string | null;
};

export type GraphAuxiliaryData = {
	narrators: GraphNarratorRow[];
	containers: Array<{ chapterId: string }>;
	detachedPanels: Array<{ id: string; detachedPanelsJson: string }>;
	/**
	 * Present and `true` when an auxiliary query hit {@link READ_LIMITS.auxiliaryRows}, so
	 * the narrator counts on the canvas are a floor rather than a total.
	 *
	 * See {@link GraphReadResult} for why truncation flags are absent rather than `false` in
	 * the ordinary case, and why the type is the literal `true`.
	 */
	truncated?: true;
};

/**
 * One story graph, bounded.
 *
 * Truncation is REPORTED rather than left for the caller to infer from
 * `chapters.length === limit`. That inference is wrong exactly at the boundary — a project
 * holding precisely `graphChapters` chapters is complete — and every consumer would have to
 * re-derive the cap to attempt it.
 *
 * The flags are ABSENT in the ordinary case rather than `false`, so a complete payload is
 * byte-identical to what this endpoint has always returned; only a bounded read grows a
 * field. Their type is the literal `true` instead of `boolean`, which turns the tempting
 * `if (result.truncated === false)` into a compile error and leaves one correct way to read
 * them: truthiness.
 */
export type GraphReadResult<TChapter = unknown, TEdge = unknown> = {
	chapters: TChapter[];
	edges: TEdge[];
	/** Present when either list was cut short. */
	truncated?: true;
	truncatedChapters?: true;
	truncatedEdges?: true;
};

export interface ProjectReadAdapter<TProject = unknown, TChapter = unknown, TGraph = unknown> {
	listProjects(
		principal: ProjectPrincipal,
		page?: ReadPage,
		status?: string,
	): Promise<ReadPageResult<TProject>>;
	getProject(id: string, principal: ProjectPrincipal): Promise<TProject | null>;
	/**
	 * Whether ANY project exists, ignoring access — the second half of the
	 * "nothing exists yet" versus "none of them are yours" question.
	 *
	 * On the adapter because the answer must come from the backend actually serving reads;
	 * asking SQLite while PostgreSQL serves the list produces a confident wrong answer.
	 * Discloses only existence, never a name, id or count.
	 */
	anyProjectExists(): Promise<boolean>;
	/**
	 * The legacy chapter listing: a bare array, capped at `chapterPage + 1` rows.
	 *
	 * The extra row is deliberately RETURNED here rather than trimmed, because this shape
	 * has no field to carry a continuation and callers detect truncation by seeing the cap.
	 * New callers should use {@link listChaptersPage}, which trims and reports a cursor.
	 */
	listChapters(
		projectId: string,
		principal: ProjectPrincipal,
		status?: string,
	): Promise<TChapter[]>;
	/** The same listing as a page: `chapterPage` rows plus a continuation cursor. */
	listChaptersPage(
		projectId: string,
		principal: ProjectPrincipal,
		page?: ReadPage,
		status?: string,
	): Promise<ReadPageResult<TChapter>>;
	getChapter(id: string, principal: ProjectPrincipal): Promise<TChapter | null>;
	/** One bounded story graph; see {@link GraphReadResult} for the truncation contract. */
	getGraph(projectId: string, principal: ProjectPrincipal): Promise<TGraph>;
	getGraphAuxiliaryData(
		projectId: string,
		chapterIds: string[],
		principal: ProjectPrincipal,
	): Promise<GraphAuxiliaryData>;
}
