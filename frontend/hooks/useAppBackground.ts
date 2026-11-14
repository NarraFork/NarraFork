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
	subscribeBackground,
	syncWallpaperLayer,
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

	useEffect(() => {
		if (typeof document === "undefined") return;
		applyBackground(document.documentElement, choice);
		let cancelled = false;
		if (!choice.enabled) {
			setStatus("idle");
			void syncWallpaperLayer(choice);
			return;
		}
		setStatus("loading");
		void syncWallpaperLayer(choice).then((result) => {
			// The async load can finish after the user changed the preference; ignoring the
			// stale result keeps the error state from sticking to a newer, valid choice.
			if (cancelled) return;
			setStatus(result === "ok" ? "ok" : "error");
		});
		return () => {
			cancelled = true;
		};
	}, [choice]);

	return { choice, setChoice, status };
}
