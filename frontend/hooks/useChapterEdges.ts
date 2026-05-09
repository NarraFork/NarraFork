import { api } from "@frontend/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const CHAPTER_EDGES_QUERY_GC_TIME_MS = 60_000;

export function useChapterEdges(projectId: string | undefined) {
	return useQuery({
		queryKey: ["chapterEdges", projectId],
		queryFn: () => {
			if (!projectId) throw new Error("projectId is required");
			return api.listChapterEdges({ projectId });
		},
		enabled: !!projectId,
		gcTime: CHAPTER_EDGES_QUERY_GC_TIME_MS,
	});
}

export function useCreateChapterEdge() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: {
			sourceId: string;
			targetId: string;
			type: string;
			metadata?: Record<string, unknown>;
		}) => api.createChapterEdge(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["chapterEdges"] });
			queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}

export function useDeleteChapterEdge() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteChapterEdge(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["chapterEdges"] });
			queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}
