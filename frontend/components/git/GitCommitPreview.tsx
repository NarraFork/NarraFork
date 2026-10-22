import { buildCommitPreviewBrowserHref } from "@frontend/lib/git-commit-preview-navigation";
import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
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
	type GitCommitDetail,
	type GitCommitFile,
} from "@shared/git-commit-preview";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconColumns2,
	IconCopy,
	IconExternalLink,
	IconLayoutRows,
	IconLink,
	IconSearch,
} from "@tabler/icons-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitCommitDetail, useGitCommitDiff } from "../../hooks/useGit";
import type { ApiError } from "../../lib/api";
import { type GitTarget, gitBasePath, gitTargetKey } from "../../lib/api/git";
import { formatRelativeTime } from "../../lib/format";
import { CopyButton } from "../common/CopyButton";
import {
	COMMIT_STATUS_COLOR,
	COMMIT_STATUS_LETTER,
	commitFileLabel,
	GitCommitFileTree,
} from "./GitCommitFileTree";
import classes from "./GitCommitPreview.module.css";
import { GitPatchView } from "./GitPatchView";

const BODY_PREVIEW_LINES = 4;
const COMMIT_DIFF_LAYOUT_KEY = "narrafork.git.commitDiffLayout";
type CommitDiffLayout = "unified" | "split";

function readCommitDiffLayout(): CommitDiffLayout {
	try {
		return localStorage.getItem(COMMIT_DIFF_LAYOUT_KEY) === "split" ? "split" : "unified";
	} catch {
		return "unified";
	}
}

function storeCommitDiffLayout(layout: CommitDiffLayout) {
	try {
		localStorage.setItem(COMMIT_DIFF_LAYOUT_KEY, layout);
	} catch {
		// The toggle still applies to this view when storage is blocked.
	}
}

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
	const [filesExpanded, setFilesExpanded] = useState(true);
	const [diffLayout, setDiffLayout] = useState<CommitDiffLayout>(readCommitDiffLayout);
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
	const visibleFiles = (data?.files ?? []).filter(
		(file) =>
			file.path.toLocaleLowerCase().includes(query) ||
			file.oldPath?.toLocaleLowerCase().includes(query),
	);
	const changeDiffLayout = (layout: CommitDiffLayout) => {
		setDiffLayout(layout);
		storeCommitDiffLayout(layout);
	};
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
	const hasBinary = data?.files.some((file) => file.binary) ?? false;

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
					<CommitHeader
						data={data}
						subject={subject}
						body={body}
						added={added}
						removed={removed}
						unknownStats={unknownStats}
						hasBinary={hasBinary}
						previewHref={previewHref}
						linkMode={linkMode}
						mode={mode}
						target={target}
						onNavigateCommit={onNavigateCommit}
					/>
					{data.files.length === 0 && !data.filesTruncated && (
						<Text size="sm" c="dimmed">
							{t("commitPreview.noFiles")}
						</Text>
					)}
					{data.files.length > 0 && (
						<div className={classes.browser} data-commit-browser>
							<nav className={classes.navigation} aria-label={t("commitPreview.fileNavigation")}>
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
										className={classes.filter}
										size="xs"
										value={filter}
										onInput={(event) => setFilter(event.currentTarget.value)}
										aria-label={t("commitPreview.filterFiles")}
										placeholder={t("commitPreview.filterFilesPlaceholder")}
										leftSection={<IconSearch size={14} />}
									/>
									<div className={classes.fileList} data-commit-file-list>
										{visibleFiles.length > 0 ? (
											<GitCommitFileTree
												files={visibleFiles}
												selectedPath={selected?.path ?? null}
												onSelect={(filePath) => {
													if (selectedPath === undefined) setLocalPath(filePath);
													onSelectPath?.(filePath);
												}}
											/>
										) : (
											<Text size="xs" c="dimmed" p="sm" role="status">
												{t("commitPreview.noMatchingFiles")}
											</Text>
										)}
									</div>
								</div>
							</nav>
							<div className={classes.diffPane}>
								{selected ? (
									<CommitFileCard
										key={JSON.stringify([selected.path, selected.oldPath])}
										target={target}
										sha={sha}
										file={selected}
										layout={diffLayout}
										onLayoutChange={changeDiffLayout}
									/>
								) : (
									path === null && (
										<Text size="sm" c="dimmed" className={classes.emptyDiff}>
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

function ChangePills({ file }: { file: GitCommitFile }) {
	const { t } = useTranslation("git");
	if (file.binary) {
		return (
			<Text component="span" size="xs" c="dimmed">
				{t("commitPreview.binary")}
			</Text>
		);
	}
	const showAdded = file.linesAdded === null || file.linesAdded > 0;
	const showRemoved = file.linesRemoved === null || file.linesRemoved > 0;
	if (!showAdded && !showRemoved) return null;
	return (
		<span className={classes.pills}>
			{showAdded && <span className={classes.addPill}>+{file.linesAdded ?? "?"}</span>}
			{showRemoved && <span className={classes.delPill}>-{file.linesRemoved ?? "?"}</span>}
		</span>
	);
}

function PathCrumbs({ path, emphasize = false }: { path: string; emphasize?: boolean }) {
	const parts = path.split("/");
	const name = parts.pop() ?? path;
	const directories = parts.map(
		(part, index) => `${parts.slice(0, index).join("/")}${index ? "/" : ""}${part}`,
	);
	return (
		<span className={classes.crumbs}>
			{directories.map((directory) => (
				<span key={directory} className={classes.crumbDir}>
					{directory.slice(directory.lastIndexOf("/") + 1)}
					<span className={classes.crumbSep}>/</span>
				</span>
			))}
			<span className={emphasize ? classes.crumbFile : classes.crumbDir}>{name}</span>
		</span>
	);
}

function DiffLayoutToggle({
	value,
	onChange,
}: {
	value: CommitDiffLayout;
	onChange: (layout: CommitDiffLayout) => void;
}) {
	const { t } = useTranslation("git");
	const options = [
		{ value: "unified" as const, label: t("commitPreview.viewUnified"), icon: IconLayoutRows },
		{ value: "split" as const, label: t("commitPreview.viewSplit"), icon: IconColumns2 },
	];
	return (
		<div
			className={classes.layoutToggle}
			role="radiogroup"
			aria-label={t("commitPreview.diffLayout")}
			data-commit-diff-layout={value}
		>
			{options.map((option) => {
				const Icon = option.icon;
				return (
					<UnstyledButton
						key={option.value}
						type="button"
						role="radio"
						aria-checked={value === option.value}
						aria-label={option.label}
						className={classes.layoutOption}
						data-commit-diff-layout-option={option.value}
						onClick={() => onChange(option.value)}
					>
						<Icon size={14} />
						<span className={classes.layoutLabel}>{option.label}</span>
					</UnstyledButton>
				);
			})}
		</div>
	);
}

function CommitHeader({
	data,
	subject,
	body,
	added,
	removed,
	unknownStats,
	hasBinary,
	previewHref,
	linkMode,
	mode,
	target,
	onNavigateCommit,
}: {
	data: GitCommitDetail;
	subject: string;
	body: string;
	added: number;
	removed: number;
	unknownStats: boolean;
	hasBinary: boolean;
	previewHref: string;
	linkMode: "page" | "window";
	mode: "modal" | "page" | "window";
	target: GitTarget;
	onNavigateCommit?: (sha: string) => void;
}) {
	const { t } = useTranslation("git");
	const showCommitter =
		data.authorName !== data.committerName || data.authorEmail !== data.committerEmail;
	return (
		<Paper withBorder radius="md" className={classes.commitCard} data-commit-statistics>
			<div className={classes.head}>
				<Text component="h2" data-commit-message className={classes.subject} title={subject}>
					{subject}
				</Text>
				<div className={classes.shaCluster}>
					<Text
						component="span"
						className={classes.sha}
						data-commit-sha={data.sha}
						title={data.sha}
					>
						{data.sha.slice(0, 7)}
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
							<Tooltip label={t(copied ? "commitPreview.copied" : "commitPreview.copyLink")}>
								<ActionIcon
									type="button"
									variant="subtle"
									size="sm"
									onClick={copy}
									aria-label={t("commitPreview.copyLink")}
									data-commit-copy-link
								>
									{copied ? <IconCheck size={14} /> : <IconLink size={14} />}
								</ActionIcon>
							</Tooltip>
						)}
					</CopyButton>
					{mode === "modal" && (
						<Tooltip label={t("commitPreview.openPage")}>
							<Anchor
								href={previewHref}
								target="_blank"
								rel="noopener noreferrer"
								aria-label={t("commitPreview.openPage")}
								data-commit-open-page
								className={classes.iconLink}
							>
								<IconExternalLink size={14} />
							</Anchor>
						</Tooltip>
					)}
				</div>
			</div>
			<Text size="xs" c="dimmed" className={classes.meta}>
				<Text span>{data.authorName}</Text> <Text span>&lt;{data.authorEmail}&gt;</Text>
				{" · "}
				<time dateTime={data.authoredAt} title={data.authoredAt} data-commit-at={data.authoredAt}>
					{formatRelativeTime(data.authoredAt)}
				</time>
				{showCommitter && (
					<>
						{" · "}
						{t("commitPreview.committer")} {data.committerName}
						{data.committerEmail !== data.authorEmail && <> &lt;{data.committerEmail}&gt;</>}
						{" · "}
						<time
							dateTime={data.committedAt}
							title={data.committedAt}
							data-commit-at={data.committedAt}
						>
							{formatRelativeTime(data.committedAt)}
						</time>
					</>
				)}
				{" · "}
				<Text span title={data.parents.join(" ")}>
					{data.parents.length === 0 ? (
						t("commitPreview.rootCommit")
					) : (
						<>
							{t("commitPreview.parents")}{" "}
							{data.parents.map((parent, index) => (
								<span key={parent}>
									{index > 0 && " "}
									<Anchor
										href={buildCommitPreviewBrowserHref(target, parent, undefined, linkMode)}
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
								</span>
							))}
						</>
					)}
				</Text>
				{" · "}
				<Text span c="green">
					+{added}
				</Text>{" "}
				<Text span c="red">
					−{removed}
				</Text>
				{" · "}
				{t("commitPreview.files", { count: data.files.length })}
			</Text>
			{body && <CommitMessageBody body={body} />}
			{data.messageTruncated && (
				<Text size="xs" c="yellow">
					{t("commitPreview.messageTruncated")}
				</Text>
			)}
			{data.parents.length > 1 && (
				<Text size="xs" c="blue">
					{t("commitPreview.mergeNotice", { parent: data.parents[0].slice(0, 7) })}
				</Text>
			)}
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
		</Paper>
	);
}

function CommitMessageBody({ body }: { body: string }) {
	const { t } = useTranslation("git");
	const long = body.split("\n").length > BODY_PREVIEW_LINES;
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	return (
		<>
			<Text
				id={bodyId}
				component="pre"
				data-commit-body
				data-clamped={long && !open ? "true" : undefined}
				className={classes.messageBody}
			>
				{body}
			</Text>
			{long && (
				<UnstyledButton
					type="button"
					className={classes.more}
					data-commit-body-toggle
					aria-expanded={open}
					aria-controls={bodyId}
					onClick={() => setOpen((value) => !value)}
				>
					{t(open ? "commitPreview.hideBody" : "commitPreview.showBody")}
				</UnstyledButton>
			)}
		</>
	);
}

function CommitFileCard({
	target,
	sha,
	file,
	layout,
	onLayoutChange,
}: {
	target: GitTarget;
	sha: string;
	file: GitCommitFile;
	layout: CommitDiffLayout;
	onLayoutChange: (layout: CommitDiffLayout) => void;
}) {
	const { t } = useTranslation("git");
	const [expanded, setExpanded] = useState(true);
	const patchId = useId();
	const label = commitFileLabel(file);
	return (
		<div className={classes.diffCard} data-commit-diff-card>
			<div className={classes.diffHeaderBar}>
				<UnstyledButton
					type="button"
					className={classes.diffTitle}
					onClick={() => setExpanded(!expanded)}
					aria-expanded={expanded}
					aria-controls={patchId}
					aria-label={t(expanded ? "commitPreview.collapseDiff" : "commitPreview.expandDiff", {
						path: file.path,
					})}
					data-commit-diff-toggle
				>
					{expanded ? (
						<IconChevronDown size={16} className={classes.chevron} />
					) : (
						<IconChevronRight size={16} className={classes.chevron} />
					)}
					<span className={classes.pathTitle} title={label}>
						{file.oldPath && (
							<>
								<PathCrumbs path={file.oldPath} />
								<span className={classes.pathArrow}>→</span>
							</>
						)}
						<PathCrumbs path={file.path} emphasize />
					</span>
					<Badge
						component="span"
						size="xs"
						color={COMMIT_STATUS_COLOR[file.status]}
						className={classes.status}
					>
						{COMMIT_STATUS_LETTER[file.status]}
					</Badge>
				</UnstyledButton>
				<div className={classes.diffTools}>
					<ChangePills file={file} />
					<DiffLayoutToggle value={layout} onChange={onLayoutChange} />
				</div>
			</div>
			{/* Unmount, rather than merely hiding, to release and cancel the query. */}
			{expanded && (
				<div id={patchId} className={classes.diffBody}>
					<CommitFilePatch target={target} sha={sha} file={file} layout={layout} />
				</div>
			)}
		</div>
	);
}

function CommitFilePatch({
	target,
	sha,
	file,
	layout,
}: {
	target: GitTarget;
	sha: string;
	file: GitCommitFile;
	layout: CommitDiffLayout;
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
			layout={layout}
			fill
		/>
	);
}
