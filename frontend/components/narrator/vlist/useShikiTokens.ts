/**
 * useShikiTokens.ts — React binding for the shared Shiki token cache.
 *
 * Kept separate from frontend/lib/shiki-token-cache.ts so that module stays
 * React-free (matching shiki-loader.ts, and letting the narrator route import the
 * cache's clear() without pulling React bindings along).
 *
 * Two deliberate design points:
 *
 * 1. The store snapshot is a VERSION NUMBER, not the token array. The cache is an
 *    LRU that re-inserts entries on read, so handing useSyncExternalStore the
 *    array would look "changed" on every access. The counter only moves when new
 *    tokens actually landed.
 *
 * 2. Tokens are read DURING RENDER, which also triggers the async highlight on a
 *    miss. That is intentional rather than moved into an effect: on a cache hit
 *    the colours must be present in the SAME frame, otherwise scrolling back to
 *    an already-highlighted block flashes uncoloured text every time. The trigger
 *    is safe because the cache reserves an in-flight slot per key, so strict-mode
 *    double invocation, sibling components and repeated renders all collapse into
 *    one request, and nothing React-owned is mutated.
 *
 * "Only highlight what is visible" needs no viewport logic here: the virtual list
 * mounts only the rows inside the visible window, so an off-screen code block
 * never runs this hook in the first place.
 */

import type { ShikiToken } from "@frontend/lib/shiki-token-cache";
import {
	getShikiTokens,
	getShikiTokensVersion,
	subscribeShikiTokens,
} from "@frontend/lib/shiki-token-cache";
import { useComputedColorScheme } from "@mantine/core";
import { useSyncExternalStore } from "react";

/** Shiki theme ids, matching HighlightedCode / StreamingCode / the Pixi renderer. */
const DARK_THEME = "github-dark-default";
const LIGHT_THEME = "github-light-default";

/** The Shiki theme id for the active colour scheme. */
export function useShikiThemeName(): string {
	return useComputedColorScheme("dark") === "light" ? LIGHT_THEME : DARK_THEME;
}

/**
 * Tokens for `code` in `lang`, or null while unavailable (no language, plain
 * text, oversized body, or still loading). Re-renders once tokens land.
 */
export function useShikiTokens(code: string, lang: string | undefined): ShikiToken[][] | null {
	const theme = useShikiThemeName();
	// Subscribe first so a highlight that lands between this render and the commit
	// still triggers a re-read.
	useSyncExternalStore(subscribeShikiTokens, getShikiTokensVersion, getShikiTokensVersion);
	return getShikiTokens(code, lang, theme);
}
