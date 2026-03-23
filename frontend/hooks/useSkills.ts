import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useSkills(projectId: string, enabled = true) {
	return useQuery({
		queryKey: ["skills", projectId],
		queryFn: () => api.listSkills(projectId),
		enabled: !!projectId && enabled,
	});
}

export function useSkill(projectId: string, name: string, enabled = true) {
	return useQuery({
		queryKey: ["skill", projectId, name],
		queryFn: () => api.getSkill(projectId, name),
		enabled: !!projectId && !!name && enabled,
	});
}

export function useGlobalSkills() {
	return useQuery({
		queryKey: ["global-skills"],
		queryFn: () => api.listGlobalSkills(),
	});
}

export function useGlobalSkill(name: string, enabled = true) {
	return useQuery({
		queryKey: ["global-skill", name],
		queryFn: () => api.getGlobalSkill(name),
		enabled: !!name && enabled,
	});
}

export function useCreateGlobalSkill() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { name: string; description: string; content: string }) =>
			api.createGlobalSkill(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["global-skills"] });
		},
	});
}

export function useUpdateGlobalSkill() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			currentName,
			...data
		}: {
			currentName: string;
			name: string;
			description: string;
			content: string;
		}) => api.updateGlobalSkill(currentName, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["global-skills"] });
			qc.invalidateQueries({ queryKey: ["global-skill"] });
		},
	});
}

export function useDeleteGlobalSkill() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api.deleteGlobalSkill(name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["global-skills"] });
		},
	});
}

export function useGlobalSkillsRefresh() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			await api.listGlobalSkills();
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["global-skills"] });
		},
	});
}
