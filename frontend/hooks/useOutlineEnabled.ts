import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { runtimeSettingsQueryOptions, useRuntimeSettings } from "./useRuntimeSettings";

function outlineOn(data: unknown): boolean {
	return (
		!REMOTE_BUILD &&
		(data as { outline?: { enabled?: unknown } } | undefined)?.outline?.enabled === true
	);
}

/**
 * Whether `outline.enabled` is on; `loading` until the settings have been read once.
 *
 * Read from the same bounded runtime projection as the authenticated app shell. While it is off the outline routes
 * answer 404, and the pages and entry points hide themselves.
 */
export function useOutlineEnabled(): { enabled: boolean; loading: boolean } {
	const { data, isLoading } = useRuntimeSettings(!REMOTE_BUILD);
	return { enabled: outlineOn(data), loading: isLoading };
}

const noSubscription = () => () => {};

/**
 * The same answer from the settings already in the query cache, without fetching and without
 * requiring a query client: hosts that wrap whole surfaces (a session's dock) use it, and they
 * are also rendered by tests without one. False until the app shell has read the settings.
 */
export function useOutlineEnabledInCache(): boolean {
	const client = useContext(QueryClientContext);
	const subscribe = useCallback(
		(listener: () => void) => client?.getQueryCache().subscribe(listener) ?? (() => {}),
		[client],
	);
	return useSyncExternalStore(
		!REMOTE_BUILD && client ? subscribe : noSubscription,
		() => outlineOn(client?.getQueryData(runtimeSettingsQueryOptions().queryKey)),
		() => false,
	);
}
