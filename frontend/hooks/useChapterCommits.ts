import { api } from "@frontend/lib/api";
import { useQuery } from "@tanstack/react-query";

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
	});
}
