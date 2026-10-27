/**
 * The off-dock host of an outline panel: a session with no dock to open panels in (a phone, a
 * detached session window) shows the outline in a drawer over the conversation instead of
 * leaving it. Full screen on a phone, where Back closes it; a side drawer elsewhere.
 *
 * The same content as the dock panel (`OutlinePanelContent`), navigated in place; a Ctrl/Cmd-click
 * navigates in place too (a drawer holds one place). "Open in outline page" leaves for the route.
 */
import { ActionIcon, Box, Center, Drawer, Group, Loader, Text, Tooltip } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMobileDrawerHistory } from "../../hooks/useMobileDrawerHistory";
import { useMobileViewport } from "../../hooks/useMobileViewport";
import type { OutlinePanelState } from "../../lib/outline-panel";
import { useOpenOutlinePage } from "../../lib/outline-router";
import {
	SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
	SAFE_AREA_DRAWER_BODY_STYLE,
	safeAreaDrawerBodyHeight,
} from "../../lib/safe-area";
import { OutlineHostProvider } from "../outline/outline-host";

const OutlinePanelContent = lazy(() =>
	import("../outline/OutlinePanelContent").then((m) => ({ default: m.OutlinePanelContent })),
);

export function OutlineDrawerHost({
	state,
	onChange,
	onClose,
	onOpenSession,
}: {
	state: OutlinePanelState;
	onChange: (next: OutlinePanelState) => void;
	onClose: () => void;
	/** Open the session that wrote an agent commit. */
	onOpenSession?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("outline");
	const isMobile = useMobileViewport();
	const openPage = useOpenOutlinePage();
	// What loaded is called this (a title the opener already knew until then); not stored.
	const [title, setTitle] = useState<string | null>(state.title ?? null);
	useMobileDrawerHistory(true, onClose);
	return (
		<Drawer
			opened
			onClose={onClose}
			position="right"
			size={isMobile ? "100%" : 640}
			title={
				<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
					<Text size="sm" fw={600} truncate>
						{title ?? t("title")}
					</Text>
					<Tooltip label={t("panel.openPage")}>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="gray"
							aria-label={t("panel.openPage")}
							onClick={() => {
								onClose();
								openPage(state);
							}}
						>
							<IconExternalLink size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			}
			closeButtonProps={{ size: "sm" }}
			styles={{
				header: SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
				title: { minWidth: 0, flex: 1, overflow: "hidden" },
				body: {
					height: safeAreaDrawerBodyHeight(60),
					padding: 0,
					display: "flex",
					flexDirection: "column",
					...SAFE_AREA_DRAWER_BODY_STYLE,
				},
			}}
			data-testid="outline-drawer"
		>
			<Suspense
				fallback={
					<Center h="100%">
						<Loader size="sm" />
					</Center>
				}
			>
				<OutlineHostProvider openSession={onOpenSession}>
					<Box style={{ flex: 1, minHeight: 0 }}>
						<OutlinePanelContent
							state={state}
							onChange={onChange}
							onOpenNew={onChange}
							onTitle={setTitle}
						/>
					</Box>
				</OutlineHostProvider>
			</Suspense>
		</Drawer>
	);
}
