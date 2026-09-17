import {
	Button,
	Group,
	Loader,
	Menu,
	ScrollArea,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitLog, useGitReset } from "../../hooks/useGit";
import { useChapterSplitCapability } from "../../hooks/usePlatform";
import { type GitTarget, gitCanWrite } from "../../lib/api/git";
import { formatRelativeTime } from "../../lib/format";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { ChapterSplitModal } from "./ChapterSplitModal";

const LIMIT = 50;
const MAX_GIT_COMMIT_LIST_TEXT_CHARS = 1_000;

function clampGitCommitListText(value: string | null | undefined): string {
	if (!value) return "";
	return value.length > MAX_GIT_COMMIT_LIST_TEXT_CHARS
		? `${value.slice(0, MAX_GIT_COMMIT_LIST_TEXT_CHARS)}…`
		: value;
}

export function GitCommitsTab({
	chapterId,
	target = chapterId ?? "",
}: {
	chapterId?: string;
	target?: GitTarget;
}) {
	const canWrite = gitCanWrite(target);
	const splitChapterId = typeof target === "string" ? target : target.chapterId;
	const { t } = useTranslation("git");
	const confirm = useConfirmDialog();
	const chapterSplitCapability = useChapterSplitCapability();
	const splitUnsupportedReason = chapterSplitCapability.supported
		? undefined
		: chapterSplitCapability.reason || t("splitUnsupported");
	const [skip, setSkip] = useState(0);
	const [splitTarget, setSplitTarget] = useState<{ sha: string; message: string } | null>(null);
	const { data: commits, isLoading, error } = useGitLog(target, LIMIT, skip);
	const reset = useGitReset(target);

	async function handleReset(sha: string, mode: "soft" | "hard") {
		if (!canWrite) return;
		const scope =
			typeof target === "string" ? "" : `\n${t("workspace.scope", { root: target.rootPath })}`;
		if (
			!(await confirm({
				message: `${t(mode === "hard" ? "resetConfirm" : "resetSoftConfirm")}${scope}`,
			}))
		)
			return;
		reset.mutate({ target: sha, mode });
	}

	if (isLoading) {
		return <Loader size="sm" />;
	}

	if (error)
		return (
			<Text c="red" size="sm">
				{error.message}
			</Text>
		);

	if (!commits || (commits.length === 0 && skip === 0)) {
		return (
			<Text size="sm" c="dimmed" py="md" ta="center">
				{t("commitEmpty")}
			</Text>
		);
	}

	return (
		<>
			{reset.error && (
				<Text c="red" size="xs">
					{reset.error.message}
				</Text>
			)}
			{reset.error && (
				<Text c="dimmed" size="xs">
					{t("workspace.writeFailureHint")}
				</Text>
			)}
			{/* Fills the dock panel: the tab body hands down its full height. */}
			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				<Stack gap={2}>
					{commits.map((c) => (
						<Group key={c.sha} gap={6} wrap="nowrap" py={2} px={4}>
							<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
								{c.shortSha}
							</Text>
							<Text size="xs" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
								{clampGitCommitListText(c.message)}
							</Text>
							<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
								{clampGitCommitListText(c.author)}
							</Text>
							<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
								{formatRelativeTime(c.date)}
							</Text>
							<Menu position="bottom-end" withinPortal>
								<Menu.Target>
									<UnstyledButton onClick={(e) => e.stopPropagation()} style={{ lineHeight: 1 }}>
										<IconDots size={14} />
									</UnstyledButton>
								</Menu.Target>
								<Menu.Dropdown>
									{splitChapterId && (
										<Menu.Item
											disabled={!canWrite || !chapterSplitCapability.supported}
											title={splitUnsupportedReason}
											onClick={() => {
												if (!chapterSplitCapability.supported) return;
												setSplitTarget({ sha: c.sha, message: c.message });
											}}
										>
											{t("splitHere")}
										</Menu.Item>
									)}
									<Menu.Item
										disabled={!canWrite || reset.isPending}
										onClick={() => handleReset(c.sha, "soft")}
									>
										{t("resetSoft")}
									</Menu.Item>
									<Menu.Item
										disabled={!canWrite || reset.isPending}
										color="red"
										onClick={() => handleReset(c.sha, "hard")}
									>
										{t("resetHard")}
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						</Group>
					))}

					{skip > 0 && (
						<Button
							size="compact-xs"
							variant="subtle"
							onClick={() => setSkip((value) => Math.max(0, value - LIMIT))}
						>
							{t("previousPage")}
						</Button>
					)}
					{commits.length === LIMIT && (
						<Button
							size="compact-xs"
							variant="subtle"
							fullWidth
							onClick={() => setSkip((s) => s + LIMIT)}
						>
							{t("loadMore")}
						</Button>
					)}
				</Stack>
			</ScrollArea>
			{splitChapterId && (
				<ChapterSplitModal
					chapterId={splitChapterId}
					commitSha={splitTarget?.sha ?? null}
					commitMessage={splitTarget?.message}
					opened={!!splitTarget}
					onClose={() => setSplitTarget(null)}
				/>
			)}
		</>
	);
}
