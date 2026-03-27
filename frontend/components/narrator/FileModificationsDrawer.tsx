import { Drawer, Tabs } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileApprovalTab } from "./FileApprovalTab";
import { FileDeletePreviewTab } from "./FileDeletePreviewTab";
import { FileSummaryTab } from "./FileSummaryTab";
import type { PendingPermission } from "./narrator-panel-types";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

export interface FileModificationsDrawerProps {
	narratorId: string;
	opened: boolean;
	onClose: () => void;
	// Approval mode
	pendingPermission?: PendingPermission | null;
	onPermissionDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
	) => void;
	// Delete preview mode
	deletePreviewMessageId?: string | null;
	onConfirmDelete?: () => void;
	onCancelDelete?: () => void;
}

export function FileModificationsDrawer({
	narratorId,
	opened,
	onClose,
	pendingPermission,
	onPermissionDecision,
	deletePreviewMessageId,
	onConfirmDelete,
	onCancelDelete,
}: FileModificationsDrawerProps) {
	const { t } = useTranslation("narrator");
	const [activeTab, setActiveTab] = useState<string>("summary");

	// Auto-switch tab based on context
	const isEditPermission = pendingPermission && EDIT_TOOLS.has(pendingPermission.toolName);

	useEffect(() => {
		if (deletePreviewMessageId) {
			setActiveTab("delete-preview");
		} else if (isEditPermission) {
			setActiveTab("approval");
		}
	}, [deletePreviewMessageId, isEditPermission]);

	// When delete preview completes or cancels, close drawer
	const handleConfirmDelete = () => {
		onConfirmDelete?.();
		onClose();
	};

	const handleCancelDelete = () => {
		onCancelDelete?.();
		onClose();
	};

	// When permission is decided via this panel, close approval tab
	const handlePermissionDecision = (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
	) => {
		onPermissionDecision?.(requestId, decision, feedbackText);
		// Switch back to summary after decision
		setActiveTab("summary");
	};

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size={600}
			title={t("fileMod_title")}
			styles={{
				body: { height: "calc(100% - 60px)", padding: 0, display: "flex", flexDirection: "column" },
			}}
		>
			<Tabs
				value={activeTab}
				onChange={(v) => setActiveTab(v ?? "summary")}
				variant="outline"
				style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
			>
				<Tabs.List px="sm">
					<Tabs.Tab value="summary">{t("fileMod_tabSummary")}</Tabs.Tab>
					{isEditPermission && <Tabs.Tab value="approval">{t("fileMod_tabApproval")}</Tabs.Tab>}
					{deletePreviewMessageId && (
						<Tabs.Tab value="delete-preview">{t("fileMod_tabDeletePreview")}</Tabs.Tab>
					)}
				</Tabs.List>

				<Tabs.Panel value="summary" style={{ flex: 1, minHeight: 0 }}>
					<FileSummaryTab narratorId={narratorId} />
				</Tabs.Panel>

				{isEditPermission && (
					<Tabs.Panel value="approval" style={{ flex: 1, minHeight: 0 }}>
						<FileApprovalTab
							narratorId={narratorId}
							permission={pendingPermission}
							onDecision={handlePermissionDecision}
						/>
					</Tabs.Panel>
				)}

				{deletePreviewMessageId && (
					<Tabs.Panel value="delete-preview" style={{ flex: 1, minHeight: 0 }}>
						<FileDeletePreviewTab
							narratorId={narratorId}
							messageId={deletePreviewMessageId}
							onConfirm={handleConfirmDelete}
							onCancel={handleCancelDelete}
						/>
					</Tabs.Panel>
				)}
			</Tabs>
		</Drawer>
	);
}
