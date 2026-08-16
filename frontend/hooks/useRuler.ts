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
	 * Trunk commit to draw this chapter at when its own start commit cannot place it —
	 * `merge-base <startCommitSha> <trunk>`, computed server-side and sent only for
	 * chapters the backbone could not position.
	 *
	 * Exists because a rewritten trunk (rebase, squash-merge, amend) leaves a real
	 * chapter pointing at a commit that is no longer reachable from the branch. Without
	 * this the chapter had no position and was dropped from the view entirely.
	 */
	anchorFallbackSha?: string | null;
	/**
	 * Whether `startCommitSha` is still an ancestor of the trunk. `false` means paging in
	 * more commits will never produce a tick for it; `true` means it is simply outside the
	 * loaded window. Only sent alongside `anchorFallbackSha`.
	 */
	startCommitOnBranch?: boolean | null;
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
	/**
	 * Absolute `git log` offsets of this page's first / last commit (see the server's
	 * `GET /:id/ruler`). Offset 0 is HEAD and grows towards OLDER history, because git
	 * walks newest-first.
	 *
	 * Named after the walk on purpose. They were `oldestLoadedIndex` / `newestLoadedIndex`,
	 * which named the opposite ends, and the paging predicates below were written against
	 * those names — `hasPreviousPage` therefore asked "is the first page's offset > 0",
	 * which is false for the very page that has all the older history still ahead of it.
	 */
	firstOffset?: number;
	lastOffset?: number;
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

export interface RulerPageParam {
	cursor?: string;
	direction: "older" | "newer";
}

/**
 * Is there OLDER history past this page, and how do we ask for it?
 *
 * React Query's `previousPage` is this query's older direction (`flattenRulerPages`
 * relies on those pages being prepended). "Older" means a LARGER absolute offset, so the
 * question is whether the page's last commit is short of the final one — not whether its
 * first offset is above zero, which is what the old `oldestLoadedIndex > 0` test asked and
 * why paging older was dead on the first page.
 *
 * The cursor is the page's LAST (oldest) commit: the server counts forward from it.
 *
 * Pure and exported so the predicate is testable without a query client — the bug it
 * replaces was a boolean that no test could reach.
 */
export function rulerOlderPageParam(page: RulerData): RulerPageParam | undefined {
	const { lastOffset, totalCommitCount } = page;
	if (lastOffset == null || totalCommitCount == null) return undefined;
	if (lastOffset >= totalCommitCount - 1) return undefined;
	const cursor = page.commits.at(-1)?.sha;
	// No cursor means an empty page: there is nothing to count forward from, and asking
	// again without one would re-fetch offset 0 forever.
	if (!cursor) return undefined;
	return { cursor, direction: "older" };
}

/** Is there NEWER history before this page? Mirror of {@link rulerOlderPageParam}. */
export function rulerNewerPageParam(page: RulerData): RulerPageParam | undefined {
	const { firstOffset } = page;
	if (firstOffset == null || firstOffset <= 0) return undefined;
	const cursor = page.commits[0]?.sha;
	if (!cursor) return undefined;
	return { cursor, direction: "newer" };
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
		initialPageParam: undefined as RulerPageParam | undefined,
		// `next` walks towards NEWER commits and `previous` towards OLDER ones, matching
		// `flattenRulerPages`: it documents that React Query prepends previous-pages, and
		// the ruler needs the older batch prepended to keep one newest-first run.
		getNextPageParam: rulerNewerPageParam,
		getPreviousPageParam: rulerOlderPageParam,
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
	// chapter's position — from this array. `firstOffset` is the absolute git-log offset
	// of each page's FIRST commit and grows towards older history, so ascending by it
	// restores a single newest-first run.
	//
	// Pages that predate the offset fields sort as 0 and keep their relative order,
	// which is the single-page behaviour they had before.
	const ordered = [...pages].sort((a, b) => (a.firstOffset ?? 0) - (b.firstOffset ?? 0));

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
		// The window the merged pages span: nearest-to-HEAD offset and farthest-into-history
		// offset. `rulerOlderPageParam` reads `lastOffset` off the merged result too, so this
		// max is what decides whether "load older commits" stays available after a page lands.
		firstOffset: Math.min(...ordered.map((p) => p.firstOffset ?? 0)),
		lastOffset: Math.max(...ordered.map((p) => p.lastOffset ?? 0)),
		degraded: ordered.some((p) => p.degraded === true) || undefined,
		fallback: ordered.some((p) => p.fallback === true) || undefined,
		fallbacks: mergeRulerFallbacks(ordered),
		capabilities: ordered.find((p) => p.capabilities)?.capabilities,
	};
}
