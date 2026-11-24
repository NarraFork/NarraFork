/**
 * "Pin to sidebar" for a project or a team: one icon button beside the page title (or on a
 * team row). Pinned, the project or team is a tab in the sidebar's pinned block; unpinning
 * leaves it there unpinned, as the row menu's unpin does, and the sidebar closes it the usual way.
 *
 * Whether it is pinned is read from the sidebar's own cache (the shell keeps it loaded, and the
 * pinned block is always on its first page), so the button follows changes made in the sidebar.
 */
import { ActionIcon, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPin, IconPinnedFilled } from "@tabler/icons-react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	RECENT_TABS_QUERY_KEY,
	type RecentTab,
	setRecentTabPinnedFromPage,
} from "../../hooks/useRecentTabs";
import { isPinnedInSidebar } from "./recent-tab-page-pin";

export function PinToSidebarButton({
	type,
	id,
	title,
	size = "md",
}: {
	type: "project" | "team";
	id: string;
	/** The tab's title until the server writes its own (a team's is its coordinator's title). */
	title: string;
	size?: "sm" | "md";
}) {
	const { t } = useTranslation("nav");
	const { data: tabs } = useQuery<RecentTab[]>({
		queryKey: RECENT_TABS_QUERY_KEY,
		queryFn: skipToken,
	});
	const pinned = isPinnedInSidebar(tabs, type, id);
	const [busy, setBusy] = useState(false);
	const label = t(pinned ? "unpinFromSidebar" : "pinToSidebar");
	const toggle = () => {
		setBusy(true);
		setRecentTabPinnedFromPage({ type, id, title }, !pinned)
			.catch(() =>
				notifications.show({
					color: "red",
					message: t(pinned ? "unpinFromSidebarFailed" : "pinToSidebarFailed"),
				}),
			)
			.finally(() => setBusy(false));
	};
	return (
		<Tooltip label={label} withinPortal>
			<ActionIcon
				size={size === "sm" ? 24 : 30}
				variant={pinned ? "light" : "subtle"}
				color={pinned ? undefined : "gray"}
				aria-label={label}
				aria-pressed={pinned}
				loading={busy}
				onClick={(event) => {
					// A team row is itself a button: pinning must not also open the team.
					event.stopPropagation();
					toggle();
				}}
				data-testid="pin-to-sidebar"
				data-pinned={pinned ? "true" : "false"}
			>
				{pinned ? (
					<IconPinnedFilled size={size === "sm" ? 14 : 16} aria-hidden />
				) : (
					<IconPin size={size === "sm" ? 14 : 16} aria-hidden />
				)}
			</ActionIcon>
		</Tooltip>
	);
}
