import { useNarrator } from "@frontend/hooks/useNarrator";
import { ActionIcon, Box, Drawer, Group, Tabs, Text } from "@mantine/core";
import { IconFileCode, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorPermissionsCapability } from "../../hooks/usePlatform";
import { FileApprovalTab } from "./FileApprovalTab";
import { FileDeletePreviewTab } from "./FileDeletePreviewTab";
import { FileSummaryTab } from "./FileSummaryTab";
import type { PendingPermission } from "./narrator-panel-types";

const EDIT_TOOLS = new Set(["Write", "Edit"]);

export interface FileModificationsPanelProps {
	narratorId: string;
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
	/**
	 * When true (dock surface), suppress this panel's own title bar — the dock's
	 * ToolPanelShell provides the single header. This panel has no header actions.
	 */
	chromeless?: boolean;
}

/** Pure content panel — used as sidebar on desktop */
export function FileModificationsPanel({
	narratorId,
	onClose,
	pendingPermission,
	onPermissionDecision,
	deletePreviewMessageId,
	onConfirmDelete,
	onCancelDelete,
	chromeless = false,
}: FileModificationsPanelProps) {
	const { t } = useTranslation("narrator");
	const { data: narrator } = useNarrator(narratorId);
	const permissionCapability = useNarratorPermissionsCapability();
	const permissionDecisionSupported =
		permissionCapability.supported && permissionCapability.approveDeny;
	const basePath = narrator?.cwd ?? null;
	const [activeTab, setActiveTab] = useState<string>("summary");

	const isEditPermission = pendingPermission && EDIT_TOOLS.has(pendingPermission.toolName);

	useEffect(() => {
		if (deletePreviewMessageId) {
			setActiveTab("delete-preview");
		} else if (isEditPermission) {
			setActiveTab("approval");
		}
	}, [deletePreviewMessageId, isEditPermission]);

	const handleConfirmDelete = () => {
		onConfirmDelete?.();
		onClose();
	};

	const handleCancelDelete = () => {
		onCancelDelete?.();
		onClose();
	};

	const handlePermissionDecision = (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
	) => {
		if (!permissionDecisionSupported) return;
		onPermissionDecision?.(requestId, decision, feedbackText);
		setActiveTab("summary");
	};

	return (
		<Box h="100%" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
			{/* Header — hidden in the dock (ToolPanelShell provides it). */}
			{!chromeless && (
				<Group
					gap={6}
					px="xs"
					py={3}
					style={{
						flexShrink: 0,
						borderBottom: "1px solid var(--mantine-color-dark-4)",
					}}
				>
					<IconFileCode size={14} />
					<Text size="xs" fw={500} style={{ flex: 1 }}>
						{t("fileMod_title")}
					</Text>
					<ActionIcon size="xs" variant="subtle" color="gray" onClick={onClose}>
						<IconX size={12} />
					</ActionIcon>
				</Group>
			)}

			{/* Tabs content */}
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

				<Tabs.Panel value="summary" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
					<FileSummaryTab narratorId={narratorId} basePath={basePath} />
				</Tabs.Panel>

				{isEditPermission && (
					<Tabs.Panel value="approval" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
						<FileApprovalTab
							narratorId={narratorId}
							basePath={basePath}
							permission={pendingPermission}
							readOnly={!permissionDecisionSupported}
							onDecision={handlePermissionDecision}
						/>
					</Tabs.Panel>
				)}

				{deletePreviewMessageId && (
					<Tabs.Panel value="delete-preview" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
						<FileDeletePreviewTab
							narratorId={narratorId}
							basePath={basePath}
							messageId={deletePreviewMessageId}
							onConfirm={handleConfirmDelete}
							onCancel={handleCancelDelete}
						/>
					</Tabs.Panel>
				)}
			</Tabs>
		</Box>
	);
}

/** Drawer wrapper — used on mobile */
export interface FileModificationsDrawerProps extends FileModificationsPanelProps {
	opened: boolean;
}

export function FileModificationsDrawer({
	opened,
	onClose,
	...rest
}: FileModificationsDrawerProps) {
	const { t } = useTranslation("narrator");

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size={600}
			title={t("fileMod_title")}
			styles={{
				body: {
					height: "calc(100% - 60px)",
					padding: 0,
					display: "flex",
					flexDirection: "column",
				},
			}}
		>
			<FileModificationsPanel onClose={onClose} {...rest} />
		</Drawer>
	);
}
