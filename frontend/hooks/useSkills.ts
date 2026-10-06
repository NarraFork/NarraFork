import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const SKILL_QUERY_GC_TIME_MS = 60_000;

export function useSkills(projectId: string, enabled = true) {
	return useQuery({
		queryKey: ["skills", projectId],
		queryFn: () => api.listSkills(projectId),
		enabled: !!projectId && enabled,
		gcTime: SKILL_QUERY_GC_TIME_MS,
	});
}

export function useSkill(projectId: string, name: string, enabled = true) {
	return useQuery({
		queryKey: ["skill", projectId, name],
		queryFn: () => api.getSkill(projectId, name),
		enabled: !!projectId && !!name && enabled,
		gcTime: SKILL_QUERY_GC_TIME_MS,
	});
}

export function useCreateProjectSkill(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { name: string; description: string; content: string }) =>
			api.createProjectSkill(projectId, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["skills", projectId] });
		},
	});
}

export function useUpdateProjectSkill(projectId: string) {
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
		}) => api.updateProjectSkill(projectId, currentName, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["skills", projectId] });
			qc.invalidateQueries({ queryKey: ["skill", projectId] });
		},
	});
}

export function useDeleteProjectSkill(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api.deleteProjectSkill(projectId, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["skills", projectId] });
			qc.invalidateQueries({ queryKey: ["skill", projectId] });
		},
	});
}

export function useProjectSkillsRefresh(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			await api.listSkills(projectId);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["skills", projectId] });
		},
	});
}

export function useGlobalSkills(enabled = true) {
	return useQuery({
		queryKey: ["global-skills"],
		queryFn: () => api.listGlobalSkills(),
		enabled,
		gcTime: SKILL_QUERY_GC_TIME_MS,
	});
}

export function useGlobalSkill(name: string, enabled = true) {
	return useQuery({
		queryKey: ["global-skill", name],
		queryFn: () => api.getGlobalSkill(name),
		enabled: !!name && enabled,
		gcTime: SKILL_QUERY_GC_TIME_MS,
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

export function useToggleGlobalSkill() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
			api.toggleGlobalSkill(name, enabled),
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
