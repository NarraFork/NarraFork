/**
 * FileTreeContent.tsx — the file tree panel's body.
 *
 * Rooted at the narrator's cwd, lazily reads one directory level per expand, and
 * patches individual levels from the watcher's path events. Clicking a file opens it
 * in the existing read-only viewer panel; this component never writes.
 *
 * Built on Mantine's `Tree` rather than a hand-rolled or third-party tree: keyboard
 * navigation, range selection and the ARIA tree semantics are already covered there,
 * and `renderNode` gives full control of each row. Async children are driven through
 * our own store instead of `useTree`'s `onLoadChildren`, because the store is also
 * the patch target — two caches would drift the moment a WS event arrived.
 */

import {
	ActionIcon,
	Box,
	Center,
	Group,
	Loader,
	type RenderTreeNodePayload,
	Text,
	Tooltip,
	Tree,
	type TreeNodeData,
	useTree,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconChevronDown,
	IconChevronRight,
	IconEyeOff,
	IconFile,
	IconFolder,
	IconRefresh,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { TREE_ROOT_KEY } from "./tree-patch";
import type { TreeEntry, TreeState } from "./tree-store";
import { useFileTree } from "./useFileTree";

/**
 * Rows rendered per directory level.
 *
 * Mantine's Tree is not virtualized, so a directory with tens of thousands of
 * entries would mount that many DOM nodes and freeze the panel. The same order of
 * magnitude as the directory picker's own cap (`MAX_DIRECTORY_ENTRIES`), for the
 * same reason recorded there: past this point the listing has stopped being usable
 * as a way to find a file.
 *
 * Truncation is always SHOWN (see `truncatedNode`) rather than silent — a tree that
 * quietly omits files is worse than one that admits it cannot show them all.
 */
const MAX_ENTRIES_PER_DIR = 1_000;

/** Sentinel value prefix for the "N more entries" row. */
const TRUNCATED_PREFIX = "\u0000truncated:";

export interface FileTreeContentProps {
	/** Absolute path of the tree root — the narrator's cwd. */
	root: string;
	showHidden: boolean;
	/** Open a file in the read-only viewer. Absolute path. */
	onOpenFile: (absolutePath: string, fileName: string) => void;
	/** Live patch feed registration; see `FileTreePanel` for the WS wiring. */
	registerIngest?: (ingest: ReturnType<typeof useFileTree>["ingest"]) => void;
}

/** Build Mantine tree data for one directory level from the store. */
function buildNodes(
	state: TreeState,
	dir: string,
	errors: ReadonlyMap<string, string>,
): TreeNodeData[] {
	const dirState = state.get(dir);
	if (!dirState) return [];

	const shown = dirState.entries.slice(0, MAX_ENTRIES_PER_DIR);
	const hiddenCount = dirState.entries.length - shown.length;

	const nodes: TreeNodeData[] = shown.map((entry) => {
		const children = entry.isDirectory ? buildNodes(state, entry.path, errors) : undefined;
		return {
			value: entry.path,
			label: entry.name,
			nodeProps: { entry },
			// `hasChildren` is what makes a directory expandable BEFORE its listing is
			// known. Deriving it from `children.length` would make every unread directory
			// look like a leaf, so nothing could ever be expanded.
			...(entry.isDirectory ? { hasChildren: true, children: children ?? [] } : {}),
		};
	});

	if (hiddenCount > 0) {
		nodes.push({
			value: `${TRUNCATED_PREFIX}${dir}`,
			label: String(hiddenCount),
			nodeProps: { truncatedCount: hiddenCount },
		});
	}

	return nodes;
}

export function FileTreeContent({
	root,
	showHidden,
	onOpenFile,
	registerIngest,
}: FileTreeContentProps) {
	const { t } = useTranslation("narrator");
	const { state, loading, errors, load, reload, reloadAll, ingest } = useFileTree(root, showHidden);

	// Hand the patch entry point to the panel, which owns the WS subscription. In an
	// effect rather than the render body: publishing a callback is a side effect, and
	// doing it during render would also fire on every discarded concurrent render.
	useEffect(() => {
		registerIngest?.(ingest);
	}, [ingest, registerIngest]);

	const tree = useTree({
		multiple: false,
		onNodeExpand: (value) => {
			// Reading on expand is what makes this lazy. `load` is a no-op for a level
			// already loaded and fresh, so collapsing and re-expanding costs nothing.
			if (value.startsWith(TRUNCATED_PREFIX)) return;
			void load(value);
		},
	});

	const data = useMemo(() => buildNodes(state, TREE_ROOT_KEY, errors), [state, errors]);

	const rootLoaded = state.has(TREE_ROOT_KEY);
	const rootError = errors.get(TREE_ROOT_KEY);
	const rootLoading = loading.has(TREE_ROOT_KEY);

	// Read the root once a root path exists.
	//
	// In an effect, not the render body: a fetch started during render runs again for
	// every discarded concurrent render, and `load` sets state, which React forbids
	// while rendering. `load` is a no-op once the root is loaded and fresh, so the
	// effect can re-run harmlessly; the error case is excluded so a failed read does
	// not retry in a loop (the error panel offers an explicit retry instead).
	useEffect(() => {
		if (!root || rootLoaded || rootLoading || rootError) return;
		void load(TREE_ROOT_KEY);
	}, [load, root, rootError, rootLoaded, rootLoading]);

	const renderNode = useCallback(
		(payload: RenderTreeNodePayload) => (
			<FileTreeRow
				payload={payload}
				root={root}
				loading={loading}
				errors={errors}
				onOpenFile={onOpenFile}
				onReload={reload}
			/>
		),
		[errors, loading, onOpenFile, reload, root],
	);

	if (!root) {
		return (
			<Center h="100%" p="md">
				<Text size="sm" c="dimmed" ta="center">
					{t("fileTree.noRoot")}
				</Text>
			</Center>
		);
	}

	if (rootError) {
		return (
			<Center h="100%" p="md">
				<Group gap="xs" wrap="nowrap">
					<IconAlertTriangle size={16} color="var(--mantine-color-orange-6)" />
					<Text size="sm" c="dimmed">
						{rootError}
					</Text>
					<Tooltip label={t("fileTree.retry")} openDelay={200}>
						<ActionIcon variant="subtle" size="sm" onClick={() => void reload(TREE_ROOT_KEY)}>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Center>
		);
	}

	if (!rootLoaded) {
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	}

	return (
		<Box style={{ height: "100%", overflow: "auto" }} p="xs">
			<Group justify="flex-end" gap={4} mb={4}>
				<Tooltip label={t("fileTree.refresh")} openDelay={200}>
					<ActionIcon variant="subtle" color="gray" size="sm" onClick={reloadAll}>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>
			{data.length === 0 ? (
				<Center py="lg">
					<Text size="sm" c="dimmed">
						{t("fileTree.empty")}
					</Text>
				</Center>
			) : (
				<Tree
					data={data}
					tree={tree}
					levelOffset="md"
					expandOnClick={false}
					selectOnClick={false}
					withLines
					renderNode={renderNode}
				/>
			)}
		</Box>
	);
}

interface FileTreeRowProps {
	payload: RenderTreeNodePayload;
	root: string;
	loading: ReadonlySet<string>;
	errors: ReadonlyMap<string, string>;
	onOpenFile: (absolutePath: string, fileName: string) => void;
	onReload: (dir: string) => Promise<void>;
}

function FileTreeRow({ payload, root, loading, errors, onOpenFile, onReload }: FileTreeRowProps) {
	const { t } = useTranslation("narrator");
	const { node, expanded, elementProps, tree } = payload;
	const props = node.nodeProps as { entry?: TreeEntry; truncatedCount?: number } | undefined;

	// The "N more entries" row: informational, not selectable.
	if (props?.truncatedCount != null) {
		return (
			<Group {...elementProps} gap={6} wrap="nowrap" style={{ cursor: "default" }}>
				<IconEyeOff size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
				<Text size="xs" c="dimmed" fs="italic">
					{t("fileTree.truncated", { count: props.truncatedCount })}
				</Text>
			</Group>
		);
	}

	const entry = props?.entry;
	if (!entry) return null;

	const isLoading = loading.has(entry.path);
	const error = errors.get(entry.path);

	const handleClick = () => {
		if (entry.isDirectory) {
			tree.toggleExpanded(entry.path);
			return;
		}
		// The store is keyed relatively; the viewer takes an absolute path.
		onOpenFile(`${root}/${entry.path}`, entry.name);
	};

	return (
		<Group
			{...elementProps}
			gap={6}
			wrap="nowrap"
			onClick={handleClick}
			style={{ ...elementProps.style, cursor: "pointer" }}
		>
			{entry.isDirectory ? (
				<>
					{isLoading ? (
						<Loader size={12} style={{ flexShrink: 0 }} />
					) : expanded ? (
						<IconChevronDown size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
					) : (
						<IconChevronRight size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
					)}
					<IconFolder size={14} style={{ flexShrink: 0, opacity: 0.75 }} />
				</>
			) : (
				<>
					<Box style={{ width: 14, flexShrink: 0 }} />
					<IconFile size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
				</>
			)}
			<Text size="sm" truncate style={{ fontStyle: entry.isSymlink ? "italic" : undefined }}>
				{entry.name}
			</Text>
			{/* A failed read must be visible on its own node: rendering the directory as
			    empty would be indistinguishable from it actually being empty. */}
			{error && (
				<Tooltip label={error} openDelay={200} multiline maw={280}>
					<ActionIcon
						variant="subtle"
						color="orange"
						size="xs"
						onClick={(event) => {
							event.stopPropagation();
							void onReload(entry.path);
						}}
					>
						<IconAlertTriangle size={12} />
					</ActionIcon>
				</Tooltip>
			)}
		</Group>
	);
}
