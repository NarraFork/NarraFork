import { Modal } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { type GitTarget, useGitDiff } from "../../hooks/useGit";
import { GitPatchView } from "./GitPatchView";

interface GitFileDiffProps {
	chapterId?: string;
	target?: GitTarget;
	file: string | null;
	staged?: boolean;
	onClose: () => void;
}

export function GitFileDiff({
	chapterId,
	target = chapterId,
	file,
	staged = false,
	onClose,
}: GitFileDiffProps) {
	const { t } = useTranslation("git");
	const { data, dataUpdatedAt, isLoading, error } = useGitDiff(target, file, staged);

	return (
		<Modal opened={!!file} onClose={onClose} title={file ? t("diffTitle", { file }) : ""} size="xl">
			<GitPatchView
				diff={data?.diff}
				truncated={!!data?.truncated}
				file={file}
				// A refetch gets a new `dataUpdatedAt`, restarting paging and scroll.
				resetKey={`${file ?? ""}:${staged}:${dataUpdatedAt}`}
				loading={isLoading}
				error={error}
			/>
		</Modal>
	);
}
