import { Text, UnstyledButton } from "@mantine/core";
import type { GitCommitFile, GitCommitFileStatus } from "@shared/git-commit-preview";
import { IconChevronDown, IconChevronRight, IconFolder, IconFolderOpen } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import classes from "./GitCommitFileTree.module.css";
import { buildGitFileTree, type GitFileTreeNode } from "./git-file-tree";

export const COMMIT_STATUS_COLOR: Record<GitCommitFileStatus, string> = {
	added: "green",
	modified: "blue",
	deleted: "red",
	renamed: "violet",
	copied: "cyan",
	typechange: "orange",
	unmerged: "yellow",
	unknown: "gray",
};

export const COMMIT_STATUS_LETTER: Record<GitCommitFileStatus, string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	unmerged: "U",
	unknown: "?",
};

export function commitFileLabel(file: GitCommitFile): string {
	return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

function coversSelection(folderPath: string, selectedPath: string): boolean {
	return selectedPath === folderPath || selectedPath.startsWith(`${folderPath}/`);
}

function openAncestors(collapsed: ReadonlySet<string>, selectedPath: string): ReadonlySet<string> {
	let changed = false;
	const next = new Set(collapsed);
	for (const path of collapsed) {
		if (!coversSelection(path, selectedPath)) continue;
		next.delete(path);
		changed = true;
	}
	return changed ? next : collapsed;
}

function isSelectionHidden(collapsed: ReadonlySet<string>, selectedPath: string | null): boolean {
	if (!selectedPath) return false;
	for (const path of collapsed) {
		if (coversSelection(path, selectedPath)) return true;
	}
	return false;
}

export function GitCommitFileTree({
	files,
	selectedPath,
	onSelect,
}: {
	files: readonly GitCommitFile[];
	selectedPath: string | null;
	onSelect: (path: string) => void;
}) {
	const { t } = useTranslation("git");
	const tree = useMemo(() => buildGitFileTree(files), [files]);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const selectedRef = useRef<HTMLButtonElement>(null);
	const selectionHidden = isSelectionHidden(collapsed, selectedPath);

	// Opening a file from the header or the URL should reveal it, without pinning
	// the folder open after the reader collapses it again.
	useEffect(() => {
		if (!selectedPath) return;
		setCollapsed((prev) => openAncestors(prev, selectedPath));
	}, [selectedPath]);

	// Scroll only once the selected row is actually mounted. Expanding a collapsed
	// ancestor commits on the next render, so this effect also depends on whether
	// the selection is still hidden — otherwise the first pass finds no row and
	// never retries.
	useLayoutEffect(() => {
		if (!selectedPath || selectionHidden) return;
		const node = selectedRef.current;
		const container = node?.closest("[data-commit-file-list]");
		if (!node || !(container instanceof HTMLElement)) return;
		const row = node.getBoundingClientRect();
		const frame = container.getBoundingClientRect();
		if (row.top < frame.top) container.scrollTop -= frame.top - row.top;
		else if (row.bottom > frame.bottom) container.scrollTop += row.bottom - frame.bottom;
	}, [selectedPath, selectionHidden]);

	const toggle = (path: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	return (
		<div className={classes.tree} role="tree" data-commit-tree>
			<TreeNodes
				nodes={tree}
				depth={0}
				collapsed={collapsed}
				selectedPath={selectedPath}
				selectedRef={selectedRef}
				onToggle={toggle}
				onSelect={onSelect}
				t={t}
			/>
		</div>
	);
}

function TreeNodes({
	nodes,
	depth,
	collapsed,
	selectedPath,
	selectedRef,
	onToggle,
	onSelect,
	t,
}: {
	nodes: readonly GitFileTreeNode<GitCommitFile>[];
	depth: number;
	collapsed: ReadonlySet<string>;
	selectedPath: string | null;
	selectedRef: RefObject<HTMLButtonElement | null>;
	onToggle: (path: string) => void;
	onSelect: (path: string) => void;
	t: TFunction;
}) {
	return nodes.map((node) =>
		node.type === "directory" ? (
			<DirectoryNode
				key={`d:${node.path}`}
				node={node}
				depth={depth}
				collapsed={collapsed}
				selectedPath={selectedPath}
				selectedRef={selectedRef}
				onToggle={onToggle}
				onSelect={onSelect}
				t={t}
			/>
		) : (
			<FileNode
				key={`f:${node.path}`}
				node={node}
				depth={depth}
				selected={selectedPath === node.file.path}
				selectedRef={selectedPath === node.file.path ? selectedRef : undefined}
				onSelect={onSelect}
				t={t}
			/>
		),
	);
}

function DirectoryNode({
	node,
	depth,
	collapsed,
	selectedPath,
	selectedRef,
	onToggle,
	onSelect,
	t,
}: {
	node: Extract<GitFileTreeNode<GitCommitFile>, { type: "directory" }>;
	depth: number;
	collapsed: ReadonlySet<string>;
	selectedPath: string | null;
	selectedRef: RefObject<HTMLButtonElement | null>;
	onToggle: (path: string) => void;
	onSelect: (path: string) => void;
	t: TFunction;
}) {
	const expanded = !collapsed.has(node.path);
	return (
		<>
			<UnstyledButton
				type="button"
				role="treeitem"
				aria-expanded={expanded}
				aria-level={depth + 1}
				className={classes.row}
				style={{ paddingLeft: depth * 12 + 4 }}
				data-commit-folder={node.path}
				title={node.path}
				aria-label={t(expanded ? "collapseFolder" : "expandFolder", { path: node.path })}
				onClick={() => onToggle(node.path)}
			>
				<span className={classes.twist}>
					{expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
				</span>
				<span className={classes.mark}>
					{expanded ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
				</span>
				<span className={classes.name}>{node.name}</span>
				<span className={classes.count}>{node.fileCount}</span>
			</UnstyledButton>
			{expanded && (
				<TreeNodes
					nodes={node.children}
					depth={depth + 1}
					collapsed={collapsed}
					selectedPath={selectedPath}
					selectedRef={selectedRef}
					onToggle={onToggle}
					onSelect={onSelect}
					t={t}
				/>
			)}
		</>
	);
}

function FileNode({
	node,
	depth,
	selected,
	selectedRef,
	onSelect,
	t,
}: {
	node: Extract<GitFileTreeNode<GitCommitFile>, { type: "file" }>;
	depth: number;
	selected: boolean;
	selectedRef?: RefObject<HTMLButtonElement | null>;
	onSelect: (path: string) => void;
	t: TFunction;
}) {
	const file = node.file;
	const label = commitFileLabel(file);
	return (
		<UnstyledButton
			ref={selectedRef}
			type="button"
			role="treeitem"
			aria-level={depth + 1}
			aria-pressed={selected}
			aria-selected={selected}
			className={`${classes.row} ${classes.file}`}
			style={{ paddingLeft: depth * 12 + 4 }}
			data-commit-file={file.path}
			title={label}
			aria-label={`${t(`commitPreview.status.${file.status}`)}: ${label}`}
			onClick={() => onSelect(file.path)}
		>
			<span className={classes.twist} />
			<span
				className={classes.mark}
				style={{ color: `var(--mantine-color-${COMMIT_STATUS_COLOR[file.status]}-text)` }}
			>
				{COMMIT_STATUS_LETTER[file.status]}
			</span>
			<span className={classes.name}>{node.name}</span>
			<span className={classes.stats}>
				<TreeFileStats file={file} />
			</span>
		</UnstyledButton>
	);
}

function TreeFileStats({ file }: { file: GitCommitFile }) {
	const { t } = useTranslation("git");
	if (file.binary) {
		return (
			<Text component="span" size="xs" c="dimmed">
				{t("commitPreview.binary")}
			</Text>
		);
	}
	const unknown = file.linesAdded === null || file.linesRemoved === null;
	return (
		<Text
			component="span"
			size="xs"
			ff="monospace"
			title={unknown ? t("commitPreview.unknownStats") : undefined}
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
