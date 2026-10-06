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
	/** Include dotfiles. */
	showHidden?: boolean;
}

export function FileTreePanel({ narratorId, onOpenFile, showHidden = false }: FileTreePanelProps) {
	const { t } = useTranslation("narrator");
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
			lineStats={lineStats}
			lineStatsTruncated={fileTreeStatus?.truncated === true}
			onRefreshLineStats={refreshLineStats}
			onOpenFile={onOpenFile}
			registerIngest={registerIngest}
		/>
	);
}
