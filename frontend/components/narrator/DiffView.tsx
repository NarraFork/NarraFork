import { Box } from "@mantine/core";
import type { Change } from "diff";
import { diffLines as computeLineDiff, diffWordsWithSpace } from "diff";
import { memo, useMemo } from "react";

// --- Types ---

interface DiffViewProps {
	oldStr: string;
	newStr: string;
	/** Max height in px. Pass undefined to remove the limit. Defaults to 200. */
	maxHeight?: number;
}

type DiffLine = {
	type: "context" | "removed" | "added";
	content: string;
	/** Word-level changes for modified lines */
	wordChanges?: Change[];
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

const removedLineStyle = {
	backgroundColor: "var(--mantine-color-red-light)",
} as const;

const addedLineStyle = {
	backgroundColor: "var(--mantine-color-green-light)",
} as const;

const removedWordStyle = {
	backgroundColor: "var(--mantine-color-red-light-hover)",
	borderRadius: 2,
} as const;

const addedWordStyle = {
	backgroundColor: "var(--mantine-color-green-light-hover)",
	borderRadius: 2,
} as const;

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

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
	const changes = computeLineDiff(oldStr, newStr);
	const result: DiffLine[] = [];

	for (let i = 0; i < changes.length; i++) {
		if (result.length >= MAX_DIFF_LINES) break;
		const change = changes[i];

		if (!change.added && !change.removed) {
			// Context lines
			for (const line of splitIntoLines(change.value)) {
				result.push({ type: "context", content: line });
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
					});
					result.push({
						type: "added",
						content: addedLines[j],
						wordChanges: wc.filter((c) => !c.removed),
					});
				}
				// Remaining unpaired lines
				for (let j = maxPaired; j < removedLines.length; j++) {
					result.push({ type: "removed", content: removedLines[j] });
				}
				for (let j = maxPaired; j < addedLines.length; j++) {
					result.push({ type: "added", content: addedLines[j] });
				}
				i++; // skip the added chunk
			} else {
				// Pure removal
				for (const line of splitIntoLines(change.value)) {
					result.push({ type: "removed", content: line });
				}
			}
			continue;
		}

		// Pure addition (not preceded by removal)
		for (const line of splitIntoLines(change.value)) {
			result.push({ type: "added", content: line });
		}
	}

	return result;
}

const DiffLineRow = memo(function DiffLineRow({ line }: { line: DiffLine }) {
	const prefix = line.type === "removed" ? "-" : line.type === "added" ? "+" : " ";
	const lineStyle =
		line.type === "removed" ? removedLineStyle : line.type === "added" ? addedLineStyle : undefined;
	const gutterColor =
		line.type === "removed"
			? "var(--mantine-color-red-text)"
			: line.type === "added"
				? "var(--mantine-color-green-text)"
				: "var(--mantine-color-dimmed)";

	return (
		<div style={lineStyle}>
			<span style={{ ...gutterStyle, color: gutterColor }}>{prefix}</span>
			{line.wordChanges ? (
				line.wordChanges.map((wc, j) => {
					if (wc.removed) {
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: diff word chunks lack stable IDs
							<span key={j} style={removedWordStyle}>
								{wc.value}
							</span>
						);
					}
					if (wc.added) {
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: diff word chunks lack stable IDs
							<span key={j} style={addedWordStyle}>
								{wc.value}
							</span>
						);
					}
					// biome-ignore lint/suspicious/noArrayIndexKey: diff word chunks lack stable IDs
					return <span key={j}>{wc.value}</span>;
				})
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

export const DiffView = memo(function DiffView({ oldStr, newStr, maxHeight = 200 }: DiffViewProps) {
	const lines = useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr]);

	if (lines.length === 0) return null;

	const style =
		maxHeight != null
			? { ...containerStyle, maxHeight }
			: { ...containerStyle, maxHeight: undefined, overflow: "auto" as any, height: "100%" };

	return (
		<Box style={style}>
			{lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are computed once and never reordered
				<DiffLineRow key={i} line={line} />
			))}
		</Box>
	);
});
