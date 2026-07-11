import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduledTaskInput } from "../lib/api";
import { api } from "../lib/api";

const QUERY_KEY = ["scheduled-tasks"];
const GC_TIME_MS = 60_000;
const RUNS_PAGE_SIZE = 50;

export function useScheduledTasks() {
	return useQuery({
		queryKey: QUERY_KEY,
		queryFn: api.listScheduledTasks,
		staleTime: 15_000,
		gcTime: GC_TIME_MS,
	});
}

export function useScheduledTask(id: string | undefined) {
	return useQuery({
		queryKey: ["scheduled-tasks", id],
		queryFn: () => api.getScheduledTask(id as string),
		enabled: !!id,
		staleTime: 15_000,
		gcTime: GC_TIME_MS,
	});
}

export function useScheduledTaskRuns(id: string | undefined) {
	return useInfiniteQuery({
		queryKey: ["scheduled-tasks", id, "runs"],
		queryFn: ({ pageParam }) =>
			api.listScheduledTaskRuns(id as string, { limit: RUNS_PAGE_SIZE, cursor: pageParam }),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		enabled: !!id,
		staleTime: 10_000,
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
