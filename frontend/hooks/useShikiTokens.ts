import {
	getShikiTokens,
	getShikiTokensVersion,
	MAX_HIGHLIGHT_CODE_CHARS,
	type ShikiToken,
	subscribeShikiTokens,
} from "@frontend/lib/shiki-token-cache";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useSharedComputedColorScheme } from "./useSharedComputedColorScheme";

/** Shared by virtual-list painters and standalone content; no vlist dependency. */
export function useShikiThemeName(): string {
	return useSharedComputedColorScheme("dark") === "light"
		? "github-light-default"
		: "github-dark-default";
}

/** Cached colours win immediately; pending appends keep the last committed prefix coloured. */
export function useShikiTokens(code: string, lang: string | undefined): ShikiToken[][] | null {
	const theme = useShikiThemeName();
	useSyncExternalStore(subscribeShikiTokens, getShikiTokensVersion, getShikiTokensVersion);
	const cached = getShikiTokens(code, lang, theme);
	const previous = useRef<{
		code: string;
		lang: string;
		theme: string;
		tokens: ShikiToken[][];
	} | null>(null);
	const eligible = !!code && !!lang && lang !== "text" && code.length <= MAX_HIGHLIGHT_CODE_CHARS;
	const tokens = useMemo(() => {
		if (cached) return cached;
		const prior = previous.current;
		if (
			!eligible ||
			!prior ||
			prior.lang !== lang ||
			prior.theme !== theme ||
			!code.startsWith(prior.code)
		)
			return null;
		if (code === prior.code) return prior.tokens;
		// Copy, never mutate the shared cache. Every appended character is present
		// immediately, but only already-confirmed characters keep their old colour.
		const lines = prior.tokens.slice();
		const tail = code.slice(prior.code.length).split("\n");
		const last = lines.at(-1)?.slice() ?? [];
		if (tail[0]) {
			const token = last.at(-1);
			if (token && !token.color) last[last.length - 1] = { content: token.content + tail[0] };
			else last.push({ content: tail[0] });
		}
		lines[lines.length - 1] = last;
		for (const content of tail.slice(1)) lines.push([{ content }]);
		return lines;
	}, [cached, code, lang, theme, eligible]);
	useLayoutEffect(() => {
		// Remember committed renders only: an abandoned concurrent render must not
		// invalidate the visible prefix. Retention obeys the cache's size budget and
		// rejects normalized/misaligned tokens (notably CRLF) before reusing them.
		previous.current =
			eligible &&
			lang &&
			tokens?.length &&
			tokens.map((line) => line.map((token) => token.content).join("")).join("\n") === code
				? { code, lang, theme, tokens }
				: null;
	}, [code, lang, theme, tokens, eligible]);
	return tokens;
}
