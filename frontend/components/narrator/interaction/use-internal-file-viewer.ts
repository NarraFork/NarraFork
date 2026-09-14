import { fileReferenceApi } from "@frontend/lib/api/file-references";
import { notifications } from "@mantine/notifications";
import type { FileTarget } from "@shared/file-reference";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFilePanelNavigation } from "../file-panel-navigation";
import { nextHighlightRequestId } from "../panels/panel-kind";

export interface UseInternalFileViewerOptions {
	narratorId: string;
	isWorkspacePreview: boolean;
	t: (key: string) => string;
}

export interface UseInternalFileViewerResult {
	/** Path shown in the off-dock file drawer, or null when closed. */
	internalFileViewerPath: string | null;
	setInternalFileViewerPath: React.Dispatch<React.SetStateAction<string | null>>;
	/** Resolved reference target backing the current viewer (selection/highlight). */
	internalFileViewerTarget: (FileTarget & { highlightRequestId: string }) | null;
	/** Open a plain file path (via the dock panel when present, else the drawer). */
	handleOpenFilePanel: ((filePath: string) => void) | undefined;
	/** Resolve + open a file reference target (dock panel or internal drawer). */
	handleOpenReferencedFile: (target: FileTarget) => Promise<void>;
	/** Whether a file reference can be opened from this panel at all. */
	canOpenReferencedFile: boolean;
}

/**
 * File-opening for a narrator panel: prefers the dock's file panel when hosted
 * in a dock, otherwise drives an off-dock right-side Drawer (the same viewer body
 * the dock's `file` panel renders). Owns the viewer path/target state, the
 * per-narrator navigation cancellation refs, and the plain-path / reference-target
 * open handlers.
 *
 * Kept lifted (called from the panel): its handlers feed the panel's
 * `fileReferenceScope` memo (consumed by descendants via context) and the Drawer
 * lives in the panel JSX, so it cannot be sunk into a single child.
 */
export function useInternalFileViewer(
	options: UseInternalFileViewerOptions,
): UseInternalFileViewerResult {
	const { narratorId, isWorkspacePreview, t } = options;

	const [internalFileViewerPath, setInternalFileViewerPath] = useState<string | null>(null);
	const [internalFileViewerTarget, setInternalFileViewerTarget] = useState<
		(FileTarget & { highlightRequestId: string }) | null
	>(null);
	const fileNavigationRef = useRef(0);
	const fileNavigationAbortRef = useRef<AbortController | null>(null);
	const dockOpenFilePanel = useFilePanelNavigation();
	const useInternalViewer = !dockOpenFilePanel && !isWorkspacePreview;
	const handleOpenFilePanel = useMemo(() => {
		if (dockOpenFilePanel) return (filePath: string) => dockOpenFilePanel(filePath);
		if (useInternalViewer)
			return (filePath: string) => {
				setInternalFileViewerTarget(null);
				setInternalFileViewerPath(filePath);
			};
		return undefined;
	}, [dockOpenFilePanel, useInternalViewer]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: cancel navigation when the owning narrator changes
	useEffect(
		() => () => {
			fileNavigationRef.current++;
			fileNavigationAbortRef.current?.abort();
		},
		[narratorId],
	);
	const handleOpenReferencedFile = useCallback(
		async (target: FileTarget) => {
			const request = ++fileNavigationRef.current;
			fileNavigationAbortRef.current?.abort();
			const controller = new AbortController();
			fileNavigationAbortRef.current = controller;
			try {
				const { targets } = await fileReferenceApi.resolve(narratorId, [target], controller.signal);
				if (request !== fileNavigationRef.current || !targets[0]) return;
				const resolved = targets[0];
				const highlightRequestId = nextHighlightRequestId();
				if (dockOpenFilePanel) {
					dockOpenFilePanel(resolved.path, undefined, {
						fileNarratorId: narratorId,
						deviceId: resolved.deviceId,
						selection: resolved.selection,
						highlightRequestId,
						referenceOrigin: true,
					});
				} else if (useInternalViewer) {
					setInternalFileViewerTarget({ ...resolved, highlightRequestId });
					setInternalFileViewerPath(resolved.path);
				}
			} catch (error) {
				if (request === fileNavigationRef.current)
					notifications.show({
						color: "red",
						title: t("fileReferences.openFailed"),
						message: error instanceof Error ? error.message : String(error),
					});
			}
		},
		[narratorId, dockOpenFilePanel, useInternalViewer, t],
	);

	const canOpenReferencedFile = !isWorkspacePreview && (!!dockOpenFilePanel || useInternalViewer);

	return {
		internalFileViewerPath,
		setInternalFileViewerPath,
		internalFileViewerTarget,
		handleOpenFilePanel,
		handleOpenReferencedFile,
		canOpenReferencedFile,
	};
}
