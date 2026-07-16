import { Box, useComputedColorScheme } from "@mantine/core";
import type { Change } from "diff";
import { diffLines as computeLineDiff, diffWordsWithSpace } from "diff";
import { memo, useEffect, useMemo, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { loadShiki } from "../../lib/shiki-loader";
import { AutoFollowScroll } from "./AutoFollowScroll";

// --- Types ---

interface DiffViewProps {
	oldStr: string;
	newStr: string;
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
	/** Enable streaming auto-follow for the scrollable diff container. */
	autoFollowKey?: string | number | null;
	/** During replacement streaming, follow the latest added line instead of the diff bottom. */
	autoFollowTarget?: "bottom" | "latest-added";
}

export type DiffLine = {
	type: "context" | "removed" | "added";
	content: string;
	/** Word-level changes for modified lines */
	wordChanges?: Change[];
	/** 1-based line number in the old file (undefined for added lines) */
	oldLineNo?: number;
	/** 1-based line number in the new file (undefined for removed lines) */
	newLineNo?: number;
};

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

// --- Helpers ---

function clampLineContent(line: string): string {
	return line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)} …` : line;
}

function splitIntoLines(value: string): string[] {
	if (!value) return [];
	const lines = value.split("\n");
	// diffLines includes trailing \n, producing an empty last element
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.map(clampLineContent);
}

const MAX_DIFF_LINES = 500;
const MAX_DIFF_INPUT_CHARS = 240_000;
const MAX_DIFF_HIGHLIGHT_CHARS = 80_000;
const MAX_WORD_DIFF_CHARS = 4_000;
const MAX_DIFF_LINE_CHARS = 4_000;

function appendPreviewLines(
	value: string,
	type: "removed" | "added",
	startLine: number,
	maxLines: number,
	result: DiffLine[],
) {
	let lineNo = startLine;
	let start = 0;
	while (start <= value.length && result.length < maxLines) {
		const newline = value.indexOf("\n", start);
		const end = newline === -1 ? value.length : newline;
		const rawContent = value.slice(start, end);
		const content =
			rawContent.length > MAX_DIFF_LINE_CHARS
				? `${rawContent.slice(0, MAX_DIFF_LINE_CHARS)} …`
				: rawContent;
		result.push({
			type,
			content,
			oldLineNo: type === "removed" ? lineNo : undefined,
			newLineNo: type === "added" ? lineNo : undefined,
		});
		lineNo++;
		start = newline === -1 ? value.length + 1 : newline + 1;
	}
}

function buildLargeInputPreview(oldStr: string, newStr: string, startLine: number): DiffLine[] {
	const result: DiffLine[] = [
		{
			type: "context",
			content:
				"... diff input too large; showing a bounded preview without full diff computation ...",
		},
	];
	const perSide = Math.floor((MAX_DIFF_LINES - result.length) / 2);
	appendPreviewLines(oldStr, "removed", startLine, perSide, result);
	appendPreviewLines(newStr, "added", startLine, MAX_DIFF_LINES - result.length, result);
	return result;
}

/** Normalize line endings so CRLF/LF differences do not appear as content edits. */
export function normalizeDiffLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

export function computeDiff(oldStr: string, newStr: string, startLine = 1): DiffLine[] {
	const normalizedOldStr = normalizeDiffLineEndings(oldStr);
	const normalizedNewStr = normalizeDiffLineEndings(newStr);

	if (normalizedOldStr.length + normalizedNewStr.length > MAX_DIFF_INPUT_CHARS) {
		return buildLargeInputPreview(normalizedOldStr, normalizedNewStr, startLine);
	}

	const changes = computeLineDiff(normalizedOldStr, normalizedNewStr);
	const result: DiffLine[] = [];
	let oldLine = startLine;
	let newLine = startLine;
	const appendLine = (line: DiffLine): boolean => {
		if (result.length >= MAX_DIFF_LINES) return false;
		result.push(line);
		return true;
	};

	for (let i = 0; i < changes.length; i++) {
		if (result.length >= MAX_DIFF_LINES) break;
		const change = changes[i];

		if (!change.added && !change.removed) {
			// Context lines
			for (const line of splitIntoLines(change.value)) {
				if (
					!appendLine({ type: "context", content: line, oldLineNo: oldLine, newLineNo: newLine })
				) {
					return result;
				}
				oldLine++;
				newLine++;
			}
			continue;
		}

		if (change.removed) {
			const next = changes[i + 1];
			if (next?.added) {
				// Modification pair: do word-level diff per paired line
				const removedLines = splitIntoLines(change.value);
				const addedLines = splitIntoLines(next.value);
				const maxPaired = Math.min(removedLines.length, addedLines.length);

				for (let j = 0; j < maxPaired; j++) {
					const shouldWordDiff =
						removedLines[j].length + addedLines[j].length <= MAX_WORD_DIFF_CHARS;
					const wc = shouldWordDiff ? diffWordsWithSpace(removedLines[j], addedLines[j]) : null;
					if (
						!appendLine({
							type: "removed",
							content: removedLines[j],
							wordChanges: wc?.filter((c) => !c.added),
							oldLineNo: oldLine,
						})
					) {
						return result;
					}
					oldLine++;
					if (
						!appendLine({
							type: "added",
							content: addedLines[j],
							wordChanges: wc?.filter((c) => !c.removed),
							newLineNo: newLine,
						})
					) {
						return result;
					}
					newLine++;
				}
				// Remaining unpaired lines
				for (let j = maxPaired; j < removedLines.length; j++) {
					if (!appendLine({ type: "removed", content: removedLines[j], oldLineNo: oldLine })) {
						return result;
					}
					oldLine++;
				}
				for (let j = maxPaired; j < addedLines.length; j++) {
					if (!appendLine({ type: "added", content: addedLines[j], newLineNo: newLine })) {
						return result;
					}
					newLine++;
				}
				i++; // skip the added chunk
			} else {
				// Pure removal
				for (const line of splitIntoLines(change.value)) {
					if (!appendLine({ type: "removed", content: line, oldLineNo: oldLine })) {
						return result;
					}
					oldLine++;
				}
			}
			continue;
		}

		// Pure addition (not preceded by removal)
		for (const line of splitIntoLines(change.value)) {
			if (!appendLine({ type: "added", content: line, newLineNo: newLine })) {
				return result;
			}
			newLine++;
		}
	}

	return result;
}

// --- Shiki token map: line content → tokens ---

type TokenMap = Map<string, ThemedToken[]>;

function buildHighlightSourceText(lines: DiffLine[]): string | null {
	let totalLength = 0;
	const sourceLines: string[] = [];
	for (const line of lines) {
		const nextLength = totalLength + (sourceLines.length > 0 ? 1 : 0) + line.content.length;
		if (nextLength > MAX_DIFF_HIGHLIGHT_CHARS) return null;
		sourceLines.push(line.content);
		totalLength = nextLength;
	}
	return sourceLines.join("\n");
}

function useTokenMap(
	lines: DiffLine[],
	language: string | undefined,
	theme: string,
): TokenMap | null {
	const [tokenMap, setTokenMap] = useState<TokenMap | null>(null);

	// Build the full source text for tokenisation with a hard total-size guard.
	const sourceText = useMemo(() => {
		if (!language || language === "text") return null;
		// Reconstruct a plausible source from all lines so shiki gets proper context.
		return buildHighlightSourceText(lines);
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

/** Build the fixed-width gutter string: " oldNo newNo±" with padStart alignment */
function formatLineNumber(no: number | undefined, w: number, lineNumberPrefix?: string): string {
	if (no == null) return " ".repeat(w);
	const label = lineNumberPrefix ? `${lineNumberPrefix}${no}` : String(no);
	return label.padStart(w);
}

function formatGutter(
	oldNo: number | undefined,
	newNo: number | undefined,
	prefix: string,
	w: number,
	lineNumberPrefix?: string,
): string {
	const old = formatLineNumber(oldNo, w, lineNumberPrefix);
	const nw = formatLineNumber(newNo, w, lineNumberPrefix);
	return `${old} ${nw}${prefix}`;
}

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
	const prefix = line.type === "removed" ? "-" : line.type === "added" ? "+" : " ";
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
					{formatGutter(line.oldLineNo, line.newLineNo, prefix, lineNoWidth, lineNumberPrefix)}
				</span>
			) : (
				<span style={{ ...gutterStyle, color: gutterColor }}>{prefix}</span>
			)}
			{line.wordChanges ? (
				line.wordChanges.map((wc, j) => {
					if (wc.removed) {
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: diff word chunks lack stable IDs
							<span key={j} style={diffStyles.removedWord}>
								{wc.value}
							</span>
						);
					}
					if (wc.added) {
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: diff word chunks lack stable IDs
							<span key={j} style={diffStyles.addedWord}>
								{wc.value}
							</span>
						);
					}
					// biome-ignore lint/suspicious/noArrayIndexKey: diff word chunks lack stable IDs
					return <span key={j}>{wc.value}</span>;
				})
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

// --- Exported component ---

export const DiffView = memo(function DiffView({
	oldStr,
	newStr,
	maxHeight,
	wordWrap,
	language,
	startLine,
	lineNumberPrefix,
	autoFollowKey,
	autoFollowTarget = "bottom",
}: DiffViewProps) {
	const computedScheme = useComputedColorScheme("dark");
	const isDark = computedScheme === "dark";
	const theme = isDark ? "github-dark-default" : "github-light-default";
	const diffStyles = getDiffStyles(isDark);
	const lines = useMemo(() => computeDiff(oldStr, newStr, startLine), [oldStr, newStr, startLine]);
	const tokenMap = useTokenMap(lines, language, theme);
	const lineNoWidth = useMemo(() => {
		if (startLine == null) return undefined;
		let maxNo = 1;
		for (const l of lines) {
			if (l.oldLineNo != null && l.oldLineNo > maxNo) maxNo = l.oldLineNo;
			if (l.newLineNo != null && l.newLineNo > maxNo) maxNo = l.newLineNo;
		}
		return Math.max(3, `${lineNumberPrefix ?? ""}${maxNo}`.length);
	}, [startLine, lineNumberPrefix, lines]);

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
				return (
					<DiffLineRow
						key={key}
						line={line}
						tokens={!line.wordChanges ? (tokenMap?.get(String(i)) ?? undefined) : undefined}
						diffStyles={diffStyles}
						lineNoWidth={lineNoWidth}
						lineNumberPrefix={lineNumberPrefix}
						autoFollowTarget={i === latestAddedIndex}
					/>
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
				deps={[oldStr, newStr, tokenMap]}
				followTo={autoFollowTarget === "latest-added" ? scrollToDiffTarget : undefined}
			>
				<Box style={style}>{content}</Box>
			</AutoFollowScroll>
		);
	}

	return <Box style={style}>{content}</Box>;
});
