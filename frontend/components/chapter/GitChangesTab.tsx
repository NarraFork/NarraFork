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
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconMinus,
	IconPlus,
	IconSparkles,
} from "@tabler/icons-react";
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
import { buildGitFileTree, compactGitFileTree, type GitFileTreeNode } from "./git-file-tree";

/** Max files to render per section to avoid UI freeze. */
const MAX_DISPLAY_FILES = 80;
const MAX_GIT_FILE_PATH_CHARS = 1_000;
/** Indent per tree level, in px. Small so deep paths still fit a narrow panel. */
const TREE_INDENT_PX = 12;

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
	collapsed: Set<string>;
	onToggle: (path: string) => void;
	onAction: (files: string[]) => void;
	onOpenFile: (path: string) => void;
	attrByPath: Map<string, FileAttributionSummary>;
	narratorLabel: Map<string, string>;
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
	// Folders start expanded, so a fresh panel still shows every changed file.
	const [collapsedStaged, setCollapsedStaged] = useState<Set<string>>(() => new Set());
	const [collapsedUnstaged, setCollapsedUnstaged] = useState<Set<string>>(() => new Set());

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

	// Cap displayed files to avoid rendering thousands of rows
	const displayStaged = stagedFiles.slice(0, MAX_DISPLAY_FILES);
	const displayUnstaged = unstagedFiles.slice(0, MAX_DISPLAY_FILES);
	const hiddenStaged = stagedFiles.length - displayStaged.length;
	const hiddenUnstaged = unstagedFiles.length - displayUnstaged.length;
	// Server may have capped the files array too
	const totalFiles = status.totalFiles ?? status.files.length;
	const serverCapped = totalFiles > status.files.length;

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

	function toggleFolder(section: "staged" | "unstaged", path: string) {
		const setState = section === "staged" ? setCollapsedStaged : setCollapsedUnstaged;
		setState((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
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
						<TreeNodes
							nodes={stagedTree}
							depth={0}
							ctx={{
								keyPrefix: "s",
								action: "unstage",
								collapsed: collapsedStaged,
								onToggle: (path) => toggleFolder("staged", path),
								onAction: (files) => unstage.mutate({ files }),
								onOpenFile: (path) => {
									setDiffFile(path);
									setDiffStaged(true);
								},
								attrByPath,
								narratorLabel,
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
						<TreeNodes
							nodes={unstagedTree}
							depth={0}
							ctx={{
								keyPrefix: "u",
								action: "stage",
								collapsed: collapsedUnstaged,
								onToggle: (path) => toggleFolder("unstaged", path),
								onAction: (files) => stage.mutate({ files }),
								onOpenFile: (path) => {
									setDiffFile(path);
									setDiffStaged(false);
								},
								attrByPath,
								narratorLabel,
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
	const expanded = !ctx.collapsed.has(node.path);
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
				{expanded ? (
					<IconChevronDown size={12} style={{ flexShrink: 0 }} />
				) : (
					<IconChevronRight size={12} style={{ flexShrink: 0 }} />
				)}
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
	const statusChar = file.status.replace(/\s/g, "") || "M";
	const color = statusRegistry.gitFileStatus(statusChar).color;
	const actionLabel = ctx.action === "stage" ? ctx.t("stageFile") : ctx.t("unstageFile");

	return (
		<TreeRow
			depth={depth}
			label={ctx.t("viewDiffOf", { path: file.path })}
			onActivate={() => ctx.onOpenFile(file.path)}
		>
			<Badge size="xs" color={color} variant="filled" w={28} style={{ flexShrink: 0 }}>
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
			<AttributionBadge
				attribution={ctx.attrByPath.get(file.path)}
				narratorLabel={ctx.narratorLabel}
				t={ctx.t}
			/>
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

/** Compact badge showing who last changed a file, with a contributor tooltip. */
function AttributionBadge({
	attribution,
	narratorLabel,
	t,
}: {
	attribution?: FileAttributionSummary;
	narratorLabel: Map<string, string>;
	t: Translate;
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
