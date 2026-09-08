import { Box, Modal } from "@mantine/core";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallDetailRef } from "../../lib/api/narrators";
import { useFilePanelNavigation } from "./file-panel-navigation";
import type { ToolEditReference } from "./tool-edit-reference";

const ToolEditFileViewer = lazy(() =>
	import("./ToolEditFileViewer").then((module) => ({ default: module.ToolEditFileViewer })),
);

/** Both right-click surfaces bind the persisted tool identity, not the active file/device. */
export function useToolEditNavigation({
	toolName,
	narratorId,
	toolUseId,
	toolDetailRef,
	filePath,
}: {
	toolName?: string;
	narratorId?: string;
	toolUseId?: string;
	toolDetailRef?: ToolCallDetailRef;
	filePath?: string;
}) {
	const openFilePanel = useFilePanelNavigation();
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const reference = useMemo<ToolEditReference | null>(() => {
		if (toolName !== "Edit" || !narratorId || !toolUseId || !filePath) return null;
		return {
			narratorId,
			toolUseId,
			toolCallId: toolDetailRef?.toolCallId,
			messageId: toolDetailRef?.messageId,
			executionAttempt: toolDetailRef?.executionAttempt,
		};
	}, [
		toolName,
		narratorId,
		toolUseId,
		filePath,
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
		open: reference ? open : undefined,
		modal:
			opened && reference && filePath ? (
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
