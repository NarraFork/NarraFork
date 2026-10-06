import { ActionIcon, Box, Group, Tooltip } from "@mantine/core";
import { IconFlask, IconX } from "@tabler/icons-react";
import { memo, type ReactNode, useMemo } from "react";
import type { NarratorDockContextValue } from "../dock/NarratorDockContext";
import { usePanelHeaderControls } from "../panels/panel-header-controls";
import { NarratorToolbarItem, type NarratorToolbarItemProps } from "./NarratorToolbarItem";
import { NarratorToolbarOverflowMenu } from "./NarratorToolbarOverflowMenu";
import {
	HEADER_TOOLBAR_FIXED_ATTR,
	selectHeaderToolbarEntries,
} from "./narrator-header-toolbar-capacity";
import type { NarratorToolbarHost } from "./narrator-toolbar-items";

export interface HeaderToolbarProps extends Omit<NarratorToolbarItemProps, "def" | "mode"> {
	headerHostCapabilities: readonly NarratorToolbarHost[];
	openArchiveConfirm: () => void;
	archiveMutation: { isPending: boolean };
	dock: NarratorDockContextValue | null;
	mockStreamEnabled: boolean;
	compatibilityEntry?: ReactNode;
	onClose?: () => void;
	/**
	 * How many surfaced tools fit AFTER the full pretext-measured title reserved
	 * its width (`resolveHeaderLayoutAfterTitle`). Not a flex result.
	 */
	visibleToolCount: number;
	/**
	 * Row width not measured yet — tools must not be labelled 空间不足
	 * (missing measurement ≠ shortfall).
	 */
	unmeasured?: boolean;
}

/**
 * Tool row on the right. Visible slice comes from title-first arithmetic;
 * the remainder stays in the overflow menu. No flex fight with the title.
 */
export const HeaderToolbar = memo(function HeaderToolbar(props: HeaderToolbarProps) {
	const controls = usePanelHeaderControls();
	const {
		headerHostCapabilities,
		toolbarBadgeCounts,
		openArchiveConfirm,
		archiveMutation,
		dock,
		mockStreamEnabled,
		onClose,
		t,
		controller,
		visibleToolCount,
		unmeasured = false,
	} = props;
	const { toolbarEntries, saveToolbarLayout, activateToolbarEntry, renderToolbarInlineOptions } =
		controller;
	const surfaced = controller.toolbarSurfacedDefs;

	// Keep the partition helper on the production path. `unmeasured` maps to
	// capacity `null`, which shows every surfaced entry and labels none "no room"
	// (missing measurement ≠ shortfall). A real shortfall passes visibleToolCount.
	const selection = useMemo(
		() => selectHeaderToolbarEntries(surfaced, unmeasured ? null : Math.max(0, visibleToolCount)),
		[surfaced, visibleToolCount, unmeasured],
	);
	const visibleDefs = selection.visible;
	const noRoomDefs = selection.hidden;
	const hiddenDefs = useMemo(
		() => [...noRoomDefs, ...controller.toolbarTuckedDefs],
		[noRoomDefs, controller.toolbarTuckedDefs],
	);
	const noRoomIds = useMemo(() => noRoomDefs.map((d) => d.id as string), [noRoomDefs]);

	return (
		<Group
			gap="xs"
			wrap="nowrap"
			style={{ flex: "0 0 auto", marginLeft: "auto" }}
			{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
		>
			{visibleDefs.map((def) => (
				<NarratorToolbarItem key={def.id} {...props} def={def} />
			))}
			{dock && mockStreamEnabled && (
				<Tooltip label="Mock stream (debug)">
					<ActionIcon
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
				hiddenDefs={hiddenDefs}
				noRoomIds={noRoomIds}
				onSaveLayout={saveToolbarLayout}
				hostCapabilities={headerHostCapabilities}
				badgeCounts={toolbarBadgeCounts}
				onActivate={activateToolbarEntry}
				renderInlineOptions={renderToolbarInlineOptions}
				onArchive={openArchiveConfirm}
				archiveLoading={archiveMutation.isPending}
				compatibilityEntry={props.compatibilityEntry}
			/>
			{onClose && controls?.pinAction && (
				<Box
					{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
					className="nodrag"
					style={{ display: "flex", flexShrink: 0 }}
				>
					{controls.pinAction}
				</Box>
			)}
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
