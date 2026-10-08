import { useEffect, useMemo, useRef } from "react";
import {
	type ListenerHandle,
	narratorWSManager,
	type SubscriptionHandle,
} from "../lib/narrator-ws-manager";
import { useAsyncQuestionListChange } from "./useAsyncQuestions";
import type { NarratorListWSEvent } from "./useNarratorWS";

export const RECENT_TABS_LIST_EVENT_TYPES = [
	"status_change",
	"substatus_change",
	"narrator:status_changed",
	"title_updated",
	"narrator:title_updated",
	"permission_mode_changed",
	"presence_update",
	"terminal_count_changed",
	"background_task_count_changed",
	"container_status_changed",
	"draft_changed",
	"goals_set",
	"list_state_snapshot",
	"async_question_changed",
] as const;

type RecentTabsWSUpdate = (narratorId: string, event: NarratorListWSEvent) => void;

function dispatchListStateItem(
	item: Record<string, unknown>,
	onUpdate: RecentTabsWSUpdate,
): boolean {
	const narratorId = typeof item.narratorId === "string" ? item.narratorId : undefined;
	if (!narratorId) return false;
	const state =
		item.state && typeof item.state === "object"
			? ({ ...item, ...(item.state as Record<string, unknown>) } as Record<string, unknown>)
			: item;
	if (typeof state.title === "string") {
		onUpdate(narratorId, { type: "title", title: state.title });
	}
	if (typeof state.status === "string" || Array.isArray(state.substatus)) {
		onUpdate(narratorId, {
			type: "status",
			status: typeof state.status === "string" ? state.status : undefined,
			substatus: Array.isArray(state.substatus)
				? state.substatus.filter((value): value is string => typeof value === "string")
				: undefined,
			turnStartedAt: typeof state.turnStartedAt === "string" ? state.turnStartedAt : undefined,
		});
	}
	if (Array.isArray(state.viewers)) {
		onUpdate(narratorId, {
			type: "presence",
			viewers: state.viewers as NarratorListWSEvent["viewers"],
		});
	}
	if (typeof state.activeTerminalCount === "number") {
		onUpdate(narratorId, {
			type: "terminalCount",
			activeTerminalCount: state.activeTerminalCount,
		});
	}
	if (typeof state.activeBackgroundTaskCount === "number") {
		onUpdate(narratorId, {
			type: "backgroundTaskCount",
			activeBackgroundTaskCount: state.activeBackgroundTaskCount,
			activeBackgroundWorkCount: state.activeBackgroundWorkCount as number | undefined,
			activeBackgroundServiceCount: state.activeBackgroundServiceCount as number | undefined,
		});
	}
	if ("containerStatus" in state) {
		onUpdate(narratorId, {
			type: "containerStatus",
			containerStatus: state.containerStatus as NarratorListWSEvent["containerStatus"],
		});
	}
	if (typeof state.hasDraft === "boolean") {
		onUpdate(narratorId, { type: "draft", hasDraft: state.hasDraft });
	}
	return true;
}

export function dispatchRecentTabsListStateSnapshot(
	data: Record<string, unknown>,
	onUpdate: RecentTabsWSUpdate,
): number {
	const raw = Array.isArray(data.items)
		? data.items
		: Array.isArray(data.states)
			? data.states
			: Array.isArray(data.narrators)
				? data.narrators
				: [];
	let count = 0;
	for (const item of raw) {
		if (item && typeof item === "object" && dispatchListStateItem(item, onUpdate)) count++;
	}
	return count;
}

/** Persistent shared-WS subscription for the bounded RecentTabs live window. */
export function useRecentTabsWS(
	narratorIds: string[],
	onUpdate: RecentTabsWSUpdate,
	onGlobalEvent?: (event: { type: string; [key: string]: unknown }) => void,
	onReconnect?: () => void,
) {
	const applyQuestionChange = useAsyncQuestionListChange();
	const onUpdateRef = useRef(onUpdate);
	onUpdateRef.current = onUpdate;
	const onGlobalEventRef = useRef(onGlobalEvent);
	onGlobalEventRef.current = onGlobalEvent;
	const onReconnectRef = useRef(onReconnect);
	onReconnectRef.current = onReconnect;

	const subHandleRef = useRef<SubscriptionHandle | null>(null);
	const narratorIdSetRef = useRef<Set<string>>(new Set(narratorIds));
	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	useEffect(() => {
		const narratorListenerHandle: ListenerHandle = narratorWSManager.addListener(
			{
				narratorIds: "*",
				types: [...RECENT_TABS_LIST_EVENT_TYPES],
			},
			(data) => {
				if (data.type === "list_state_snapshot") {
					dispatchRecentTabsListStateSnapshot(data, (narratorId, event) => {
						if (narratorIdSetRef.current.has(narratorId)) {
							onUpdateRef.current(narratorId, event);
						}
					});
					return;
				}
				const narratorId = data.narratorId as string | undefined;
				if (!narratorId || !narratorIdSetRef.current.has(narratorId)) return;

				if (data.type === "status_change" || data.type === "narrator:status_changed") {
					onUpdateRef.current(narratorId, {
						type: "status",
						status: data.status as string,
						substatus: data.substatus as string[] | undefined,
						turnStartedAt: data.turnStartedAt as string | undefined,
					});
				} else if (data.type === "substatus_change") {
					onUpdateRef.current(narratorId, {
						type: "status",
						substatus: data.substatus as string[],
					});
				} else if (data.type === "title_updated" || data.type === "narrator:title_updated") {
					onUpdateRef.current(narratorId, { type: "title", title: data.title as string });
				} else if (data.type === "permission_mode_changed") {
					onUpdateRef.current(narratorId, {
						type: "permissionMode",
						permissionMode: data.permissionMode as string,
					});
				} else if (data.type === "presence_update") {
					onUpdateRef.current(narratorId, {
						type: "presence",
						viewers: data.viewers as NarratorListWSEvent["viewers"],
					});
				} else if (data.type === "terminal_count_changed") {
					onUpdateRef.current(narratorId, {
						type: "terminalCount",
						activeTerminalCount: data.activeTerminalCount as number,
					});
				} else if (data.type === "background_task_count_changed") {
					onUpdateRef.current(narratorId, {
						type: "backgroundTaskCount",
						activeBackgroundTaskCount: data.activeBackgroundTaskCount as number,
						activeBackgroundWorkCount: data.activeBackgroundWorkCount as number | undefined,
						activeBackgroundServiceCount: data.activeBackgroundServiceCount as number | undefined,
					});
				} else if (data.type === "container_status_changed") {
					onUpdateRef.current(narratorId, {
						type: "containerStatus",
						containerStatus: data.containerStatus as NarratorListWSEvent["containerStatus"],
					});
				} else if (data.type === "draft_changed") {
					onUpdateRef.current(narratorId, { type: "draft", hasDraft: !!data.hasDraft });
				} else if (data.type === "async_question_changed") {
					const event = applyQuestionChange(data);
					if (event) onUpdateRef.current(narratorId, event);
				}
			},
		);

		const globalListenerHandle: ListenerHandle = narratorWSManager.addListener(
			{ typePrefixes: ["user:", "group:"] },
			(data) => onGlobalEventRef.current?.(data as { type: string; [key: string]: unknown }),
		);
		const unsubscribeConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) onReconnectRef.current?.();
		});

		return () => {
			unsubscribeConnection();
			narratorWSManager.removeListener(narratorListenerHandle);
			narratorWSManager.removeListener(globalListenerHandle);
			if (subHandleRef.current) {
				narratorWSManager.unsubscribe(subHandleRef.current);
				subHandleRef.current = null;
			}
		};
	}, [applyQuestionChange]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is the stable serialization
	useEffect(() => {
		const desired = new Set(narratorIds);
		narratorIdSetRef.current = desired;
		if (!subHandleRef.current) {
			subHandleRef.current = narratorWSManager.subscribe(narratorIds, { kind: "list" });
		} else {
			narratorWSManager.updateSubscription(subHandleRef.current, narratorIds);
		}
	}, [idsKey]);
}
