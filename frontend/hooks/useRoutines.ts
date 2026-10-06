import type { ToolRoutineMode, ToolRoutineModeOverride } from "@shared/routine-modes";
import { isPreloadedMode } from "@shared/routine-modes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

type RoutinesResponse = Awaited<ReturnType<typeof api.getRoutines>>;
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

/**
 * Set the global three-position mode of an optional tool routine.
 *
 * Optimistic so the segmented control does not snap back to the old position
 * while the request is in flight. `enabled` is kept in step with the mode because
 * other rows in the same response read it.
 */
export function useSetRoutineMode() {
	const qc = useQueryClient();
	const queryKey = ["routines"];
	return useMutation({
		mutationFn: ({ id, mode }: { id: string; mode: ToolRoutineMode }) =>
			api.setRoutineMode(id, mode),
		onMutate: async ({ id, mode }) => {
			await qc.cancelQueries({ queryKey });
			const previous = qc.getQueryData<RoutinesResponse>(queryKey);
			qc.setQueryData<RoutinesResponse>(queryKey, (old) => {
				if (!old) return old;
				return {
					...old,
					routines: old.routines.map((routine) =>
						routine.id === id ? { ...routine, mode, enabled: isPreloadedMode(mode) } : routine,
					),
				};
			});
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) qc.setQueryData(queryKey, context.previous);
		},
		onSettled: () => {
			qc.invalidateQueries({ queryKey });
			// The slash menu lists optional tools available via /load.
			qc.invalidateQueries({ queryKey: ["narrator-commands"] });
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

/**
 * Set (or clear) the project-level mode of an optional tool routine.
 *
 * `"global"` clears the override; the optimistic row then falls back to the
 * global mode already carried in the response, so the control does not flicker
 * through a wrong position on the way there.
 */
export function useSetProjectRoutineMode(projectId: string) {
	const qc = useQueryClient();
	const queryKey = ["project-routines", projectId];
	return useMutation({
		mutationFn: ({ id, mode }: { id: string; mode: ToolRoutineModeOverride }) =>
			api.setProjectRoutineMode(projectId, id, mode),
		onMutate: async ({ id, mode }) => {
			await qc.cancelQueries({ queryKey });
			const previous = qc.getQueryData<ProjectRoutinesResponse>(queryKey);
			qc.setQueryData<ProjectRoutinesResponse>(queryKey, (old) => {
				if (!old) return old;
				return {
					...old,
					routines: old.routines.map((routine) => {
						if (routine.id !== id) return routine;
						const effective = mode === "global" ? (routine.globalMode ?? "manual") : mode;
						return {
							...routine,
							modeOverride: mode,
							mode: effective,
							override:
								mode === "global" ? "global" : isPreloadedMode(mode) ? "enabled" : "disabled",
							enabled: isPreloadedMode(effective),
						};
					}),
				};
			});
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) qc.setQueryData(queryKey, context.previous);
		},
		onSettled: () => {
			qc.invalidateQueries({ queryKey });
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
