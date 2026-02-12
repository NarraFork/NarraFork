import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useProjects(status?: string) {
	return useQuery({
		queryKey: ["projects", { status }],
		queryFn: () => api.listProjects(status),
	});
}

export function useProject(id: string) {
	return useQuery({
		queryKey: ["projects", id],
		queryFn: () => api.getProject(id),
		enabled: !!id,
	});
}

export function useCreateProject() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createProject,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});
}

export function useUpdateProject() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: any }) => api.updateProject(id, data),
		onSuccess: (_, { id }) => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			qc.invalidateQueries({ queryKey: ["projects", id] });
		},
	});
}

export function useDeleteProject() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteProject,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});
}
