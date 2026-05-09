import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const TERMINALS_QUERY_GC_TIME_MS = 60_000;

export function useTerminals(chapterId: string) {
	const qc = useQueryClient();

	// Invalidate when any narrator in this chapter reports terminal_count_changed
	useEffect(() => {
		if (!chapterId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: "*", types: ["terminal_count_changed"] },
			() => {
				qc.invalidateQueries({ queryKey: ["terminals", { chapterId }] });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [chapterId, qc]);

	return useQuery({
		queryKey: ["terminals", { chapterId }],
		queryFn: () => api.listTerminals(chapterId),
		enabled: !!chapterId,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
	});
}

export function useNarratorTerminals(narratorId: string) {
	const qc = useQueryClient();

	// Invalidate when this narrator's terminal count changes
	useEffect(() => {
		if (!narratorId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["terminal_count_changed"] },
			() => {
				qc.invalidateQueries({ queryKey: ["terminals", { narratorId }] });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, qc]);

	return useQuery({
		queryKey: ["terminals", { narratorId }],
		queryFn: () => api.listTerminalsByNarrator(narratorId),
		enabled: !!narratorId,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
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
