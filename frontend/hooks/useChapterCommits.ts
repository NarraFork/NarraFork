import { api } from "@frontend/lib/api";
import { useQuery } from "@tanstack/react-query";

const CHAPTER_COMMITS_QUERY_GC_TIME_MS = 60_000;

export function useChapterCommits(
	chapterId: string | undefined,
	params?: { limit?: number; since?: string },
) {
	return useQuery({
		queryKey: ["chapterCommits", chapterId, params],
		queryFn: () => {
			if (!chapterId) {
				throw new Error("chapterId is required");
			}
			return api.getChapterCommits(chapterId, params);
		},
		enabled: !!chapterId,
		gcTime: CHAPTER_COMMITS_QUERY_GC_TIME_MS,
	});
}
