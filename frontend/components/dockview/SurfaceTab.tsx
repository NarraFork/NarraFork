import { Menu, Portal } from "@mantine/core";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import { type FunctionComponent, useState } from "react";
import { useTranslation } from "react-i18next";
import { closeSurfaceTabs, getTabCloseTargets, type TabCloseAction } from "./tab-close";

const actions: TabCloseAction[] = ["all", "left", "right", "auxiliary"];
const wrappers = new WeakMap<
	FunctionComponent<IDockviewPanelHeaderProps>,
	FunctionComponent<IDockviewPanelHeaderProps>
>();

/** Cache by renderer, not registry identity, so parent rerenders never remount tabs. */
export function withSurfaceTabMenu(Tab: FunctionComponent<IDockviewPanelHeaderProps>) {
	const existing = wrappers.get(Tab);
	if (existing) return existing;
	function SurfaceTab(props: IDockviewPanelHeaderProps) {
		const { t } = useTranslation("common");
		const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
		return (
			// The wrapper leaves ordinary click, middle-click and drag handling to the tab.
			// biome-ignore lint/a11y/noStaticElementInteractions: context menu supplements native tab interactions
			<div
				style={{ height: "100%" }}
				onContextMenu={(event) => {
					event.preventDefault();
					event.stopPropagation();
					setPosition({ x: event.clientX, y: event.clientY });
				}}
			>
				<Tab {...props} />
				{position && (
					<Menu
						opened={position !== null}
						onChange={(opened) => {
							if (!opened) setPosition(null);
						}}
						position="bottom-start"
						withinPortal
					>
						{/* Escape transformed graph ancestors: client coordinates are viewport-relative. */}
						<Portal>
							<Menu.Target>
								<span
									style={{
										position: "fixed",
										left: position?.x ?? 0,
										top: position?.y ?? 0,
										width: 0,
										height: 0,
										pointerEvents: "none",
									}}
								/>
							</Menu.Target>
						</Portal>
						<Menu.Dropdown
							onMouseDown={(event) => event.stopPropagation()}
							onClick={(event) => event.stopPropagation()}
						>
							{actions.map((action) => (
								<Menu.Item
									key={action}
									disabled={
										getTabCloseTargets(props.containerApi, props.api.id, action).length === 0
									}
									onClick={() => {
										setPosition(null);
										closeSurfaceTabs(props.containerApi, props.api.id, action);
									}}
								>
									{t(`dockTabs.${action}`)}
								</Menu.Item>
							))}
						</Menu.Dropdown>
					</Menu>
				)}
			</div>
		);
	}
	wrappers.set(Tab, SurfaceTab);
	return SurfaceTab;
}

export const DefaultSurfaceTab = withSurfaceTabMenu(DockviewDefaultTab);
