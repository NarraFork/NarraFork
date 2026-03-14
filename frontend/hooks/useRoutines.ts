import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useRoutines() {
	return useQuery({
		queryKey: ["routines"],
		queryFn: api.getRoutines,
		staleTime: 30_000,
	});
}

export function useToggleRoutine() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			api.toggleRoutine(id, enabled),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["routines"] });
		},
	});
}

export function useProjectRoutines(projectId: string | undefined) {
	return useQuery({
		queryKey: ["project-routines", projectId],
		queryFn: () => api.getProjectRoutines(projectId as string),
		enabled: !!projectId,
		staleTime: 30_000,
	});
}

export function useToggleProjectRoutine(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, action }: { id: string; action: "enable" | "disable" | "reset" }) =>
			api.toggleProjectRoutine(projectId, id, action),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project-routines", projectId] });
			// Also invalidate narrator commands since routines affect the slash menu
			qc.invalidateQueries({ queryKey: ["narrator-commands"] });
		},
	});
}

export function useGlobalPrompt() {
	return useQuery({
		queryKey: ["global-prompt"],
		queryFn: api.getGlobalPrompt,
		staleTime: 30_000,
	});
}

export function useUpdateGlobalPrompt() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { content: string; filePath?: string }) => api.updateGlobalPrompt(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["global-prompt"] });
		},
	});
}
