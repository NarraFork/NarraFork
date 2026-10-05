import { Box, Text } from "@mantine/core";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import { useNarrator } from "../../../hooks/useNarrator";
import type { WorkspacePanelParams } from "./panel-types";
import { workspaceResourceOwner } from "./workspace-dock";

/** Temporary windows have no tabs. Durable resource tabs still identify their owner. */
export function WorkspaceResourceTab(props: IDockviewPanelHeaderProps) {
	const owner = workspaceResourceOwner(props.params as WorkspacePanelParams);
	const { data: narrator } = useNarrator(owner ?? "");
	const ownerTitle = (narrator as { title?: string } | undefined)?.title ?? owner?.slice(0, 8);
	return (
		<Box style={{ display: "flex", alignItems: "center", height: "100%", minWidth: 0 }}>
			{ownerTitle && (
				<Text size="xs" c="dimmed" px={4} style={{ maxWidth: 100 }} truncate>
					{ownerTitle}
				</Text>
			)}
			<DockviewDefaultTab {...props} />
		</Box>
	);
}
