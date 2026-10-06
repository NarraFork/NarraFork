import { buildCommitPreviewBrowserHref } from "@frontend/lib/git-commit-preview-navigation";
import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	CopyButton,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	GIT_COMMIT_PREVIEW_UNSUPPORTED,
	type GitCommitFile,
	type GitCommitFileStatus,
} from "@shared/git-commit-preview";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconExternalLink,
	IconSearch,
} from "@tabler/icons-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitCommitDetail, useGitCommitDiff } from "../../hooks/useGit";
import type { ApiError } from "../../lib/api";
import { type GitTarget, gitBasePath, gitTargetKey } from "../../lib/api/git";
import { formatRelativeTime } from "../../lib/format";
import classes from "./GitCommitPreview.module.css";
import { GitPatchView } from "./GitPatchView";

const STATUS_COLOR: Record<GitCommitFileStatus, string> = {
	added: "green",
	modified: "blue",
	deleted: "red",
	renamed: "violet",
	copied: "cyan",
	typechange: "orange",
	unmerged: "yellow",
	unknown: "gray",
};
const STATUS_LETTER: Record<GitCommitFileStatus, string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	unmerged: "U",
	unknown: "?",
};

function isUnsupported(error: unknown): boolean {
	return (error as ApiError | null)?.data?.code === GIT_COMMIT_PREVIEW_UNSUPPORTED;
}

export function GitCommitPreview(props: {
	target: GitTarget;
	sha: string;
	selectedPath?: string | null;
	onSelectPath?: (path: string) => void;
	onNavigateCommit?: (sha: string) => void;
	mode?: "modal" | "page" | "window";
}) {
	// Identity includes the API endpoint, not just the workspace: two narrators may
	// share a worktree but have different permissions. Reset observers and UI state.
	return (
		<CommitPreviewContent
			key={JSON.stringify([gitBasePath(props.target), gitTargetKey(props.target), props.sha])}
			{...props}
		/>
	);
}

function CommitPreviewContent({
	target,
	sha,
	selectedPath,
	onSelectPath,
	onNavigateCommit,
	mode = "modal",
}: Parameters<typeof GitCommitPreview>[0]) {
	const { t } = useTranslation("git");
	const [localPath, setLocalPath] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [bodyExpanded, setBodyExpanded] = useState(false);
	const [filesExpanded, setFilesExpanded] = useState(true);
	const bodyId = useId();
	const filesId = useId();
	const detail = useGitCommitDetail(target, sha);
	// A failed refetch retains cached data. Never expose private metadata or keep
	// its patch observer alive after the server has refused access.
	const data = detail.isError ? undefined : detail.data;
	// Undefined is uncontrolled; explicit null is a page awaiting URL normalization.
	const path =
		selectedPath === undefined ? (localPath ?? data?.files[0]?.path ?? null) : selectedPath;
	const selected = data?.files.find((file) => file.path === path);
	const linkMode = mode === "page" ? "page" : "window";
	const previewHref = data
		? buildCommitPreviewBrowserHref(target, sha, selected?.path, linkMode)
		: "";
	const query = filter.trim().toLocaleLowerCase();
	const visibleFiles = data?.files.filter(
		(file) =>
			file.path.toLocaleLowerCase().includes(query) ||
			file.oldPath?.toLocaleLowerCase().includes(query),
	);
	const message = data?.message ?? "";
	const lineBreak = message.indexOf("\n");
	const subject = lineBreak < 0 ? message : message.slice(0, lineBreak);
	const body = lineBreak < 0 ? "" : message.slice(lineBreak + 1).replace(/^\s*\n/, "");
	const textFiles = data?.files.filter((file) => !file.binary) ?? [];
	const added = textFiles.reduce((sum, file) => sum + (file.linesAdded ?? 0), 0);
	const removed = textFiles.reduce((sum, file) => sum + (file.linesRemoved ?? 0), 0);
	const unknownStats = textFiles.some(
		(file) => file.linesAdded === null || file.linesRemoved === null,
	);
	const hasBinary = data?.files.some((file) => file.binary);

	return (
		<Stack gap="md" className={classes.preview} data-commit-preview={mode}>
			{detail.isLoading && <Loader size="sm" />}
			{detail.error &&
				(isUnsupported(detail.error) ? (
					<Alert color="yellow">{t("commitPreview.unsupported")}</Alert>
				) : (
					<Text c="red" size="sm" role="alert">
						{detail.error.message}
					</Text>
				))}
			{data && (
				<>
					<Paper withBorder radius="md" p="md">
						<Stack gap="sm">
							<div data-commit-message>
								<Text component="h2" size="lg" fw={600} m={0} className={classes.wrap}>
									{subject}
								</Text>
								{body && (
									<>
										<Button
											variant="subtle"
											size="compact-xs"
											mt="xs"
											onClick={() => setBodyExpanded(!bodyExpanded)}
											aria-expanded={bodyExpanded}
											aria-controls={bodyId}
											data-commit-body-toggle
										>
											{t(bodyExpanded ? "commitPreview.hideBody" : "commitPreview.showBody")}
										</Button>
										{bodyExpanded && (
											<Text
												id={bodyId}
												component="pre"
												size="sm"
												mt="sm"
												mb={0}
												className={classes.messageBody}
												data-commit-body
											>
												{body}
											</Text>
										)}
									</>
								)}
							</div>
							{data.messageTruncated && (
								<Text size="xs" c="yellow">
									{t("commitPreview.messageTruncated")}
								</Text>
							)}
							<Group gap="xs" className={classes.wrap}>
								<Text size="xs" ff="monospace" data-commit-sha>
									{t("commitPreview.sha")}: {data.sha}
								</Text>
								<CopyButton value={data.sha}>
									{({ copied, copy }) => (
										<Tooltip label={t(copied ? "commitPreview.copied" : "commitPreview.copySha")}>
											<ActionIcon
												type="button"
												variant="subtle"
												size="sm"
												onClick={copy}
												aria-label={t("commitPreview.copySha")}
											>
												{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
											</ActionIcon>
										</Tooltip>
									)}
								</CopyButton>
								<CopyButton value={`${globalThis.location?.origin ?? ""}${previewHref}`}>
									{({ copied, copy }) => (
										<Button
											type="button"
											variant="subtle"
											size="compact-xs"
											onClick={copy}
											data-commit-copy-link
										>
											{t(copied ? "commitPreview.copied" : "commitPreview.copyLink")}
										</Button>
									)}
								</CopyButton>
								{mode === "modal" && (
									<Anchor
										href={previewHref}
										target="_blank"
										rel="noopener noreferrer"
										size="xs"
										data-commit-open-page
									>
										<Group component="span" gap={4}>
											{t("commitPreview.openPage")}
											<IconExternalLink size={14} />
										</Group>
									</Anchor>
								)}
							</Group>
							<Stack gap={3} className={classes.wrap}>
								<Text size="xs" c="dimmed">
									{t("commitPreview.author")}: {data.authorName} &lt;{data.authorEmail}&gt; ·{" "}
									<time dateTime={data.authoredAt} title={formatRelativeTime(data.authoredAt)}>
										{data.authoredAt}
									</time>
								</Text>
								<Text size="xs" c="dimmed">
									{t("commitPreview.committer")}: {data.committerName} &lt;{data.committerEmail}&gt;
									·{" "}
									<time dateTime={data.committedAt} title={formatRelativeTime(data.committedAt)}>
										{data.committedAt}
									</time>
								</Text>
								<Group gap="xs" title={data.parents.join(" ")}>
									<Text size="xs" c="dimmed">
										{t("commitPreview.parents")}:
									</Text>
									{data.parents.length === 0 ? (
										<Text size="xs">—</Text>
									) : (
										data.parents.map((parent) => (
											<Anchor
												key={parent}
												href={buildCommitPreviewBrowserHref(target, parent, undefined, linkMode)}
												size="xs"
												ff="monospace"
												title={parent}
												data-commit-parent={parent}
												onClick={(event) => {
													if (
														onNavigateCommit &&
														event.button === 0 &&
														!event.metaKey &&
														!event.ctrlKey &&
														!event.shiftKey &&
														!event.altKey
													) {
														event.preventDefault();
														onNavigateCommit(parent);
													}
												}}
											>
												{parent.slice(0, 7)}
											</Anchor>
										))
									)}
								</Group>
							</Stack>
							{data.parents.length === 0 && (
								<Text size="xs" c="dimmed">
									{t("commitPreview.rootCommit")}
								</Text>
							)}
							{data.parents.length > 1 && (
								<Alert color="blue" py={6}>
									<Text size="xs">
										{t("commitPreview.mergeNotice", { parent: data.parents[0].slice(0, 7) })}
									</Text>
								</Alert>
							)}
						</Stack>
					</Paper>

					<Stack gap={4} data-commit-statistics>
						<Group gap="md">
							<Text size="sm" fw={600}>
								{t("commitPreview.files", { count: data.files.length })}
							</Text>
							<Text size="sm" c="green">
								{t("commitPreview.additions", { count: added })}
							</Text>
							<Text size="sm" c="red">
								{t("commitPreview.deletions", { count: removed })}
							</Text>
						</Group>
						{(data.filesTruncated || unknownStats) && (
							<Text size="xs" c="yellow">
								{t("commitPreview.partialStats")}
							</Text>
						)}
						{unknownStats && (
							<Text size="xs" c="yellow">
								{t("commitPreview.unknownStats")}
							</Text>
						)}
						{hasBinary && (
							<Text size="xs" c="dimmed">
								{t("commitPreview.binaryStats")}
							</Text>
						)}
						{data.filesTruncated && (
							<Text size="xs" c="yellow">
								{t("commitPreview.filesTruncated", { count: data.files.length })}
							</Text>
						)}
					</Stack>
					{data.files.length === 0 && !data.filesTruncated && (
						<Text size="sm" c="dimmed">
							{t("commitPreview.noFiles")}
						</Text>
					)}
					{data.files.length > 0 && (
						<div className={classes.layout}>
							<Paper
								component="nav"
								withBorder
								radius="md"
								className={classes.navigation}
								aria-label={t("commitPreview.fileNavigation")}
							>
								<UnstyledButton
									type="button"
									className={classes.mobileToggle}
									aria-expanded={filesExpanded}
									aria-controls={filesId}
									onClick={() => setFilesExpanded(!filesExpanded)}
									data-commit-files-toggle
								>
									<Group gap="xs">
										{filesExpanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
										<Text size="sm" fw={600}>
											{t("commitPreview.fileNavigation")}
										</Text>
									</Group>
								</UnstyledButton>
								<div id={filesId} className={classes.fileBrowser} data-expanded={filesExpanded}>
									<TextInput
										p="xs"
										size="xs"
										value={filter}
										onInput={(event) => setFilter(event.currentTarget.value)}
										aria-label={t("commitPreview.filterFiles")}
										placeholder={t("commitPreview.filterFiles")}
										leftSection={<IconSearch size={14} />}
									/>
									<div className={classes.fileList}>
										{visibleFiles?.map((file) => {
											const label = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
											return (
												<UnstyledButton
													key={file.path}
													type="button"
													className={classes.fileButton}
													aria-pressed={selected?.path === file.path}
													aria-label={`${t(`commitPreview.status.${file.status}`)}: ${label}`}
													title={label}
													data-commit-file={file.path}
													onClick={() => {
														if (selectedPath === undefined) setLocalPath(file.path);
														onSelectPath?.(file.path);
													}}
												>
													<Group gap={6} wrap="nowrap">
														<Badge
															component="span"
															size="xs"
															color={STATUS_COLOR[file.status]}
															className={classes.status}
														>
															{STATUS_LETTER[file.status]}
														</Badge>
														<Text
															component="span"
															size="xs"
															ff="monospace"
															className={classes.fileName}
														>
															{label}
														</Text>
													</Group>
													<Box pl={28}>
														<FileStats file={file} />
													</Box>
												</UnstyledButton>
											);
										})}
										{visibleFiles?.length === 0 && (
											<Text size="xs" c="dimmed" p="sm" role="status">
												{t("commitPreview.noMatchingFiles")}
											</Text>
										)}
									</div>
								</div>
							</Paper>
							<div className={classes.diffColumn}>
								{selected ? (
									<CommitFileCard
										key={JSON.stringify([selected.path, selected.oldPath])}
										target={target}
										sha={sha}
										file={selected}
										mode={mode}
									/>
								) : (
									path === null && (
										<Text size="sm" c="dimmed">
											{t("commitPreview.selectFile")}
										</Text>
									)
								)}
							</div>
						</div>
					)}
					{path !== null && !selected && (
						<Alert color="red" role="alert">
							{t("commitPreview.invalidFile", { path })}
						</Alert>
					)}
				</>
			)}
		</Stack>
	);
}

function FileStats({ file }: { file: GitCommitFile }) {
	const { t } = useTranslation("git");
	return file.binary ? (
		<Text component="span" size="xs" c="dimmed">
			{t("commitPreview.binary")}
		</Text>
	) : (
		<Text
			component="span"
			size="xs"
			ff="monospace"
			title={
				file.linesAdded === null || file.linesRemoved === null
					? t("commitPreview.unknownStats")
					: undefined
			}
		>
			<Text span c="green" inherit>
				+{file.linesAdded ?? "?"}
			</Text>{" "}
			<Text span c="red" inherit>
				-{file.linesRemoved ?? "?"}
			</Text>
		</Text>
	);
}

function CommitFileCard({
	target,
	sha,
	file,
	mode,
}: {
	target: GitTarget;
	sha: string;
	file: GitCommitFile;
	mode: "modal" | "page" | "window";
}) {
	const { t } = useTranslation("git");
	const [expanded, setExpanded] = useState(true);
	const patchId = useId();
	const label = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
	return (
		<Paper withBorder radius="md" className={classes.diffCard} data-commit-diff-card>
			<UnstyledButton
				type="button"
				className={classes.diffHeader}
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				aria-controls={patchId}
				aria-label={t(expanded ? "commitPreview.collapseDiff" : "commitPreview.expandDiff", {
					path: file.path,
				})}
				data-commit-diff-toggle
			>
				<Group gap="xs" wrap="nowrap">
					{expanded ? (
						<IconChevronDown size={16} className={classes.chevron} />
					) : (
						<IconChevronRight size={16} className={classes.chevron} />
					)}
					<Text component="span" size="xs" ff="monospace" className={classes.fileName}>
						{label}
					</Text>
					<Badge
						component="span"
						size="xs"
						color={STATUS_COLOR[file.status]}
						className={classes.status}
					>
						{STATUS_LETTER[file.status]}
					</Badge>
				</Group>
				<Box pl={24}>
					<FileStats file={file} />
				</Box>
			</UnstyledButton>
			{/* Unmount, rather than merely hiding, to release and cancel the query. */}
			{expanded && (
				<Box id={patchId} p="xs">
					<CommitFilePatch
						target={target}
						sha={sha}
						file={file}
						maxHeight={mode === "modal" ? 560 : 720}
					/>
				</Box>
			)}
		</Paper>
	);
}

function CommitFilePatch({
	target,
	sha,
	file,
	maxHeight,
}: {
	target: GitTarget;
	sha: string;
	file: GitCommitFile;
	maxHeight: number;
}) {
	const { t } = useTranslation("git");
	const patch = useGitCommitDiff(target, sha, file.path, file.oldPath);
	if (isUnsupported(patch.error))
		return <Alert color="yellow">{t("commitPreview.unsupported")}</Alert>;
	return (
		<GitPatchView
			diff={patch.data?.diff}
			truncated={!!patch.data?.truncated}
			file={file.path}
			resetKey={JSON.stringify([sha, file.oldPath, file.path, patch.dataUpdatedAt])}
			loading={patch.isLoading}
			error={patch.error}
			maxHeight={maxHeight}
		/>
	);
}
