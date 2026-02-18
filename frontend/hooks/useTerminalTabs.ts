import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useTerminalTabs(opts: { chapterId?: string; narratorId?: string }) {
	return useQuery({
		queryKey: ["terminalTabs", opts],
		queryFn: () => api.listTerminalTabs(opts),
		enabled: !!(opts.chapterId || opts.narratorId),
	});
}

export function useCreateTerminalTab(opts: { chapterId?: string; narratorId?: string }) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { name: string }) => api.createTerminalTab({ ...opts, ...data }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["terminalTabs", opts] }),
	});
}

export function useUpdateTerminalTab(opts: { chapterId?: string; narratorId?: string }) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; name?: string }) => api.updateTerminalTab(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["terminalTabs", opts] }),
	});
}

export function useDeleteTerminalTab(opts: { chapterId?: string; narratorId?: string }) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteTerminalTab(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["terminalTabs", opts] }),
	});
}

export function useReorderTerminalTabs(opts: { chapterId?: string; narratorId?: string }) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (ids: string[]) => api.reorderTerminalTabs(ids),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["terminalTabs", opts] }),
	});
}
