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
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFileTreeStatus, useNarrator } from "../../../hooks/useNarrator";
import { useNarratorWS } from "../../../hooks/useNarratorWS";
import { FileTreeContent } from "./FileTreeContent";
import type { TreeChange } from "./tree-patch";
import { buildTreeLineStats } from "./tree-store";

export interface FileTreePanelProps {
	narratorId: string;
	/** Open a file in the read-only viewer panel. */
	onOpenFile: (absolutePath: string, fileName: string) => void;
	/** Include dotfiles. */
	showHidden?: boolean;
}

export function FileTreePanel({ narratorId, onOpenFile, showHidden = false }: FileTreePanelProps) {
	const { t } = useTranslation("narrator");
	const { data: narrator } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator entity
	const root = ((narrator as any)?.cwd as string | undefined)?.trim() ?? "";
	const { data: fileTreeStatus, refetch: refetchFileTreeStatus } = useFileTreeStatus(
		narratorId,
		!!root,
		root,
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
	const registerIngest = useCallback(
		(ingest: (changes: readonly TreeChange[], truncated: boolean) => void) => {
			ingestRef.current = ingest;
		},
		[],
	);

	useNarratorWS(narratorId, {
		onWorkspacePathsChanged: ({ changes, truncated }) => {
			// Dropped when the tree has not mounted its store yet: there is nothing to
			// patch, and the first read will see the current filesystem anyway.
			ingestRef.current?.(changes, truncated);
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
					{t("fileTree.noRoot")}
				</Text>
			</Center>
		);
	}

	return (
		<FileTreeContent
			// Keyed by root: a narrator whose cwd changes must start a fresh tree rather
			// than patch entries that were relative to the previous root.
			key={root}
			root={root}
			showHidden={showHidden}
			lineStats={lineStats}
			lineStatsTruncated={fileTreeStatus?.truncated === true}
			onRefreshLineStats={refreshLineStats}
			onOpenFile={onOpenFile}
			registerIngest={registerIngest}
		/>
	);
}
