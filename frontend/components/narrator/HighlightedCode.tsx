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

// In-memory cache: key = theme + "\0" + lang + "\0" + code
const htmlCache = new Map<string, string>();
const MAX_CACHE = 256;

function cacheKey(theme: string, lang: string, code: string) {
	return `${theme}\0${lang}\0${code}`;
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
	const cached = htmlCache.get(key);
	const [html, setHtml] = useState<string | null>(cached ?? null);

	useEffect(() => {
		if (effectiveLang === "text") {
			setHtml(null);
			return;
		}

		const existing = htmlCache.get(key);
		if (existing) {
			setHtml(existing);
			return;
		}

		let cancelled = false;
		codeToHtml(code, {
			lang: effectiveLang,
			theme,
		}).then((result) => {
			if (cancelled) return;
			// Evict oldest entries when cache is full
			if (htmlCache.size >= MAX_CACHE) {
				const first = htmlCache.keys().next().value;
				if (first !== undefined) htmlCache.delete(first);
			}
			htmlCache.set(key, result);
			setHtml(result);
		});

		return () => {
			cancelled = true;
		};
	}, [key, effectiveLang, code, theme]);

	// Plain text or pending — use Mantine Code
	if (!html) {
		return (
			<Code block style={style}>
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
