import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

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
	narratorId: string | null;
	narratorStatus: string | null;
	axisOffset: number;
	crossOffset: number;
}

export interface RulerData {
	commits: RulerCommit[];
	segments: RulerSegment[];
	activeChapters: RulerActiveChapter[];
	mergedChapters?: RulerActiveChapter[];
	totalCommitCount?: number;
	oldestLoadedIndex?: number;
	newestLoadedIndex?: number;
}

export function useRulerData(projectId: string) {
	return useQuery({
		queryKey: ["ruler", projectId],
		queryFn: () => api.getRulerData(projectId) as Promise<RulerData>,
		enabled: !!projectId,
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
		enabled: !!projectId,
	});
}

export function flattenRulerPages(pages: RulerData[]): RulerData {
	if (pages.length === 0) return { commits: [], segments: [], activeChapters: [] };
	if (pages.length === 1) return pages[0];

	const commits = pages.flatMap((p) => p.commits);
	// Deduplicate segments by fromSha
	const segMap = new Map<string, RulerSegment>();
	for (const page of pages) {
		for (const seg of page.segments) segMap.set(seg.fromSha, seg);
	}
	// Deduplicate active chapters by id
	const chapterMap = new Map<string, RulerActiveChapter>();
	for (const page of pages) {
		for (const ch of page.activeChapters) chapterMap.set(ch.id, ch);
	}
	// Deduplicate merged chapters by id
	const mergedMap = new Map<string, RulerActiveChapter>();
	for (const page of pages) {
		for (const ch of page.mergedChapters ?? []) mergedMap.set(ch.id, ch);
	}
	return {
		commits,
		segments: [...segMap.values()],
		activeChapters: [...chapterMap.values()],
		mergedChapters: mergedMap.size > 0 ? [...mergedMap.values()] : undefined,
		totalCommitCount: pages[0].totalCommitCount,
		oldestLoadedIndex: Math.min(...pages.map((p) => p.oldestLoadedIndex ?? 0)),
		newestLoadedIndex: Math.max(...pages.map((p) => p.newestLoadedIndex ?? 0)),
	};
}
