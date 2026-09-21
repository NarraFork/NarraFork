import { ActionIcon, Indicator, Tooltip } from "@mantine/core";
import { IconBell } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NotificationCenterDrawer } from "./NotificationCenterDrawer";
import { formatUnreadBadge } from "./types";
import { useNotificationUnreadCounts } from "./useNotificationCenter";

/**
 * Header bell + unread badge + drawer entry (spec §6.2).
 *
 * Mounted once in `AppRootLayout` AppShell.Header. Owns the live WS
 * subscription for the badge (via `useNotificationUnreadCounts`), so the
 * drawer need not be open for counts to stay fresh.
 *
 * Opening the drawer does **not** re-fire PWA/toast paths — this component
 * only touches notification queries; transient toasts stay in
 * `frontend/lib/notification.ts`.
 */
export function NotificationBell() {
	const { t } = useTranslation("nav");
	const [opened, setOpened] = useState(false);
	const counts = useNotificationUnreadCounts(true);
	const total = counts.data?.total ?? 0;
	const label = formatUnreadBadge(total, counts.data?.lowerBound);
	const badgeAria =
		label != null
			? counts.data?.lowerBound || total > 99
				? t("notificationUnreadBadgeCap", { defaultValue: "99+ unread notifications" })
				: t("notificationUnreadBadge", {
						count: total,
						defaultValue: "{{count}} unread notifications",
					})
			: t("notificationCenterTooltip", { defaultValue: "Open notifications" });

	return (
		<>
			<Tooltip
				label={label != null ? badgeAria : t("notificationCenterTooltip", "Open notifications")}
				position="bottom"
				withArrow
			>
				<Indicator
					disabled={!label}
					label={label ?? undefined}
					size={16}
					color="red"
					offset={2}
					withBorder
					data-testid="notification-bell-badge"
				>
					<ActionIcon
						variant="subtle"
						color="gray"
						aria-label={badgeAria}
						data-testid="notification-bell"
						onClick={() => setOpened(true)}
					>
						<IconBell size={20} />
					</ActionIcon>
				</Indicator>
			</Tooltip>
			<NotificationCenterDrawer opened={opened} onClose={() => setOpened(false)} />
		</>
	);
}
