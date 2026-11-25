import { useEffect, useMemo, useRef } from "react";
import {
	type ListenerHandle,
	narratorWSManager,
	type SubscriptionHandle,
} from "../lib/narrator-ws-manager";
import { isRecentTabsScopeCurrent, type RecentTabsScope } from "../lib/recent-tabs-owner";
import { useAsyncQuestionListChange } from "./useAsyncQuestions";
import type { NarratorListWSEvent } from "./useNarratorWS";

export const RECENT_TABS_LIST_EVENT_TYPES = [
	"status_change",
	"substatus_change",
	"status_notification",
	"narrator:status_changed",
	"title_updated",
	"narrator:title_updated",
	"permission_mode_changed",
	"presence_update",
	"terminal_count_changed",
	"background_task_count_changed",
	"draft_changed",
	"goals_set",
	"list_state_snapshot",
	"async_question_changed",
] as const;

type RecentTabsWSUpdate = (narratorId: string, event: NarratorListWSEvent) => void;
type RecentTabsStatusVersion = { statusEpoch: string; statusRevision: number };
type RecentTabsAcceptedStatus = {
	status?: string;
	substatus?: string[];
	turnStartedAt?: string;
	statusEpoch?: string;
};

/** A late done can notify, but must never resurrect a previous turn or an already-read state. */
export function recentTabsStatusNotification(
	current: RecentTabsAcceptedStatus | undefined,
	data: Record<string, unknown>,
): NarratorListWSEvent | null {
	if (
		!current ||
		typeof data.statusEpoch !== "string" ||
		current.statusEpoch !== data.statusEpoch ||
		typeof data.turnStartedAt !== "string" ||
		current.turnStartedAt !== data.turnStartedAt ||
		current.status !== "idle" ||
		!current.substatus?.includes("unread") ||
		data.status !== "idle" ||
		!Array.isArray(data.substatus) ||
		!data.substatus.includes("unread")
	)
		return null;
	return {
		type: "status",
		notificationOnly: true,
		status: "idle",
		substatus: data.substatus.filter((value): value is string => typeof value === "string"),
		turnStartedAt: data.turnStartedAt,
		...(typeof data.backgroundWorkActive === "boolean"
			? { backgroundWorkActive: data.backgroundWorkActive }
			: {}),
	};
}
type AcceptSnapshotStatus = (narratorId: string, state: Record<string, unknown>) => boolean;

/** The list domain has its own watermark: lightweight snapshots must not advance full-frame state. */
export function acceptRecentTabsStatusVersion(
	versions: Map<string, RecentTabsStatusVersion>,
	narratorId: string,
	data: Record<string, unknown>,
): boolean {
	const { statusEpoch, statusRevision } = data;
	if (
		typeof statusEpoch !== "string" ||
		!statusEpoch ||
		typeof statusRevision !== "number" ||
		!Number.isSafeInteger(statusRevision) ||
		statusRevision < 0
	)
		return true; // Preserve legacy producers without manufacturing an ordering proof.
	const previous = versions.get(narratorId);
	if (previous?.statusEpoch === statusEpoch && previous.statusRevision > statusRevision)
		return false;
	versions.set(narratorId, { statusEpoch, statusRevision });
	return true;
}

function dispatchListStateItem(
	item: Record<string, unknown>,
	onUpdate: RecentTabsWSUpdate,
	acceptStatus?: AcceptSnapshotStatus,
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
	if (
		(typeof state.status === "string" || Array.isArray(state.substatus)) &&
		(!acceptStatus || acceptStatus(narratorId, state))
	) {
		onUpdate(narratorId, {
			type: "status",
			status: typeof state.status === "string" ? state.status : undefined,
			substatus: Array.isArray(state.substatus)
				? state.substatus.filter((value): value is string => typeof value === "string")
				: undefined,
			turnStartedAt: typeof state.turnStartedAt === "string" ? state.turnStartedAt : undefined,
			// Snapshot replay of the done-transition suppression flag (see
			// sendListStateSnapshot server-side) — suppresses sound/PWA on resubscribe
			// the same way the live status_change flag does.
			...(state.backgroundWorkActive === true ? { backgroundWorkActive: true } : {}),
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
	if (typeof state.hasDraft === "boolean") {
		onUpdate(narratorId, { type: "draft", hasDraft: state.hasDraft });
	}
	return true;
}

export function dispatchRecentTabsListStateSnapshot(
	data: Record<string, unknown>,
	onUpdate: RecentTabsWSUpdate,
	acceptStatus?: AcceptSnapshotStatus,
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
		if (item && typeof item === "object" && dispatchListStateItem(item, onUpdate, acceptStatus))
			count++;
	}
	return count;
}

/** Persistent shared-WS subscription for the bounded RecentTabs live window. */
export function useRecentTabsWS(
	scope: RecentTabsScope,
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
	const statusVersionsRef = useRef(new Map<string, RecentTabsStatusVersion>());
	const acceptedStatusesRef = useRef(new Map<string, RecentTabsAcceptedStatus>());
	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	useEffect(() => {
		const acceptsFrame = () =>
			isRecentTabsScopeCurrent(scope) &&
			narratorWSManager.getConnectionAuthGeneration() === scope.authGeneration;
		const rememberStatus = (narratorId: string, data: Record<string, unknown>) => {
			const substatus = Array.isArray(data.substatus)
				? data.substatus.filter((value): value is string => typeof value === "string")
				: undefined;
			if (typeof data.status === "string") {
				// A full list state establishes its own turn proof; missing/null turn clears it.
				acceptedStatusesRef.current.set(narratorId, {
					status: data.status,
					substatus,
					turnStartedAt: typeof data.turnStartedAt === "string" ? data.turnStartedAt : undefined,
					statusEpoch: typeof data.statusEpoch === "string" ? data.statusEpoch : undefined,
				});
			} else if (substatus) {
				acceptedStatusesRef.current.set(narratorId, {
					...acceptedStatusesRef.current.get(narratorId),
					substatus,
				});
			}
		};
		const notifyLateStatus = (narratorId: string, data: Record<string, unknown>) => {
			const notification = recentTabsStatusNotification(
				acceptedStatusesRef.current.get(narratorId),
				data,
			);
			if (notification) onUpdateRef.current(narratorId, notification);
		};
		const narratorListenerHandle: ListenerHandle = narratorWSManager.addListener(
			{
				narratorIds: "*",
				types: [...RECENT_TABS_LIST_EVENT_TYPES],
			},
			(data) => {
				if (!acceptsFrame()) return;
				if (data.type === "list_state_snapshot") {
					dispatchRecentTabsListStateSnapshot(
						data,
						(narratorId, event) => {
							if (narratorIdSetRef.current.has(narratorId)) {
								onUpdateRef.current(narratorId, event);
							}
						},
						(narratorId, state) => {
							if (
								!narratorIdSetRef.current.has(narratorId) ||
								narratorWSManager.isStatusVersionStale(narratorId, state) ||
								!acceptRecentTabsStatusVersion(statusVersionsRef.current, narratorId, state)
							)
								return false;
							rememberStatus(narratorId, state);
							return true;
						},
					);
					return;
				}
				const narratorId = data.narratorId as string | undefined;
				if (!narratorId || !narratorIdSetRef.current.has(narratorId)) return;
				if (data.type === "status_notification") {
					notifyLateStatus(narratorId, data);
					return;
				}

				if (
					data.type === "status_change" ||
					data.type === "narrator:status_changed" ||
					(data.type === "substatus_change" && typeof data.status === "string")
				) {
					if (!acceptRecentTabsStatusVersion(statusVersionsRef.current, narratorId, data)) {
						if (data.type !== "substatus_change") notifyLateStatus(narratorId, data);
						return;
					}
					rememberStatus(narratorId, data);
					onUpdateRef.current(narratorId, {
						type: "status",
						status: data.status as string,
						substatus: data.substatus as string[] | undefined,
						...(data.type === "substatus_change" ? { stateOnly: true } : {}),
						turnStartedAt: data.turnStartedAt as string | undefined,
						...(data.backgroundWorkActive === true ? { backgroundWorkActive: true } : {}),
					});
				} else if (data.type === "substatus_change") {
					rememberStatus(narratorId, data);
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
			(data) => {
				if (acceptsFrame())
					onGlobalEventRef.current?.(data as { type: string; [key: string]: unknown });
			},
		);
		const unsubscribeConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (!connected || !acceptsFrame()) return;
			statusVersionsRef.current.clear();
			acceptedStatusesRef.current.clear();
			if (isReconnect) onReconnectRef.current?.();
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
	}, [applyQuestionChange, scope]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is the stable serialization
	useEffect(() => {
		const desired = new Set(narratorIds);
		narratorIdSetRef.current = desired;
		for (const narratorId of statusVersionsRef.current.keys()) {
			if (!desired.has(narratorId)) statusVersionsRef.current.delete(narratorId);
		}
		for (const narratorId of acceptedStatusesRef.current.keys()) {
			if (!desired.has(narratorId)) acceptedStatusesRef.current.delete(narratorId);
		}
		if (!subHandleRef.current) {
			subHandleRef.current = narratorWSManager.subscribe(narratorIds, { kind: "list" });
		} else {
			narratorWSManager.updateSubscription(subHandleRef.current, narratorIds);
		}
	}, [idsKey, scope]);
}
