import { Code, useComputedColorScheme } from "@mantine/core";
import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
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

interface HighlightedCodeProps {
	/** Source code to highlight */
	code: string;
	/** Shiki language id (e.g. "typescript"). Falls back to "text". */
	lang?: string;
	/** Extra inline styles applied to the wrapper */
	style?: CSSProperties;
}

// Lazy-loaded shiki helpers — resolved once on first use.
let shikiReady: Promise<{
	bundledLanguages: Record<string, unknown>;
	codeToHtml: typeof import("shiki").codeToHtml;
}> | null = null;

function getShiki() {
	if (!shikiReady) {
		shikiReady = import("shiki").then((m) => ({
			bundledLanguages: m.bundledLanguages,
			codeToHtml: m.codeToHtml,
		}));
	}
	return shikiReady;
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
		if (!lang || lang === "text") return null;
		return peekCachedHtml(cacheKey(theme, lang, code));
	});

	// Track whether shiki's bundledLanguages has been resolved.
	const bundledLangsRef = useRef<Record<string, unknown> | null>(null);

	useEffect(() => {
		if (!lang || lang === "text") {
			setHtml(null);
			return;
		}

		const shouldCache = code.length <= MAX_CACHEABLE_CODE_CHARS;
		let cancelled = false;

		getShiki().then(({ bundledLanguages, codeToHtml }) => {
			if (cancelled) return;
			bundledLangsRef.current = bundledLanguages;

			const effectiveLang = lang in bundledLanguages ? lang : "text";
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

			codeToHtml(code, { lang: effectiveLang, theme })
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

	// Plain text or pending — use Mantine Code
	if (!html) {
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
