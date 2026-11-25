import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { EXECUTION_DEVICES_CHANGED_WS_TYPE } from "@shared/execution-devices";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const queryPrefix = ["narratorExecutionDevices"] as const;
const subscriptions = new WeakMap<QueryClient, { count: number; dispose: () => void }>();

/** A single listener per cache, even with several narrator panels and permission dialogs. */
function useExecutionDeviceSync(enabled: boolean): void {
	const client = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		let subscription = subscriptions.get(client);
		if (!subscription) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let dirty = false;
			let running = false;
			let disposed = false;
			const flush = async () => {
				timer = undefined;
				if (disposed || !dirty) return;
				dirty = false;
				running = true;
				try {
					await client.invalidateQueries(
						{ queryKey: queryPrefix, refetchType: "active" },
						{ cancelRefetch: false },
					);
				} finally {
					running = false;
					if (dirty && !disposed) timer = setTimeout(() => void flush(), 100);
				}
			};
			const refresh = () => {
				if (disposed) return;
				// Invalidate an old in-flight snapshot as soon as authorization/device state
				// changes, not after the coalescing timer has let it overwrite the cache.
				// A newly mounted observer can start a read even while a previous hint
				// is still queued, so every hint must invalidate the in-flight generation.
				void client.cancelQueries({ queryKey: queryPrefix });
				dirty = true;
				if (timer === undefined && !running) timer = setTimeout(() => void flush(), 100);
			};
			const handle = narratorWSManager.addListener(
				{ types: [EXECUTION_DEVICES_CHANGED_WS_TYPE] },
				refresh,
			);
			const offConnection = narratorWSManager.onConnectionChange((connected) => {
				// Covers the first HTTP → WS gap as well as missed changes during a reconnect.
				if (connected) refresh();
			});
			const offRecovery = narratorWSManager.onControlPlaneRecovery(refresh);
			subscription = {
				count: 0,
				dispose: () => {
					disposed = true;
					if (timer !== undefined) clearTimeout(timer);
					narratorWSManager.removeListener(handle);
					offConnection();
					offRecovery();
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

/** Initial/on-demand reads plus device changes and connection recovery; never a steady-state poll. */
export function useNarratorExecutionDevices(narratorId: string, enabled = true) {
	const active = !REMOTE_BUILD && enabled && !!narratorId;
	useExecutionDeviceSync(active);
	return useQuery({
		queryKey: [...queryPrefix, narratorId],
		queryFn: ({ signal }) => api.getNarratorExecutionDevices(narratorId, signal),
		enabled: active,
		staleTime: 30_000,
		// A page may have been fully unmounted while its device hints were missed.
		refetchOnMount: "always",
		refetchInterval: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
}
