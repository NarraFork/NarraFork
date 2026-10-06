import { Code, useComputedColorScheme } from "@mantine/core";
import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { loadShiki } from "../../../lib/shiki-loader";
import classes from "./HighlightedCode.module.css";
import {
	cacheKey,
	FILE_HIGHLIGHT_OPTIONS,
	getCachedHtml,
	MAX_CACHEABLE_CODE_CHARS,
	MAX_FILE_HIGHLIGHT_CODE_CHARS,
	peekCachedHtml,
	setCachedHtml,
} from "./highlight-cache";

// Re-export for backward compat — callers that imported from here still work.
export { clearHighlightCache } from "./highlight-cache";

interface HighlightedCodeProps {
	/** Source code to highlight */
	code: string;
	/** Shiki language id (e.g. "typescript"). Falls back to "text". */
	lang?: string;
	/** Extra inline styles applied to the wrapper */
	style?: CSSProperties;
	/** File panels opt into a larger bounded budget; chat previews keep 20k. */
	maxHighlightChars?: number;
}

/**
 * Renders syntax-highlighted code using shiki.
 * Falls back to Mantine `<Code>` while the async highlight is pending
 * or when the language is "text".
 */
export const HighlightedCode = memo(function HighlightedCode({
	code,
	lang = "text",
	style,
	maxHighlightChars = MAX_CACHEABLE_CODE_CHARS,
}: HighlightedCodeProps) {
	const highlightLimit = Math.min(maxHighlightChars, MAX_FILE_HIGHLIGHT_CODE_CHARS);
	const computedScheme = useComputedColorScheme("dark");
	const theme = computedScheme === "light" ? "github-light-default" : "github-dark-default";

	// We can't synchronously check bundledLanguages before shiki loads,
	// so we start with the raw lang and validate once shiki is available.
	const [html, setHtml] = useState<string | null>(() => {
		if (!lang || lang === "text" || code.length > highlightLimit) return null;
		return peekCachedHtml(cacheKey(theme, lang, code));
	});

	// Track whether shiki's bundledLanguages has been resolved.
	const bundledLangsRef = useRef<Record<string, unknown> | null>(null);

	useEffect(() => {
		if (!lang || lang === "text" || code.length > highlightLimit) {
			setHtml(null);
			return;
		}

		const shouldCache = code.length <= MAX_CACHEABLE_CODE_CHARS;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		const initialKey = cacheKey(theme, lang, code);
		setHtml(shouldCache ? peekCachedHtml(initialKey) : null);

		/**
		 * One highlight attempt. Retries once on a transient failure.
		 *
		 * `loadShiki()` now evicts a failed core so a later call can recover, but a
		 * block that is already on screen never makes that later call: this effect
		 * runs on mount and then only when `lang`/`code`/`theme` change. On a cold
		 * PWA start — where the engine chunk is most likely to fail — that meant the
		 * whole visible conversation rendered as plain text and stayed that way,
		 * because nothing re-triggered the effect. Restarting the app was the only
		 * cure, which is what made this look like a caching bug rather than a
		 * network one.
		 *
		 * Deliberately bounded to a single retry: the fallback (`<Code>`) is a
		 * perfectly readable block, so this is a nicety worth one extra request and
		 * not worth an unbounded backoff loop running behind every code block on
		 * the page.
		 */
		const attempt = (retriesLeft: number) => {
			loadShiki()
				.then((shiki) => {
					if (cancelled) return;
					if (!shiki) {
						if (retriesLeft > 0) retryTimer = setTimeout(() => attempt(retriesLeft - 1), 1_000);
						return;
					}
					bundledLangsRef.current = shiki.bundledLanguages;

					const effectiveLang = lang in shiki.bundledLanguages ? lang : "text";
					if (effectiveLang === "text") {
						setHtml(null);
						return;
					}

					const key = cacheKey(theme, effectiveLang, code);
					const existing = shouldCache ? getCachedHtml(key) : null;
					if (existing) {
						setHtml(existing);
						return;
					}

					shiki
						.codeToHtml(code, {
							lang: effectiveLang as BundledLanguage,
							theme,
							...(highlightLimit > MAX_CACHEABLE_CODE_CHARS ? FILE_HIGHLIGHT_OPTIONS : {}),
						})
						.then((result) => {
							if (cancelled) return;
							if (shouldCache) {
								setCachedHtml(key, result);
							}
							setHtml(result);
						})
						.catch(() => {
							if (cancelled) return;
							setHtml(null);
							// A throw here means the grammar or theme module failed to load, not
							// that the code is unhighlightable — both ensurers evict their own
							// failures, so a retry can genuinely succeed.
							if (retriesLeft > 0) retryTimer = setTimeout(() => attempt(retriesLeft - 1), 1_000);
						});
				})
				.catch(() => {
					if (!cancelled && retriesLeft > 0) {
						retryTimer = setTimeout(() => attempt(retriesLeft - 1), 1_000);
					}
				});
		};

		attempt(1);

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [lang, code, theme, highlightLimit]);

	// Plain text, oversized, or pending — use Mantine Code
	if (code.length > highlightLimit || !html) {
		return (
			<Code
				block
				style={{
					whiteSpace: "pre-wrap",
					wordBreak: "break-word",
					overflowWrap: "break-word",
					...style,
				}}
			>
				{code}
			</Code>
		);
	}

	return (
		<div
			className={classes.root}
			style={style}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is trusted
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
});
