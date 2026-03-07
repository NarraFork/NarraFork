import { statusRegistry } from "@frontend/lib/status-registry";
import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconCheck, IconMinus, IconPlus, IconSparkles } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useGitAiCommitMessage,
	useGitCommit,
	useGitDiscard,
	useGitStage,
	useGitStatus,
	useGitUnstage,
} from "../../hooks/useGit";
import { GitFileDiff } from "./GitFileDiff";

/** Max files to render per section to avoid UI freeze. */
const MAX_DISPLAY_FILES = 80;

export function GitChangesTab({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");
	const { data: status, isLoading } = useGitStatus(chapterId);
	const stage = useGitStage(chapterId);
	const unstage = useGitUnstage(chapterId);
	const commit = useGitCommit(chapterId);
	const discard = useGitDiscard(chapterId);
	const aiMsg = useGitAiCommitMessage(chapterId);

	const [message, setMessage] = useState("");
	const [diffFile, setDiffFile] = useState<string | null>(null);
	const [diffStaged, setDiffStaged] = useState(false);

	if (isLoading) {
		return <Loader size="sm" />;
	}

	if (!status || !status.hasChanges) {
		return (
			<Text size="sm" c="dimmed" py="md" ta="center">
				{t("noChanges")}
			</Text>
		);
	}

	const stagedFiles = status.files.filter(
		(f) => !f.status.startsWith("?") && status.staged > 0 && isStagedFile(f.status),
	);
	const unstagedFiles = status.files.filter(
		(f) => f.status.startsWith("?") || !isStagedFile(f.status),
	);

	// Cap displayed files to avoid rendering thousands of rows
	const displayStaged = stagedFiles.slice(0, MAX_DISPLAY_FILES);
	const displayUnstaged = unstagedFiles.slice(0, MAX_DISPLAY_FILES);
	const hiddenStaged = stagedFiles.length - displayStaged.length;
	const hiddenUnstaged = unstagedFiles.length - displayUnstaged.length;
	// Server may have capped the files array too
	const totalFiles = status.totalFiles ?? status.files.length;
	const serverCapped = totalFiles > status.files.length;

	function isStagedFile(fileStatus: string): boolean {
		return /^[MADRC] /.test(fileStatus) || /^[MADRC]$/.test(fileStatus);
	}

	function handleCommit() {
		if (!message.trim()) return;
		commit.mutate(message.trim(), {
			onSuccess: () => setMessage(""),
		});
	}

	function handleAiGenerate() {
		aiMsg.mutate(undefined, {
			onSuccess: (data) => {
				if (data?.message) setMessage(data.message);
			},
		});
	}

	function handleDiscardAll() {
		if (window.confirm(t("discardConfirm"))) {
			discard.mutate({ all: true });
		}
	}

	return (
		<ScrollArea.Autosize mah={300}>
			<Stack gap="xs">
				{/* Staged section */}
				{stagedFiles.length > 0 && (
					<Stack gap={4}>
						<Group gap="xs" justify="space-between">
							<Text size="xs" fw={600}>
								{t("staged")} ({status.staged})
							</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => unstage.mutate({ all: true })}
								loading={unstage.isPending}
							>
								{t("unstageAll")}
							</Button>
						</Group>
						{displayStaged.map((f) => (
							<FileRow
								key={`s-${f.path}`}
								file={f}
								action="unstage"
								onAction={() => unstage.mutate({ files: [f.path] })}
								onClick={() => {
									setDiffFile(f.path);
									setDiffStaged(true);
								}}
								t={t}
							/>
						))}
						{hiddenStaged > 0 && (
							<Text size="xs" c="dimmed" ta="center">
								+{hiddenStaged} more
							</Text>
						)}
					</Stack>
				)}

				{/* Unstaged / untracked section */}
				{unstagedFiles.length > 0 && (
					<Stack gap={4}>
						<Group gap="xs" justify="space-between">
							<Text size="xs" fw={600}>
								{t("unstaged")} ({status.unstaged + status.untracked})
							</Text>
							<Group gap={4}>
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={() => stage.mutate({ all: true })}
									loading={stage.isPending}
								>
									{t("stageAll")}
								</Button>
								<Button
									size="compact-xs"
									variant="subtle"
									color="red"
									onClick={handleDiscardAll}
									loading={discard.isPending}
								>
									{t("discardAll")}
								</Button>
							</Group>
						</Group>
						{displayUnstaged.map((f) => (
							<FileRow
								key={`u-${f.path}`}
								file={f}
								action="stage"
								onAction={() => stage.mutate({ files: [f.path] })}
								onClick={() => {
									setDiffFile(f.path);
									setDiffStaged(false);
								}}
								t={t}
							/>
						))}
						{(hiddenUnstaged > 0 || serverCapped) && (
							<Text size="xs" c="dimmed" ta="center">
								+{serverCapped ? totalFiles - status.files.length : hiddenUnstaged} more
							</Text>
						)}
					</Stack>
				)}

				{/* Commit area */}
				<Group gap="xs" align="flex-end" wrap="nowrap">
					<TextInput
						placeholder={t("commitMessage")}
						value={message}
						onChange={(e) => setMessage(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) handleCommit();
						}}
						size="xs"
						style={{ flex: 1 }}
					/>
					<Tooltip label={t("aiGenerate")}>
						<ActionIcon
							variant="subtle"
							size="sm"
							onClick={handleAiGenerate}
							loading={aiMsg.isPending}
						>
							<IconSparkles size={14} />
						</ActionIcon>
					</Tooltip>
					<Button
						size="compact-xs"
						leftSection={<IconCheck size={14} />}
						onClick={handleCommit}
						loading={commit.isPending}
						disabled={!message.trim() || status.staged === 0}
					>
						{t("commitButton")}
					</Button>
				</Group>
			</Stack>

			<GitFileDiff
				chapterId={chapterId}
				file={diffFile}
				staged={diffStaged}
				onClose={() => setDiffFile(null)}
			/>
		</ScrollArea.Autosize>
	);
}

function FileRow({
	file,
	action,
	onAction,
	onClick,
	t,
}: {
	file: { status: string; path: string };
	action: "stage" | "unstage";
	onAction: () => void;
	onClick: () => void;
	t: (key: string) => string;
}) {
	const statusChar = file.status.replace(/\s/g, "") || "M";
	const color = statusRegistry.gitFileStatus(statusChar).color;

	return (
		<Group
			gap={4}
			wrap="nowrap"
			py={2}
			px={4}
			style={{ borderRadius: 4, cursor: "pointer" }}
			onClick={onClick}
		>
			<Badge size="xs" color={color} variant="filled" w={28} style={{ flexShrink: 0 }}>
				{statusChar}
			</Badge>
			<Text size="xs" lineClamp={1} style={{ flex: 1, minWidth: 0 }} ff="monospace">
				{file.path}
			</Text>
			<Tooltip label={action === "stage" ? t("stageFile") : t("unstageFile")}>
				<ActionIcon
					size="xs"
					variant="subtle"
					onClick={(e) => {
						e.stopPropagation();
						onAction();
					}}
				>
					{action === "stage" ? <IconPlus size={12} /> : <IconMinus size={12} />}
				</ActionIcon>
			</Tooltip>
		</Group>
	);
}
