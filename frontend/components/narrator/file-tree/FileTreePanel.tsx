/**
 * FileTreePanel.tsx — the file tree bound to one narrator.
 *
 * Owns the two things `FileTreeContent` cannot resolve for itself: the root path
 * (the narrator's cwd) and the live patch feed (the narrator's WS subscription).
 *
 * ## Why the subscription lives here
 *
 * `workspace_paths_changed` is narrator-scoped, so the patch feed is a property of
 * "which narrator is this tree showing", not of the tree widget. Keeping the
 * subscription out of `FileTreeContent` also keeps that component testable against a
 * plain root path with no socket.
 */

import { Center, Text } from "@mantine/core";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileTreeStatus } from "../../../hooks/useNarrator";
import { useNarratorWS } from "../../../hooks/useNarratorWS";
import { useWorkspaceContext } from "../../../hooks/useWorkspaceContext";
import { FileTreeContent } from "./FileTreeContent";
import type { TreeChange } from "./tree-patch";
import { buildTreeLineStats } from "./tree-store";

export interface FileTreePanelProps {
	narratorId: string;
	/** Open a file in the read-only viewer panel. */
	onOpenFile: (absolutePath: string, fileName: string) => void;
	/**
	 * Initial dotfile visibility. Defaults to true.
	 *
	 * 默认为 true —— 文件树是叙述者查看/打开项目文件的入口, 隐藏 `.env`、
	 * `.gitignore`、`.config/` 这些恰恰是最常被讨论的文件, 会让用户在树里
	 * "找不到"一个明明存在的路径。
	 *
	 * 这只是**初始值**: 面板工具栏的可见性开关会接管后续变化, 所以宿主无需
	 * 为此接线就能得到可用行为。想跨挂载保留用户选择的宿主, 接
	 * `onShowHiddenChange` 并把结果回传给这个 prop 即可, 不必自己渲染开关。
	 */
	showHidden?: boolean;
	/** Reports the user's visibility toggle, for hosts that want to persist it. */
	onShowHiddenChange?: (showHidden: boolean) => void;
}

export function FileTreePanel({
	narratorId,
	onOpenFile,
	showHidden: initialShowHidden = true,
	onShowHiddenChange,
}: FileTreePanelProps) {
	const { t } = useTranslation("narrator");
	const [showHidden, setShowHidden] = useState(initialShowHidden);
	const toggleShowHidden = useCallback(() => {
		setShowHidden((previous) => {
			const next = !previous;
			onShowHiddenChange?.(next);
			return next;
		});
	}, [onShowHiddenChange]);
	const contextQuery = useWorkspaceContext(narratorId);
	const context = contextQuery.data;
	const root = context?.deviceId === "local" ? context.cwd.trim() : "";
	const treeIdentity = JSON.stringify([
		narratorId,
		context?.contextKey,
		context?.revision,
		context?.deviceId,
		root,
	]);
	const { data: fileTreeStatus, refetch: refetchFileTreeStatus } = useFileTreeStatus(
		narratorId,
		!!root,
		treeIdentity,
	);
	const lineStats = useMemo(
		() => buildTreeLineStats(fileTreeStatus?.files ?? []),
		[fileTreeStatus?.files],
	);
	const refreshLineStats = useCallback(() => {
		void refetchFileTreeStatus();
	}, [refetchFileTreeStatus]);

	// The tree publishes its patch entry point here; held in a ref because the WS
	// callback must not re-subscribe every time the tree re-renders.
	const ingestRef = useRef<((changes: readonly TreeChange[], truncated: boolean) => void) | null>(
		null,
	);
	const registration = useRef({ key: treeIdentity, token: {} });
	if (registration.current.key !== treeIdentity) {
		registration.current = { key: treeIdentity, token: {} };
		ingestRef.current = null;
	}
	const owner = registration.current;
	const registerIngest = useCallback(
		(ingest: (changes: readonly TreeChange[], truncated: boolean) => void) => {
			if (registration.current.token === owner.token) ingestRef.current = ingest;
		},
		[owner],
	);

	useNarratorWS(narratorId, {
		onWorkspacePathsChanged: () => {
			// Legacy path events carry no workspace identity. A queued old-root delete
			// must never evict a new-root entry: revalidate the CURRENT tree instead.
			// Reads are bounded and guarded against late responses in useFileTree.
			ingestRef.current?.([], true);
			refreshLineStats();
		},
		// Stage/unstage/commit can change the Git figures without changing file bytes,
		// so the path feed alone is not enough to keep the annotations current.
		onGitStatus: refreshLineStats,
	});

	if (!root) {
		return (
			<Center h="100%" p="md">
				<Text size="sm" c="dimmed" ta="center">
					{contextQuery.error
						? contextQuery.error.message
						: context && context.deviceId !== "local"
							? t("fileTree.remoteUnsupported")
							: t("fileTree.noRoot")}
				</Text>
			</Center>
		);
	}

	return (
		<FileTreeContent
			// Keyed by root: a narrator whose cwd changes must start a fresh tree rather
			// than patch entries that were relative to the previous root.
			key={treeIdentity}
			contextKey={treeIdentity}
			root={root}
			showHidden={showHidden}
			onToggleShowHidden={toggleShowHidden}
			lineStats={lineStats}
			lineStatsTruncated={fileTreeStatus?.truncated === true}
			onRefreshLineStats={refreshLineStats}
			onOpenFile={onOpenFile}
			registerIngest={registerIngest}
		/>
	);
}
