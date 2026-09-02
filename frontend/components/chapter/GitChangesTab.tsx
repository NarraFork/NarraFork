import { statusRegistry } from "@frontend/lib/status-registry";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconFilter,
	IconFilterOff,
	IconFolder,
	IconFolderOpen,
	IconHelpCircle,
	IconMinus,
	IconPlus,
	IconSparkles,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type FileModificationGroup,
	useGitAiCommitMessage,
	useGitCommit,
	useGitDiscard,
	useGitModifications,
	useGitStage,
	useGitStatus,
	useGitUnstage,
} from "../../hooks/useGit";
import { useGitFolderPrefs } from "../../hooks/useGitFolderPrefs";
import { useGitStatusFilter } from "../../hooks/useGitStatusFilter";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { buildAttributionBadge } from "./attribution-label";
import { GitFileDiff } from "./GitFileDiff";
import { type GitFileSection, gitFileBadgeChar } from "./git-file-status";
import { buildGitFileTree, compactGitFileTree, type GitFileTreeNode } from "./git-file-tree";
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
	displayLinesAdded: number;
	displayLinesRemoved: number;
}

/** Everything a tree row needs that does not change per node. */
interface TreeContext {
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
	attrByPath: Map<string, FileModificationGroup>;
	t: Translate;
}

/** Flatten a subtree back to Git paths so folder rows can act on their files. */
function collectFiles(node: GitFileTreeNode<DisplayFile>): DisplayFile[] {
	if (node.type === "file") return [node.file];
	return node.children.flatMap(collectFiles);
}

export function GitChangesTab({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");
	const confirm = useConfirmDialog();
	const { data: status, isLoading } = useGitStatus(chapterId);
	const { data: modifications } = useGitModifications(chapterId);
	const stage = useGitStage(chapterId);
	const unstage = useGitUnstage(chapterId);
	const commit = useGitCommit(chapterId);
	const discard = useGitDiscard(chapterId);
	const aiMsg = useGitAiCommitMessage(chapterId);

	const [message, setMessage] = useState("");
	const [diffFile, setDiffFile] = useState<string | null>(null);
	const [diffStaged, setDiffStaged] = useState(false);
	// Which status letters the user wants to see. Empty = unfiltered; see
	// `git-status-filter.ts` for why that is the empty representation.
	const statusFilter = useGitStatusFilter(chapterId);
	// Folders start COLLAPSED and remember what the user opened across reloads.
	// Keyed per chapter and per section, because `src/` under Staged and under
	// Changes are independent rows.
	const stagedFolders = useGitFolderPrefs(chapterId, "staged");
	const unstagedFolders = useGitFolderPrefs(chapterId, "unstaged");

	// path → who changed it in the current uncommitted change. A path absent from this map
	// has no attributable session, which the badge reports by not rendering. Memoized
	// because every file row reads it: rebuilding per render also handed each row a new
	// `ctx` object, defeating any downstream memoization on the tree.
	const attrByPath = useMemo(
		() => new Map((modifications?.byFile ?? []).map((g) => [g.filePath, g])),
		[modifications?.byFile],
	);
	// A truncated row window means an absent path proves nothing: its changes may simply
	// lie beyond the window. `windowCount === 0` with `hasMore` is the clear case — the cap
	// was spent entirely on rows outside the per-file boundary — so the panel says the
	// attribution is incomplete instead of implying nobody wrote these files.
	const attributionTruncated = !!modifications?.hasMore && (modifications.windowCount ?? 1) === 0;

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

	const stagedFiles: DisplayFile[] = status.files
		.filter((f) => !f.status.startsWith("?") && isStagedFile(f.status))
		.map((f) => ({
			status: f.status,
			path: f.path,
			displayLinesAdded: f.stagedLinesAdded,
			displayLinesRemoved: f.stagedLinesRemoved,
		}));
	const unstagedFiles: DisplayFile[] = status.files
		.filter((f) => f.status.startsWith("?") || isUnstagedFile(f.status))
		.map((f) => ({
			status: f.status,
			path: f.path,
			displayLinesAdded: f.unstagedLinesAdded,
			displayLinesRemoved: f.unstagedLinesRemoved,
		}));

	// Chip counts come from the UNFILTERED lists, so an unselected chip still says
	// how many rows it would reveal instead of collapsing to zero the moment any
	// filter is on.
	const badgeCounts = countBadgeChars([
		{ section: "staged", files: stagedFiles },
		{ section: "unstaged", files: unstagedFiles },
	]);
	const filterChars = visibleFilterChars(badgeCounts, statusFilter.selected);

	// Filter BEFORE the row cap: capping first would spend the 80-row budget on
	// rows the filter then removes, so a filter on a large change set could show
	// nothing while claiming "+N more".
	const matchedStaged = filterFilesByStatus(stagedFiles, "staged", statusFilter.selected);
	const matchedUnstaged = filterFilesByStatus(unstagedFiles, "unstaged", statusFilter.selected);

	// Cap displayed files to avoid rendering thousands of rows
	const displayStaged = matchedStaged.slice(0, MAX_DISPLAY_FILES);
	const displayUnstaged = matchedUnstaged.slice(0, MAX_DISPLAY_FILES);
	const hiddenStaged = matchedStaged.length - displayStaged.length;
	const hiddenUnstaged = matchedUnstaged.length - displayUnstaged.length;
	// Server may have capped the files array too
	const totalFiles = status.totalFiles ?? status.files.length;
	const serverCapped = totalFiles > status.files.length;
	const filterActive = statusFilter.selected.size > 0;
	// A filter that matches nothing must say so. Both sections would otherwise
	// simply not render, leaving a panel that reads as "working tree clean" while
	// there are uncommitted changes.
	const filterHidesEverything =
		filterActive && matchedStaged.length === 0 && matchedUnstaged.length === 0;

	const stagedTree = compactGitFileTree(buildGitFileTree(displayStaged));
	const unstagedTree = compactGitFileTree(buildGitFileTree(displayUnstaged));

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

	/**
	 * Discard, scoped to whatever the filter currently shows.
	 *
	 * This is the one action where the filter scope is a correctness requirement
	 * rather than a nicety: `all: true` runs `checkout HEAD -- .` plus `clean -fd`,
	 * which would destroy uncommitted work the filter had hidden from view. The
	 * confirmation text names the scope for the same reason — "all uncommitted
	 * changes" is a false statement once a filter is on.
	 */
	async function handleDiscardAll() {
		const files = filterActive ? matchedUnstaged.map((f) => f.path) : null;
		const confirmMessage = files
			? t("filter.discardMatchedConfirm", { count: files.length })
			: t("discardConfirm");
		if (!(await confirm({ message: confirmMessage }))) return;
		if (files) {
			if (files.length > 0) discard.mutate({ files });
			return;
		}
		discard.mutate({ all: true });
	}

	return (
		<Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
			{/*
			 * Only the file list scrolls. The commit box lives outside it so it stays
			 * reachable no matter how many files changed — inside the scroller it sat
			 * below hundreds of rows and looked missing.
			 */}
			{/*
			 * Filter chips sit ABOVE the scroller, like the commit box sits below it: a
			 * control that decides what the list contains must stay reachable when the
			 * list is long, and inside the scroller it would scroll away exactly when
			 * the user needs it most.
			 */}
			<StatusFilterBar
				chars={filterChars}
				counts={badgeCounts}
				selected={statusFilter.selected}
				onToggle={statusFilter.toggle}
				onClear={statusFilter.clear}
				t={t}
			/>

			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				<Stack gap="xs" pb="xs">
					{/*
					 * Stated once for the whole list rather than per row: the shortfall is a
					 * property of the query window, not of any one file, and a missing badge on
					 * its own would read as "nobody wrote this".
					 */}
					{attributionTruncated && (
						<Text size="xs" c="dimmed">
							{t("attributionWindowTruncated")}
						</Text>
					)}

					{/*
					 * An active filter that matches nothing has to be named. Without this the
					 * two sections just do not render, and the panel reads as a clean working
					 * tree while uncommitted changes are merely hidden.
					 */}
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

					{/* Staged section */}
					{matchedStaged.length > 0 && (
						<Stack gap={4}>
							<Group gap="xs" justify="space-between">
								<Text size="xs" fw={600}>
									{t("staged")} (
									{filterActive ? `${matchedStaged.length}/${stagedFiles.length}` : status.staged})
								</Text>
								{/*
								 * Scoped to what the filter shows. "All" while a filter hides rows would
								 * act on files the user cannot see — harmless for unstage, but the same
								 * shape as Discard below, where it destroys work that was filtered out.
								 * The label changes with the scope so the button never lies about it.
								 */}
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={() =>
										filterActive
											? unstage.mutate({ files: matchedStaged.map((f) => f.path) })
											: unstage.mutate({ all: true })
									}
									loading={unstage.isPending}
								>
									{filterActive ? t("filter.unstageMatched") : t("unstageAll")}
								</Button>
							</Group>
							<TreeNodes
								nodes={stagedTree}
								depth={0}
								ctx={{
									keyPrefix: "s",
									action: "unstage",
									section: "staged",
									expandedFolders: stagedFolders.expanded,
									onToggle: stagedFolders.toggle,
									onAction: (files) => unstage.mutate({ files }),
									onOpenFile: (path) => {
										setDiffFile(path);
										setDiffStaged(true);
									},
									attrByPath,
									t,
								}}
							/>
							{hiddenStaged > 0 && (
								<Text size="xs" c="dimmed" ta="center">
									+{hiddenStaged} more
								</Text>
							)}
						</Stack>
					)}

					{/* Unstaged / untracked section */}
					{matchedUnstaged.length > 0 && (
						<Stack gap={4}>
							<Group gap="xs" justify="space-between">
								<Text size="xs" fw={600}>
									{t("unstaged")} (
									{filterActive
										? `${matchedUnstaged.length}/${unstagedFiles.length}`
										: status.unstaged + status.untracked}
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
										loading={stage.isPending}
									>
										{filterActive ? t("filter.stageMatched") : t("stageAll")}
									</Button>
									<Button
										size="compact-xs"
										variant="subtle"
										color="red"
										onClick={handleDiscardAll}
										loading={discard.isPending}
									>
										{filterActive ? t("filter.discardMatched") : t("discardAll")}
									</Button>
								</Group>
							</Group>
							<TreeNodes
								nodes={unstagedTree}
								depth={0}
								ctx={{
									keyPrefix: "u",
									action: "stage",
									section: "unstaged",
									expandedFolders: unstagedFolders.expanded,
									onToggle: unstagedFolders.toggle,
									onAction: (files) => stage.mutate({ files }),
									onOpenFile: (path) => {
										setDiffFile(path);
										setDiffStaged(false);
									},
									attrByPath,
									t,
								}}
							/>
							{(hiddenUnstaged > 0 || serverCapped) && (
								<Text size="xs" c="dimmed" ta="center">
									+{serverCapped ? totalFiles - status.files.length : hiddenUnstaged} more
								</Text>
							)}
						</Stack>
					)}
				</Stack>
			</ScrollArea>

			{/* Commit area — pinned below the scroller. */}
			<Group
				gap="xs"
				align="flex-end"
				wrap="nowrap"
				pt="xs"
				style={{
					flexShrink: 0,
					borderTop: "1px solid var(--mantine-color-default-border)",
				}}
			>
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

			<GitFileDiff
				chapterId={chapterId}
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
			<IconFilter
				size={12}
				style={{ flexShrink: 0, opacity: 0.6 }}
				color={active ? "var(--mantine-color-indigo-4)" : undefined}
			/>
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
						aria-label={t("filter.toggle", { name, count })}
						onClick={() => onToggle(char)}
						style={{ cursor: "pointer", textTransform: "none" }}
					>
						{char} {count}
					</Badge>
				);
			})}
			{active && (
				<Tooltip label={t("filter.clear")}>
					<ActionIcon
						size="sm"
						variant="subtle"
						aria-label={t("filter.clear")}
						onClick={onClear}
						style={{ flexShrink: 0 }}
					>
						<IconFilterOff size={12} />
					</ActionIcon>
				</Tooltip>
			)}
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
function LineStats({ added, removed }: { added: number; removed: number }) {
	if (added <= 0 && removed <= 0) return null;
	return (
		<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
			{added > 0 && (
				<Text size="xs" c="green" ff="monospace">
					+{added}
				</Text>
			)}
			{removed > 0 && (
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
	const added = files.reduce((sum, f) => sum + f.displayLinesAdded, 0);
	const removed = files.reduce((sum, f) => sum + f.displayLinesRemoved, 0);
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
			<Badge
				size="xs"
				color={color}
				variant="filled"
				w={STATUS_BADGE_WIDTH}
				style={{ flexShrink: 0 }}
			>
				{statusChar}
			</Badge>
			<Text
				size="xs"
				lineClamp={1}
				style={{ flex: 1, minWidth: 0 }}
				ff="monospace"
				title={file.path}
			>
				{clampGitFilePath(children)}
			</Text>
			<AttributionBadge attribution={ctx.attrByPath.get(file.path)} t={ctx.t} />
			<LineStats added={file.displayLinesAdded} removed={file.displayLinesRemoved} />
			<Tooltip label={actionLabel}>
				<ActionIcon
					size="xs"
					variant="subtle"
					aria-label={actionLabel}
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

/**
 * Compact badge naming who caused a file's current uncommitted change.
 *
 * Scoped to this round of edits, not the file's history: a long-lived worktree has been
 * touched by dozens of sessions, and listing them all here answered a question nobody
 * asked while looking authoritative. A file with no attributable session in scope renders
 * nothing at all — "no session wrote this" is the honest answer, and inventing a
 * contributor is worse than showing none.
 *
 * Labels come from the API because attribution spans subagents and sessions outside this
 * chapter, which a chapter-scoped narrator list cannot name.
 */
function AttributionBadge({
	attribution,
	t,
}: {
	attribution?: FileModificationGroup;
	t: Translate;
}) {
	if (!attribution) return null;

	// Caption, "+N" and tooltip are one decision, made in the pure module: computing them
	// separately here is what let a lone external contributor render as "External +1".
	const badge = buildAttributionBadge(attribution, t);
	const tooltip = badge.tooltipLines.join("\n");

	return (
		<Tooltip label={tooltip} multiline withinPortal>
			<Badge
				size="xs"
				variant="light"
				color={badge.hasNarrator ? "indigo" : "gray"}
				// The tooltip is hover-only, so its contributor list would otherwise be
				// unreachable by a screen reader — and by a test — while closed.
				aria-label={tooltip}
				// Uncertainty is carried by an icon rather than by colour alone, which
				// would not survive a colour-blind or high-contrast viewer.
				leftSection={attribution.hasImpreciseAttribution ? <IconHelpCircle size={10} /> : undefined}
				style={{ flexShrink: 0, maxWidth: 110, cursor: "default", textTransform: "none" }}
				onClick={(e) => e.stopPropagation()}
			>
				<Text size="xs" lineClamp={1} component="span">
					{badge.label}
					{badge.extraCount > 0 ? ` +${badge.extraCount}` : ""}
				</Text>
			</Badge>
		</Tooltip>
	);
}
