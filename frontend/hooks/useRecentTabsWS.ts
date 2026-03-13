import { useEffect, useMemo, useRef } from "react";
import {
	type ListenerHandle,
	narratorWSManager,
	type SubscriptionHandle,
} from "../lib/narrator-ws-manager";
import type { NarratorListWSEvent } from "./useNarratorWS";

/**
 * Persistent WS subscription for RecentTabs real-time updates.
 *
 * Uses the global NarratorWSManager — no dedicated WebSocket connection.
 * Sends incremental subscribe/unsubscribe when narrator IDs change and
 * always receives global `user:*` events.
 */
export function useRecentTabsWS(
	narratorIds: string[],
	onUpdate: (narratorId: string, event: NarratorListWSEvent) => void,
	onGlobalEvent?: (event: { type: string; [key: string]: unknown }) => void,
	onReconnect?: () => void,
) {
	const onUpdateRef = useRef(onUpdate);
	onUpdateRef.current = onUpdate;
	const onGlobalEventRef = useRef(onGlobalEvent);
	onGlobalEventRef.current = onGlobalEvent;
	const onReconnectRef = useRef(onReconnect);
	onReconnectRef.current = onReconnect;

	const subHandleRef = useRef<SubscriptionHandle | null>(null);
	const presenceHandleIdRef = useRef<number | null>(null);
	const presenceIdsRef = useRef<Set<string>>(new Set());

	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	// --- Effect 1: mount-only — set up listener + connection tracking ---
	useEffect(() => {
		// Allocate a stable presence handle ID for this hook instance
		const presenceHandleId = narratorWSManager.allocateId();
		presenceHandleIdRef.current = presenceHandleId;

		const listenerHandle: ListenerHandle = narratorWSManager.addListener(
			{ narratorIds: "*" },
			(data) => {
				const nId = data.narratorId as string | undefined;
				if (data.type === "status_change" || data.type === "narrator:status_changed") {
					if (nId) onUpdateRef.current(nId, { type: "status", status: data.status as string });
				} else if (data.type === "title_updated" || data.type === "narrator:title_updated") {
					if (nId) onUpdateRef.current(nId, { type: "title", title: data.title as string });
				} else if (data.type === "permission_mode_changed") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "permissionMode",
							permissionMode: data.permissionMode as string,
						});
				} else if (data.type === "presence_update") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "presence",
							viewers: data.viewers as NarratorListWSEvent["viewers"],
						});
				} else if (data.type === "terminal_count_changed") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "terminalCount",
							activeTerminalCount: data.activeTerminalCount as number,
						});
				} else if (data.type === "container_status_changed") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "containerStatus",
							containerStatus: data.containerStatus as NarratorListWSEvent["containerStatus"],
						});
				} else if ((data.type as string).startsWith("user:")) {
					onGlobalEventRef.current?.(data as { type: string; [key: string]: unknown });
				}
			},
		);

		const unsubConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) {
				onReconnectRef.current?.();
			}
		});

		return () => {
			unsubConnection();
			narratorWSManager.removeListener(listenerHandle);
			// Clean up subscription
			if (subHandleRef.current) {
				narratorWSManager.unsubscribe(subHandleRef.current);
				subHandleRef.current = null;
			}
			// Clean up presence
			for (const id of presenceIdsRef.current) {
				narratorWSManager.leavePresence(id, presenceHandleId);
			}
			presenceIdsRef.current.clear();
		};
	}, []);

	// --- Effect 2: incremental subscribe/unsubscribe when IDs change ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a stable memoized serialization of narratorIds
	useEffect(() => {
		if (!subHandleRef.current) {
			subHandleRef.current = narratorWSManager.subscribe(narratorIds);
		} else {
			narratorWSManager.updateSubscription(subHandleRef.current, narratorIds);
		}

		// Presence diff
		const desired = new Set(narratorIds);
		const current = presenceIdsRef.current;
		const hId = presenceHandleIdRef.current ?? narratorWSManager.allocateId();

		for (const id of narratorIds) {
			if (!current.has(id)) {
				narratorWSManager.joinPresence(id, hId);
				current.add(id);
			}
		}
		for (const id of current) {
			if (!desired.has(id)) {
				narratorWSManager.leavePresence(id, hId);
				current.delete(id);
			}
		}
	}, [idsKey]);
}
