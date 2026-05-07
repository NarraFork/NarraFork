import { Code, useComputedColorScheme } from "@mantine/core";
import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { loadShiki } from "../../lib/shiki-loader";
import classes from "./HighlightedCode.module.css";
import {
	cacheKey,
	getCachedHtml,
	MAX_CACHEABLE_CODE_CHARS,
	peekCachedHtml,
	setCachedHtml,
} from "./highlight-cache";

// Re-export for backward compat — callers that imported from here still work.
export { clearHighlightCache } from "./highlight-cache";

const MAX_HIGHLIGHT_CODE_CHARS = MAX_CACHEABLE_CODE_CHARS;

interface HighlightedCodeProps {
	/** Source code to highlight */
	code: string;
	/** Shiki language id (e.g. "typescript"). Falls back to "text". */
	lang?: string;
	/** Extra inline styles applied to the wrapper */
	style?: CSSProperties;
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
}: HighlightedCodeProps) {
	const computedScheme = useComputedColorScheme("dark");
	const theme = computedScheme === "light" ? "github-light-default" : "github-dark-default";

	// We can't synchronously check bundledLanguages before shiki loads,
	// so we start with the raw lang and validate once shiki is available.
	const [html, setHtml] = useState<string | null>(() => {
		if (!lang || lang === "text" || code.length > MAX_HIGHLIGHT_CODE_CHARS) return null;
		return peekCachedHtml(cacheKey(theme, lang, code));
	});

	// Track whether shiki's bundledLanguages has been resolved.
	const bundledLangsRef = useRef<Record<string, unknown> | null>(null);

	useEffect(() => {
		if (!lang || lang === "text" || code.length > MAX_HIGHLIGHT_CODE_CHARS) {
			setHtml(null);
			return;
		}

		const shouldCache = code.length <= MAX_CACHEABLE_CODE_CHARS;
		let cancelled = false;

		const initialKey = cacheKey(theme, lang, code);
		setHtml(shouldCache ? peekCachedHtml(initialKey) : null);

		loadShiki().then((shiki) => {
			if (cancelled || !shiki) return;
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
				.codeToHtml(code, { lang: effectiveLang as BundledLanguage, theme })
				.then((result) => {
					if (cancelled) return;
					if (shouldCache) {
						setCachedHtml(key, result);
					}
					setHtml(result);
				})
				.catch(() => {
					if (!cancelled) setHtml(null);
				});
		});

		return () => {
			cancelled = true;
		};
	}, [lang, code, theme]);

	// Plain text, oversized, or pending — use Mantine Code
	if (code.length > MAX_HIGHLIGHT_CODE_CHARS || !html) {
		return (
			<Code
				block
				style={{
					...style,
					whiteSpace: "pre-wrap",
					wordBreak: "break-word",
					overflowWrap: "break-word",
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
