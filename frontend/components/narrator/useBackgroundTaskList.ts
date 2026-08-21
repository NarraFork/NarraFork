/**
 * Background-task list data source.
 *
 * ## Why this exists
 *
 * The task list used to be polled — every 3 s while the panel was open, every
 * 10 s while it was closed (the toolbar badge kept the query alive), plus a
 * third poll from `ToolCallCard`. Each tick refetched a narrator's ENTIRE task
 * history: hundreds of long-finished rows, and on the legacy path their full
 * result text. One real narrator in this repo's database has 107 such rows
 * totalling ~600 KB, all of them dead.
 *
 * This hook replaces that with cursor paging plus `background_task_list_delta`
 * frames. There is deliberately NO `refetchInterval` anywhere in it.
 */

import type { BackgroundTaskListDelta, BackgroundTaskListItem } from "@shared/background-task-list";
import { BACKGROUND_TASK_LIST_PAGE_SIZE } from "@shared/background-task-list";
import { type InfiniteData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import {
	applyBackgroundTaskDelta,
	type BackgroundTaskListState,
	flattenBackgroundTaskList,
	toBackgroundTaskListState,
} from "./background-task-list-state";

type BackgroundTaskPage = Awaited<ReturnType<typeof api.listBackgroundTasks>>;
type BackgroundTaskInfiniteData = InfiniteData<BackgroundTaskPage, string | null>;

export function backgroundTaskListQueryKey(narratorId: string): readonly unknown[] {
	return ["background-tasks", narratorId];
}

/**
 * Debounce for the `subagent_status_changed` fallback refetch.
 *
 * `continued` and `child_running` are derived from NARRATOR state, not from the
 * task row, so they produce no task delta — a subagent that starts working again
 * after its task row went terminal would otherwise leave the badge permanently
 * wrong.
 *
 * The window is deliberately several seconds rather than one: this hook is
 * mounted by the toolbar badge on every narrator panel (no open panel required),
 * a parent with several live subagents emits these frames frequently, and the
 * refetch pulls page 0 including its `activeTasks` set. At one second per frame
 * this fallback could cost MORE than the 10 s poll it replaced.
 */
const SUBAGENT_STATUS_REFETCH_DEBOUNCE_MS = 5_000;

export interface BackgroundTaskListResult {
	tasks: BackgroundTaskListItem[];
	activeCount: number;
	activeTruncated: boolean;
	isLoading: boolean;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	fetchNextPage: () => void;
	/** Drop cached pages and reload from the first page. */
	refresh: () => void;
}

/**
 * Paged, delta-driven task list for one parent narrator.
 *
 * Keyed identically for the panel body and the toolbar badge so React Query
 * dedupes them into a single request per narrator; the badge reads `activeCount`
 * (a server-side count) rather than counting rows it would otherwise have to
 * load in full.
 */
export function useBackgroundTaskList(
	narratorId: string,
	enabled: boolean,
): BackgroundTaskListResult {
	const qc = useQueryClient();
	const queryKey = useMemo(() => backgroundTaskListQueryKey(narratorId), [narratorId]);

	const query = useInfiniteQuery({
		queryKey,
		queryFn: ({ pageParam }) =>
			api.listBackgroundTasks(narratorId, {
				limit: BACKGROUND_TASK_LIST_PAGE_SIZE,
				cursor: pageParam,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		enabled,
		// Steady state is delta-driven. A timer here would reintroduce exactly the
		// traffic this hook exists to remove.
		refetchInterval: false,
		staleTime: 30_000,
		gcTime: 60_000,
	});

	/**
	 * Reload the list.
	 *
	 * `dropPages` distinguishes the two reasons this is called:
	 *
	 * - After a gap/invalidate/epoch change the cached cursors may address rows that
	 *   no longer exist, so keeping later pages would stitch a window that was never
	 *   contiguous. Those callers drop back to page 1.
	 * - The `subagent_status_changed` fallback is only re-deriving narrator-derived
	 *   statuses; the pages themselves are still valid. Dropping them there would
	 *   silently undo every "load older tasks" click each time any subagent changed
	 *   state, which on a busy parent is constantly.
	 */
	const reload = useCallback(
		(opts?: { dropPages?: boolean }) => {
			if (opts?.dropPages) {
				qc.setQueryData<BackgroundTaskInfiniteData>(queryKey, (old) =>
					old && old.pages.length > 1
						? { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) }
						: old,
				);
			}
			void qc.invalidateQueries({ queryKey });
		},
		[qc, queryKey],
	);

	const refresh = useCallback(() => reload({ dropPages: true }), [reload]);

	const reloadRef = useRef(reload);
	reloadRef.current = reload;

	// --- Delta application -------------------------------------------------
	const applyDelta = useCallback(
		(delta: BackgroundTaskListDelta) => {
			let needsRefresh = false;
			qc.setQueryData<BackgroundTaskInfiniteData>(queryKey, (old) => {
				if (!old) {
					// Nothing cached: there is no list to patch, and no list on screen to
					// go stale. The next mount fetches fresh.
					return old;
				}
				const state = toBackgroundTaskListState(old.pages);
				const outcome = applyBackgroundTaskDelta(state, delta);
				if (outcome.kind === "refetch") {
					needsRefresh = true;
					return old;
				}
				if (outcome.kind !== "applied") return old;
				return { ...old, pages: outcome.state.pages as BackgroundTaskPage[] };
			});
			// A delta the reducer could not apply means the cached cursors are suspect,
			// so this is the branch that must drop back to page 1.
			if (needsRefresh) reloadRef.current({ dropPages: true });
		},
		[qc, queryKey],
	);

	// --- WS wiring ---------------------------------------------------------
	useEffect(() => {
		if (!enabled || !narratorId) return;
		const subscription = narratorWSManager.subscribe([narratorId], { kind: "list" });

		let subagentTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleSubagentRefresh = () => {
			if (subagentTimer) return;
			subagentTimer = setTimeout(() => {
				subagentTimer = undefined;
				// Keep the loaded pages: this only re-derives narrator-derived statuses.
				reloadRef.current();
			}, SUBAGENT_STATUS_REFETCH_DEBOUNCE_MS);
		};

		const listener = narratorWSManager.addListener(
			{
				narratorIds: [narratorId],
				types: ["background_task_list_delta", "subagent_status_changed"],
			},
			(data) => {
				if (data.type === "subagent_status_changed") {
					scheduleSubagentRefresh();
					return;
				}
				applyDelta({
					listEpoch: data.listEpoch as string,
					version: data.version as number,
					activeCount: data.activeCount as number,
					upsert: data.upsert as BackgroundTaskListDelta["upsert"],
					removeIds: data.removeIds as string[] | undefined,
					invalidate: data.invalidate as boolean | undefined,
				});
			},
		);

		// A reconnect always means lost deltas: whatever changed while the socket was
		// down produced frames nobody received, so the cached version can no longer
		// be contiguous with the server's. Refetch rather than wait for the next
		// delta to be diagnosed as a gap (which would leave the list wrong until
		// something happens to change).
		const offConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) reloadRef.current({ dropPages: true });
		});

		return () => {
			if (subagentTimer) clearTimeout(subagentTimer);
			offConnection();
			narratorWSManager.removeListener(listener);
			narratorWSManager.unsubscribe(subscription);
		};
	}, [applyDelta, enabled, narratorId]);

	// --- Derived view ------------------------------------------------------
	const state: BackgroundTaskListState | null = useMemo(
		() => (query.data ? toBackgroundTaskListState(query.data.pages) : null),
		[query.data],
	);
	const tasks = useMemo(() => flattenBackgroundTaskList(state), [state]);

	const fetchNextPage = useCallback(() => {
		if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
	}, [query]);

	return {
		tasks,
		activeCount: state?.activeCount ?? 0,
		activeTruncated: state?.activeTruncated ?? false,
		isLoading: query.isLoading,
		hasNextPage: !!query.hasNextPage,
		isFetchingNextPage: query.isFetchingNextPage,
		fetchNextPage,
		refresh,
	};
}
