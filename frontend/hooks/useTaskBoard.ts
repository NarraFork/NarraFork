/**
 * The task board's queries (outline P2 PR 5): a session's board (its dock tab), a project's board
 * (the project page), the board's changes, and the status bar's current task. A session's board
 * and current task refresh on `outline_tasks_changed` (any outline write to the session's tasks)
 * and `spec_changed` (tasks.json); a project's board on window focus and every half minute, and
 * after the person's own changes.
 */
import type {
	OutlineBoardAddRequest,
	OutlineBoardTaskUpdateRequest,
} from "@shared/outline-task-board";
import { OUTLINE_TASKS_CHANGED_EVENT } from "@shared/outline-task-board";
import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export const taskBoardKeys = {
	all: ["task-board"] as const,
	session: (narratorId: string) => ["task-board", "session", narratorId] as const,
	project: (projectId: string) => ["task-board", "project", projectId] as const,
	current: (narratorId: string) => ["narrators", narratorId, "tasks", "current"] as const,
};

/** Every board and current task re-reads (after a person's change, which may show anywhere). */
export function invalidateTaskBoards(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: taskBoardKeys.all });
	void queryClient.invalidateQueries({
		predicate: (query) =>
			Array.isArray(query.queryKey) &&
			query.queryKey[0] === "narrators" &&
			query.queryKey[2] === "tasks" &&
			query.queryKey[3] === "current",
	});
}

/**
 * Re-read a session's board and current task when its tasks change. Subscribed whether or not the
 * reads are enabled yet (a first screen defers its GETs, never its live subscription).
 */
function useSessionTaskEvents(narratorId: string): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (!narratorId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: [OUTLINE_TASKS_CHANGED_EVENT, "spec_changed"] },
			(data) => {
				if (data.type === "spec_changed" && data.path !== "tasks.json" && data.source !== "reset")
					return;
				void queryClient.invalidateQueries({ queryKey: taskBoardKeys.session(narratorId) });
				void queryClient.invalidateQueries({ queryKey: taskBoardKeys.current(narratorId) });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, queryClient]);
}

/** A session's task board. */
export function useSessionTaskBoard(narratorId: string, enabled = true) {
	useSessionTaskEvents(narratorId);
	return useQuery({
		queryKey: taskBoardKeys.session(narratorId),
		queryFn: () => api.getSessionTaskBoard(narratorId),
		enabled: enabled && !!narratorId,
		retry: false,
		staleTime: 5_000,
	});
}

/** A project's task board, a page of spaces at a time. */
export function useProjectTaskBoard(projectId: string, enabled = true) {
	return useInfiniteQuery({
		queryKey: taskBoardKeys.project(projectId),
		queryFn: ({ pageParam }) => api.getProjectTaskBoard(projectId, pageParam),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled: enabled && !!projectId,
		retry: false,
		staleTime: 10_000,
		refetchInterval: 30_000,
		refetchOnWindowFocus: true,
	});
}

/** A person adds a task to a session ("Add", "Add and start"). */
export function useAddBoardTask(narratorId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: OutlineBoardAddRequest) => api.addBoardTask(narratorId, body),
		onSettled: () => invalidateTaskBoards(queryClient),
	});
}

/** A person changes one task (finish, cancel, reopen, hand over). */
export function useUpdateBoardTask() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { blockId: string; body: OutlineBoardTaskUpdateRequest }) =>
			api.updateBoardTask(input.blockId, input.body),
		onSettled: () => invalidateTaskBoards(queryClient),
	});
}

/**
 * The status bar's current task and the session's task backend (`spec` while the outline is
 * switched off), from the task source.
 */
export function useNarratorCurrentTask(narratorId: string, enabled = true) {
	useSessionTaskEvents(narratorId);
	return useQuery({
		queryKey: taskBoardKeys.current(narratorId),
		queryFn: () => api.getNarratorCurrentTask(narratorId),
		enabled: enabled && !!narratorId,
		retry: false,
		staleTime: 5_000,
	});
}
