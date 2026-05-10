import { useComputedColorScheme } from "@mantine/core";
import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { loadShiki } from "../../lib/shiki-loader";
import { AutoFollowScroll } from "./AutoFollowScroll";
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
const STREAMING_CODE_DISPLAY_MAX_CHARS = 80_000;

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
	// How much of `code` the current `tokens` cover.
	const highlightedLenRef = useRef(0);
	const highlightedCodeRef = useRef("");

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const inflightRef = useRef(0); // generation counter to discard stale results
	const tokenContextKeyRef = useRef<string | null>(null);
	const scheduleContextKeyRef = useRef<string | null>(null);
	const codeRef = useRef(code);
	codeRef.current = code;
	const highlightContextKey = `${lang ?? ""}\u0000${theme}`;

	// --- Throttled highlight pass ---
	useEffect(() => {
		const clearPendingTimer = () => {
			if (timerRef.current != null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
		const clearHighlight = () => {
			inflightRef.current++;
			highlightedLenRef.current = 0;
			highlightedCodeRef.current = "";
			tokenContextKeyRef.current = null;
			setTokens(null);
		};

		if (scheduleContextKeyRef.current !== highlightContextKey) {
			scheduleContextKeyRef.current = highlightContextKey;
			clearPendingTimer();
			clearHighlight();
		}

		if (!lang || lang === "text" || !code || code.length > STREAMING_CODE_HIGHLIGHT_MAX_CHARS) {
			clearPendingTimer();
			clearHighlight();
			return;
		}

		// Schedule a highlight pass if one isn't already pending. Code changes keep
		// the pending timer; lang/theme changes are handled by the context key above.
		if (timerRef.current == null) {
			const scheduledLang = lang;
			const scheduledTheme = theme;
			const scheduledContextKey = highlightContextKey;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				const gen = ++inflightRef.current;
				// Read the latest code from ref so we always highlight the most
				// recent text, even if code changed while the timer was pending.
				const latestCode = codeRef.current;
				if (
					scheduledContextKey !== scheduleContextKeyRef.current ||
					latestCode.length > STREAMING_CODE_HIGHLIGHT_MAX_CHARS
				) {
					if (scheduledContextKey === scheduleContextKeyRef.current) clearHighlight();
					return;
				}
				loadShiki().then((shiki) => {
					if (
						!shiki ||
						gen !== inflightRef.current ||
						scheduledContextKey !== scheduleContextKeyRef.current
					) {
						return;
					}
					const effectiveLang = scheduledLang in shiki.bundledLanguages ? scheduledLang : null;
					if (!effectiveLang) {
						clearHighlight();
						return;
					}
					shiki
						.codeToTokens(latestCode, {
							lang: effectiveLang as BundledLanguage,
							theme: scheduledTheme,
						})
						.then((result) => {
							if (
								gen !== inflightRef.current ||
								scheduledContextKey !== scheduleContextKeyRef.current
							) {
								return;
							}
							tokenContextKeyRef.current = scheduledContextKey;
							highlightedCodeRef.current = latestCode;
							setTokens(result.tokens);
							highlightedLenRef.current = latestCode.length;
						})
						.catch(() => {
							if (gen === inflightRef.current) clearHighlight();
						});
				});
			}, HIGHLIGHT_INTERVAL);
		}
	}, [lang, theme, code, highlightContextKey]);

	// Cleanup timer on unmount
	useEffect(() => {
		return () => {
			if (timerRef.current != null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			inflightRef.current++;
			highlightedCodeRef.current = "";
			tokenContextKeyRef.current = null;
		};
	}, []);

	// --- Render ---
	const isDisplayTruncated = code.length > STREAMING_CODE_DISPLAY_MAX_CHARS;
	const displayCode = isDisplayTruncated ? code.slice(-STREAMING_CODE_DISPLAY_MAX_CHARS) : code;
	const tokensMatchContext = tokenContextKeyRef.current === highlightContextKey;
	const tokensMatchCode = tokensMatchContext && code.startsWith(highlightedCodeRef.current);
	const highlightedChars = isDisplayTruncated || !tokensMatchCode ? 0 : highlightedLenRef.current;
	const displayTokens = isDisplayTruncated || !tokensMatchCode ? null : tokens;
	const pendingText = displayCode.slice(highlightedChars);

	return (
		<AutoFollowScroll asChild followKey={highlightContextKey} deps={[code, tokens]}>
			<div className={classes.root} style={style}>
				<pre>
					<code>
						{isDisplayTruncated && <span>{"…\n"}</span>}
						{displayTokens
							? displayTokens.map((line, li) => (
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
							: displayCode.slice(0, highlightedChars)}
						{pendingText && <span>{pendingText}</span>}
					</code>
				</pre>
			</div>
		</AutoFollowScroll>
	);
});
