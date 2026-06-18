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
	type FileAttributionSummary,
	useGitAiCommitMessage,
	useGitAttributions,
	useGitCommit,
	useGitDiscard,
	useGitStage,
	useGitStatus,
	useGitUnstage,
} from "../../hooks/useGit";
import { useNarrators } from "../../hooks/useNarrator";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";
import { GitFileDiff } from "./GitFileDiff";

/** Max files to render per section to avoid UI freeze. */
const MAX_DISPLAY_FILES = 80;
const MAX_GIT_FILE_PATH_CHARS = 1_000;

function clampGitFilePath(path: string): string {
	return path.length > MAX_GIT_FILE_PATH_CHARS
		? `${path.slice(0, MAX_GIT_FILE_PATH_CHARS)}…`
		: path;
}

export function GitChangesTab({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");
	const confirm = useConfirmDialog();
	const { data: status, isLoading } = useGitStatus(chapterId);
	const { data: attributions } = useGitAttributions(chapterId);
	const { data: narrators } = useNarrators({ chapterId });
	const stage = useGitStage(chapterId);
	const unstage = useGitUnstage(chapterId);
	const commit = useGitCommit(chapterId);
	const discard = useGitDiscard(chapterId);
	const aiMsg = useGitAiCommitMessage(chapterId);

	const [message, setMessage] = useState("");
	const [diffFile, setDiffFile] = useState<string | null>(null);
	const [diffStaged, setDiffStaged] = useState(false);

	// path → attribution summary, and narratorId → display label.
	const attrByPath = new Map((attributions ?? []).map((a) => [a.filePath, a]));
	const narratorLabel = new Map(
		(narrators ?? []).map((n) => [n.id, n.title || t("attributionUnnamed")]),
	);

	if (isLoading) {
		return <Loader size="sm" />;
	}

	if (!status?.hasChanges) {
		return (
			<Text size="sm" c="dimmed" py="md" ta="center">
				{t("noChanges")}
			</Text>
		);
	}

	const stagedFiles = status.files
		.filter((f) => !f.status.startsWith("?") && isStagedFile(f.status))
		.map((f) => ({
			...f,
			displayLinesAdded: f.stagedLinesAdded,
			displayLinesRemoved: f.stagedLinesRemoved,
		}));
	const unstagedFiles = status.files
		.filter((f) => f.status.startsWith("?") || isUnstagedFile(f.status))
		.map((f) => ({
			...f,
			displayLinesAdded: f.unstagedLinesAdded,
			displayLinesRemoved: f.unstagedLinesRemoved,
		}));

	// Cap displayed files to avoid rendering thousands of rows
	const displayStaged = stagedFiles.slice(0, MAX_DISPLAY_FILES);
	const displayUnstaged = unstagedFiles.slice(0, MAX_DISPLAY_FILES);
	const hiddenStaged = stagedFiles.length - displayStaged.length;
	const hiddenUnstaged = unstagedFiles.length - displayUnstaged.length;
	// Server may have capped the files array too
	const totalFiles = status.totalFiles ?? status.files.length;
	const serverCapped = totalFiles > status.files.length;

	/** Porcelain status XY: X is index status, Y is worktree status.
	 *  A file is staged if X is one of M/A/D/R/C (not space or ?). */
	function isStagedFile(s: string): boolean {
		const x = s[0];
		return x !== " " && x !== "?" && /[MADRC]/.test(x);
	}

	/** A file has unstaged changes if Y (second char) is not space,
	 *  or it's untracked (??) */
	function isUnstagedFile(s: string): boolean {
		const y = s[1];
		return y !== " " || s.startsWith("?");
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

	async function handleDiscardAll() {
		if (await confirm({ message: t("discardConfirm") })) {
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
								attribution={attrByPath.get(f.path)}
								narratorLabel={narratorLabel}
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
								attribution={attrByPath.get(f.path)}
								narratorLabel={narratorLabel}
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
							aria-label={t("aiGenerate")}
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
	attribution,
	narratorLabel,
	t,
}: {
	file: {
		status: string;
		path: string;
		displayLinesAdded: number;
		displayLinesRemoved: number;
	};
	action: "stage" | "unstage";
	onAction: () => void;
	onClick: () => void;
	attribution?: FileAttributionSummary;
	narratorLabel: Map<string, string>;
	t: (key: string, opts?: Record<string, unknown>) => string;
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
				{clampGitFilePath(file.path)}
			</Text>
			<AttributionBadge attribution={attribution} narratorLabel={narratorLabel} t={t} />
			{(file.displayLinesAdded > 0 || file.displayLinesRemoved > 0) && (
				<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
					{file.displayLinesAdded > 0 && (
						<Text size="xs" c="green" ff="monospace">
							+{file.displayLinesAdded}
						</Text>
					)}
					{file.displayLinesRemoved > 0 && (
						<Text size="xs" c="red" ff="monospace">
							-{file.displayLinesRemoved}
						</Text>
					)}
				</Group>
			)}
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

/** Compact badge showing who last changed a file, with a contributor tooltip. */
function AttributionBadge({
	attribution,
	narratorLabel,
	t,
}: {
	attribution?: FileAttributionSummary;
	narratorLabel: Map<string, string>;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	if (!attribution) return null;

	const labelFor = (id: string | null): string =>
		id ? (narratorLabel.get(id) ?? t("attributionUnknown")) : t("attributionExternal");

	const lastLabel = attribution.lastNarratorId
		? labelFor(attribution.lastNarratorId)
		: attribution.hasExternal
			? t("attributionExternal")
			: t("attributionUnknown");

	// Contributors other than the last modifier.
	const others = attribution.contributorNarratorIds.filter(
		(id) => id !== attribution.lastNarratorId,
	);

	const tooltipLines: string[] = [
		t("attributionLastModified", { name: lastLabel }),
		...others.map((id) => t("attributionAlsoModified", { name: labelFor(id) })),
	];
	if (attribution.hasExternal && attribution.lastNarratorId) {
		tooltipLines.push(t("attributionHasExternal"));
	}

	const extraCount = others.length + (attribution.hasExternal ? 1 : 0);

	return (
		<Tooltip label={tooltipLines.join("\n")} multiline withinPortal>
			<Badge
				size="xs"
				variant="light"
				color={attribution.lastNarratorId ? "indigo" : "gray"}
				style={{ flexShrink: 0, maxWidth: 110, cursor: "default", textTransform: "none" }}
				onClick={(e) => e.stopPropagation()}
			>
				<Text size="xs" lineClamp={1} component="span">
					{lastLabel}
					{extraCount > 0 ? ` +${extraCount}` : ""}
				</Text>
			</Badge>
		</Tooltip>
	);
}
