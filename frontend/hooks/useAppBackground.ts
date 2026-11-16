/**
 * Reads the wallpaper preference from localStorage and applies it to `<html>`.
 *
 * Same snapshot-caching trick as `usePaletteChoice`: `useSyncExternalStore` requires a
 * stable reference between renders, so the parsed object is cached keyed by the raw string.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
	applyBackground,
	BACKGROUND_PREF_KEY,
	DEFAULT_BACKGROUND,
	parseBackgroundChoice,
	readStoredBackground,
	subscribeBackground,
	syncWallpaperLayer,
	wallpaperSourceUnchanged,
	writeStoredBackground,
} from "../lib/app-background";

let cachedRaw: string | null = null;
let cachedChoice = { ...DEFAULT_BACKGROUND };

function readSnapshot() {
	if (typeof localStorage === "undefined") return cachedChoice;
	const raw = localStorage.getItem(BACKGROUND_PREF_KEY);
	if (raw !== cachedRaw) {
		cachedRaw = raw;
		cachedChoice = raw ? parseBackgroundChoice(safeParse(raw)) : { ...DEFAULT_BACKGROUND };
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

export function useAppBackground() {
	const choice = useSyncExternalStore(subscribeBackground, readSnapshot, () => DEFAULT_BACKGROUND);

	const setChoice = useCallback((next: Parameters<typeof writeStoredBackground>[0]) => {
		writeStoredBackground(next);
	}, []);

	const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
	/**
	 * Bumped by the reload button. A plain re-run of the effect would hand the browser the
	 * same URL and it would answer from cache, which looks like the button does nothing.
	 */
	const reload = useCallback(() => {
		writeStoredBackground({ ...readStoredBackground(), reloadKey: Date.now() });
	}, []);

	useEffect(() => {
		if (typeof document === "undefined") return;
		applyBackground(document.documentElement, choice);
		let cancelled = false;
		if (!choice.enabled) {
			setStatus("idle");
			void syncWallpaperLayer(choice);
			return;
		}
		// Opacity, scrim and blur only change CSS variables. Starting a load (or flipping
		// the badge to "loading") would re-request the image and race the previous listeners.
		const reused = wallpaperSourceUnchanged(choice);
		if (!reused) setStatus("loading");
		/*
		 * Never let a wallpaper failure escape into React: this effect runs in the provider
		 * that wraps every route, so an unhandled throw here blanks the whole app. A broken
		 * image must degrade to "no wallpaper", not to "no UI".
		 */
		syncWallpaperLayer(choice)
			.then((result) => {
				// The load can finish after the preference changed; dropping the stale result
				// keeps an error state from sticking to a newer, valid choice.
				if (cancelled) return;
				setStatus(result === "ok" ? "ok" : "error");
			})
			.catch((error) => {
				console.error("[wallpaper] failed to apply", error);
				if (!cancelled) setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [choice]);

	return { choice, setChoice, status, reload };
}
