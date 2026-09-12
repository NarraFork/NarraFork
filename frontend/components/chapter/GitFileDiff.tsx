import { DiffView } from "@frontend/components/narrator/diff/DiffView";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import { Loader, Modal, Text } from "@mantine/core";
import { parseUnifiedDiff } from "@shared/pretext-layout/parse-unified-diff";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitDiff } from "../../hooks/useGit";

const DIFF_SEGMENT_ROWS = 500;

interface GitFileDiffProps {
	chapterId: string;
	file: string | null;
	staged?: boolean;
	onClose: () => void;
}

export function GitFileDiff({ chapterId, file, staged = false, onClose }: GitFileDiffProps) {
	const { t } = useTranslation("git");
	const { data, dataUpdatedAt, isLoading } = useGitDiff(chapterId, file, staged);

	// Git already computed this diff, so the rows are parsed from the patch rather
	// than recomputed from two texts. That keeps the real file line numbers the
	// `@@` headers carry, and lets the shared renderer supply highlighting, the
	// added/removed tint and word-level marking that the old plain <Code> block
	// could not.
	const parsed = useMemo(() => (data?.diff ? parseUnifiedDiff(data.diff) : null), [data?.diff]);
	const [visibleWindow, setVisibleWindow] = useState(() => ({
		file,
		staged,
		dataUpdatedAt,
		lineCount: DIFF_SEGMENT_ROWS,
	}));
	const isCurrentPatch =
		visibleWindow.file === file &&
		visibleWindow.staged === staged &&
		visibleWindow.dataUpdatedAt === dataUpdatedAt;
	// A new file or a query refetch gets a new `dataUpdatedAt`, so it starts at the
	// first segment without a setState-in-effect reset. The same value also keys
	// DiffView below, resetting its scrollTop.
	const visibleLineCount = isCurrentPatch ? visibleWindow.lineCount : DIFF_SEGMENT_ROWS;

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
			file,
			staged,
			dataUpdatedAt,
			lineCount: Math.min(parsed.lines.length, visibleLineCount + DIFF_SEGMENT_ROWS),
		});
	}, [dataUpdatedAt, file, parsed, staged, visibleLineCount]);

	// Only the server-side byte ceiling is genuine truncation now. The parser no
	// longer discards rows; the modal merely keeps later rows off-screen until the
	// reader scrolls down.
	const showTruncated = !!data?.truncated;

	return (
		<Modal opened={!!file} onClose={onClose} title={file ? t("diffTitle", { file }) : ""} size="xl">
			{isLoading && <Loader size="sm" />}

			{!isLoading && !data?.diff && (
				<Text size="sm" c="dimmed">
					{t("noDiff")}
				</Text>
			)}

			{!isLoading && parsed?.binary && (
				<Text size="sm" c="dimmed">
					{t("diffBinary")}
				</Text>
			)}

			{!isLoading && parsed && !parsed.binary && parsed.lines.length > 0 && (
				<>
					{showTruncated && (
						<Text size="xs" c="yellow" mb="xs">
							{t("diffTruncated")}
						</Text>
					)}
					{hasMoreLines && (
						<Text size="xs" c="dimmed" mb="xs">
							{t("diffLoadMore", {
								shown: visibleLines.length,
								total: parsed.lines.length,
							})}
						</Text>
					)}
					<DiffView
						key={`${file ?? ""}:${staged}:${dataUpdatedAt}`}
						lines={visibleLines}
						hunks={visibleHunks}
						language={file ? getShikiLang(file) : undefined}
						maxHeight={500}
						onNearBottom={hasMoreLines ? loadNextSegment : undefined}
						// This panel is not measured by pretext, so the column may shrink to
						// the digits actually present. A two-digit file previously reserved a
						// third padding column per side, which is wasted width on a phone.
						gutterMinWidth={1}
					/>
				</>
			)}
		</Modal>
	);
}
