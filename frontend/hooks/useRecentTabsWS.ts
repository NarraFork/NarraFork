import { useEffect, useMemo, useRef } from "react";
import { getToken } from "../lib/api";
import { buildWsUrl, safeCloseWs } from "../lib/ws";
import type { NarratorListWSEvent } from "./useNarratorWS";

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Persistent WS connection for RecentTabs real-time updates.
 *
 * Unlike useNarratorsListWS, this hook:
 * - Keeps a single WS connection alive for the entire component lifetime
 * - Sends incremental subscribe/unsubscribe messages when narrator IDs change
 *   (instead of tearing down and rebuilding the connection)
 * - Always stays connected to receive global `user:*` events
 */
export function useRecentTabsWS(
	narratorIds: string[],
	onUpdate: (narratorId: string, event: NarratorListWSEvent) => void,
	onGlobalEvent?: (event: { type: string; [key: string]: unknown }) => void,
	onReconnect?: () => void,
) {
	const wsRef = useRef<WebSocket | null>(null);
	const onUpdateRef = useRef(onUpdate);
	onUpdateRef.current = onUpdate;
	const onGlobalEventRef = useRef(onGlobalEvent);
	onGlobalEventRef.current = onGlobalEvent;
	const onReconnectRef = useRef(onReconnect);
	onReconnectRef.current = onReconnect;

	// Track which IDs are currently subscribed on the server side
	const subscribedIdsRef = useRef<Set<string>>(new Set());
	// Latest desired IDs (for reconnect)
	const desiredIdsRef = useRef<string[]>([]);

	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	// --- Effect 1: establish and maintain a persistent WS connection ---
	useEffect(() => {
		let cancelled = false;
		let attempts = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

		function connect() {
			if (cancelled) return;

			const token = getToken();
			const tokenQuery = token ? `token=${encodeURIComponent(token)}` : "";
			const ws = new WebSocket(buildWsUrl("/ws/narrator", tokenQuery));
			wsRef.current = ws;

			ws.onopen = () => {
				if (cancelled) {
					ws.close();
					return;
				}
				const isReconnect = attempts > 0;
				attempts = 0;
				// Re-subscribe to all currently desired IDs
				subscribedIdsRef.current.clear();
				const ids = desiredIdsRef.current;
				if (ids.length) {
					ws.send(JSON.stringify({ type: "subscribe", narratorIds: ids }));
					for (const id of ids) {
						subscribedIdsRef.current.add(id);
						ws.send(JSON.stringify({ type: "presence_join", narratorId: id }));
					}
				}
				// On reconnect, notify caller to refresh stale data
				if (isReconnect) {
					onReconnectRef.current?.();
				}
			};

			ws.onmessage = (event) => {
				if (cancelled) return;
				try {
					const data = JSON.parse(event.data);
					const nId = data.narratorId;
					if (data.type === "status_change" || data.type === "narrator:status_changed") {
						onUpdateRef.current(nId, { type: "status", status: data.status });
					} else if (data.type === "title_updated" || data.type === "narrator:title_updated") {
						onUpdateRef.current(nId, { type: "title", title: data.title });
					} else if (data.type === "plan_mode_changed") {
						onUpdateRef.current(nId, { type: "planMode", planMode: data.planMode });
					} else if (data.type === "presence_update") {
						onUpdateRef.current(nId, { type: "presence", viewers: data.viewers });
					} else if (data.type === "terminal_count_changed") {
						onUpdateRef.current(nId, {
							type: "terminalCount",
							activeTerminalCount: data.activeTerminalCount,
						});
					} else if (data.type === "container_status_changed") {
						onUpdateRef.current(nId, {
							type: "containerStatus",
							containerStatus: data.containerStatus,
						});
					} else if (data.type === "ping") {
						ws.send(JSON.stringify({ type: "pong" }));
					} else if (data.type.startsWith("user:")) {
						onGlobalEventRef.current?.(data);
					}
				} catch (err) {
					if (import.meta.env.DEV)
						console.warn("[useRecentTabsWS] Failed to parse WS message:", err);
				}
			};

			ws.onclose = () => {
				if (cancelled) return;
				subscribedIdsRef.current.clear();
				scheduleReconnect();
			};
			ws.onerror = () => {};
		}

		function scheduleReconnect() {
			if (cancelled) return;
			const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
			attempts++;
			reconnectTimer = setTimeout(connect, delay);
		}

		connect();

		return () => {
			cancelled = true;
			clearTimeout(reconnectTimer);
			const ws = wsRef.current;
			const subbed = [...subscribedIdsRef.current];
			safeCloseWs(ws, (w) => {
				if (subbed.length) {
					for (const id of subbed) {
						w.send(JSON.stringify({ type: "presence_leave", narratorId: id }));
					}
					w.send(JSON.stringify({ type: "unsubscribe", narratorIds: subbed }));
				}
			});
			subscribedIdsRef.current.clear();
		};
	}, []); // Mount-only — connection persists across ID changes

	// --- Effect 2: incremental subscribe/unsubscribe when IDs change ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a stable memoized serialization of narratorIds
	useEffect(() => {
		desiredIdsRef.current = narratorIds;

		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;

		const desired = new Set(narratorIds);
		const current = subscribedIdsRef.current;

		// IDs to subscribe (in desired but not yet subscribed)
		const toSubscribe = narratorIds.filter((id) => !current.has(id));
		// IDs to unsubscribe (currently subscribed but no longer desired)
		const toUnsubscribe = [...current].filter((id) => !desired.has(id));

		if (toUnsubscribe.length) {
			for (const id of toUnsubscribe) {
				ws.send(JSON.stringify({ type: "presence_leave", narratorId: id }));
			}
			ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: toUnsubscribe }));
			for (const id of toUnsubscribe) current.delete(id);
		}
		if (toSubscribe.length) {
			ws.send(JSON.stringify({ type: "subscribe", narratorIds: toSubscribe }));
			for (const id of toSubscribe) {
				current.add(id);
				ws.send(JSON.stringify({ type: "presence_join", narratorId: id }));
			}
		}
	}, [idsKey]);
}
