import { ActionIcon, Group, Tooltip } from "@mantine/core";
import { IconFlask, IconX } from "@tabler/icons-react";
import { memo, type RefObject } from "react";
import type { NarratorDockContextValue } from "../dock/NarratorDockContext";
import { NarratorToolbarItem, type NarratorToolbarItemProps } from "./NarratorToolbarItem";
import { NarratorToolbarOverflowMenu } from "./NarratorToolbarOverflowMenu";
import { HEADER_TOOLBAR_FIXED_ATTR } from "./narrator-header-toolbar-capacity";
import type { NarratorToolbarHost } from "./narrator-toolbar-items";
import { useHeaderToolbarCapacityPartition } from "./use-header-toolbar";

export interface HeaderToolbarProps extends Omit<NarratorToolbarItemProps, "def" | "mode"> {
	headerRowRef: RefObject<HTMLDivElement | null>;
	headerToolbarRef: RefObject<HTMLDivElement | null>;
	headerLeadingRef: RefObject<HTMLDivElement | null>;
	hostOwnsTitle: boolean;
	isWorkspacePreview: boolean;
	isMobileViewport: boolean;
	headerHostCapabilities: readonly NarratorToolbarHost[];
	openArchiveConfirm: () => void;
	archiveMutation: { isPending: boolean };
	dock: NarratorDockContextValue | null;
	mockStreamEnabled: boolean;
	onClose?: () => void;
}

/**
 * Header tool row. Width capacity lives HERE so icon collapse/expand re-renders
 * this row (and its overflow menu), not the whole NarratorPanel.
 */
export const HeaderToolbar = memo(function HeaderToolbar(props: HeaderToolbarProps) {
	const {
		headerRowRef,
		headerToolbarRef,
		headerLeadingRef,
		hostOwnsTitle,
		isWorkspacePreview,
		isMobileViewport,
		headerHostCapabilities,
		toolbarBadgeCounts,
		openArchiveConfirm,
		archiveMutation,
		dock,
		mockStreamEnabled,
		onClose,
		t,
		controller,
	} = props;
	const { toolbarVisibleDefs, toolbarHiddenDefs, toolbarNoRoomIds } =
		useHeaderToolbarCapacityPartition({
			surfacedDefs: controller.toolbarSurfacedDefs,
			tuckedDefs: controller.toolbarTuckedDefs,
			headerRowRef,
			headerToolbarRef,
			headerLeadingRef,
			hostOwnsTitle,
			isWorkspacePreview,
			isMobileViewport,
		});
	const { toolbarEntries, saveToolbarLayout, activateToolbarEntry, renderToolbarInlineOptions } =
		controller;
	return (
		<Group ref={headerToolbarRef} gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
			{toolbarVisibleDefs.map((def) => (
				<NarratorToolbarItem key={def.id} {...props} def={def} />
			))}
			{/* Debug-only entry intentionally stays outside the persisted registry. */}
			{dock && mockStreamEnabled && (
				<Tooltip label="Mock stream (debug)">
					<ActionIcon
						{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
						size="sm"
						variant={dock.openToolTypes.has("mock") ? "light" : "subtle"}
						color={dock.openToolTypes.has("mock") ? "indigo" : "gray"}
						onClick={() => dock.toggleToolPanel("mock")}
					>
						<IconFlask size={16} />
					</ActionIcon>
				</Tooltip>
			)}
			<NarratorToolbarOverflowMenu
				entries={toolbarEntries}
				hiddenDefs={toolbarHiddenDefs}
				noRoomIds={toolbarNoRoomIds}
				onSaveLayout={saveToolbarLayout}
				hostCapabilities={headerHostCapabilities}
				badgeCounts={toolbarBadgeCounts}
				onActivate={activateToolbarEntry}
				renderInlineOptions={renderToolbarInlineOptions}
				onArchive={openArchiveConfirm}
				archiveLoading={archiveMutation.isPending}
			/>
			{onClose && (
				<Tooltip label={t("closePanel")}>
					<ActionIcon
						{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
						size="sm"
						variant="subtle"
						color="red"
						onClick={onClose}
					>
						<IconX size={16} />
					</ActionIcon>
				</Tooltip>
			)}
		</Group>
	);
});
