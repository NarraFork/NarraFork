import { Box, useComputedColorScheme } from "@mantine/core";
import {
	buildDiffHighlightPlan,
	computeDiff,
	type DiffLine,
	diffLineMarker,
	diffLineNoWidth,
	formatDiffGutter,
	MAX_DIFF_LINES,
} from "@shared/pretext-layout/diff-core";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";
import { Fragment, memo, type UIEvent, useEffect, useMemo, useRef, useState } from "react";
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
	/**
	 * Called once when the user scrolls near the bottom. The latch resets only
	 * after the viewport leaves that zone, so one wheel gesture cannot append
	 * several 500-row segments at once.
	 */
	onNearBottom?: () => void;
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

	// Each side is reconstructed and tokenized separately, so a multi-line construct
	// on one side cannot bleed into the other's rows. See `buildDiffHighlightPlan`.
	const plan = useMemo(() => {
		if (!language || language === "text") return null;
		return buildDiffHighlightPlan(lines);
	}, [language, lines]);

	useEffect(() => {
		if (!language || language === "text" || !plan) {
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
			Promise.all(
				plan.sources.map((source) =>
					shiki.codeToTokens(source, { lang: effectiveLang as BundledLanguage, theme }),
				),
			)
				.then((results) => {
					if (cancelled) return;
					const map: TokenMap = new Map();
					// Keyed by ROW index (not source line), so lookup stays a plain
					// `get(String(i))` for the renderer while the row's tokens come from
					// whichever side that row belongs to.
					for (let i = 0; i < lines.length; i++) {
						const ref = plan.rows[i];
						if (!ref) continue;
						const tokens = results[ref.source]?.tokens[ref.line];
						if (tokens) map.set(String(i), tokens);
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
	}, [language, plan, lines, theme]);

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
 * Hunk separator colours, taken from GitHub's Primer diff palette rather than
 * Mantine's neutral hover grey.
 *
 * GitHub tints this row with the ACCENT (blue) family, not a grey: the row is a
 * position marker, and a grey band reads as just another muted code row next to
 * the red/green change rows. `bgColor-accent-muted` / `fgColor-muted` are the
 * tokens GitHub uses in each scheme.
 */
const darkHunkSeparator = {
	backgroundColor: "#121d2f",
	color: "#9198a1",
	borderTop: "1px solid #1f2a37",
	borderBottom: "1px solid #1f2a37",
} as const;

const lightHunkSeparator = {
	backgroundColor: "#ddf4ff",
	color: "#59636e",
	borderTop: "1px solid #c6e6ff",
	borderBottom: "1px solid #c6e6ff",
} as const;

/**
 * A hunk boundary: the `@@` range plus git's context hint.
 *
 * Without it, a jump from old line 16 to old line 48 renders as two adjacent rows
 * with no indication that 31 lines were skipped, and the enclosing function name
 * git supplied is thrown away.
 *
 * The gutter is reserved as blank space so the `@@` text starts in the SAME column
 * as code, the way GitHub's unified view leaves the line-number cells empty and
 * tinted. Reprinting the range verbatim (`hunk.range`) matters: rebuilding it from
 * the parsed start lines would drop git's counts.
 */
const HunkSeparatorRow = memo(function HunkSeparatorRow({
	hunk,
	isDark,
	lineNoWidth,
}: {
	hunk: ParsedDiffHunk;
	isDark: boolean;
	/** Gutter width in characters per side, matching `formatDiffGutter`. */
	lineNoWidth?: number;
}) {
	// `formatDiffGutter` emits `old + " " + new + marker`, so the gutter spans two
	// number columns plus two single characters. Without numbers the row only has
	// the 1.5ch marker gutter.
	const gutterWidth = lineNoWidth != null ? `${lineNoWidth * 2 + 2}ch` : "1.5ch";

	return (
		<div
			data-diff-hunk-separator="true"
			style={{
				...(isDark ? darkHunkSeparator : lightHunkSeparator),
				userSelect: "none",
				// Bleed through the container's padding so the band spans the full width,
				// as GitHub's does, instead of floating inside an untinted margin.
				marginLeft: "calc(-1 * var(--mantine-spacing-xs))",
				marginRight: "calc(-1 * var(--mantine-spacing-xs))",
				paddingLeft: "var(--mantine-spacing-xs)",
				paddingRight: "var(--mantine-spacing-xs)",
			}}
		>
			<span style={{ display: "inline-block", width: gutterWidth, flexShrink: 0 }} />
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
	onNearBottom,
}: DiffViewProps) {
	const computedScheme = useComputedColorScheme("dark");
	const isDark = computedScheme === "dark";
	const theme = isDark ? "github-dark-default" : "github-light-default";
	const diffStyles = getDiffStyles(isDark);
	const nearBottomFired = useRef(false);
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
	const handleScroll = onNearBottom
		? (event: UIEvent<HTMLDivElement>) => {
				const viewport = event.currentTarget;
				const isNearBottom =
					viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 120;
				if (!isNearBottom) {
					nearBottomFired.current = false;
					return;
				}
				if (nearBottomFired.current) return;
				nearBottomFired.current = true;
				onNearBottom();
			}
		: undefined;

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

	// A pre-computed array may intentionally contain exactly 500 visible rows while
	// the git modal keeps the rest off-screen. Length alone therefore says nothing
	// about truncation for that mode. Keep the legacy footer only for the two-text
	// path, whose `computeDiff` still owns the 500-row safety ceiling.
	const truncated = providedLines == null && lines.length >= MAX_DIFF_LINES;
	const latestAddedIndex =
		autoFollowTarget === "latest-added" ? lines.findLastIndex((line) => line.type === "added") : -1;

	const content = (
		<div style={wordWrap ? undefined : { minWidth: "fit-content" }}>
			{lines.map((line, i) => {
				const key = `${line.type}-${i}`;
				const hunk = hunkByRow?.get(i);
				return (
					<Fragment key={key}>
						{hunk ? (
							<HunkSeparatorRow hunk={hunk} isDark={isDark} lineNoWidth={lineNoWidth} />
						) : null}
						<DiffLineRow
							line={line}
							// Passed for EVERY row, including word-diffed ones. Withholding tokens
							// from rows that carry `wordChanges` made modified lines — the rows a
							// reader looks at first — the only ones rendered without syntax colour,
							// because DiffWordTokens then falls back to its tint-only branch. Word
							// chunks and Shiki tokens partition the same text, so they intersect
							// rather than compete; RenderToolCall already passed both.
							tokens={tokenMap?.get(String(i)) ?? undefined}
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
				<Box data-diff-scroll-container="true" style={style} onScroll={handleScroll}>
					{content}
				</Box>
			</AutoFollowScroll>
		);
	}

	return (
		<Box data-diff-scroll-container="true" style={style} onScroll={handleScroll}>
			{content}
		</Box>
	);
});
