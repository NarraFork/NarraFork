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

import { appearanceStore, subscribeAppearancePreferences } from "./appearance-preference-store";

export const subscribePluginThemePref = subscribeAppearancePreferences;

/** Readable before React mounts; no API or Query dependency is introduced here. */
export function readActivePluginThemeKey(): string | null {
	return (appearanceStore.get("pluginTheme") as string) || null;
}

export function writeActivePluginThemeKey(key: string | null): void {
	appearanceStore.set("pluginTheme", key ?? "");
}
