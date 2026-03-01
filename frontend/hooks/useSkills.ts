import { useQuery } from "@tanstack/react-query";
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
