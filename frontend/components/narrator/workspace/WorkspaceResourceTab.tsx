import { ActionIcon, Box, Menu, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChevronDown, IconLayoutColumns, IconPin } from "@tabler/icons-react";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../../hooks/useNarrator";
import type { WorkspacePanelParams } from "./panel-types";
import { useWorkspaceDock, workspaceResourceOwner } from "./workspace-dock";

/** Same panel, same content instance: pin only changes its native group. */
export function WorkspaceResourceTab(props: IDockviewPanelHeaderProps) {
	const store = useWorkspaceDock();
	const { t } = useTranslation("narrators");
	useSyncExternalStore(
		store?.subscribeResources ?? (() => () => {}),
		store?.getResourceRevision ?? (() => 0),
	);
	const [revision, setRevision] = useState(0);
	const [highlighted, setHighlighted] = useState<HTMLElement | null>(null);
	useEffect(() => {
		const disposable = props.containerApi.onDidLayoutChange(() =>
			setRevision((value) => value + 1),
		);
		return () => disposable.dispose();
	}, [props.containerApi]);
	useEffect(() => () => highlighted?.classList.remove("workspace-resource-target"), [highlighted]);
	const owner = workspaceResourceOwner(props.params as WorkspacePanelParams);
	const { data: narrator } = useNarrator(owner ?? "");
	const ownerTitle = (narrator as { title?: string } | undefined)?.title ?? owner?.slice(0, 8);
	const temporary = store?.isTemporary(props.api.id) ?? false;
	// The layout subscription updates geometry/availability after resize or drag.
	void revision;
	const targets = temporary ? (store?.getPinTargets(props.api.id) ?? []) : [];
	const target = targets[0];
	const pinLabel = target
		? t(store?.getDirectorActive() ? "resourceFloat.pinDirector" : "resourceFloat.pin", {
				target: target.title,
			})
		: t("resourceFloat.noNeighbour");
	const clearHighlight = () => setHighlighted(null);
	const highlightTarget = () => {
		const root = target?.group.element.closest(".workspace-resource-surface");
		const directorHost =
			store?.getDirectorActive() && root
				? [...root.querySelectorAll<HTMLElement>("[data-workspace-panel-id]")].find((host) =>
						target?.group.panels.some((panel) => panel.id === host.dataset.workspacePanelId),
					)
				: undefined;
		setHighlighted(directorHost || target?.group.element || null);
	};
	useEffect(() => {
		highlighted?.classList.add("workspace-resource-target");
	}, [highlighted]);
	const pin = (targetId?: string, createSplit = false) => {
		clearHighlight();
		if (!store?.pinResource(props.api.id, targetId, createSplit)) {
			notifications.show({ color: "orange", message: t("resourceFloat.pinFailed") });
		}
	};
	return (
		<Box style={{ display: "flex", alignItems: "center", height: "100%", minWidth: 0 }}>
			{ownerTitle && (
				<Text size="xs" c="dimmed" px={4} style={{ maxWidth: 100 }} truncate>
					{ownerTitle}
				</Text>
			)}
			<DockviewDefaultTab {...props} />
			{temporary && (
				<Box
					style={{ display: "flex" }}
					onPointerDown={(event) => event.stopPropagation()}
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => event.stopPropagation()}
					onContextMenu={(event) => event.stopPropagation()}
				>
					<Tooltip label={pinLabel}>
						<span style={{ display: "flex" }}>
							<ActionIcon
								size="xs"
								variant="subtle"
								aria-label={pinLabel}
								disabled={!target}
								onMouseEnter={highlightTarget}
								onMouseLeave={clearHighlight}
								onFocus={highlightTarget}
								onBlur={clearHighlight}
								onClick={() => pin()}
							>
								<IconPin size={13} />
							</ActionIcon>
						</span>
					</Tooltip>
					<Menu withinPortal position="bottom-end">
						<Menu.Target>
							<ActionIcon size="xs" variant="subtle" aria-label={t("resourceFloat.chooseTarget")}>
								<IconChevronDown size={12} />
							</ActionIcon>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Label>{t("resourceFloat.chooseTarget")}</Menu.Label>
							{targets.map((entry) => (
								<Menu.Item
									key={entry.group.id}
									leftSection={<IconPin size={14} />}
									onClick={() => pin(entry.group.id)}
								>
									{entry.title}
								</Menu.Item>
							))}
							<Menu.Divider />
							<Menu.Item
								leftSection={<IconLayoutColumns size={14} />}
								disabled={!store?.canCreateResourceSplit(props.api.id)}
								onClick={() => pin(undefined, true)}
							>
								{t("resourceFloat.newSplit")}
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>
				</Box>
			)}
		</Box>
	);
}
