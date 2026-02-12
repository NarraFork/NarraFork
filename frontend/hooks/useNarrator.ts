import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useNarrators(chapterId: string) {
	return useQuery({
		queryKey: ["narrators", { chapterId }],
		queryFn: () => api.listNarrators(chapterId),
		enabled: !!chapterId,
	});
}

export function useNarrator(id: string) {
	return useQuery({
		queryKey: ["narrators", id],
		queryFn: () => api.getNarrator(id),
		enabled: !!id,
	});
}

export function useNarratorMessages(narratorId: string) {
	return useQuery({
		queryKey: ["narrators", narratorId, "messages"],
		queryFn: () => api.getNarratorMessages(narratorId),
		enabled: !!narratorId,
	});
}

export function useCreateNarrator(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data?: { type?: string; model?: string }) =>
			api.createNarrator({ chapterId, ...data }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators", { chapterId }] });
		},
	});
}

export function useDeleteNarrator(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteNarrator(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators", { chapterId }] });
		},
	});
}

export function useInterruptNarrator() {
	return useMutation({
		mutationFn: (id: string) => api.interruptNarrator(id),
	});
}
