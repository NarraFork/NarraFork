import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getToken } from "../lib/api/client";
import {
	type PluginAvailableThemeItem,
	type PluginThemeItem,
	pluginsApi,
} from "../lib/api/plugins";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import {
	readActivePluginThemeKey,
	subscribePluginThemePref,
	writeActivePluginThemeKey,
} from "../lib/plugin-theme-pref-store";
import { pluginKeys } from "./usePlugins";

/**
 * The stable identity of an active plugin theme, `${pluginId}__${themeId}`.
 * Mirrors the server's `buildThemeKey` and the `[data-plugin-theme]` selector.
 */
export function pluginThemeKey(item: Pick<PluginThemeItem, "pluginId" | "themeId">): string {
	return `${item.pluginId}__${item.themeId}`;
}

export interface UsePluginThemesResult {
	themes: PluginThemeItem[];
	isFetching: boolean;
	error: unknown;
	invalidate: () => void;
}

/**
 * React Query-backed list of plugin-contributed themes. The backend is the
 * source of truth (it already gates on the `ui.theme` grant and ships compiled,
 * sanitized CSS). This hook mirrors the bounded snapshot and resyncs when a
 * plugin lifecycle change is broadcast over the narrator WebSocket.
 */
export function usePluginThemes(enabled = true): UsePluginThemesResult {
	const queryClient = useQueryClient();
	const hasToken = !!getToken();

	const query = useQuery({
		queryKey: pluginKeys.themes,
		queryFn: pluginsApi.listThemes,
		enabled: enabled && hasToken,
		gcTime: 60_000,
		retry: (failureCount, error) => {
			if ((error as { status?: number }).status === 503) return false;
			return failureCount < 2;
		},
	});

	const invalidate = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: pluginKeys.themes });
	}, [queryClient]);

	// Resync on contribution-change broadcasts (the WS event is only an
	// invalidation signal; the HTTP snapshot remains the payload of truth).
	useEffect(() => {
		if (!enabled) return;
		const listener = narratorWSManager.addListener(
			{ types: ["plugin_contributions_changed"] },
			() => invalidate(),
		);
		return () => narratorWSManager.removeListener(listener);
	}, [enabled, invalidate]);

	// Resync after a WS reconnect, matching the contribution store's behavior.
	useEffect(() => {
		if (!enabled) return;
		return narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) invalidate();
		});
	}, [enabled, invalidate]);

	return {
		themes: query.data ?? [],
		isFetching: query.isFetching,
		error: query.error,
		invalidate,
	};
}

export interface UsePluginAvailableThemesResult {
	/** All theme-only themes with the current user's per-user enabled flag. */
	themes: PluginAvailableThemeItem[];
	isFetching: boolean;
	error: unknown;
	/** Enable or disable a theme for the current user (optimistic invalidation). */
	setEnabled: (pluginId: string, themeId: string, enabled: boolean) => Promise<void>;
	isMutating: boolean;
}

/**
 * List of all installed theme-only themes plus whether the current user has
 * enabled each, and a mutation to toggle enablement. Used by the appearance
 * settings selector. Enabling a theme also invalidates the enabled-CSS query so
 * the injector picks it up.
 */
export function usePluginAvailableThemes(enabled = true): UsePluginAvailableThemesResult {
	const queryClient = useQueryClient();
	const hasToken = !!getToken();

	const query = useQuery({
		queryKey: pluginKeys.availableThemes,
		queryFn: pluginsApi.listAvailableThemes,
		enabled: enabled && hasToken,
		gcTime: 60_000,
		retry: (failureCount, error) => {
			if ((error as { status?: number }).status === 503) return false;
			return failureCount < 2;
		},
	});

	const mutation = useMutation({
		mutationFn: ({
			pluginId,
			themeId,
			enabled: next,
		}: {
			pluginId: string;
			themeId: string;
			enabled: boolean;
		}) => pluginsApi.setThemeEnabled(pluginId, themeId, next),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: pluginKeys.availableThemes });
			void queryClient.invalidateQueries({ queryKey: pluginKeys.themes });
		},
	});

	const setEnabled = useCallback(
		async (pluginId: string, themeId: string, next: boolean) => {
			await mutation.mutateAsync({ pluginId, themeId, enabled: next });
		},
		[mutation],
	);

	return {
		themes: query.data ?? [],
		isFetching: query.isFetching,
		error: query.error,
		setEnabled,
		isMutating: mutation.isPending,
	};
}

// --- Active plugin theme preference (device-scoped, like OLED mode) ---

/**
 * Re-exported so existing imports keep working. The store itself lives in
 * `lib/plugin-theme-pref-store.ts` because `main.tsx` reads it before React mounts, and
 * importing it from HERE would put this module's React Query dependencies (and through
 * them the whole `lib/api` barrel) on the entry's graph — where an HMR update has no
 * accepting importer and becomes a full page reload. See that file's header.
 *
 * ⚠️ `main.tsx` must import from the store directly, NOT through this re-export: a
 * re-export still makes this module (and its dependencies) part of the entry's graph,
 * which is exactly what the split removes. `app-hmr-boundary.test.ts` asserts that.
 */
export { readActivePluginThemeKey };

/**
 * Device-scoped preference for the active plugin theme key (or `null` for the
 * default look). Persisted in localStorage and broadcast across tabs, mirroring
 * the `useLocalPref` pattern used by OLED mode, so the choice survives reloads
 * and can be applied before React mounts to avoid a flash of the default theme.
 */
export function usePluginThemePref(): [string | null, (key: string | null) => void] {
	const value = useSyncExternalStore(
		subscribePluginThemePref,
		readActivePluginThemeKey,
		() => null,
	);
	const setValue = useCallback((key: string | null) => {
		writeActivePluginThemeKey(key);
	}, []);
	return [value, setValue];
}
