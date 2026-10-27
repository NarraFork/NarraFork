import { ActionIcon, Indicator, Tooltip } from "@mantine/core";
import { IconBell } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { loadedHumanAttentionItems, useHumanAttention } from "../../hooks/useHumanAttention";
import { useMyKnowledgeSubmissionOutcomes, useReviewInboxCount } from "../../hooks/useKnowledge";
import {
	NotificationCenterLazyDrawer,
	preloadNotificationCenterDrawer,
} from "./NotificationCenterLazyDrawer";
import { formatUnreadBadge, type NotificationCenterTab } from "./types";
import { useNotificationUnreadCounts } from "./useNotificationCenter";

export function NotificationBell() {
	const { t } = useTranslation("nav");
	const [opened, setOpened] = useState(false);
	const [initialTab, setInitialTab] = useState<NotificationCenterTab>("activity");
	const counts = useNotificationUnreadCounts();
	const attention = useHumanAttention();
	const reviewInbox = useReviewInboxCount();
	const reviewOutcomes = useMyKnowledgeSubmissionOutcomes();
	const items = loadedHumanAttentionItems(attention.data?.pages);
	const hasAttention = items.length > 0 || attention.hasNextPage;
	const unknown = attention.isError || counts.isError;
	const attentionPending = attention.isPending || attention.isError;
	const conversationLabel = attentionPending
		? null
		: formatUnreadBadge(counts.data?.unreadConversations, counts.data?.conversationsLowerBound);
	const reviewCount = (reviewInbox.data?.count ?? 0) + (reviewOutcomes.data?.length ?? 0);
	const reviewLabel = formatUnreadBadge(reviewCount, reviewInbox.data?.capped === true);
	// Attention and unread conversations keep the badge they had. Knowledge review
	// fills it only when those are idle and empty, so a pending inbox is not silent.
	const label = hasAttention
		? formatUnreadBadge(items.length, attention.hasNextPage)
		: attentionPending
			? null
			: (conversationLabel ?? reviewLabel);
	const reviewBadge = !hasAttention && !attentionPending && !conversationLabel && !!reviewLabel;
	const badgeAria = [
		label
			? t(
					hasAttention
						? "notificationAttentionBadge"
						: reviewBadge
							? "notificationKnowledgeBadge"
							: "notificationConversationBadge",
					{ count: label },
				)
			: t("notificationCenterTooltip"),
		unknown ? t("notificationCountUnknown") : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<>
			<Tooltip label={badgeAria} position="bottom" withArrow>
				{/* Mantine Indicator defaults to `display: block`, which adds baseline
				    descender space around the inline-flex ActionIcon and parks the bell
				    higher than sibling header icons. Flex shrinks the root to the button. */}
				<Indicator
					disabled={!label && !unknown}
					label={label ?? (unknown ? "?" : undefined)}
					size={16}
					color={hasAttention ? "yellow" : reviewBadge ? "indigo" : "gray"}
					offset={2}
					withBorder
					data-testid="notification-bell-badge"
					style={{ display: "flex", alignItems: "center" }}
				>
					<ActionIcon
						variant="subtle"
						color={hasAttention ? "yellow" : reviewBadge ? "indigo" : "gray"}
						aria-label={badgeAria}
						data-testid="notification-bell"
						onPointerEnter={preloadNotificationCenterDrawer}
						onFocus={preloadNotificationCenterDrawer}
						onPointerDown={preloadNotificationCenterDrawer}
						onClick={() => {
							setInitialTab(hasAttention || attention.isError ? "attention" : "activity");
							setOpened(true);
						}}
					>
						<IconBell size={20} />
					</ActionIcon>
				</Indicator>
			</Tooltip>
			<NotificationCenterLazyDrawer
				opened={opened}
				onClose={() => setOpened(false)}
				initialTab={initialTab}
				summaryError={counts.isError}
				onRetrySummary={() => void counts.refetch()}
			/>
		</>
	);
}
