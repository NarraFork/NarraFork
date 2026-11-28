import { Group, Text } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconFolder, IconFolderOpen } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";
import classes from "./GitChangesTab.module.css";

export const STATUS_BADGE_WIDTH = 28;
const TREE_INDENT_PX = 12;
const MAX_GIT_FILE_PATH_CHARS = 1_000;
export function clampGitFilePath(path: string): string {
	return path.length > MAX_GIT_FILE_PATH_CHARS
		? `${path.slice(0, MAX_GIT_FILE_PATH_CHARS)}…`
		: path;
}

/** Shared presentation only: each caller retains its own scope and actions. */
export function TreeRow({
	depth,
	label,
	expanded,
	onActivate,
	children,
	...attributes
}: Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "children"> & {
	depth: number;
	label: string;
	expanded?: boolean;
	onActivate: () => void;
	children: ReactNode;
}) {
	return (
		<Group
			{...attributes}
			className={classes.treeRow}
			gap={4}
			wrap="nowrap"
			py={2}
			pr={4}
			style={{ paddingInlineStart: `min(${depth * TREE_INDENT_PX + 4}px, 25%)` }}
			role="button"
			tabIndex={0}
			aria-label={label}
			aria-expanded={expanded}
			onClick={onActivate}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
					return;
				event.preventDefault();
				onActivate();
			}}
		>
			{children}
		</Group>
	);
}

export function DirectoryGlyph({ expanded }: { expanded: boolean }) {
	return (
		<Group gap={2} wrap="nowrap" w={STATUS_BADGE_WIDTH} style={{ flexShrink: 0 }}>
			{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
			{expanded ? (
				<IconFolderOpen size={14} style={{ opacity: 0.75 }} />
			) : (
				<IconFolder size={14} style={{ opacity: 0.75 }} />
			)}
		</Group>
	);
}

/** Unknown and non-text changes never acquire synthetic zero line counts. */
export function LineStats({
	added,
	removed,
	refreshing,
	annotation,
}: {
	added?: number;
	removed?: number;
	refreshing?: boolean;
	annotation?: { label: string; content: ReactNode };
}) {
	const known =
		added != null && removed != null && Number.isFinite(added) && Number.isFinite(removed);
	if (!known && !annotation) return null;
	return (
		<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }} aria-busy={refreshing === true}>
			{annotation && (
				<Text size="xs" c="dimmed" title={annotation.label} aria-label={annotation.label}>
					{annotation.content}
				</Text>
			)}
			{known && (added > 0 || removed === 0) && (
				<Text size="xs" c="green" ff="monospace">
					+{added}
				</Text>
			)}
			{known && (removed > 0 || added === 0) && (
				<Text size="xs" c="red" ff="monospace">
					-{removed}
				</Text>
			)}
		</Group>
	);
}
