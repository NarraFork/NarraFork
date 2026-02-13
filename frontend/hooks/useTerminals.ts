import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useTerminals(chapterId: string) {
	return useQuery({
		queryKey: ["terminals", { chapterId }],
		queryFn: () => api.listTerminals(chapterId),
		enabled: !!chapterId,
	});
}

export function useCreateTerminal(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data?: { name?: string; cols?: number; rows?: number }) =>
			api.createTerminal({ chapterId, ...data }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", { chapterId }] });
		},
	});
}

export function useDeleteTerminal(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteTerminal(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", { chapterId }] });
		},
	});
}
