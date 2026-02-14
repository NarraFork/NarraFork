import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function useNarratorMessages(narratorId: string, around?: string) {
	return useInfiniteQuery({
		queryKey: ["narrators", narratorId, "messages", { around }],
		queryFn: ({ pageParam }) => {
			// First page: use `around` if provided, otherwise fetch latest 10
			if (!pageParam && around) {
				return api.getNarratorMessages(narratorId, undefined, undefined, around);
			}
			return api.getNarratorMessages(narratorId, pageParam ? 50 : 10, pageParam);
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
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
