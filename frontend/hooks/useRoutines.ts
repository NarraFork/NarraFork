import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

type ProjectRoutinesResponse = Awaited<ReturnType<typeof api.getProjectRoutines>>;
type ProjectRoutineAction = "enable" | "disable" | "reset";
type ProjectRoutineOverride = "global" | "enabled" | "disabled";

const actionToOverride: Record<ProjectRoutineAction, ProjectRoutineOverride> = {
	enable: "enabled",
	disable: "disabled",
	reset: "global",
};

const ROUTINE_QUERY_GC_TIME_MS = 60_000;

export function useRoutines() {
	return useQuery({
		queryKey: ["routines"],
		queryFn: api.getRoutines,
		staleTime: 30_000,
		gcTime: ROUTINE_QUERY_GC_TIME_MS,
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
		gcTime: ROUTINE_QUERY_GC_TIME_MS,
	});
}

export function useToggleProjectRoutine(projectId: string) {
	const qc = useQueryClient();
	const queryKey = ["project-routines", projectId];
	return useMutation({
		mutationFn: ({ id, action }: { id: string; action: ProjectRoutineAction }) =>
			api.toggleProjectRoutine(projectId, id, action),
		onMutate: async ({ id, action }) => {
			await qc.cancelQueries({ queryKey });
			const previous = qc.getQueryData<ProjectRoutinesResponse>(queryKey);
			const override = actionToOverride[action];
			qc.setQueryData<ProjectRoutinesResponse>(queryKey, (old) => {
				if (!old) return old;
				return {
					...old,
					routines: old.routines.map((routine) => {
						if (routine.id !== id) return routine;
						return {
							...routine,
							override,
							enabled: override === "global" ? routine.globalEnabled : override === "enabled",
						};
					}),
				};
			});
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) {
				qc.setQueryData(queryKey, context.previous);
			}
		},
		onSettled: () => {
			qc.invalidateQueries({ queryKey });
			// Also invalidate narrator commands since routines affect the slash menu
			qc.invalidateQueries({ queryKey: ["narrator-commands"] });
		},
	});
}

export function useGlobalPrompt(enabled = true) {
	return useQuery({
		queryKey: ["global-prompt"],
		queryFn: api.getGlobalPrompt,
		enabled,
		staleTime: 30_000,
		gcTime: ROUTINE_QUERY_GC_TIME_MS,
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
