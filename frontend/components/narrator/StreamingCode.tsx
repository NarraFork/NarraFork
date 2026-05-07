import { useComputedColorScheme } from "@mantine/core";
import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { loadShiki } from "../../lib/shiki-loader";
import classes from "./HighlightedCode.module.css";

interface StreamingCodeProps {
	/** Code string that grows over time during streaming */
	code: string;
	/** Shiki language id (e.g. "typescript"). Falls back to plain text. */
	lang?: string;
	/** Extra inline styles (maxHeight, overflow, fontSize, etc.) */
	style?: CSSProperties;
}

/** Interval between highlight passes (ms) */
const HIGHLIGHT_INTERVAL = 300;
const STREAMING_CODE_HIGHLIGHT_MAX_CHARS = 20_000;

/**
 * Code viewer optimised for streaming: renders an ever-growing `code` string
 * with syntax highlighting while keeping the scroll pinned to the bottom.
 *
 * Strategy:
 *  - Maintain a "highlighted prefix" (token spans) + "pending tail" (plain text).
 *  - On every `code` change the pending tail updates instantly (zero cost).
 *  - A throttled async pass re-highlights the full text every HIGHLIGHT_INTERVAL ms,
 *    then replaces the entire content with coloured spans.
 *  - The container auto-scrolls to the bottom after every render.
 */
export const StreamingCode = memo(function StreamingCode({
	code,
	lang,
	style,
}: StreamingCodeProps) {
	const computedScheme = useComputedColorScheme("dark");
	const theme = computedScheme === "light" ? "github-light-default" : "github-dark-default";

	// Highlighted tokens (line-grouped). null = not yet highlighted.
	const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
	// How many chars of `code` the current `tokens` cover.
	const highlightedLenRef = useRef(0);

	const scrollRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const inflightRef = useRef(0); // generation counter to discard stale results
	const codeRef = useRef(code);
	codeRef.current = code;

	// --- Throttled highlight pass ---
	useEffect(() => {
		if (!lang || lang === "text" || !code || code.length > STREAMING_CODE_HIGHLIGHT_MAX_CHARS) {
			if (timerRef.current != null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			inflightRef.current++;
			highlightedLenRef.current = 0;
			setTokens(null);
			return;
		}

		// Schedule a highlight pass if one isn't already pending
		if (timerRef.current == null) {
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				const gen = ++inflightRef.current;
				// Read the latest code from ref so we always highlight the most
				// recent text, even if code changed while the timer was pending.
				const latestCode = codeRef.current;
				if (latestCode.length > STREAMING_CODE_HIGHLIGHT_MAX_CHARS) {
					highlightedLenRef.current = 0;
					setTokens(null);
					return;
				}
				loadShiki().then((shiki) => {
					if (!shiki || gen !== inflightRef.current) return;
					const effectiveLang = lang in shiki.bundledLanguages ? lang : null;
					if (!effectiveLang) {
						highlightedLenRef.current = 0;
						setTokens(null);
						return;
					}
					shiki
						.codeToTokens(latestCode, {
							lang: effectiveLang as BundledLanguage,
							theme,
						})
						.then((result) => {
							if (gen !== inflightRef.current) return;
							setTokens(result.tokens);
							highlightedLenRef.current = latestCode.length;
						})
						.catch(() => {});
				});
			}, HIGHLIGHT_INTERVAL);
		}

		return () => {
			// Don't clear the timer on every code change — let it fire on schedule.
			// Only clean up on unmount or when lang/theme changes.
		};
	}, [lang, theme, code]);

	// Cleanup timer on unmount
	useEffect(() => {
		return () => {
			if (timerRef.current != null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			inflightRef.current++;
		};
	}, []);

	// --- Auto-scroll to bottom ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: we need to re-scroll whenever code grows or tokens update
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const raf = requestAnimationFrame(() => {
			if (scrollRef.current) {
				scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			}
		});
		return () => cancelAnimationFrame(raf);
	}, [code, tokens]);

	// --- Render ---
	const pendingText = code.slice(highlightedLenRef.current);

	return (
		<div className={classes.root} style={style} ref={scrollRef}>
			<pre>
				<code>
					{tokens
						? tokens.map((line, li) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
								<span key={li}>
									{li > 0 && "\n"}
									{line.map((tok, ti) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
										<span key={ti} style={tok.color ? { color: tok.color } : undefined}>
											{tok.content}
										</span>
									))}
								</span>
							))
						: code.slice(0, highlightedLenRef.current)}
					{pendingText && <span>{pendingText}</span>}
				</code>
			</pre>
		</div>
	);
});
