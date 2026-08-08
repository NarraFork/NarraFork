import { Box, useComputedColorScheme } from "@mantine/core";
import {
	buildDiffHighlightSource,
	computeDiff,
	type DiffLine,
	diffLineMarker,
	diffLineNoWidth,
	formatDiffGutter,
	MAX_DIFF_LINES,
} from "@shared/pretext-layout/diff-core";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";
import { Fragment, memo, useEffect, useMemo, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { loadShiki } from "../../lib/shiki-loader";
import { AutoFollowScroll } from "./AutoFollowScroll";
import { DiffWordTokens } from "./DiffWordTokens";

export type { DiffLine } from "@shared/pretext-layout/diff-core";
// The diff MODEL (line/word structure, line numbers, bounds) lives in
// shared/pretext-layout/diff-core so the pretext virtual list can compute the
// identical structure from its purity-guarded layer. This file owns only the
// React presentation. Re-exported for the existing importers of this module.
export { computeDiff, normalizeDiffLineEndings } from "@shared/pretext-layout/diff-core";

// --- Types ---

/**
 * Two mutually exclusive input modes:
 *
 *   - SELF-COMPUTED: pass `oldStr`/`newStr` and the diff is derived here.
 *   - PRE-COMPUTED: pass `lines` when the rows already exist. The git panel uses
 *     this, because a patch's diff is computed by git and its `@@` headers carry
 *     real file line numbers that reconstructing two texts would destroy.
 */
interface DiffViewProps {
	oldStr?: string;
	newStr?: string;
	/** Pre-computed rows. When present, `oldStr`/`newStr` are ignored. */
	lines?: readonly DiffLine[];
	/**
	 * Hunk boundaries for the pre-computed rows, drawn as separators above the row
	 * each one points at. Only the git panel has these — a two-text diff is one
	 * continuous region with no hunks to separate.
	 */
	hunks?: readonly ParsedDiffHunk[];
	/** Max height in px. When undefined, uses flex to fill parent. */
	maxHeight?: number;
	/** Enable word-wrap. Defaults to false (horizontal scroll). */
	wordWrap?: boolean;
	/** Shiki language id for syntax highlighting */
	language?: string;
	/** 1-based line number where the old text starts in the original file */
	startLine?: number;
	/** Optional prefix for provisional line numbers while the real match location is unknown. */
	lineNumberPrefix?: string;
	/**
	 * Floor for one line-number column. Defaults to the measure layer's value.
	 * Pass a smaller floor only from a surface that owns its own layout (the git
	 * panel), where reserving a third column for two-digit numbers wastes width on
	 * a phone.
	 */
	gutterMinWidth?: number;
	/** Enable streaming auto-follow for the scrollable diff container. */
	autoFollowKey?: string | number | null;
	/** During replacement streaming, follow the latest added line instead of the diff bottom. */
	autoFollowTarget?: "bottom" | "latest-added";
}

// --- Styles (inline, Mantine dark-theme compatible) ---

const containerStyle = {
	fontSize: 11,
	fontFamily: "var(--mantine-font-family-monospace)",
	maxHeight: 200,
	overflow: "auto",
	borderRadius: "var(--mantine-radius-sm)",
	backgroundColor: "var(--mantine-color-body)",
	border: "1px solid var(--mantine-color-default-border)",
	padding: "var(--mantine-spacing-xs)",
	lineHeight: 1.5,
	whiteSpace: "pre" as const,
	tabSize: 4,
} as const;

// Dark mode: Mantine's light variants work well against dark backgrounds.
// Light mode: Mantine's light variants are too pale — use explicit rgba with
// higher opacity so syntax-highlighted text remains legible.
const darkRemovedLine = { backgroundColor: "var(--mantine-color-red-light)" } as const;
const darkAddedLine = { backgroundColor: "var(--mantine-color-green-light)" } as const;
const darkRemovedWord = {
	backgroundColor: "var(--mantine-color-red-light-hover)",
	borderRadius: 2,
} as const;
const darkAddedWord = {
	backgroundColor: "var(--mantine-color-green-light-hover)",
	borderRadius: 2,
} as const;

const lightRemovedLine = { backgroundColor: "rgba(255, 99, 71, 0.13)" } as const;
const lightAddedLine = { backgroundColor: "rgba(46, 160, 67, 0.13)" } as const;
const lightRemovedWord = { backgroundColor: "rgba(255, 99, 71, 0.25)", borderRadius: 2 } as const;
const lightAddedWord = { backgroundColor: "rgba(46, 160, 67, 0.25)", borderRadius: 2 } as const;

function getDiffStyles(isDark: boolean) {
	return {
		removedLine: isDark ? darkRemovedLine : lightRemovedLine,
		addedLine: isDark ? darkAddedLine : lightAddedLine,
		removedWord: isDark ? darkRemovedWord : lightRemovedWord,
		addedWord: isDark ? darkAddedWord : lightAddedWord,
	};
}

const gutterStyle = {
	display: "inline-block",
	width: "1.5ch",
	userSelect: "none" as const,
	flexShrink: 0,
	opacity: 0.6,
} as const;

// --- Shiki token map: line content → tokens ---

type TokenMap = Map<string, ThemedToken[]>;

function useTokenMap(
	lines: readonly DiffLine[],
	language: string | undefined,
	theme: string,
): TokenMap | null {
	const [tokenMap, setTokenMap] = useState<TokenMap | null>(null);

	// Build the full source text for tokenisation with a hard total-size guard.
	const sourceText = useMemo(() => {
		if (!language || language === "text") return null;
		// Reconstruct a plausible source from all lines so shiki gets proper context.
		return buildDiffHighlightSource(lines);
	}, [language, lines]);

	useEffect(() => {
		if (!language || language === "text" || !sourceText) {
			setTokenMap(null);
			return;
		}

		let cancelled = false;
		loadShiki().then((shiki) => {
			if (cancelled || !shiki) return;
			const effectiveLang = language in shiki.bundledLanguages ? language : null;
			if (!effectiveLang) {
				setTokenMap(null);
				return;
			}
			shiki
				.codeToTokens(sourceText, {
					lang: effectiveLang as BundledLanguage,
					theme,
				})
				.then((result) => {
					if (cancelled) return;
					const map: TokenMap = new Map();
					for (let i = 0; i < result.tokens.length && i < lines.length; i++) {
						// Key by index to handle duplicate lines correctly
						map.set(String(i), result.tokens[i]);
					}
					setTokenMap(map);
				})
				.catch(() => {
					if (!cancelled) setTokenMap(null);
				});
		});

		return () => {
			cancelled = true;
		};
	}, [language, sourceText, lines, theme]);

	return tokenMap;
}

// --- Highlighted line rendering ---

function renderTokens(tokens: ThemedToken[]) {
	return tokens.map((token, i) => (
		<span
			// biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
			key={i}
			style={{ color: token.color ?? "inherit" }}
		>
			{token.content}
		</span>
	));
}

const lineNoGutterStyle = {
	display: "inline-block",
	userSelect: "none" as const,
	flexShrink: 0,
	opacity: 0.4,
	fontSize: "inherit",
	fontFamily: "inherit",
} as const;

const DIFF_AUTO_FOLLOW_TARGET_ATTR = "data-diff-auto-follow-target";

function scrollToDiffTarget(el: HTMLElement) {
	const target = el.querySelector<HTMLElement>(`[${DIFF_AUTO_FOLLOW_TARGET_ATTR}="true"]`);
	if (!target) {
		el.scrollTop = el.scrollHeight;
		return;
	}
	const margin = 24;
	const targetTop = target.offsetTop;
	const targetBottom = targetTop + target.offsetHeight;
	const viewportTop = el.scrollTop;
	const viewportBottom = viewportTop + el.clientHeight;
	if (targetBottom + margin > viewportBottom) {
		el.scrollTop = Math.max(0, targetBottom - el.clientHeight + margin);
	} else if (targetTop - margin < viewportTop) {
		el.scrollTop = Math.max(0, targetTop - margin);
	}
}

const DiffLineRow = memo(function DiffLineRow({
	line,
	tokens,
	diffStyles,
	lineNoWidth,
	lineNumberPrefix,
	autoFollowTarget,
}: {
	line: DiffLine;
	tokens?: ThemedToken[];
	diffStyles: ReturnType<typeof getDiffStyles>;
	lineNoWidth?: number;
	lineNumberPrefix?: string;
	autoFollowTarget?: boolean;
}) {
	const prefix = diffLineMarker(line.type);
	const lineStyle =
		line.type === "removed"
			? diffStyles.removedLine
			: line.type === "added"
				? diffStyles.addedLine
				: undefined;
	const gutterColor =
		line.type === "removed"
			? "var(--mantine-color-red-text)"
			: line.type === "added"
				? "var(--mantine-color-green-text)"
				: "var(--mantine-color-dimmed)";

	return (
		<div
			style={lineStyle}
			{...(autoFollowTarget ? { [DIFF_AUTO_FOLLOW_TARGET_ATTR]: "true" } : {})}
		>
			{lineNoWidth != null ? (
				<span style={{ ...lineNoGutterStyle, color: gutterColor }}>
					{formatDiffGutter(line, lineNoWidth, lineNumberPrefix)}
				</span>
			) : (
				<span style={{ ...gutterStyle, color: gutterColor }}>{prefix}</span>
			)}
			{line.wordChanges ? (
				<DiffWordTokens wordChanges={line.wordChanges} tokens={tokens} styles={diffStyles} />
			) : tokens ? (
				renderTokens(tokens)
			) : (
				<span
					style={line.type === "context" ? { color: "var(--mantine-color-dimmed)" } : undefined}
				>
					{line.content}
				</span>
			)}
		</div>
	);
});

/**
 * A hunk boundary: the `@@` range plus git's context hint.
 *
 * Without it, a jump from old line 16 to old line 48 renders as two adjacent rows
 * with no indication that 31 lines were skipped, and the enclosing function name
 * git supplied is thrown away.
 */
const HunkSeparatorRow = memo(function HunkSeparatorRow({ hunk }: { hunk: ParsedDiffHunk }) {
	return (
		<div
			data-diff-hunk-separator="true"
			style={{
				color: "var(--mantine-color-dimmed)",
				backgroundColor: "var(--mantine-color-default-hover)",
				opacity: 0.85,
				userSelect: "none",
			}}
		>
			{`@@ ${hunk.range} @@`}
			{hunk.heading ? ` ${hunk.heading}` : ""}
		</div>
	);
});

// --- Exported component ---

export const DiffView = memo(function DiffView({
	oldStr,
	newStr,
	lines: providedLines,
	hunks,
	maxHeight,
	wordWrap,
	language,
	startLine,
	lineNumberPrefix,
	gutterMinWidth,
	autoFollowKey,
	autoFollowTarget = "bottom",
}: DiffViewProps) {
	const computedScheme = useComputedColorScheme("dark");
	const isDark = computedScheme === "dark";
	const theme = isDark ? "github-dark-default" : "github-light-default";
	const diffStyles = getDiffStyles(isDark);
	const lines = useMemo(
		() => providedLines ?? computeDiff(oldStr ?? "", newStr ?? "", startLine),
		[providedLines, oldStr, newStr, startLine],
	);
	const tokenMap = useTokenMap(lines, language, theme);
	// Pre-computed rows carry their own numbers (a patch's `@@` headers) without
	// passing `startLine`, so the gutter must also switch on their presence.
	const lineNoWidth = useMemo(
		() =>
			startLine == null && !lines.some((l) => l.oldLineNo != null || l.newLineNo != null)
				? undefined
				: diffLineNoWidth(lines, lineNumberPrefix, gutterMinWidth),
		[startLine, lineNumberPrefix, gutterMinWidth, lines],
	);
	// rowIndex → separator, so a hunk boundary is emitted just before its first row
	// without the row array itself carrying a non-row entry. Must stay above the
	// empty-rows early return: hooks run unconditionally.
	const hunkByRow = useMemo(() => {
		if (!hunks || hunks.length === 0) return null;
		const map = new Map<number, ParsedDiffHunk>();
		for (const hunk of hunks) map.set(hunk.rowIndex, hunk);
		return map;
	}, [hunks]);

	if (lines.length === 0) return null;

	const wrapOverride = wordWrap
		? {
				whiteSpace: "pre-wrap" as const,
				wordBreak: "break-all" as const,
				overflowX: "hidden" as const,
			}
		: {};

	const style =
		maxHeight !== undefined
			? { ...containerStyle, maxHeight, ...wrapOverride }
			: {
					...containerStyle,
					maxHeight: undefined,
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					overflow: "auto" as any,
					flex: 1,
					minHeight: 0,
					...wrapOverride,
				};

	const truncated = lines.length >= MAX_DIFF_LINES;
	const latestAddedIndex =
		autoFollowTarget === "latest-added" ? lines.findLastIndex((line) => line.type === "added") : -1;

	const content = (
		<div style={wordWrap ? undefined : { minWidth: "fit-content" }}>
			{lines.map((line, i) => {
				const key = `${line.type}-${i}`;
				const hunk = hunkByRow?.get(i);
				return (
					<Fragment key={key}>
						{hunk ? <HunkSeparatorRow hunk={hunk} /> : null}
						<DiffLineRow
							line={line}
							tokens={!line.wordChanges ? (tokenMap?.get(String(i)) ?? undefined) : undefined}
							diffStyles={diffStyles}
							lineNoWidth={lineNoWidth}
							lineNumberPrefix={lineNumberPrefix}
							autoFollowTarget={i === latestAddedIndex}
						/>
					</Fragment>
				);
			})}
			{truncated && (
				<div style={{ textAlign: "center", opacity: 0.6, paddingTop: 4 }}>
					... diff truncated at {MAX_DIFF_LINES} lines ...
				</div>
			)}
		</div>
	);

	if (autoFollowKey != null) {
		return (
			<AutoFollowScroll
				asChild
				followKey={autoFollowKey}
				deps={[oldStr, newStr, providedLines, tokenMap]}
				followTo={autoFollowTarget === "latest-added" ? scrollToDiffTarget : undefined}
			>
				<Box style={style}>{content}</Box>
			</AutoFollowScroll>
		);
	}

	return <Box style={style}>{content}</Box>;
});
