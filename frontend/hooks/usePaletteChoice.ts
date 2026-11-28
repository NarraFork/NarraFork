/**
 * Reads the theme palette from localStorage and applies it to `<html>`.
 *
 * The snapshot is cached by the raw string so `useSyncExternalStore` sees a stable object
 * between renders — re-parsing on every call would hand React a fresh reference each time
 * and loop forever.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
	accentRampOverride,
	applyPalette,
	PALETTE_PREF_KEY,
	subscribePalette,
	writeStoredPalette,
} from "../lib/palette-apply";
import { DEFAULT_PALETTE, parsePaletteChoice, resolvePalette } from "../lib/palette-presets";
import { readActivePluginThemeKey, subscribePluginThemePref } from "../lib/plugin-theme-pref-store";

let cachedRaw: string | null = null;
let cachedChoice = { ...DEFAULT_PALETTE };

function readSnapshot() {
	if (typeof localStorage === "undefined") return cachedChoice;
	const raw = localStorage.getItem(PALETTE_PREF_KEY);
	if (raw !== cachedRaw) {
		cachedRaw = raw;
		cachedChoice = raw ? parsePaletteChoice(safeParse(raw)) : { ...DEFAULT_PALETTE };
	}
	return cachedChoice;
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** The resolved palette, for callers that need the accent ramp. */
export function usePaletteChoice() {
	const choice = useSyncExternalStore(subscribePalette, readSnapshot, () => DEFAULT_PALETTE);
	const pluginThemeKey = useSyncExternalStore(
		subscribePluginThemePref,
		readActivePluginThemeKey,
		() => null,
	);

	const setChoice = useCallback((next: Parameters<typeof writeStoredPalette>[0]) => {
		writeStoredPalette(next);
	}, []);

	useEffect(() => {
		if (typeof document === "undefined") return;
		applyPalette(document.documentElement, choice, pluginThemeKey);
	}, [choice, pluginThemeKey]);

	const resolved = useMemo(() => resolvePalette(choice), [choice]);
	const accentOverride = useMemo(
		() => accentRampOverride(choice, pluginThemeKey),
		[choice, pluginThemeKey],
	);

	return { choice, setChoice, resolved, accentOverride };
}
