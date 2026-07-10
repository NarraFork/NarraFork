import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduledTaskInput } from "../lib/api";
import { api } from "../lib/api";

const QUERY_KEY = ["scheduled-tasks"];
const GC_TIME_MS = 60_000;

export function useScheduledTasks() {
	return useQuery({
		queryKey: QUERY_KEY,
		queryFn: api.listScheduledTasks,
		staleTime: 15_000,
		gcTime: GC_TIME_MS,
	});
}

export function useCreateScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: ScheduledTaskInput) => api.createScheduledTask(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
	});
}

export function useUpdateScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: Partial<ScheduledTaskInput> }) =>
			api.updateScheduledTask(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
	});
}

export function useToggleScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			api.toggleScheduledTask(id, enabled),
		onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
	});
}

export function useRunScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.runScheduledTask(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
	});
}

export function useDeleteScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteScheduledTask(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
	});
}
