import {
	getShikiTokens,
	getShikiTokensVersion,
	type ShikiToken,
	subscribeShikiTokens,
} from "@frontend/lib/shiki-token-cache";
import { useComputedColorScheme } from "@mantine/core";
import { useSyncExternalStore } from "react";

/** Shared by virtual-list painters and standalone content; no vlist dependency. */
export function useShikiThemeName(): string {
	return useComputedColorScheme("dark") === "light"
		? "github-light-default"
		: "github-dark-default";
}

/** Read during render so cached colours never flash; the cache deduplicates misses. */
export function useShikiTokens(code: string, lang: string | undefined): ShikiToken[][] | null {
	const theme = useShikiThemeName();
	useSyncExternalStore(subscribeShikiTokens, getShikiTokensVersion, getShikiTokensVersion);
	return getShikiTokens(code, lang, theme);
}
