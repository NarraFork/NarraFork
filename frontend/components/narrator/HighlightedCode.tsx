import { Code, useComputedColorScheme } from "@mantine/core";
import { type CSSProperties, memo, useEffect, useState } from "react";
import { bundledLanguages, codeToHtml } from "shiki";
import classes from "./HighlightedCode.module.css";

interface HighlightedCodeProps {
	/** Source code to highlight */
	code: string;
	/** Shiki language id (e.g. "typescript"). Falls back to "text". */
	lang?: string;
	/** Extra inline styles applied to the wrapper */
	style?: CSSProperties;
}

type CacheEntry = {
	html: string;
	size: number;
};

const htmlCache = new Map<string, CacheEntry>();
let htmlCacheBytes = 0;
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 1 * 1024 * 1024;
const MAX_CACHEABLE_CODE_CHARS = 20_000;

function cacheKey(theme: string, lang: string, code: string) {
	return `${theme}\0${lang}\0${code}`;
}

function peekCachedHtml(key: string): string | null {
	return htmlCache.get(key)?.html ?? null;
}

function getCachedHtml(key: string): string | null {
	const entry = htmlCache.get(key);
	if (!entry) return null;
	htmlCache.delete(key);
	htmlCache.set(key, entry);
	return entry.html;
}

function evictOldestCachedHtml() {
	const oldestKey = htmlCache.keys().next().value;
	if (!oldestKey) return;
	const oldest = htmlCache.get(oldestKey);
	if (!oldest) return;
	htmlCacheBytes -= oldest.size;
	htmlCache.delete(oldestKey);
}

function setCachedHtml(key: string, html: string) {
	const existing = htmlCache.get(key);
	if (existing) {
		htmlCacheBytes -= existing.size;
		htmlCache.delete(key);
	}
	const entry = { html, size: html.length * 2 };
	htmlCache.set(key, entry);
	htmlCacheBytes += entry.size;
	while (htmlCache.size > MAX_CACHE_ENTRIES || htmlCacheBytes > MAX_CACHE_BYTES) {
		evictOldestCachedHtml();
	}
}

/** Clear the entire highlight cache. Call when navigating away from narrator pages. */
export function clearHighlightCache() {
	htmlCache.clear();
	htmlCacheBytes = 0;
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
	const effectiveLang = lang && lang in bundledLanguages ? lang : "text";
	const key = cacheKey(theme, effectiveLang, code);
	const shouldCache = code.length <= MAX_CACHEABLE_CODE_CHARS;
	const [html, setHtml] = useState<string | null>(() => peekCachedHtml(key));

	useEffect(() => {
		if (effectiveLang === "text") {
			setHtml(null);
			return;
		}

		const existing = shouldCache ? getCachedHtml(key) : null;
		if (existing) {
			setHtml(existing);
			return;
		}

		setHtml(null);
		let cancelled = false;
		codeToHtml(code, {
			lang: effectiveLang,
			theme,
		})
			.then((result) => {
				if (cancelled) return;
				if (shouldCache) {
					setCachedHtml(key, result);
				}
				setHtml(result);
			})
			.catch(() => {
				if (!cancelled) {
					setHtml(null);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [key, effectiveLang, code, theme, shouldCache]);

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
