import { DiffView } from "@frontend/components/narrator/DiffView";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import { Loader, Modal, ScrollArea, Text } from "@mantine/core";
import { parseUnifiedDiff } from "@shared/pretext-layout/parse-unified-diff";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useGitDiff } from "../../hooks/useGit";

interface GitFileDiffProps {
	chapterId: string;
	file: string | null;
	staged?: boolean;
	onClose: () => void;
}

export function GitFileDiff({ chapterId, file, staged = false, onClose }: GitFileDiffProps) {
	const { t } = useTranslation("git");
	const { data, isLoading } = useGitDiff(chapterId, file, staged);

	// Git already computed this diff, so the rows are parsed from the patch rather
	// than recomputed from two texts. That keeps the real file line numbers the
	// `@@` headers carry, and lets the shared renderer supply highlighting, the
	// added/removed tint and word-level marking that the old plain <Code> block
	// could not.
	const parsed = useMemo(() => (data?.diff ? parseUnifiedDiff(data.diff) : null), [data?.diff]);

	// Server-side byte cap and the row cap are both truncation the reader should
	// know about.
	const showTruncated = !!data?.truncated || !!parsed?.truncated;

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
				<ScrollArea.Autosize mah={500}>
					{showTruncated && (
						<Text size="xs" c="yellow" mb="xs">
							{t("diffTruncated")}
						</Text>
					)}
					<DiffView
						lines={parsed.lines}
						hunks={parsed.hunks}
						language={file ? getShikiLang(file) : undefined}
						maxHeight={500}
						// This panel is not measured by pretext, so the column may shrink to
						// the digits actually present. A two-digit file previously reserved a
						// third padding column per side, which is wasted width on a phone.
						gutterMinWidth={1}
					/>
				</ScrollArea.Autosize>
			)}
		</Modal>
	);
}
