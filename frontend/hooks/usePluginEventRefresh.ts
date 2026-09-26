import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { pluginKeys } from "./usePlugins";

/**
 * Event-driven refresh for plugin management data.
 *
 * Listens for `narrafork:plugin-event` CustomEvents (dispatched by the shared
 * narrator WebSocket manager when the host broadcasts plugin lifecycle events)
 * and invalidates the matching React Query keys, so the plugin panel updates
 * live. Polling remains the fallback for missed events / reconnect gaps.
 *
 * Mount once at the plugin management root.
 */
export function usePluginEventRefresh(): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		const handler = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					type: string;
					pluginId?: string;
				}>
			).detail;
			if (!detail?.type) return;
			void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
			if (detail.pluginId) {
				void queryClient.invalidateQueries({
					queryKey: pluginKeys.detail(detail.pluginId),
				});
				void queryClient.invalidateQueries({
					queryKey: pluginKeys.permissionRequests(detail.pluginId),
				});
				void queryClient.invalidateQueries({
					queryKey: pluginKeys.permanentDenials(detail.pluginId),
				});
				void queryClient.invalidateQueries({
					queryKey: pluginKeys.grants(detail.pluginId),
				});
			}
		};
		window.addEventListener("narrafork:plugin-event", handler);
		return () => window.removeEventListener("narrafork:plugin-event", handler);
	}, [queryClient]);
}
