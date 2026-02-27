import { Code, Loader, Modal, ScrollArea, Text } from "@mantine/core";
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

	return (
		<Modal opened={!!file} onClose={onClose} title={file ? t("diffTitle", { file }) : ""} size="xl">
			{isLoading && <Loader size="sm" />}

			{!isLoading && (!data || !data.diff) && (
				<Text size="sm" c="dimmed">
					{t("noDiff")}
				</Text>
			)}

			{!isLoading && data?.diff && (
				<ScrollArea.Autosize mah={500}>
					{data.truncated && (
						<Text size="xs" c="yellow" mb="xs">
							{t("diffTruncated")}
						</Text>
					)}
					<Code block style={{ whiteSpace: "pre", fontSize: 12, lineHeight: 1.5 }}>
						{data.diff}
					</Code>
				</ScrollArea.Autosize>
			)}
		</Modal>
	);
}
