import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useNarrators(opts?: {
	chapterId?: string;
	standalone?: boolean;
	status?: string;
	sortBy?: string;
	sortOrder?: string;
}) {
	return useQuery({
		queryKey: ["narrators", { ...opts }],
		queryFn: () => api.listNarrators(opts),
		enabled: !!(opts?.chapterId || opts?.standalone),
	});
}

export function useNarratorsPaginated(opts?: {
	standalone?: boolean;
	status?: string;
	sortBy?: string;
	sortOrder?: string;
	limit?: number;
}) {
	return useInfiniteQuery({
		queryKey: ["narrators", "paginated", { ...opts }],
		queryFn: ({ pageParam }) =>
			api.listNarratorsPaginated({
				...opts,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) =>
			lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
		enabled: !!opts?.standalone,
	});
}

export function useNarrator(id: string) {
	return useQuery({
		queryKey: ["narrators", id],
		queryFn: () => api.getNarrator(id),
		enabled: !!id,
	});
}

export function useNarratorMessages(narratorId: string, around?: string, branchId?: string) {
	return useInfiniteQuery({
		queryKey: ["narrators", narratorId, "messages", { around, branchId }],
		queryFn: ({ pageParam }) => {
			// First page: use `around` if provided, otherwise fetch latest 20
			if (!pageParam && around) {
				return api.getNarratorMessages(narratorId, undefined, undefined, around, branchId);
			}
			return api.getNarratorMessages(
				narratorId,
				pageParam ? 50 : 20,
				pageParam,
				undefined,
				branchId,
			);
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
		enabled: !!narratorId,
		// Messages are kept up-to-date via WebSocket (setQueryData), so background
		// refetch on remount is unnecessary. A high staleTime prevents TanStack Query
		// from refetching ALL cached pages when the component remounts, which would
		// cause a cascade of API calls proportional to the number of loaded pages.
		staleTime: Infinity,
	});
}

export function useToolCallDetail(narratorId: string, toolUseId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["narrators", narratorId, "tool-calls", toolUseId],
		queryFn: () => api.getToolCallDetail(narratorId, toolUseId),
		enabled: !!narratorId && !!toolUseId && enabled,
		staleTime: 5 * 60 * 1000,
	});
}

export function useCreateNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: {
			chapterId?: string | null;
			type?: string;
			model?: string;
			systemPrompt?: string;
			permissionMode?: string;
			cwd?: string;
			planMode?: boolean;
		}) => api.createNarrator(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useArchiveNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.archiveNarrator(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}
export function useUnarchiveNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.unarchiveNarrator(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useInterruptNarrator() {
	return useMutation({
		mutationFn: (id: string) => api.interruptNarrator(id),
	});
}

export function useUpdatePermissionMode() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, permissionMode }: { id: string; permissionMode: string }) =>
			api.updateNarratorPermissionMode(id, permissionMode),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useUpdateModel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, model }: { id: string; model: string }) =>
			api.updateNarratorModel(id, model),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

// === Conversation Branches ===

export function useBranches(narratorId: string) {
	return useQuery({
		queryKey: ["narrators", narratorId, "branches"],
		queryFn: () => api.listBranches(narratorId),
		enabled: !!narratorId,
	});
}

export function useCreateBranch() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			forkMessageId,
			name,
		}: {
			narratorId: string;
			forkMessageId: string;
			name?: string;
		}) => api.createBranch(narratorId, forkMessageId, name),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId, "branches"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId, "messages"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId] });
		},
	});
}

export function useSwitchBranch() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ narratorId, branchId }: { narratorId: string; branchId: string }) =>
			api.switchBranch(narratorId, branchId),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId, "messages"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId] });
		},
	});
}

export function useUpdateBranch() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			branchId,
			data,
		}: {
			narratorId: string;
			branchId: string;
			data: { name?: string; status?: string };
		}) => api.updateBranch(narratorId, branchId, data),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId, "branches"] });
		},
	});
}

export function useDeleteBranch() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ narratorId, branchId }: { narratorId: string; branchId: string }) =>
			api.deleteBranch(narratorId, branchId),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId, "branches"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId, "messages"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.narratorId] });
		},
	});
}
