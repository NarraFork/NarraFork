import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useChapters(projectId: string, status?: string) {
	return useQuery({
		queryKey: ["chapters", { projectId, status }],
		queryFn: () => api.listChapters(projectId, status),
		enabled: !!projectId,
	});
}

export function useChapter(id: string) {
	return useQuery({
		queryKey: ["chapters", id],
		queryFn: () => api.getChapter(id),
		enabled: !!id,
	});
}

export function useCreateChapter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createChapter,
		onSuccess: (data: any) => {
			qc.invalidateQueries({ queryKey: ["chapters", { projectId: data.projectId }] });
		},
	});
}

export function useUpdateChapter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: any }) => api.updateChapter(id, data),
		onSuccess: (_, { id }) => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["chapters", id] });
		},
	});
}

export function useDeleteChapter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteChapter,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters"] }),
	});
}
