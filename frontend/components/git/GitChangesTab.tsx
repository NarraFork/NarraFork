import { statusRegistry } from "@frontend/lib/status-registry";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	HoverCard,
	Loader,
	rem,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Timeline,
	Tooltip,
} from "@mantine/core";

import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconFilter,
	IconFilterOff,
	IconFolder,
	IconFolderOpen,
	IconMinus,
	IconPlus,
	IconRefresh,
	IconSparkles,
	IconTrash,
} from "@tabler/icons-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useClipboard } from "../../hooks/useClipboard";
import {
	type CurrentDiffTarget,
	useGitAiCommitMessage,
	useGitCommit,
	useGitDiscard,
	useGitFileModifications,
	useGitLineStats,
	useGitStage,
	useGitStatus,
	useGitUnstage,
} from "../../hooks/useGit";
import { useGitFolderPrefs } from "../../hooks/useGitFolderPrefs";
import { useGitStatusFilter } from "../../hooks/useGitStatusFilter";
import { useGitViewMode } from "../../hooks/useGitViewMode";
import { type GitTarget, gitCanWrite, gitTargetKey } from "../../lib/api/git";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { observePageLifecycle } from "../../lib/page-lifecycle";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { buildAttributionLabels } from "./attribution-label";
import { GitFileDiff } from "./GitFileDiff";
import { GitLineStatsSummary } from "./GitLineStatsSummary";
import { type GitFileSection, gitFileBadgeChar } from "./git-file-status";
import { buildGitFileTree, compactGitFileTree, type GitFileTreeNode } from "./git-file-tree";
import {
	formatGitSectionCount,
	gitSectionCount,
	gitTotalFileCount,
	gitUniqueFileCount,
	hiddenGitSectionRows,
} from "./git-status-counts";
import {
	countBadgeChars,
	filterFilesByStatus,
	type GitStatusFilterChar,
	visibleFilterChars,
} from "./git-status-filter";

/** Max files to render per section to avoid UI freeze. */
const MAX_DISPLAY_FILES = 80;
const MAX_GIT_FILE_PATH_CHARS = 1_000;
/** Indent per tree level, in px. Small so deep paths still fit a narrow panel. */
const TREE_INDENT_PX = 12;
/**
 * Width of a row's leading slot: the file status badge, and the folder row's
 * chevron+glyph pair.
 *
 * Shared so the two stay locked together — the names after them only line up
 * while both leading slots are the same width, and that alignment is the whole
 * reason the folder row reserves this much space.
 */
const STATUS_BADGE_WIDTH = 28;

function clampGitFilePath(path: string): string {
	return path.length > MAX_GIT_FILE_PATH_CHARS
		? `${path.slice(0, MAX_GIT_FILE_PATH_CHARS)}…`
		: path;
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

interface DisplayFile {
	status: string;
	path: string;
	displayLinesAdded?: number;
	displayLinesRemoved?: number;
	statsComplete: boolean;
}

/** Everything a tree row needs that does not change per node. */
interface TreeContext {
	canWrite: boolean;
	directoryStatsComplete: boolean;
	keyPrefix: string;
	action: "stage" | "unstage";
	/**
	 * Which half of the porcelain status these rows report. Carried explicitly
	 * rather than derived from `action`: the badge letter depends on it, and
	 * inferring "staged" from the verb "unstage" is the kind of double negative
	 * that reads wrong at the call site.
	 */
	section: GitFileSection;
	/**
	 * Folder paths the user has opened. Folders default to CLOSED, so this is the
	 * exception list rather than a collapsed list — an unseen path is collapsed
	 * without anyone having to enumerate the tree.
	 */
	expandedFolders: Set<string>;
	onToggle: (path: string) => void;
	onAction: (files: string[]) => void;
	onOpenFile: (path: string) => void;
	onDiscard?: (path: string) => void;
	/** Attribution is read per file when its hover card opens, never for the whole list. */
	target: GitTarget;
	t: Translate;
}

/** Flatten a subtree back to Git paths so folder rows can act on their files. */
function collectFiles(node: GitFileTreeNode<DisplayFile>): DisplayFile[] {
	if (node.type === "file") return [node.file];
	return node.children.flatMap(collectFiles);
}

export function GitChangesTab({
	target,
	onRefresh,
}: {
	target: GitTarget;
	onRefresh?: () => void;
}) {
	const canWrite = gitCanWrite(target);
	const preferenceKey = gitTargetKey(target) ?? "";
	const { t } = useTranslation("git");
	const confirm = useConfirmDialog();
	const { data: status, isLoading, error } = useGitStatus(target);
	const lineStats = useGitLineStats(target);
	// Keep the last measured rows while updating; errors never fall back to legacy counts.
	const statsByPath = useMemo(
		() =>
			new Map(
				(lineStats.error ? [] : (lineStats.data?.files ?? [])).map((file) => [file.path, file]),
			),
		[lineStats.data, lineStats.error],
	);
	const stage = useGitStage(target);
	const unstage = useGitUnstage(target);
	const commit = useGitCommit(target);
	const discard = useGitDiscard(target);
	const aiMsg = useGitAiCommitMessage(target);
	const clipboard = useClipboard({ timeout: 1500 });
	const { mode: viewMode, setMode: setViewMode } = useGitViewMode(preferenceKey);

	const [message, setMessage] = useState("");
	const [diffFile, setDiffFile] = useState<string | null>(null);
	const [diffStaged, setDiffStaged] = useState(false);
	const statusFilter = useGitStatusFilter(preferenceKey);
	const stagedFolders = useGitFolderPrefs(preferenceKey, "staged");
	const unstagedFolders = useGitFolderPrefs(preferenceKey, "unstaged");

	if (isLoading) return <Loader size="sm" />;
	if (error)
		return (
			<Text c="red" size="sm" p="xs">
				{error.message}
			</Text>
		);
	if (!status) return null;

	const stagedFiles: DisplayFile[] = status.files
		.filter((f) => !f.status.startsWith("?") && isStagedFile(f.status))
		.map((f) => ({
			status: f.status,
			path: f.path,
			displayLinesAdded: statsByPath.get(f.path)?.stagedLinesAdded,
			displayLinesRemoved: statsByPath.get(f.path)?.stagedLinesRemoved,
			statsComplete: statsByPath.get(f.path)?.complete === true,
		}));
	const unstagedFiles: DisplayFile[] = status.files
		.filter((f) => f.status.startsWith("?") || isUnstagedFile(f.status))
		.map((f) => ({
			status: f.status,
			path: f.path,
			displayLinesAdded: statsByPath.get(f.path)?.unstagedLinesAdded,
			displayLinesRemoved: statsByPath.get(f.path)?.unstagedLinesRemoved,
			statsComplete: statsByPath.get(f.path)?.complete === true,
		}));
	const badgeCounts = countBadgeChars([
		{ section: "staged", files: stagedFiles },
		{ section: "unstaged", files: unstagedFiles },
	]);
	const filterChars = visibleFilterChars(badgeCounts, statusFilter.selected);
	const matchedStaged = filterFilesByStatus(stagedFiles, "staged", statusFilter.selected);
	const matchedUnstaged = filterFilesByStatus(unstagedFiles, "unstaged", statusFilter.selected);
	const displayStaged = matchedStaged.slice(0, MAX_DISPLAY_FILES);
	const displayUnstaged = matchedUnstaged.slice(0, MAX_DISPLAY_FILES);
	const hiddenStaged = hiddenGitSectionRows(matchedStaged.length, displayStaged.length);
	const hiddenUnstaged = hiddenGitSectionRows(matchedUnstaged.length, displayUnstaged.length);
	const totalFiles = gitTotalFileCount(status);
	const serverCapped = totalFiles > gitUniqueFileCount(status.files);
	const countsAreLowerBounds =
		status.totalFilesExact === false ||
		(status.totalFilesExact === undefined && !!status.truncated);
	const stagedCountLabel = formatGitSectionCount(
		gitSectionCount(status, "staged"),
		countsAreLowerBounds,
	);
	const unstagedCountLabel = formatGitSectionCount(
		gitSectionCount(status, "unstaged"),
		countsAreLowerBounds,
	);
	const filterActive = statusFilter.selected.size > 0;
	const filterHidesEverything =
		filterActive && matchedStaged.length === 0 && matchedUnstaged.length === 0;

	function isStagedFile(s: string): boolean {
		const x = s[0];
		return x !== " " && x !== "?" && /[MADRC]/.test(x);
	}

	function isUnstagedFile(s: string): boolean {
		const y = s[1];
		return y !== " " || s.startsWith("?");
	}

	function handleCommit() {
		if (!canWrite || !message.trim() || status?.staged === 0) return;
		commit.mutate(message.trim(), { onSuccess: () => setMessage("") });
	}

	function handleAiGenerate() {
		aiMsg.mutate(undefined, {
			onSuccess: (data) => {
				if (data?.message) setMessage(data.message);
			},
		});
	}

	async function handleDiscardAll() {
		const files = filterActive ? matchedUnstaged.map((f) => f.path) : null;
		const confirmMessage = files
			? t("filter.discardMatchedConfirm", { count: files.length })
			: t("discardConfirm");
		if (!canWrite) return;
		const scope = `\n${t("workspace.scope", { root: target.rootPath })}`;
		if (!(await confirm({ message: confirmMessage + scope }))) return;
		if (files) {
			if (files.length > 0) discard.mutate({ files });
			return;
		}
		discard.mutate({ all: true });
	}

	function contextFor(
		section: GitFileSection,
		action: "stage" | "unstage",
		folders: { expanded: Set<string>; toggle: (path: string) => void },
		keyPrefix: string,
	): TreeContext {
		return {
			canWrite,
			directoryStatsComplete:
				!countsAreLowerBounds &&
				!serverCapped &&
				!filterActive &&
				(section === "staged" ? hiddenStaged === 0 : hiddenUnstaged === 0),
			keyPrefix,
			action,
			section,
			expandedFolders: folders.expanded,
			onToggle: folders.toggle,
			onAction: (paths) =>
				action === "stage" ? stage.mutate({ files: paths }) : unstage.mutate({ files: paths }),
			onOpenFile: (path) => {
				setDiffFile(path);
				setDiffStaged(section === "staged");
			},
			onDiscard:
				section === "unstaged"
					? async (file) => {
							if (!canWrite) return;
							const scope = `\n${t("workspace.scope", { root: target.rootPath })}`;
							if (await confirm({ message: t("discardFileConfirm", { file }) + scope }))
								discard.mutate({ files: [file] });
						}
					: undefined,
			target,
			t,
		};
	}

	function renderRows(
		section: GitFileSection,
		action: "stage" | "unstage",
		files: readonly DisplayFile[],
		folders: { expanded: Set<string>; toggle: (path: string) => void },
		keyPrefix: string,
	) {
		const context = contextFor(section, action, folders, keyPrefix);
		if (viewMode === "flat") {
			return files.map((file) => (
				<FileRow key={`${keyPrefix}f-${file.path}`} file={file} depth={0} ctx={context}>
					{file.path}
				</FileRow>
			));
		}
		const tree = compactGitFileTree(buildGitFileTree(files));
		return <TreeNodes nodes={tree} depth={0} ctx={context} />;
	}

	return (
		<Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
			{(stage.error || unstage.error || commit.error || discard.error || aiMsg.error) && (
				<Text c="red" size="xs" px="xs" pt={4}>
					{(stage.error || unstage.error || commit.error || discard.error || aiMsg.error)?.message}
				</Text>
			)}
			{(stage.error || unstage.error || commit.error || discard.error) && (
				<Text c="dimmed" size="xs" px="xs">
					{t("workspace.writeFailureHint")}
				</Text>
			)}

			<Stack gap={4} px="xs" pt="xs" style={{ flexShrink: 0 }}>
				<TextInput
					placeholder={t("commitMessage")}
					value={message}
					onChange={(e) => setMessage(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) handleCommit();
					}}
					rightSection={
						<Tooltip label={t("aiGenerate")}>
							<ActionIcon
								aria-label={t("aiGenerate")}
								variant="subtle"
								size="sm"
								onClick={handleAiGenerate}
								disabled={!canWrite}
								loading={aiMsg.isPending}
							>
								<IconSparkles size={14} />
							</ActionIcon>
						</Tooltip>
					}
					size="sm"
				/>
				<Button
					fullWidth
					size="sm"
					leftSection={<IconCheck size={15} />}
					onClick={handleCommit}
					loading={commit.isPending}
					disabled={!canWrite || !message.trim() || status.staged === 0}
				>
					{t("commitButton")}
					{status.staged > 0 ? ` (${status.staged})` : ""}
				</Button>
			</Stack>

			<Group gap={6} px="xs" py={6} wrap="nowrap" style={{ flexShrink: 0 }}>
				{/* Counts live on the section headers below; this title is just the panel name. */}
				<Text size="sm" fw={600} style={{ flexShrink: 0, flexGrow: status.branch ? 0 : 1 }}>
					{t("panel.changes")}
				</Text>
				<GitLineStatsSummary {...lineStats} compact />
				{status.branch && (
					<Group gap={2} wrap="nowrap" justify="flex-end" style={{ flex: 1, minWidth: 0 }}>
						<Text
							size="xs"
							c="dimmed"
							ff="monospace"
							truncate
							title={status.branch}
							style={{ minWidth: 0, flexShrink: 1, userSelect: "text" }}
						>
							{status.branch}
						</Text>
						<Tooltip label={clipboard.copied ? t("panel.branchCopied") : t("panel.copyBranch")}>
							<ActionIcon
								variant="subtle"
								color={clipboard.copied ? "green" : "gray"}
								size="sm"
								aria-label={t("panel.copyBranch")}
								style={{ flexShrink: 0 }}
								onClick={() => clipboard.copy(status.branch)}
							>
								{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
							</ActionIcon>
						</Tooltip>
					</Group>
				)}
				<Button.Group style={{ flexShrink: 0 }}>
					<Button
						size="compact-xs"
						variant={viewMode === "tree" ? "filled" : "subtle"}
						aria-pressed={viewMode === "tree"}
						onClick={() => setViewMode("tree")}
					>
						{t("view.tree")}
					</Button>
					<Button
						size="compact-xs"
						variant={viewMode === "flat" ? "filled" : "subtle"}
						aria-pressed={viewMode === "flat"}
						onClick={() => setViewMode("flat")}
					>
						{t("view.flat")}
					</Button>
				</Button.Group>
				<Tooltip label={t("workspace.retry")}>
					<ActionIcon
						size="sm"
						variant="subtle"
						aria-label={t("workspace.retry")}
						onClick={onRefresh}
					>
						<IconRefresh size={15} />
					</ActionIcon>
				</Tooltip>
			</Group>

			{countsAreLowerBounds && (
				<Text size="xs" c="yellow" px="xs" pt={4}>
					{t("workspace.statusTruncated")}
				</Text>
			)}
			<StatusFilterBar
				chars={filterChars}
				counts={badgeCounts}
				selected={statusFilter.selected}
				onToggle={statusFilter.toggle}
				onClear={statusFilter.clear}
				t={t}
			/>

			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				<Stack gap={4} px={4} pb="xs">
					{filterHidesEverything && (
						<Stack gap={4} py="md" align="center">
							<Text size="sm" c="dimmed">
								{t("filter.noMatches")}
							</Text>
							<Button size="compact-xs" variant="subtle" onClick={statusFilter.clear}>
								{t("filter.clear")}
							</Button>
						</Stack>
					)}

					{(matchedStaged.length > 0 ||
						(!filterActive &&
							(serverCapped || countsAreLowerBounds) &&
							gitSectionCount(status, "staged") > 0)) && (
						<Stack gap={2}>
							<Group gap="xs" justify="space-between" px={4}>
								<Text size="xs" fw={600}>
									{t("staged")} (
									{filterActive
										? `${matchedStaged.length}/${stagedFiles.length}`
										: stagedCountLabel}
									)
								</Text>
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={() =>
										filterActive
											? unstage.mutate({ files: matchedStaged.map((f) => f.path) })
											: unstage.mutate({ all: true })
									}
									disabled={!canWrite}
									loading={unstage.isPending}
								>
									{filterActive ? t("filter.unstageMatched") : t("unstageAll")}
								</Button>
							</Group>
							{renderRows("staged", "unstage", displayStaged, stagedFolders, "s")}
							{(hiddenStaged > 0 || serverCapped || countsAreLowerBounds) && (
								<Text size="xs" c="dimmed" ta="center">
									{hiddenStaged > 0 ? `+${hiddenStaged} more` : null}
									{serverCapped ? ` ${t("workspace.serverFilesTruncated")}` : null}
									{countsAreLowerBounds
										? ` ${t("workspace.sectionTruncated", { section: t("staged") })}`
										: null}
								</Text>
							)}
						</Stack>
					)}

					{(matchedUnstaged.length > 0 ||
						(!filterActive &&
							(serverCapped || countsAreLowerBounds) &&
							gitSectionCount(status, "unstaged") > 0)) && (
						<Stack gap={2}>
							<Group gap="xs" justify="space-between" px={4}>
								<Text size="xs" fw={600}>
									{t("unstaged")} (
									{filterActive
										? `${matchedUnstaged.length}/${unstagedFiles.length}`
										: unstagedCountLabel}
									)
								</Text>
								<Group gap={4}>
									<Button
										size="compact-xs"
										variant="subtle"
										onClick={() =>
											filterActive
												? stage.mutate({ files: matchedUnstaged.map((f) => f.path) })
												: stage.mutate({ all: true })
										}
										disabled={!canWrite}
										loading={stage.isPending}
									>
										{filterActive ? t("filter.stageMatched") : t("stageAll")}
									</Button>
									<Button
										size="compact-xs"
										variant="subtle"
										color="red"
										onClick={handleDiscardAll}
										disabled={!canWrite}
										loading={discard.isPending}
									>
										{filterActive ? t("filter.discardMatched") : t("discardAll")}
									</Button>
								</Group>
							</Group>
							{renderRows("unstaged", "stage", displayUnstaged, unstagedFolders, "u")}
							{(hiddenUnstaged > 0 || serverCapped || countsAreLowerBounds) && (
								<Text size="xs" c="dimmed" ta="center">
									{hiddenUnstaged > 0 ? `+${hiddenUnstaged} more` : null}
									{serverCapped ? ` ${t("workspace.serverFilesTruncated")}` : null}
									{countsAreLowerBounds
										? ` ${t("workspace.sectionTruncated", { section: t("unstaged") })}`
										: null}
								</Text>
							)}
						</Stack>
					)}

					{!status.hasChanges && (
						<Text size="sm" c="dimmed" py="md" ta="center">
							{t("noChanges")}
						</Text>
					)}
				</Stack>
			</ScrollArea>

			<GitFileDiff
				target={target}
				file={diffFile}
				staged={diffStaged}
				onClose={() => setDiffFile(null)}
			/>
		</Box>
	);
}

/**
 * Status filter chips: one per kind of change present in the working tree.
 *
 * ── Why chips and not a Select ───────────────────────────────────────────────
 * The question is "which kinds do I want to see", which is multi-select and has
 * at most six answers. A dropdown hides both the current selection and the
 * per-kind counts behind a click; six toggles show them at a glance and cost one
 * click each. They also reuse the exact letter and colour the file rows already
 * render, so the chip and the badge it filters on are visibly the same thing.
 *
 * Renders nothing when there is only one kind of change: a filter that can only
 * show everything or nothing is noise, and it would take a row of height away
 * from the file list in the common single-kind case.
 */
function StatusFilterBar({
	chars,
	counts,
	selected,
	onToggle,
	onClear,
	t,
}: {
	chars: readonly GitStatusFilterChar[];
	counts: ReadonlyMap<GitStatusFilterChar, number>;
	selected: ReadonlySet<GitStatusFilterChar>;
	onToggle: (char: GitStatusFilterChar) => void;
	onClear: () => void;
	t: Translate;
}) {
	const { t: tCommon } = useTranslation("common");
	if (chars.length < 2) return null;
	const active = selected.size > 0;

	return (
		<Group
			gap={4}
			wrap="wrap"
			px="xs"
			pb="xs"
			style={{ flexShrink: 0 }}
			role="group"
			aria-label={t("filter.label")}
		>
			{/*
			 * The leading filter glyph doubles as the clear control. A separate
			 * trailing "clear" button only appeared while filtering, and an
			 * ActionIcon is taller than the chips — the whole bar jumped in height
			 * every time the filter toggled. One fixed-size slot that only changes
			 * state keeps the bar's shape identical in both modes.
			 */}
			<Tooltip label={active ? t("filter.clear") : t("filter.label")}>
				<ActionIcon
					size="sm"
					variant="subtle"
					color={active ? "indigo" : "gray"}
					aria-label={active ? t("filter.clear") : t("filter.label")}
					aria-pressed={active}
					disabled={!active}
					onClick={onClear}
					style={{ flexShrink: 0 }}
				>
					{active ? <IconFilterOff size={12} /> : <IconFilter size={12} />}
				</ActionIcon>
			</Tooltip>
			{chars.map((char) => {
				const entry = statusRegistry.gitFileStatus(char);
				const on = selected.has(char);
				const count = counts.get(char) ?? 0;
				// The chip names the KIND ("Modified"), not just the letter: the letter is
				// the compact form the rows use, but a filter control has room to say what
				// it means, and `C` / `R` are not guessable.
				const name = entry.i18nKey ? tCommon(entry.i18nKey) : char;
				return (
					<Badge
						key={char}
						size="sm"
						variant={on ? "filled" : "outline"}
						color={entry.color}
						component="button"
						type="button"
						// `aria-pressed` rather than a checkbox role: these are toggle buttons,
						// and it is also the only way a test (or a screen reader) can read the
						// selection without inspecting Mantine's variant classes.
						aria-pressed={on}
						data-git-status-filter={char}
						aria-label={t("filter.toggle", { name, count })}
						onClick={() => onToggle(char)}
						style={{ cursor: "pointer", textTransform: "none" }}
					>
						{char} {count}
					</Badge>
				);
			})}
		</Group>
	);
}

/** Recursive tree body: folders first, then files, both already sorted. */
function TreeNodes({
	nodes,
	depth,
	ctx,
}: {
	nodes: readonly GitFileTreeNode<DisplayFile>[];
	depth: number;
	ctx: TreeContext;
}) {
	return (
		<>
			{nodes.map((node) =>
				node.type === "directory" ? (
					<DirectoryRow
						key={`${ctx.keyPrefix}d-${node.path}`}
						node={node}
						depth={depth}
						ctx={ctx}
					/>
				) : (
					<FileRow key={`${ctx.keyPrefix}f-${node.path}`} file={node.file} depth={depth} ctx={ctx}>
						{node.name}
					</FileRow>
				),
			)}
		</>
	);
}

/** Shared row chrome: click/keyboard activation plus depth indent. */
function TreeRow({
	depth,
	label,
	expanded,
	onActivate,
	children,
}: {
	depth: number;
	label: string;
	expanded?: boolean;
	onActivate: () => void;
	children: React.ReactNode;
}) {
	return (
		<Group
			gap={4}
			wrap="nowrap"
			py={2}
			pr={4}
			pl={depth * TREE_INDENT_PX + 4}
			style={{ borderRadius: 4, cursor: "pointer" }}
			role="button"
			tabIndex={0}
			aria-label={label}
			aria-expanded={expanded}
			onClick={onActivate}
			onKeyDown={(e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				onActivate();
			}}
		>
			{children}
		</Group>
	);
}

/** Aggregated +/- counts, rendered for both folder and file rows. */
function LineStats({ added, removed }: { added?: number; removed?: number }) {
	if (added == null || removed == null || !Number.isFinite(added) || !Number.isFinite(removed))
		return null;
	return (
		<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
			{(added > 0 || removed === 0) && (
				<Text size="xs" c="green" ff="monospace">
					+{added}
				</Text>
			)}
			{(removed > 0 || added === 0) && (
				<Text size="xs" c="red" ff="monospace">
					-{removed}
				</Text>
			)}
		</Group>
	);
}

function DirectoryRow({
	node,
	depth,
	ctx,
}: {
	node: Extract<GitFileTreeNode<DisplayFile>, { type: "directory" }>;
	depth: number;
	ctx: TreeContext;
}) {
	const expanded = ctx.expandedFolders.has(node.path);
	const files = collectFiles(node);
	const complete =
		ctx.directoryStatsComplete &&
		files.every(
			(f) =>
				f.statsComplete &&
				f.displayLinesAdded != null &&
				f.displayLinesRemoved != null &&
				Number.isFinite(f.displayLinesAdded) &&
				Number.isFinite(f.displayLinesRemoved),
		);
	const added = complete
		? files.reduce((sum, f) => sum + (f.displayLinesAdded as number), 0)
		: undefined;
	const removed = complete
		? files.reduce((sum, f) => sum + (f.displayLinesRemoved as number), 0)
		: undefined;
	// Folder rows reuse the file wording: the action is the same, only the scope differs.
	const actionLabel = ctx.action === "stage" ? ctx.t("stageFile") : ctx.t("unstageFile");

	return (
		<>
			<TreeRow
				depth={depth}
				expanded={expanded}
				label={
					expanded
						? ctx.t("collapseFolder", { path: node.path })
						: ctx.t("expandFolder", { path: node.path })
				}
				onActivate={() => ctx.onToggle(node.path)}
			>
				{/*
				 * Same footprint as a file row's status badge (STATUS_BADGE_WIDTH), so
				 * folder and file names start at one column instead of a ragged edge —
				 * a bare chevron is much narrower than the badge and left folder rows
				 * looking unanchored. The folder glyph is what carries the "this is a
				 * directory" signal; the chevron only carries open/closed.
				 */}
				<Group gap={2} wrap="nowrap" w={STATUS_BADGE_WIDTH} style={{ flexShrink: 0 }}>
					{expanded ? (
						<IconChevronDown size={12} style={{ flexShrink: 0 }} />
					) : (
						<IconChevronRight size={12} style={{ flexShrink: 0 }} />
					)}
					{expanded ? (
						<IconFolderOpen size={14} style={{ flexShrink: 0, opacity: 0.75 }} />
					) : (
						<IconFolder size={14} style={{ flexShrink: 0, opacity: 0.75 }} />
					)}
				</Group>
				<Text
					size="xs"
					fw={600}
					lineClamp={1}
					style={{ flex: 1, minWidth: 0 }}
					ff="monospace"
					title={node.path}
				>
					{clampGitFilePath(node.name)}
				</Text>
				<Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
					{node.fileCount}
				</Badge>
				<LineStats added={added} removed={removed} />
				<Tooltip label={actionLabel}>
					<ActionIcon
						size="xs"
						variant="subtle"
						aria-label={actionLabel}
						disabled={!ctx.canWrite}
						onClick={(e) => {
							e.stopPropagation();
							ctx.onAction(files.map((f) => f.path));
						}}
					>
						{ctx.action === "stage" ? <IconPlus size={12} /> : <IconMinus size={12} />}
					</ActionIcon>
				</Tooltip>
			</TreeRow>
			{expanded && <TreeNodes nodes={node.children} depth={depth + 1} ctx={ctx} />}
		</>
	);
}

function FileRow({
	file,
	depth,
	ctx,
	children,
}: {
	file: DisplayFile;
	depth: number;
	ctx: TreeContext;
	children: string;
}) {
	// The badge shows what KIND of change this is; which SECTION the row is in
	// already carries the staged/unstaged axis. Passing the section is what keeps
	// `AM` from rendering as a two-letter gray blob.
	const statusChar = gitFileBadgeChar(file.status, ctx.section);
	const color = statusRegistry.gitFileStatus(statusChar).color;
	const actionLabel = ctx.action === "stage" ? ctx.t("stageFile") : ctx.t("unstageFile");

	return (
		<TreeRow
			depth={depth}
			label={ctx.t("viewDiffOf", { path: file.path })}
			onActivate={() => ctx.onOpenFile(file.path)}
		>
			<AttributionHoverCard
				target={ctx.target}
				filePath={file.path}
				section={ctx.section}
				t={ctx.t}
			>
				<Badge
					size="xs"
					color={color}
					variant="filled"
					w={STATUS_BADGE_WIDTH}
					style={{ flexShrink: 0 }}
				>
					{statusChar}
				</Badge>
			</AttributionHoverCard>
			<Text
				size="xs"
				lineClamp={1}
				style={{ flex: 1, minWidth: 0 }}
				ff="monospace"
				title={file.path}
			>
				{clampGitFilePath(children)}
			</Text>
			<LineStats added={file.displayLinesAdded} removed={file.displayLinesRemoved} />
			{ctx.onDiscard && (
				<Tooltip label={ctx.t("discardFile")}>
					<ActionIcon
						size="xs"
						variant="subtle"
						color="red"
						disabled={!ctx.canWrite}
						aria-label={ctx.t("discardFile")}
						onClick={(event) => {
							event.stopPropagation();
							ctx.onDiscard?.(file.path);
						}}
					>
						<IconTrash size={12} />
					</ActionIcon>
				</Tooltip>
			)}
			<Tooltip label={actionLabel}>
				<ActionIcon
					size="xs"
					variant="subtle"
					aria-label={actionLabel}
					disabled={!ctx.canWrite}
					onClick={(e) => {
						e.stopPropagation();
						ctx.onAction([file.path]);
					}}
				>
					{ctx.action === "stage" ? <IconPlus size={12} /> : <IconMinus size={12} />}
				</ActionIcon>
			</Tooltip>
		</TreeRow>
	);
}

function formatAttributionTime(value: string): string {
	try {
		return formatLocaleDateTime(value, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		return value;
	}
}

function AttributionHoverCard({
	target,
	filePath,
	section,
	t,
	children,
}: {
	target: GitTarget;
	filePath: string;
	section: GitFileSection;
	t: Translate;
	children: ReactNode;
}) {
	return (
		<HoverCard width={320} shadow="md" withArrow openDelay={120} closeDelay={120} withinPortal>
			<HoverCard.Target>
				{/* The leading slot of every file row; folder rows reserve the same width. */}
				<span
					data-attribution-hover-target="true"
					style={{
						display: "inline-flex",
						flexShrink: 0,
						width: rem(STATUS_BADGE_WIDTH),
						cursor: "help",
					}}
				>
					{children}
				</span>
			</HoverCard.Target>
			{/* Dropdown children mount only while the card is open, so a closed row holds no
			    query observer and closing the card aborts its in-flight read. */}
			<HoverCard.Dropdown p="xs">
				<ForegroundAttributionDetails target={target} filePath={filePath} section={section} t={t} />
			</HoverCard.Dropdown>
		</HoverCard>
	);
}

/** A hidden page unmounts the query (aborting its read) and remounts it on return. */
function ForegroundAttributionDetails(props: {
	target: GitTarget;
	filePath: string;
	section: GitFileSection;
	t: Translate;
}) {
	const [hidden, setHidden] = useState(false);
	useEffect(
		() =>
			observePageLifecycle({
				onHidden: () => setHidden(true),
				onForeground: () => setHidden(false),
			}),
		[],
	);
	return hidden ? null : <AttributionDetails {...props} />;
}

/**
 * Latest observed actor plus historical participants. None is claimed to own the current
 * diff: v1 timestamp hints have no verified baseline fingerprint or workspace epoch.
 * No recorded observation is a short empty note, not a claim that no one changed the file.
 */
function AttributionDetails({
	target,
	filePath,
	section,
	t,
}: {
	target: GitTarget;
	filePath: string;
	section: GitFileSection;
	t: Translate;
}) {
	const query = useGitFileModifications(target, filePath);
	if (!query.data) {
		if (query.isError)
			return (
				// The dropdown is portalled, but React still bubbles click and Enter/Space to the
				// row, whose handlers would open the diff instead of retrying.
				<Group
					gap="xs"
					wrap="nowrap"
					justify="space-between"
					onKeyDown={(event) => event.stopPropagation()}
				>
					<Text size="xs" c="dimmed">
						{t("attributionLoadFailedShort")}
					</Text>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={(event) => {
							event.stopPropagation();
							void query.refetch();
						}}
					>
						{t("attributionRetry")}
					</Button>
				</Group>
			);
		return (
			<Group gap="xs" wrap="nowrap">
				<Loader size="xs" />
				<Text size="xs" c="dimmed">
					{t("attributionLoadingShort")}
				</Text>
			</Group>
		);
	}

	const currentDiff = query.data.currentDiff;
	const observed = currentDiff?.byFile.find((file) => file.filePath === filePath)?.[
		section === "staged" ? "index" : "worktree"
	];
	// Evidence being re-read after a Git change is no longer a confirmed current claim.
	const refreshing = query.isFetching && query.isStale;
	const current: CurrentDiffTarget | undefined =
		observed && currentDiff?.baselineStatus === "stable" && !refreshing
			? observed
			: observed
				? {
						...observed,
						status: "unknown",
						actor: null,
						effectId: null,
						reason: refreshing
							? null
							: currentDiff?.baselineStatus === "stale"
								? "stale"
								: "unavailable",
					}
				: undefined;
	const history = query.data.byFile.find((group) => group.filePath === filePath);
	const showCurrent = !!current && current.status !== "clean";
	const recentEvents = history?.recentEvents ?? [];
	if (!showCurrent && recentEvents.length === 0)
		return (
			<Text size="xs" c="dimmed">
				{t("attributionEmptyShort")}
			</Text>
		);

	const hasCurrentEvidence =
		current?.status === "matching_evidence" &&
		current.actor &&
		!!current.baselineVersion &&
		!current.reason;
	const currentLabel = hasCurrentEvidence
		? buildAttributionLabels(current.actor, t).detail
		: refreshing && current
			? t("attributionRefreshingShort")
			: t("attributionCurrentUnknownShort");
	const currentTitle = current
		? t("attributionCurrentEvidenceShort")
		: t("attributionLastObservedShort");
	// History is treated as always incomplete; only surface actionable current-diff reasons.
	const reason =
		current?.reason && current.reason !== "history_incomplete"
			? t(`attributionCurrentReasonShort.${current.reason}`)
			: null;

	return (
		<Stack gap={6}>
			{current?.status !== "clean" && (
				<div>
					<Text size="xs" c="dimmed">
						{currentTitle}
					</Text>
					<Text size="sm" fw={600} lineClamp={1} title={currentLabel}>
						{currentLabel}
					</Text>
					{reason && (
						<Text size="xs" c="dimmed" lineClamp={2}>
							{reason}
						</Text>
					)}
				</div>
			)}

			{recentEvents.length > 0 && (
				<div>
					<Text size="xs" c="dimmed" mb={2}>
						{t("attributionHistoryShort")}
					</Text>
					{/* Mantine default item gap is spacing-xl; hover history wants a dense list. */}
					<Timeline
						bulletSize={8}
						lineWidth={1}
						styles={{
							item: { marginTop: 4, paddingTop: 0, paddingBottom: 0 },
							itemTitle: { marginBottom: 0, lineHeight: 1.3 },
							itemBody: { paddingTop: 0, paddingBottom: 0 },
						}}
					>
						{recentEvents.map((event) => {
							const labels = buildAttributionLabels(event.actor, t);
							const added = event.linesAdded;
							const removed = event.linesRemoved;
							const hasLineStats = typeof added === "number" || typeof removed === "number";
							const showLineStats = hasLineStats && !((added ?? 0) === 0 && (removed ?? 0) === 0);
							return (
								<Timeline.Item
									key={event.id}
									title={
										<Text size="xs" fw={500} lineClamp={1} title={labels.detail}>
											{labels.detail}
										</Text>
									}
								>
									<Group gap={6} wrap="nowrap" justify="space-between">
										<Text size="xs" c="dimmed" lineClamp={1}>
											{t(`attributionAction.${event.action}`)} ·{" "}
											{formatAttributionTime(event.changedAt)}
										</Text>
										{showLineStats && (
											<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
												{typeof added === "number" && added > 0 && (
													<Text size="xs" c="green" ff="monospace">
														+{added}
													</Text>
												)}
												{typeof removed === "number" && removed > 0 && (
													<Text size="xs" c="red" ff="monospace">
														-{removed}
													</Text>
												)}
											</Group>
										)}
									</Group>
								</Timeline.Item>
							);
						})}
					</Timeline>
				</div>
			)}
		</Stack>
	);
}
