import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type HookApiRecord } from "../lib/api";

export type { HookApiRecord as HookRecord } from "../lib/api";

const HOOKS_KEY = ["hooks"];

function hooksKey(projectId?: string | null) {
	return projectId ? ["hooks", { projectId }] : HOOKS_KEY;
}

export function useHooks(projectId?: string | null) {
	return useQuery<HookApiRecord[]>({
		queryKey: hooksKey(projectId),
		queryFn: () => (projectId ? api.listHooks(projectId) : api.listHooks()),
	});
}

export function useCreateHook() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: Record<string, unknown>) => api.createHook(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: HOOKS_KEY });
		},
	});
}

export function useUpdateHook() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
			api.updateHook(id, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: HOOKS_KEY });
		},
	});
}

export function useDeleteHook() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteHook(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: HOOKS_KEY });
		},
	});
}
