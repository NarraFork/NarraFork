/**
 * "Pin to sidebar" for a project or a team: one icon button beside the page title (or on a
 * team row). Pinned, the project or team is a tab in the sidebar's pinned block; unpinning
 * leaves it there unpinned, as the row menu's unpin does, and the sidebar closes it the usual way.
 *
 * Whether it is pinned comes from the sidebar's own cache when the tab is among its loaded rows
 * (so the button follows changes made in the sidebar at once), and otherwise from one read of
 * that tab (`api.getRecentTabState`): a pinned tab can sit past the loaded pages. That read is
 * marked stale by every delta touching the tab (`invalidateRecentTabStates`) and by this
 * button's own pin and unpin.
 */
import { ActionIcon, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPin, IconPinnedFilled } from "@tabler/icons-react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	invalidateRecentTabStates,
	RECENT_TABS_QUERY_KEY,
	type RecentTab,
	recentTabStateQueryKey,
	setRecentTabPinnedFromPage,
} from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";
import { loadedSidebarPin, resolvePagePin } from "./recent-tab-page-pin";

/** How long one tab's pin read stays fresh; deltas touching the tab invalidate it sooner. */
const PIN_STATE_STALE_MS = 60_000;

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
	const qc = useQueryClient();
	const key = `${type}:${id}`;
	const { data: tabs } = useQuery<RecentTab[]>({
		queryKey: RECENT_TABS_QUERY_KEY,
		queryFn: skipToken,
	});
	const loaded = loadedSidebarPin(tabs, type, id);
	const state = useQuery({
		queryKey: recentTabStateQueryKey(key),
		queryFn: ({ signal }) => api.getRecentTabState(type, id, signal),
		enabled: loaded === undefined,
		staleTime: PIN_STATE_STALE_MS,
		// A failed read leaves the button unpinned and usable; it is not worth a toast.
		meta: { suppressErrorToast: true },
	});
	const { pinned, known } = resolvePagePin(loaded, state.data);
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
			.finally(() => {
				invalidateRecentTabStates(qc, [key]);
				setBusy(false);
			});
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
				// Until the pin is known, a click could pin an already pinned tab again.
				disabled={!known && !state.isError}
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
