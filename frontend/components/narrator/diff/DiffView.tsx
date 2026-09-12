import { createDiffDocument, type DiffLine } from "@shared/pretext-layout/diff-core";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";
import { memo, useId, useMemo } from "react";
import { AutoFollowScroll, type ContentViewportLayout } from "../AutoFollowScroll";
import { DiffContent } from "./DiffContent";

export type { DiffLine } from "@shared/pretext-layout/diff-core";
export { normalizeDiffLineEndings } from "@shared/pretext-layout/diff-core";

const DIFF_CONTENT_PADDING = { x: 10, y: 10 };

interface DiffViewProps {
	/** Explicit viewport pixels; omitted for existing CSS-owned Git/modal surfaces. */
	layout?: ContentViewportLayout;
	oldStr?: string;
	newStr?: string;
	/** Already parsed Git rows retain their exact line numbers and word changes. */
	lines?: readonly DiffLine[];
	hunks?: readonly ParsedDiffHunk[];
	/** Undefined fills the available flex height. */
	maxHeight?: number;
	wordWrap?: boolean;
	language?: string;
	startLine?: number;
	lineNumberPrefix?: string;
	gutterMinWidth?: number;
	onNearBottom?: () => void;
}

/** Static entry only. Live tools use the same painter in their permanent host. */
export const DiffView = memo(function DiffView({
	layout,
	oldStr,
	newStr,
	lines,
	hunks,
	maxHeight,
	wordWrap = false,
	language,
	startLine,
	lineNumberPrefix,
	gutterMinWidth,
	onNearBottom,
}: DiffViewProps) {
	const id = useId();
	const document = useMemo(
		() =>
			lines
				? undefined
				: createDiffDocument({ oldText: oldStr ?? "", newText: newStr ?? "", startLine }),
		[lines, oldStr, newStr, startLine],
	);
	return (
		<AutoFollowScroll
			bodyId={`diff:${id}`}
			live={false}
			revision={document?.revision ?? lines?.length ?? 0}
			followTarget="row"
			layout={layout}
			contentPadding={DIFF_CONTENT_PADDING}
			style={maxHeight == null ? { flex: 1, minHeight: 0 } : undefined}
			viewportStyle={{
				maxHeight,
				...(maxHeight == null ? { height: "100%" } : {}),
				borderRadius: "var(--mantine-radius-sm)",
				backgroundColor: "var(--mantine-color-body)",
				border: "1px solid var(--mantine-color-default-border)",
				overflowX: wordWrap ? "hidden" : "auto",
			}}
		>
			<DiffContent
				document={document}
				lines={lines}
				hunks={hunks}
				wordWrap={wordWrap}
				language={language}
				lineNumberPrefix={lineNumberPrefix}
				gutterMinWidth={gutterMinWidth}
				onNearBottom={onNearBottom}
			/>
		</AutoFollowScroll>
	);
});
