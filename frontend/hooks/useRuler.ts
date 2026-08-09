import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

const MAX_RULER_PAGES = 20;
const RULER_QUERY_GC_TIME_MS = 60_000;

export interface RulerCommit {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string;
}

export interface RulerSegment {
	fromSha: string;
	toSha: string;
	fromIndex: number;
	toIndex: number;
	activeChapterCount: number;
	totalChapterCount: number;
	activeChapterIds: string[];
	isExpandable: boolean;
}

export interface RulerActiveChapter {
	id: string;
	title: string;
	branch: string;
	role: string;
	parentChapterId: string | null;
	startCommitSha: string | null;
	mergeCommitSha?: string | null;
	/**
	 * Backbone commit the merge connector anchors to. Falls back server-side to the
	 * target's pre-merge HEAD, because a commit-free merge produces no merge commit.
	 */
	mergeAnchorCommitSha?: string | null;
	/**
	 * Snapshot of uncommitted work an earlier rebase parked and could not reapply, while
	 * the server is still tracking it (`chapters.parkedSnapshotCommitSha`).
	 *
	 * Served so the recovery panel survives a reload: it used to live only in the rebase
	 * response, so refreshing the page hid the only UI that could act on the work while
	 * the server kept rejecting further rebases with `REBASE_PARKED_WORK_CONFLICT`.
	 */
	parkedSnapshot?: string | null;
	narratorId: string | null;
	narratorStatus: string | null;
	/**
	 * Narrator is parked until an unavailable model recovers. Sent separately from
	 * `narratorStatus` (which stays `"waiting"`) because the Pixi card renders and
	 * measures the status string as raw text; this only drives color and offscreen
	 * bubble suppression.
	 */
	narratorModelUnavailable?: boolean;
	axisOffset: number;
	crossOffset: number;
}

/**
 * NOT YET SERVED BY THE BACKEND.
 *
 * `GET /:id/ruler` currently returns only commits, segments, activeChapters,
 * mergedChapters and the index/count fields; it never sets `degraded`, `fallback`,
 * `fallbacks` or `capabilities`. These types and the readers below are kept because
 * the classic graph endpoint already reports degradation this way
 * (`summarizeGraphRuntimeState`) and the ruler is expected to follow, but every
 * consumer must treat absence as "fully available" rather than as a signal.
 *
 * Consequence to keep in mind when reading the RulerFlow code: the degraded banner
 * never appears and the mutation guards are all `undefined` (so nothing is disabled)
 * until the server starts emitting these fields.
 */
export interface RulerFallback {
	feature?: string;
	reason?: string;
	message?: string;
	error?: string;
	code?: string;
}

export interface RulerFeatureCapability {
	supported?: boolean;
	fallback?: boolean;
	code?: string;
	reason?: string;
}

export interface RulerCapabilities {
	read?: RulerFeatureCapability;
	mutations?: Partial<
		Record<
			"fork" | "merge" | "abandon" | "rebase" | "rebaseResolve" | "rebaseContinue",
			RulerFeatureCapability
		>
	>;
	[key: string]: unknown;
}

export interface RulerData {
	commits: RulerCommit[];
	segments: RulerSegment[];
	activeChapters: RulerActiveChapter[];
	mergedChapters?: RulerActiveChapter[];
	totalCommitCount?: number;
	oldestLoadedIndex?: number;
	newestLoadedIndex?: number;
	/** Optional and not yet emitted by the server — see `RulerFallback`. */
	degraded?: boolean;
	fallback?: boolean;
	fallbacks?: RulerFallback[];
	capabilities?: RulerCapabilities;
}

export function useRulerData(projectId: string) {
	return useQuery({
		queryKey: ["ruler", projectId],
		queryFn: () => api.getRulerData(projectId) as Promise<RulerData>,
		enabled: !!projectId,
		gcTime: RULER_QUERY_GC_TIME_MS,
	});
}

export function useRulerInfinite(projectId: string) {
	return useInfiniteQuery({
		queryKey: ["ruler", projectId],
		queryFn: ({ pageParam }) =>
			api.getRulerData(projectId, {
				limit: 200,
				cursor: pageParam?.cursor,
				direction: pageParam?.direction,
			}) as Promise<RulerData>,
		initialPageParam: undefined as { cursor?: string; direction: "older" | "newer" } | undefined,
		getNextPageParam: (lastPage) =>
			lastPage.newestLoadedIndex != null &&
			lastPage.totalCommitCount != null &&
			lastPage.newestLoadedIndex < lastPage.totalCommitCount - 1
				? { cursor: lastPage.commits[0]?.sha, direction: "newer" as const }
				: undefined,
		getPreviousPageParam: (firstPage) =>
			firstPage.oldestLoadedIndex != null && firstPage.oldestLoadedIndex > 0
				? {
						cursor: firstPage.commits.at(-1)?.sha,
						direction: "older" as const,
					}
				: undefined,
		staleTime: 5 * 60 * 1000,
		gcTime: RULER_QUERY_GC_TIME_MS,
		maxPages: MAX_RULER_PAGES,
		enabled: !!projectId,
	});
}

function mergeRulerFallbacks(pages: RulerData[]): RulerFallback[] | undefined {
	const seen = new Set<string>();
	const merged: RulerFallback[] = [];
	for (const fallback of pages.flatMap((page) => page.fallbacks ?? [])) {
		const key = [
			fallback.feature,
			fallback.code,
			fallback.reason,
			fallback.message,
			fallback.error,
		].join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(fallback);
	}
	return merged.length > 0 ? merged : undefined;
}

export function flattenRulerPages(pages: RulerData[]): RulerData {
	if (pages.length === 0) return { commits: [], segments: [], activeChapters: [] };
	if (pages.length === 1) return pages[0];

	// Order pages by their absolute offset before concatenating.
	//
	// A plain flatMap over `pages` is wrong for this query: within a page git returns
	// commits newest-first, but React Query PREPENDS pages fetched via
	// `fetchPreviousPage` (the "older" direction), so `pages` runs oldest-batch-first
	// while each batch runs newest-first. Concatenating that yields a list that is
	// neither newest- nor oldest-first, and the ruler derives tick order — hence every
	// chapter's position — from this array. `oldestLoadedIndex` is the absolute index of
	// each page's FIRST commit, so ascending by it restores a single newest-first run.
	//
	// Pages that predate the index fields sort as 0 and keep their relative order,
	// which is the single-page behaviour they had before.
	const ordered = [...pages].sort(
		(a, b) => (a.oldestLoadedIndex ?? 0) - (b.oldestLoadedIndex ?? 0),
	);

	// Deduplicate commits by sha: the "newer" cursor direction computes its offset as
	// `cursorIndex - limit`, which deliberately overlaps the page it pages towards.
	const commitBySha = new Map<string, RulerCommit>();
	for (const page of ordered) {
		for (const commit of page.commits) {
			if (!commitBySha.has(commit.sha)) commitBySha.set(commit.sha, commit);
		}
	}
	const commits = [...commitBySha.values()];
	const indexBySha = new Map(commits.map((commit, index) => [commit.sha, index]));

	// Deduplicate segments by fromSha, then re-index against the flattened commit list.
	//
	// The server computes `fromIndex`/`toIndex` relative to the page it is answering, so
	// a segment from the second page carries indices that address the wrong commits once
	// the pages are concatenated. The SHAs are absolute, so they are the safe source:
	// recompute the indices, and keep the server's values only when a SHA is missing
	// from the loaded window.
	const segMap = new Map<string, RulerSegment>();
	for (const page of ordered) {
		for (const seg of page.segments) {
			segMap.set(seg.fromSha, {
				...seg,
				fromIndex: indexBySha.get(seg.fromSha) ?? seg.fromIndex,
				toIndex: indexBySha.get(seg.toSha) ?? seg.toIndex,
			});
		}
	}
	// Deduplicate active chapters by id
	const chapterMap = new Map<string, RulerActiveChapter>();
	for (const page of ordered) {
		for (const ch of page.activeChapters) chapterMap.set(ch.id, ch);
	}
	// Deduplicate merged chapters by id
	const mergedMap = new Map<string, RulerActiveChapter>();
	for (const page of ordered) {
		for (const ch of page.mergedChapters ?? []) mergedMap.set(ch.id, ch);
	}
	return {
		commits,
		segments: [...segMap.values()],
		activeChapters: [...chapterMap.values()],
		mergedChapters: mergedMap.size > 0 ? [...mergedMap.values()] : undefined,
		// Read from `ordered`, not `pages`: this function establishes right above that
		// `pages` order is not meaningful, and reaching back into its first element
		// contradicts that in the one place a reader is most likely to copy. The value
		// happens to be identical on every page today, so this is about keeping the
		// invariant locally legible rather than fixing a live bug.
		totalCommitCount: ordered[0].totalCommitCount,
		oldestLoadedIndex: Math.min(...ordered.map((p) => p.oldestLoadedIndex ?? 0)),
		newestLoadedIndex: Math.max(...ordered.map((p) => p.newestLoadedIndex ?? 0)),
		degraded: ordered.some((p) => p.degraded === true) || undefined,
		fallback: ordered.some((p) => p.fallback === true) || undefined,
		fallbacks: mergeRulerFallbacks(ordered),
		capabilities: ordered.find((p) => p.capabilities)?.capabilities,
	};
}
