import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError, api } from "../lib/api";
import {
	type SystemLifecycleStatus,
	systemLifecycleNoticeQueryKey,
	systemLifecycleStatusQueryKey,
} from "../lib/api/system-lifecycle";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const subscriptions = new WeakMap<QueryClient, { count: number; dispose: () => void }>();

/** One shared listener per cache, regardless of how many maintenance surfaces are mounted. */
export function useSystemLifecycleSync(enabled: boolean) {
	const client = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		let subscription = subscriptions.get(client);
		if (!subscription) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let reconcileConnection = false;
			let disposed = false;
			const refresh = () => {
				if (timer !== undefined) return;
				// Coalesce a burst without postponing refresh indefinitely during drain.
				timer = setTimeout(async () => {
					timer = undefined;
					// invalidateQueries alone reuses an initial in-flight request with no data.
					// Abort it so a response captured before this signal cannot win the race.
					await Promise.all([
						client.cancelQueries({ queryKey: systemLifecycleStatusQueryKey }),
						client.cancelQueries({ queryKey: systemLifecycleNoticeQueryKey }),
					]);
					if (disposed) return;
					const state = client.getQueryState<SystemLifecycleStatus>(systemLifecycleStatusQueryKey);
					const stopped =
						state?.data?.phase === "shutting_down" ||
						(state?.data?.shutdownRequested && state.error && !(state.error instanceof ApiError));
					if (reconcileConnection && stopped) {
						// A live connection may be a restarted server. Clear the shutdown fetch guard.
						void client.resetQueries({ queryKey: systemLifecycleStatusQueryKey });
					} else {
						void client.invalidateQueries({ queryKey: systemLifecycleStatusQueryKey });
					}
					reconcileConnection = false;
					void client.invalidateQueries({ queryKey: systemLifecycleNoticeQueryKey });
				}, 100);
			};
			const listener = narratorWSManager.addListener(
				{ types: ["system_lifecycle_changed"] },
				refresh,
			);
			// Also reconcile the first connection: the initial HTTP fetch can precede WS open.
			const disconnect = narratorWSManager.onConnectionChange((connected) => {
				if (connected) {
					reconcileConnection = true;
					refresh();
				}
			});
			subscription = {
				count: 0,
				dispose: () => {
					disposed = true;
					if (timer !== undefined) clearTimeout(timer);
					disconnect();
					narratorWSManager.removeListener(listener);
				},
			};
			subscriptions.set(client, subscription);
		}
		subscription.count++;
		return () => {
			if (--subscription.count === 0) {
				subscription.dispose();
				subscriptions.delete(client);
			}
		};
	}, [client, enabled]);
}

/** Both administrator surfaces observe this same cache, including asynchronous preparation. */
export function useSystemLifecycleStatus(enabled = true) {
	useSystemLifecycleSync(enabled);
	return useQuery({
		queryKey: systemLifecycleStatusQueryKey,
		queryFn: ({ signal }) => api.getSystemLifecycleStatus(signal),
		enabled: (query) =>
			enabled &&
			query.state.data?.phase !== "shutting_down" &&
			!(
				query.state.data?.shutdownRequested &&
				query.state.error &&
				!(query.state.error instanceof ApiError)
			),
		refetchInterval: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: (query) => query.state.data?.phase !== "shutting_down",
		retry: false,
	});
}
