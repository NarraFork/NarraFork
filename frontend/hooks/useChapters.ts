import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const CHAPTER_QUERY_GC_TIME_MS = 60_000;

export function useChapters(projectId: string, status?: string) {
	return useQuery({
		queryKey: ["chapters", { projectId, status }],
		queryFn: () => api.listChapters(projectId, status),
		enabled: !!projectId,
		gcTime: CHAPTER_QUERY_GC_TIME_MS,
	});
}

export function useChapter(id: string) {
	return useQuery({
		queryKey: ["chapters", id],
		queryFn: () => api.getChapter(id),
		enabled: !!id,
		gcTime: CHAPTER_QUERY_GC_TIME_MS,
	});
}

export function useCreateChapter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createChapter,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		onSuccess: (data: any) => {
			qc.invalidateQueries({ queryKey: ["chapters", { projectId: data.projectId }] });
			qc.invalidateQueries({ queryKey: ["narraFlow", data.projectId] });
		},
	});
}

export function useUpdateChapter() {
	const qc = useQueryClient();
	return useMutation({
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		mutationFn: ({ id, data }: { id: string; data: any }) => api.updateChapter(id, data),
		onSuccess: (_, { id }) => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["chapters", id] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}

export function useDeleteChapter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteChapter,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}
