import { DiffView } from "@frontend/components/narrator/diff/DiffView";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import { Loader, Text } from "@mantine/core";
import { parseUnifiedDiff } from "@shared/pretext-layout/parse-unified-diff";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

const DIFF_SEGMENT_ROWS = 500;
const METADATA_MAX_CHARS = 8_192;
const METADATA_MAX_LINES = 80;

export interface GitPatchViewProps {
	/** One file's unified patch; the parser reads only the first file. */
	diff: string | undefined;
	truncated?: boolean;
	/** Used for syntax highlighting. */
	file: string | null;
	/** Changes whenever the patch identity changes; restarts paging and scroll. */
	resetKey: string;
	loading?: boolean;
	error?: Error | null;
	maxHeight?: number;
}

/** Presentation for a single-file patch: loading, errors, binary, truncation and paging. */
export function GitPatchView({
	diff,
	truncated = false,
	file,
	resetKey,
	loading = false,
	error = null,
	maxHeight = 500,
}: GitPatchViewProps) {
	const { t } = useTranslation("git");
	// Git already computed this diff, so the rows are parsed from the patch rather
	// than recomputed from two texts. That keeps the real file line numbers the
	// `@@` headers carry, and lets the shared renderer supply highlighting, the
	// added/removed tint and word-level marking.
	const parsed = useMemo(
		() => (!error && !loading && diff?.trim() ? parseUnifiedDiff(diff) : null),
		[diff, error, loading],
	);
	const metadata = useMemo(
		() =>
			parsed && !parsed.binary && parsed.lines.length === 0
				? (diff ?? "")
						.slice(0, METADATA_MAX_CHARS)
						.split("\n")
						.slice(0, METADATA_MAX_LINES)
						.join("\n")
				: "",
		[diff, parsed],
	);
	const [visibleWindow, setVisibleWindow] = useState(() => ({
		resetKey,
		lineCount: DIFF_SEGMENT_ROWS,
	}));
	// A new patch starts at the first segment without a setState-in-effect reset.
	const visibleLineCount =
		visibleWindow.resetKey === resetKey ? visibleWindow.lineCount : DIFF_SEGMENT_ROWS;

	const visibleLines = useMemo(
		() => parsed?.lines.slice(0, visibleLineCount) ?? [],
		[parsed, visibleLineCount],
	);
	const visibleHunks = useMemo(
		() => parsed?.hunks.filter((hunk) => hunk.rowIndex < visibleLines.length) ?? [],
		[parsed, visibleLines.length],
	);
	const hasMoreLines = !!parsed && visibleLines.length < parsed.lines.length;
	const loadNextSegment = useCallback(() => {
		if (!parsed) return;
		setVisibleWindow({
			resetKey,
			lineCount: Math.min(parsed.lines.length, visibleLineCount + DIFF_SEGMENT_ROWS),
		});
	}, [parsed, resetKey, visibleLineCount]);

	// A failed refetch may still carry cached data. The error replaces the entire
	// preview, including binary/metadata branches, rather than exposing that data.
	if (error) {
		return (
			<Text c="red" size="sm" role="alert">
				{error.message}
			</Text>
		);
	}
	if (loading) return <Loader size="sm" />;

	return (
		<>
			{/* The server-side byte ceiling applies even to binary or zero-row patches. */}
			{truncated && (
				<Text size="xs" c="yellow" mb="xs">
					{t("diffTruncated")}
				</Text>
			)}
			{!parsed && (
				<Text size="sm" c="dimmed">
					{t("noDiff")}
				</Text>
			)}

			{parsed?.binary && (
				<Text size="sm" c="dimmed">
					{t("diffBinary")}
				</Text>
			)}

			{metadata && (
				<>
					<Text size="sm" c="dimmed" mb="xs">
						{t("diffMetadataOnly")}
					</Text>
					<Text
						component="pre"
						size="xs"
						ff="monospace"
						tabIndex={0}
						aria-label={t("diffMetadataOnly")}
						data-git-patch-metadata
						style={{
							whiteSpace: "pre-wrap",
							overflowWrap: "anywhere",
							maxHeight: Math.min(maxHeight, 200),
							overflowY: "auto",
						}}
					>
						{metadata}
					</Text>
					{metadata.length < (diff?.length ?? 0) && (
						<Text size="xs" c="yellow">
							{t("diffMetadataTruncated")}
						</Text>
					)}
				</>
			)}

			{parsed && !parsed.binary && parsed.lines.length > 0 && (
				<>
					{hasMoreLines && (
						<Text size="xs" c="dimmed" mb="xs">
							{t("diffLoadMore", {
								shown: visibleLines.length,
								total: parsed.lines.length,
							})}
						</Text>
					)}
					<DiffView
						key={resetKey}
						lines={visibleLines}
						hunks={visibleHunks}
						language={file ? getShikiLang(file) : undefined}
						maxHeight={maxHeight}
						onNearBottom={hasMoreLines ? loadNextSegment : undefined}
						// This panel is not measured by pretext, so the gutter may shrink to
						// the digits actually present, which matters on a phone.
						gutterMinWidth={1}
					/>
				</>
			)}
		</>
	);
}
