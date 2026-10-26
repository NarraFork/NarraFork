import {
	getShikiTokens,
	getShikiTokensVersion,
	type ShikiToken,
	subscribeShikiTokens,
} from "@frontend/lib/shiki-token-cache";
import { useSyncExternalStore } from "react";
import { useSharedComputedColorScheme } from "./useSharedComputedColorScheme";

/** Shared by virtual-list painters and standalone content; no vlist dependency. */
export function useShikiThemeName(): string {
	return useSharedComputedColorScheme("dark") === "light"
		? "github-light-default"
		: "github-dark-default";
}

/** Read during render so cached colours never flash; the cache deduplicates misses. */
export function useShikiTokens(code: string, lang: string | undefined): ShikiToken[][] | null {
	const theme = useShikiThemeName();
	useSyncExternalStore(subscribeShikiTokens, getShikiTokensVersion, getShikiTokensVersion);
	return getShikiTokens(code, lang, theme);
}
