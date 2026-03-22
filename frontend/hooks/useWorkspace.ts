import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useWorkspace(id: string) {
	return useQuery({
		queryKey: ["workspace", id],
		queryFn: () => api.getWorkspace(id),
		enabled: !!id,
	});
}

export function useCreateWorkspace() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { title?: string; tree: string }) => api.createWorkspace(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});
}

export function useUpdateWorkspace() {
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; title?: string; tree?: string }) =>
			api.updateWorkspace(id, data),
	});
}

export function useDeleteWorkspace() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteWorkspace(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});
}
