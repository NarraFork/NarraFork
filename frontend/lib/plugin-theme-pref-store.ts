/**
 * The device-scoped active-plugin-theme preference, with NO React Query dependency.
 *
 * WHY THIS IS ITS OWN MODULE
 * -------------------------
 * `main.tsx` reads this preference before React mounts, to set `[data-plugin-theme]` on
 * the first paint. It used to import `readActivePluginThemeKey` from
 * `hooks/usePluginThemes.ts`, which also holds the React Query hooks — and through
 * `lib/api/plugins` that pulls in the whole `lib/api` barrel: 53 modules reachable from
 * the entry for what is, at bootstrap, a single `localStorage.getItem`.
 *
 * That mattered for Fast Refresh, not bundle size. `main.tsx` runs bootstrap side
 * effects at module scope, so it is not a valid HMR boundary, and being the ENTRY it has
 * no importer above it to accept an update instead. Any edit that propagated up to it
 * therefore ended in a full page reload. Splitting the plain store out of the hook module
 * keeps those 53 modules off the entry's import graph, so editing them refreshes the
 * component tree instead of reloading the page.
 *
 * `usePluginThemes.ts` re-exports the hook from here, so existing imports keep working.
 */

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

/** `useSyncExternalStore` subscribe: cross-tab changes arrive via the storage event. */
export function subscribePluginThemePref(cb: () => void): () => void {
	prefListeners.add(cb);
	ensurePrefStorageListener();
	return () => {
		prefListeners.delete(cb);
		removePrefStorageListenerIfIdle();
	};
}

/**
 * The persisted active plugin theme key, or `null` for the default look.
 *
 * Safe to call before React mounts and in contexts where `localStorage` throws
 * (private mode, embedded webviews with storage disabled).
 */
export function readActivePluginThemeKey(): string | null {
	try {
		return localStorage.getItem(PLUGIN_THEME_STORAGE_KEY);
	} catch {
		return null;
	}
}

/** Persist the active plugin theme key (or clear it) and notify same-tab subscribers. */
export function writeActivePluginThemeKey(key: string | null): void {
	try {
		if (key) localStorage.setItem(PLUGIN_THEME_STORAGE_KEY, key);
		else localStorage.removeItem(PLUGIN_THEME_STORAGE_KEY);
	} catch {
		// Ignore storage failures (private mode, quota, etc.).
	}
	// The `storage` event does not fire in the tab that wrote it, so notify locally.
	for (const cb of prefListeners) cb();
}
