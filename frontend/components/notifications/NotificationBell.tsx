import { ActionIcon, Indicator, Tooltip } from "@mantine/core";
import { IconBell } from "@tabler/icons-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadedHumanAttentionItems, useHumanAttention } from "../../hooks/useHumanAttention";
import { formatUnreadBadge, type NotificationCenterTab } from "./types";
import { useNotificationUnreadCounts } from "./useNotificationCenter";

const NotificationCenterDrawer = lazy(() =>
	import("./NotificationCenterDrawer").then((module) => ({
		default: module.NotificationCenterDrawer,
	})),
);

export function NotificationBell() {
	const { t } = useTranslation("nav");
	const [opened, setOpened] = useState(false);
	const [initialTab, setInitialTab] = useState<NotificationCenterTab>("activity");
	const counts = useNotificationUnreadCounts();
	const attention = useHumanAttention();
	const items = loadedHumanAttentionItems(attention.data?.pages);
	const hasAttention = items.length > 0 || attention.hasNextPage;
	const unknown = attention.isError || counts.isError;
	const label = hasAttention
		? formatUnreadBadge(items.length, attention.hasNextPage)
		: attention.isPending || attention.isError
			? null
			: formatUnreadBadge(counts.data?.unreadConversations, counts.data?.conversationsLowerBound);
	const badgeAria = [
		label
			? t(hasAttention ? "notificationAttentionBadge" : "notificationConversationBadge", {
					count: label,
				})
			: t("notificationCenterTooltip"),
		unknown ? t("notificationCountUnknown") : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<>
			<Tooltip label={badgeAria} position="bottom" withArrow>
				<Indicator
					disabled={!label && !unknown}
					label={label ?? (unknown ? "?" : undefined)}
					size={16}
					color={hasAttention ? "yellow" : "gray"}
					offset={2}
					withBorder
					data-testid="notification-bell-badge"
				>
					<ActionIcon
						variant="subtle"
						color={hasAttention ? "yellow" : "gray"}
						aria-label={badgeAria}
						data-testid="notification-bell"
						onClick={() => {
							setInitialTab(hasAttention || attention.isError ? "attention" : "activity");
							setOpened(true);
						}}
					>
						<IconBell size={20} />
					</ActionIcon>
				</Indicator>
			</Tooltip>
			{opened && (
				<Suspense fallback={null}>
					<NotificationCenterDrawer
						opened
						onClose={() => setOpened(false)}
						initialTab={initialTab}
						summaryError={counts.isError}
						onRetrySummary={() => void counts.refetch()}
					/>
				</Suspense>
			)}
		</>
	);
}
