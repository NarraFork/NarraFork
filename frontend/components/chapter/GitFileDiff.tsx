import { Code, Loader, Modal, ScrollArea, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useGitDiff } from "../../hooks/useGit";

interface GitFileDiffProps {
	chapterId: string;
	file: string | null;
	staged?: boolean;
	onClose: () => void;
}

const MAX_RENDERED_DIFF_CHARS = 160_000;

export function GitFileDiff({ chapterId, file, staged = false, onClose }: GitFileDiffProps) {
	const { t } = useTranslation("git");
	const { data, isLoading } = useGitDiff(chapterId, file, staged);
	const renderedDiff =
		data?.diff && data.diff.length > MAX_RENDERED_DIFF_CHARS
			? data.diff.slice(0, MAX_RENDERED_DIFF_CHARS)
			: data?.diff;
	const diffDisplayTruncated = !!data?.truncated || !!(data?.diff && data.diff !== renderedDiff);

	return (
		<Modal opened={!!file} onClose={onClose} title={file ? t("diffTitle", { file }) : ""} size="xl">
			{isLoading && <Loader size="sm" />}

			{!isLoading && !data?.diff && (
				<Text size="sm" c="dimmed">
					{t("noDiff")}
				</Text>
			)}

			{!isLoading && renderedDiff && (
				<ScrollArea.Autosize mah={500}>
					{diffDisplayTruncated && (
						<Text size="xs" c="yellow" mb="xs">
							{t("diffTruncated")}
						</Text>
					)}
					<Code block style={{ whiteSpace: "pre", fontSize: 12, lineHeight: 1.5 }}>
						{renderedDiff}
					</Code>
				</ScrollArea.Autosize>
			)}
		</Modal>
	);
}
