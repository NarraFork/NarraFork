import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useTerminals(chapterId: string) {
	return useQuery({
		queryKey: ["terminals", { chapterId }],
		queryFn: () => api.listTerminals(chapterId),
		enabled: !!chapterId,
	});
}

export function useNarratorTerminals(narratorId: string) {
	return useQuery({
		queryKey: ["terminals", { narratorId }],
		queryFn: () => api.listTerminalsByNarrator(narratorId),
		enabled: !!narratorId,
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

export function useCreateNarratorTerminal(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data?: { name?: string; cols?: number; rows?: number }) =>
			api.createTerminal({ narratorId, ...data }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", { narratorId }] });
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

export function useDeleteNarratorTerminal(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteTerminal(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", { narratorId }] });
		},
	});
}

export function useRenameTerminal(key: { chapterId?: string; narratorId?: string }) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => api.renameTerminal(id, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", key] });
		},
	});
}
