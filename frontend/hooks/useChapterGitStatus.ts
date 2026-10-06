import { api } from "@frontend/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const CHAPTER_GIT_STATUS_GC_TIME_MS = 60_000;

export interface ChapterGitStatus {
	commitsAhead: number;
	baseBranch: string;
	linesAdded: number;
	linesRemoved: number;
}

/**
 * Fetches chapter git status (commits ahead of base branch + uncommitted line changes).
 * Initial load via API, then updated in real-time via WS `git_status` messages
 * pushed through the narrator channel.
 *
 * The WS update is handled by the caller (NarratorPanel's WS handler) calling
 * `queryClient.setQueryData` to patch the cached value.
 */
export function useChapterGitStatus(chapterId: string | undefined | null) {
	return useQuery({
		queryKey: ["chapterGitStatus", chapterId],
		queryFn: () => api.getChapterGitStatus(chapterId as string),
		enabled: !!chapterId,
		refetchInterval: 30_000, // fallback polling every 30s
		staleTime: 10_000,
		gcTime: CHAPTER_GIT_STATUS_GC_TIME_MS,
	});
}

/**
 * Call this from the WS message handler to update the cached git status
 * when a `git_status` message arrives.
 */
export function useChapterGitStatusUpdater() {
	const qc = useQueryClient();

	return (chapterId: string, data: Partial<ChapterGitStatus>) => {
		qc.setQueryData<ChapterGitStatus>(["chapterGitStatus", chapterId], (old) => {
			if (!old) return old;
			return { ...old, ...data };
		});
	};
}
