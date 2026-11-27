import { useDebouncedValue } from "@mantine/hooks";
import type { TaskSchedule } from "@shared/scheduled-task-schedule";
import type { RunVerdict } from "@shared/scheduled-task-status";
import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { scheduledTasksApi as api, type ScheduledTaskInput } from "../lib/api/scheduled-tasks";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import type { ScheduledTaskSearch } from "../lib/scheduled-task-search";

export const scheduledTasksQueryKey = ["scheduled-tasks"] as const;
const GC_TIME_MS = 60_000;
const RUNS_PAGE_SIZE = 30;
const listeners = new WeakMap<QueryClient, { users: number; dispose: () => void }>();

function retainListener(client: QueryClient) {
	let entry = listeners.get(client);
	if (!entry) {
		let queued = false;
		let disposed = false;
		const invalidate = () => {
			if (queued || disposed) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (!disposed) void client.invalidateQueries({ queryKey: scheduledTasksQueryKey });
			});
		};
		const handle = narratorWSManager.addListener(
			{ types: ["scheduled_tasks_changed", "project_access_changed", "narrator_access_changed"] },
			(event) => {
				if (event.type === "project_access_changed" || event.type === "narrator_access_changed") {
					// Clear private labels before refetching, including requests still in flight.
					void client.resetQueries({ queryKey: scheduledTasksQueryKey });
				} else invalidate();
			},
		);
		const offConnection = narratorWSManager.onConnectionChange((connected) => {
			if (connected) invalidate();
		});
		entry = {
			users: 0,
			dispose: () => {
				disposed = true;
				narratorWSManager.removeListener(handle);
				offConnection();
			},
		};
		listeners.set(client, entry);
	}
	entry.users++;
	return () => {
		if (--entry.users === 0) {
			entry.dispose();
			listeners.delete(client);
		}
	};
}

function useScheduledTaskUpdates() {
	const client = useQueryClient();
	useEffect(() => retainListener(client), [client]);
}

export function useScheduledTasks(filters: ScheduledTaskSearch = {}) {
	useScheduledTaskUpdates();
	return useQuery({
		queryKey: [...scheduledTasksQueryKey, "list", filters],
		queryFn: ({ signal }) => api.listScheduledTasks(filters, signal),
		staleTime: 15_000,
		gcTime: GC_TIME_MS,
	});
}

export function useScheduledTask(id: string | undefined) {
	useScheduledTaskUpdates();
	return useQuery({
		queryKey: [...scheduledTasksQueryKey, "detail", id],
		queryFn: ({ signal }) => api.getScheduledTask(id as string, signal),
		enabled: !!id,
		staleTime: 15_000,
		gcTime: GC_TIME_MS,
		retry: false,
	});
}

export function useScheduledTaskRuns(id: string | undefined, result?: RunVerdict) {
	useScheduledTaskUpdates();
	return useInfiniteQuery({
		queryKey: [...scheduledTasksQueryKey, "detail", id, "runs", result],
		queryFn: ({ pageParam, signal }) =>
			api.listScheduledTaskRuns(
				id as string,
				{ limit: RUNS_PAGE_SIZE, cursor: pageParam, result },
				signal,
			),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: !!id,
		staleTime: 10_000,
		gcTime: GC_TIME_MS,
	});
}

export function useScheduledTaskTargets(search: string, enabled = true) {
	useScheduledTaskUpdates();
	const q = search.trim();
	const [debounced] = useDebouncedValue(q, 250);
	const query = useInfiniteQuery({
		queryKey: [...scheduledTasksQueryKey, "targets", q],
		queryFn: ({ pageParam, signal }) =>
			api.listScheduledTaskTargets({ q, limit: 30, cursor: pageParam }, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: enabled && q === debounced,
		staleTime: 10_000,
		gcTime: GC_TIME_MS,
		retry: false,
	});
	return { ...query, debouncing: q !== debounced };
}

export function useScheduledTaskAssociations(narratorId: string | undefined) {
	useScheduledTaskUpdates();
	return useInfiniteQuery({
		queryKey: [...scheduledTasksQueryKey, "for-narrator", narratorId],
		queryFn: ({ pageParam, signal }) =>
			api.listScheduledTaskAssociations(
				narratorId as string,
				{ limit: 20, cursor: pageParam },
				signal,
			),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: !!narratorId,
		staleTime: 10_000,
		gcTime: GC_TIME_MS,
		retry: false,
	});
}

/** Changing the key immediately cancels obsolete requests; only stable input is fetched. */
export function useSchedulePreview(
	schedule: TaskSchedule,
	timezone: string | null,
	firedCount = 0,
) {
	const input = JSON.stringify({ schedule, timezone, firedCount, count: 5 });
	const [debounced] = useDebouncedValue(input, 350);
	const query = useQuery({
		queryKey: [...scheduledTasksQueryKey, "preview", input],
		queryFn: ({ signal }) => api.previewScheduledTask(JSON.parse(input), signal),
		enabled: input === debounced,
		staleTime: 30_000,
		gcTime: 0,
		retry: false,
	});
	return { ...query, debouncing: input !== debounced };
}

export function useCreateScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: ScheduledTaskInput) => api.createScheduledTask(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: scheduledTasksQueryKey }),
	});
}
export function useUpdateScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: Partial<ScheduledTaskInput> }) =>
			api.updateScheduledTask(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: scheduledTasksQueryKey }),
	});
}
export function useToggleScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			api.toggleScheduledTask(id, enabled),
		onSuccess: () => qc.invalidateQueries({ queryKey: scheduledTasksQueryKey }),
	});
}
export function useRunScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.runScheduledTask(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: scheduledTasksQueryKey }),
	});
}
export function useCleanupScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.cleanupScheduledTask(id),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: scheduledTasksQueryKey });
			void qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}
export function useTransferScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ownerUserId }: { id: string; ownerUserId: string }) =>
			api.transferScheduledTask(id, ownerUserId),
		onSuccess: () => qc.invalidateQueries({ queryKey: scheduledTasksQueryKey }),
	});
}
export function useDeleteScheduledTask() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteScheduledTask(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: scheduledTasksQueryKey }),
	});
}
