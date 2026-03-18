import { Box, useComputedColorScheme } from "@mantine/core";
import type { Change } from "diff";
import { diffLines as computeLineDiff, diffWordsWithSpace } from "diff";
import { memo, useEffect, useMemo, useState } from "react";
import { type BundledLanguage, bundledLanguages, codeToTokens, type ThemedToken } from "shiki";

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
}

type DiffLine = {
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

function splitIntoLines(value: string): string[] {
	if (!value) return [];
	const lines = value.split("\n");
	// diffLines includes trailing \n, producing an empty last element
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

const MAX_DIFF_LINES = 500;

function computeDiff(oldStr: string, newStr: string, startLine = 1): DiffLine[] {
	const changes = computeLineDiff(oldStr, newStr);
	const result: DiffLine[] = [];
	let oldLine = startLine;
	let newLine = startLine;

	for (let i = 0; i < changes.length; i++) {
		if (result.length >= MAX_DIFF_LINES) break;
		const change = changes[i];

		if (!change.added && !change.removed) {
			// Context lines
			for (const line of splitIntoLines(change.value)) {
				result.push({ type: "context", content: line, oldLineNo: oldLine, newLineNo: newLine });
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
					const wc = diffWordsWithSpace(removedLines[j], addedLines[j]);
					result.push({
						type: "removed",
						content: removedLines[j],
						wordChanges: wc.filter((c) => !c.added),
						oldLineNo: oldLine,
					});
					oldLine++;
					result.push({
						type: "added",
						content: addedLines[j],
						wordChanges: wc.filter((c) => !c.removed),
						newLineNo: newLine,
					});
					newLine++;
				}
				// Remaining unpaired lines
				for (let j = maxPaired; j < removedLines.length; j++) {
					result.push({ type: "removed", content: removedLines[j], oldLineNo: oldLine });
					oldLine++;
				}
				for (let j = maxPaired; j < addedLines.length; j++) {
					result.push({ type: "added", content: addedLines[j], newLineNo: newLine });
					newLine++;
				}
				i++; // skip the added chunk
			} else {
				// Pure removal
				for (const line of splitIntoLines(change.value)) {
					result.push({ type: "removed", content: line, oldLineNo: oldLine });
					oldLine++;
				}
			}
			continue;
		}

		// Pure addition (not preceded by removal)
		for (const line of splitIntoLines(change.value)) {
			result.push({ type: "added", content: line, newLineNo: newLine });
			newLine++;
		}
	}

	return result;
}

// --- Shiki token map: line content → tokens ---

type TokenMap = Map<string, ThemedToken[]>;

function useTokenMap(
	lines: DiffLine[],
	language: string | undefined,
	theme: string,
): TokenMap | null {
	const [tokenMap, setTokenMap] = useState<TokenMap | null>(null);

	const effectiveLang =
		language && language !== "text" && language in bundledLanguages ? language : null;

	// Build the full source text for tokenisation (all unique lines)
	const sourceText = useMemo(() => {
		if (!effectiveLang) return null;
		// Reconstruct a plausible source from all lines so shiki gets proper context
		return lines.map((l) => l.content).join("\n");
	}, [effectiveLang, lines]);

	useEffect(() => {
		if (!effectiveLang || !sourceText) {
			setTokenMap(null);
			return;
		}

		let cancelled = false;
		codeToTokens(sourceText, {
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

		return () => {
			cancelled = true;
		};
	}, [effectiveLang, sourceText, lines, theme]);

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
function formatGutter(
	oldNo: number | undefined,
	newNo: number | undefined,
	prefix: string,
	w: number,
): string {
	const old = oldNo != null ? String(oldNo).padStart(w) : " ".repeat(w);
	const nw = newNo != null ? String(newNo).padStart(w) : " ".repeat(w);
	return `${old} ${nw}${prefix}`;
}

const DiffLineRow = memo(function DiffLineRow({
	line,
	tokens,
	diffStyles,
	lineNoWidth,
}: {
	line: DiffLine;
	tokens?: ThemedToken[];
	diffStyles: ReturnType<typeof getDiffStyles>;
	lineNoWidth?: number;
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
		<div style={lineStyle}>
			{lineNoWidth != null ? (
				<span style={{ ...lineNoGutterStyle, color: gutterColor }}>
					{formatGutter(line.oldLineNo, line.newLineNo, prefix, lineNoWidth)}
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
		return Math.max(3, String(maxNo).length);
	}, [startLine, lines]);

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

	return (
		<Box style={style}>
			{lines.map((line, i) => {
				const key = `${line.type}-${i}`;
				return (
					<DiffLineRow
						key={key}
						line={line}
						tokens={!line.wordChanges ? (tokenMap?.get(String(i)) ?? undefined) : undefined}
						diffStyles={diffStyles}
						lineNoWidth={lineNoWidth}
					/>
				);
			})}
			{truncated && (
				<div style={{ textAlign: "center", opacity: 0.6, paddingTop: 4 }}>
					... diff truncated at {MAX_DIFF_LINES} lines ...
				</div>
			)}
		</Box>
	);
});
