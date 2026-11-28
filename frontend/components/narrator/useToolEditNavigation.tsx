import { Box, Modal } from "@mantine/core";
import { isFileHistoryEnabledForDevice } from "@shared/file-change-protocol";
import type { FileTarget } from "@shared/file-reference";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallDetailRef } from "../../lib/api/narrators";
import { useFilePanelNavigation } from "./file-panel/file-panel-navigation";
import type { ToolEditReference } from "./tool-call/tool-edit-reference";
import { useToolFileNavigation } from "./tool-call/useToolFileNavigation";

const ToolEditFileViewer = lazy(() =>
	import("./tool-call/ToolEditFileViewer").then((module) => ({
		default: module.ToolEditFileViewer,
	})),
);

/** Both right-click surfaces bind the persisted tool identity, not the active file/device. */
export function useToolEditNavigation({
	toolName,
	narratorId,
	toolUseId,
	toolDetailRef,
	filePath,
	fileTarget,
	fileNarratorId,
}: {
	toolName?: string;
	narratorId?: string;
	toolUseId?: string;
	toolDetailRef?: ToolCallDetailRef;
	filePath?: string;
	/** Persisted execution target, never the receiving panel's current device. */
	fileTarget?: FileTarget | null;
	fileNarratorId?: string;
}) {
	const targetDeviceId =
		typeof fileTarget?.deviceId === "string" && fileTarget.deviceId.trim()
			? fileTarget.deviceId
			: undefined;
	const localFile = !!targetDeviceId && !isFileHistoryEnabledForDevice(targetDeviceId);
	const openCurrentFile = useToolFileNavigation(fileTarget, fileNarratorId);
	const openFilePanel = useFilePanelNavigation();
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	// StructSed qualifies alongside Edit: the preview is built from the tool call's tree
	// snapshot hashes, which it records the same way, so nothing here is Edit-specific.
	// Excluding it only denied a structural rewrite the review affordance its equivalent
	// Edit already had.
	const reference = useMemo<ToolEditReference | null>(() => {
		if (
			(toolName !== "Edit" && toolName !== "StructSed") ||
			!narratorId ||
			!toolUseId ||
			!filePath ||
			!targetDeviceId
		)
			return null;
		return {
			narratorId,
			toolUseId,
			toolCallId: toolDetailRef?.toolCallId,
			messageId: toolDetailRef?.messageId,
			executionAttempt: toolDetailRef?.executionAttempt,
			deviceId: targetDeviceId,
		};
	}, [
		toolName,
		narratorId,
		toolUseId,
		filePath,
		targetDeviceId,
		toolDetailRef?.toolCallId,
		toolDetailRef?.messageId,
		toolDetailRef?.executionAttempt,
	]);
	const open = useCallback(() => {
		if (!reference || !filePath) return;
		if (openFilePanel) openFilePanel(filePath, undefined, { toolEdit: reference });
		else setOpened(true);
	}, [openFilePanel, reference, filePath]);
	return {
		labelKey: localFile ? "contextMenu_openFilePanel" : "editPreview.open",
		open: reference ? (localFile ? openCurrentFile : open) : undefined,
		modal:
			!localFile && opened && reference && filePath ? (
				<Modal opened onClose={() => setOpened(false)} title={t("editPreview.open")} size="90vw">
					<Box h="75dvh" style={{ minHeight: 0 }}>
						<Suspense fallback={null}>
							<ToolEditFileViewer reference={reference} filePath={filePath} />
						</Suspense>
					</Box>
				</Modal>
			) : null,
	};
}
