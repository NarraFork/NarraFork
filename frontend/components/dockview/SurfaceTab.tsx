import { Menu, Portal } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFolder } from "@tabler/icons-react";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import { type FunctionComponent, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../../hooks/usePlatform";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { canRevealFromBrowser } from "../../lib/local-origin";
import { closeSurfaceTabs, getTabCloseTargets, type TabCloseAction } from "./tab-close";

const actions: TabCloseAction[] = ["all", "left", "right", "auxiliary"];
const wrappers = new WeakMap<
	FunctionComponent<IDockviewPanelHeaderProps>,
	FunctionComponent<IDockviewPanelHeaderProps>
>();

/** Reveal runs on the server desktop, never on a remote executor or browser. */
export function fileTabRevealDirectory(
	params: IDockviewPanelHeaderProps["params"],
	platform: string,
	localOrigin: boolean,
): string | null {
	if (!localOrigin || !["windows", "macos", "linux"].includes(platform)) return null;
	if (params?.panelType !== "file" || (params.deviceId ?? "local") !== "local") return null;
	const path = params.filePath;
	// Never resolve a relative path against the server process cwd. Virtual resources
	// (spec://) are not on-disk files either.
	if (typeof path !== "string" || !(/^[a-z]:[\\/]/i.test(path) || path.startsWith("/")))
		return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject unsafe filesystem path characters
	if (/[\u0000-\u001f\u007f]/.test(path)) return null;
	// Dock params contain literal filesystem paths, not Markdown hrefs: `#` and
	// line-looking suffixes must remain part of the directory/file name.
	const windows = /^[a-z]:[\\/]/i.test(path);
	const normalized = windows ? path.replace(/\\/g, "/") : path;
	const rootLength = windows ? 3 : 1;
	let end = normalized.length;
	while (end > rootLength && normalized[end - 1] === "/") end--;
	const slash = normalized.lastIndexOf("/", end - 1);
	return slash < rootLength ? normalized.slice(0, rootLength) : normalized.slice(0, slash);
}

/** Cache by renderer, not registry identity, so parent rerenders never remount tabs. */
export function withSurfaceTabMenu(Tab: FunctionComponent<IDockviewPanelHeaderProps>) {
	const existing = wrappers.get(Tab);
	if (existing) return existing;
	function SurfaceTab(props: IDockviewPanelHeaderProps) {
		const { t } = useTranslation("common");
		const platform = usePlatform();
		const { data: userPrefs } = useUserPreferences();
		const revealDirectory = fileTabRevealDirectory(
			props.params,
			platform,
			canRevealFromBrowser(userPrefs?.treatAsLocalAccess),
		);
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
							{revealDirectory && (
								<>
									<Menu.Item
										leftSection={<IconFolder size={14} />}
										onClick={() => {
											setPosition(null);
											void api.fsReveal(revealDirectory).catch((error: unknown) => {
												notifications.show({
													color: "red",
													title: t("dockTabs.revealFailed"),
													message: error instanceof Error ? error.message : t("unknownError"),
												});
											});
										}}
									>
										{t("dockTabs.revealInExplorer")}
									</Menu.Item>
									<Menu.Divider />
								</>
							)}
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
