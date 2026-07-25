import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getToken } from "../lib/api/client";
import {
	type PluginAvailableThemeItem,
	type PluginThemeItem,
	pluginsApi,
} from "../lib/api/plugins";
import { narratorWSManager } from "../lib/narrator-ws-manager";
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

const PLUGIN_THEME_STORAGE_KEY = "narrafork_plugin_theme";

const prefListeners = new Set<() => void>();
let prefStorageListener: ((e: StorageEvent) => void) | null = null;

function ensurePrefStorageListener() {
	if (prefStorageListener) return;
	prefStorageListener = (e: StorageEvent) => {
		if (e.key === PLUGIN_THEME_STORAGE_KEY) {
			for (const cb of prefListeners) cb();
		}
	};
	window.addEventListener("storage", prefStorageListener);
}

function removePrefStorageListenerIfIdle() {
	if (prefListeners.size > 0 || !prefStorageListener) return;
	window.removeEventListener("storage", prefStorageListener);
	prefStorageListener = null;
}

function subscribePref(cb: () => void): () => void {
	prefListeners.add(cb);
	ensurePrefStorageListener();
	return () => {
		prefListeners.delete(cb);
		removePrefStorageListenerIfIdle();
	};
}

function getPrefSnapshot(): string | null {
	try {
		return localStorage.getItem(PLUGIN_THEME_STORAGE_KEY);
	} catch {
		return null;
	}
}

/** Read the persisted active plugin theme key without React (for bootstrap). */
export function readActivePluginThemeKey(): string | null {
	return getPrefSnapshot();
}

/**
 * Device-scoped preference for the active plugin theme key (or `null` for the
 * default look). Persisted in localStorage and broadcast across tabs, mirroring
 * the `useLocalPref` pattern used by OLED mode, so the choice survives reloads
 * and can be applied before React mounts to avoid a flash of the default theme.
 */
export function usePluginThemePref(): [string | null, (key: string | null) => void] {
	const value = useSyncExternalStore(subscribePref, getPrefSnapshot, () => null);
	const setValue = useCallback((key: string | null) => {
		try {
			if (key) localStorage.setItem(PLUGIN_THEME_STORAGE_KEY, key);
			else localStorage.removeItem(PLUGIN_THEME_STORAGE_KEY);
		} catch {
			// Ignore storage failures (private mode, quota, etc.).
		}
		for (const cb of prefListeners) cb();
	}, []);
	return [value, setValue];
}
