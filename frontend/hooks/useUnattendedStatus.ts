import { UNATTENDED_CHANGED_WS_TYPE, UNATTENDED_IDLE_POLL_INTERVAL_MS } from "@shared/unattended";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { type UnattendedStatus, unattendedStatusQueryKey } from "../lib/api/unattended";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const filters = { queryKey: unattendedStatusQueryKey, exact: true } as const;
const subscriptions = new WeakMap<QueryClient, { users: number; dispose(): void }>();

/** One control-plane subscription and offline safety timer per shared cache, not per surface. */
function subscribe(client: QueryClient): () => void {
	let subscription = subscriptions.get(client);
	if (!subscription) {
		let disposed = false;
		let connected = narratorWSManager.connected;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let queued = false;
		let refreshing = false;
		let dirty = false;
		const stopTimer = () => {
			clearTimeout(timer);
			timer = undefined;
		};
		const scheduleOfflinePoll = () => {
			stopTimer();
			if (disposed || connected) return;
			const status = client.getQueryData<UnattendedStatus>(unattendedStatusQueryKey);
			timer = setTimeout(refresh, status?.enabled ? 5_000 : UNATTENDED_IDLE_POLL_INTERVAL_MS);
		};
		function refresh() {
			if (disposed) return;
			stopTimer();
			// Cancel on every hint, even while queued: a new observer/read may have started
			// HTTP since the previous hint. Only the recovery read is coalesced below.
			// React Query also discards canceled results when the transport ignores abort.
			void client.cancelQueries(filters);
			dirty = true;
			if (queued || refreshing) return;
			queued = true;
			queueMicrotask(async () => {
				queued = false;
				if (disposed) return;
				refreshing = true;
				dirty = false;
				try {
					await client.invalidateQueries(filters);
				} finally {
					refreshing = false;
					if (dirty) refresh();
					else scheduleOfflinePoll();
				}
			});
		}
		const listener = narratorWSManager.addListener(
			{ types: [UNATTENDED_CHANGED_WS_TYPE] },
			refresh,
		);
		const offConnection = narratorWSManager.onConnectionChange((next) => {
			if (next === connected) return;
			connected = next;
			// A lost heartbeat can take 60 s to detect. Read immediately on the offline
			// edge, before a missed remote arm exhausts its 70 s minimum undo window.
			// Repeated offline notifications must not defer the existing safety timer.
			refresh();
		});
		const offRecovery = narratorWSManager.onControlPlaneRecovery(refresh);
		const offCache = client.getQueryCache().subscribe((event) => {
			if (event.type === "updated" && event.query.queryKey[0] === unattendedStatusQueryKey[0]) {
				if (event.action.type === "success" || event.action.type === "error") scheduleOfflinePoll();
			}
		});
		// Close the initial HTTP-before-WS-listener race, including an already-open socket.
		if (connected) refresh();
		else scheduleOfflinePoll();
		subscription = {
			users: 0,
			dispose() {
				disposed = true;
				stopTimer();
				offConnection();
				offRecovery();
				offCache();
				narratorWSManager.removeListener(listener);
				void client.cancelQueries(filters);
			},
		};
		subscriptions.set(client, subscription);
	}
	const shared = subscription;
	shared.users++;
	return () => {
		if (--shared.users === 0) {
			shared.dispose();
			subscriptions.delete(client);
		}
	};
}

export function useUnattendedStatus(enabled = true) {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: unattendedStatusQueryKey,
		queryFn: ({ signal }) => api.getUnattendedStatus(signal),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: false,
	});
	useEffect(() => {
		if (enabled) return subscribe(client);
	}, [client, enabled]);
	return query;
}
