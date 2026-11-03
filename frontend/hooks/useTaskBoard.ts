/**
 * The task board's queries (outline P2 PR 5): a session's board (its dock tab), a project's board
 * (the project page), the board's changes, and the status bar's current task. A session's board
 * and current task refresh on `outline_tasks_changed` (a structural change to the session's tasks,
 * never a text-only commit) and `spec_changed` (tasks.json). A project's board is one query per
 * page of spaces: only the first refreshes on window focus and every half minute (review round 1
 * S5: the pages loaded with "More sessions" are not re-read on a timer); every loaded page
 * re-reads after the person's own changes.
 */
import type {
	OutlineBoardAddRequest,
	OutlineBoardTaskUpdateRequest,
} from "@shared/outline-task-board";
import { OUTLINE_TASKS_CHANGED_EVENT } from "@shared/outline-task-board";
import {
	type QueryClient,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export const taskBoardKeys = {
	all: ["task-board"] as const,
	session: (narratorId: string) => ["task-board", "session", narratorId] as const,
	project: (projectId: string) => ["task-board", "project", projectId] as const,
	projectPage: (projectId: string, cursor: string | null) =>
		["task-board", "project", projectId, cursor ?? ""] as const,
	current: (narratorId: string) => ["narrators", narratorId, "tasks", "current"] as const,
};

/** Every board and current task re-reads (after a person's change, which may show anywhere). */
export function invalidateTaskBoards(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: taskBoardKeys.all }, { cancelRefetch: false });
	void queryClient.invalidateQueries(
		{
			predicate: (query) =>
				Array.isArray(query.queryKey) &&
				query.queryKey[0] === "narrators" &&
				query.queryKey[2] === "tasks" &&
				query.queryKey[3] === "current",
		},
		{ cancelRefetch: false },
	);
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
				// Several views of one session each listen: a read already under way is shared,
				// not restarted.
				void queryClient.invalidateQueries(
					{ queryKey: taskBoardKeys.session(narratorId) },
					{ cancelRefetch: false },
				);
				void queryClient.invalidateQueries(
					{ queryKey: taskBoardKeys.current(narratorId) },
					{ cancelRefetch: false },
				);
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

/** How often the first page of a project's board refreshes on its own. */
export const PROJECT_BOARD_REFRESH_MS = 30_000;

/**
 * A project's task board, a page of spaces at a time: one query per page, so the timer and window
 * focus re-read the first page only. A page's cursor comes from the page before it as first read;
 * a later refresh of that page does not move the pages after it.
 */
export function useProjectTaskBoard(projectId: string, enabled = true) {
	const [state, setState] = useState<{ projectId: string; cursors: Array<string | null> }>({
		projectId,
		cursors: [null],
	});
	const cursors = state.projectId === projectId ? state.cursors : [null];
	const results = useQueries({
		queries: cursors.map((cursor, index) => ({
			queryKey: taskBoardKeys.projectPage(projectId, cursor),
			queryFn: () => api.getProjectTaskBoard(projectId, cursor),
			enabled: enabled && !!projectId,
			retry: false,
			staleTime: index === 0 ? 10_000 : Number.POSITIVE_INFINITY,
			refetchInterval: index === 0 ? PROJECT_BOARD_REFRESH_MS : (false as const),
			refetchOnWindowFocus: index === 0,
		})),
	});
	const last = results.at(-1);
	const nextCursor = last?.data?.nextCursor ?? null;
	const fetchNextPage = useCallback(() => {
		if (!nextCursor) return;
		setState((prev) => {
			const current = prev.projectId === projectId ? prev.cursors : [null];
			return current.includes(nextCursor) ? prev : { projectId, cursors: [...current, nextCursor] };
		});
	}, [nextCursor, projectId]);
	const first = results[0];
	const pages = results.flatMap((result) => (result.data ? [result.data] : []));
	return {
		pages,
		isLoading: !!first?.isLoading,
		error: first?.error ?? null,
		hasNextPage: nextCursor !== null,
		isFetchingNextPage: results.length > 1 && !!last?.isLoading,
		fetchNextPage,
	};
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
