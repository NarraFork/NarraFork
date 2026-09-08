import type { QueryClient } from "@tanstack/react-query";
import type { UiRpcNotification } from "./protocol";

/**
 * Handle raw notifications emitted by plugin iframes.
 *
 * Kept out of `App.tsx` for two independent reasons:
 *
 * - `App.tsx` must export components only, or it stops being a valid Fast Refresh
 *   boundary (see `lib/app-hmr-boundary.test.ts`);
 * - the invalidation policy is easier to test against a fresh QueryClient than by
 *   mounting the whole app shell.
 *
 * `providerSettings.catalogInvalidated` means the host has already applied the plugin
 * command's writes and refreshed the affected provider catalog. The iframe is therefore
 * only asking the host to drop derived caches; it is not trusted to mutate settings.
 */
export function handlePluginUiNotification(
	notification: UiRpcNotification,
	queryClient: Pick<QueryClient, "invalidateQueries">,
): boolean {
	if (notification.method !== "providerSettings.catalogInvalidated") return false;
	invalidatePluginModelQueries(queryClient);
	return true;
}

/** Shared by iframe writes, backend discovery and WS reconnect (which can miss a push). */
export function invalidatePluginModelQueries(
	queryClient: Pick<QueryClient, "invalidateQueries">,
): void {
	void queryClient.invalidateQueries({ queryKey: ["settings"] });
	void queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
}
