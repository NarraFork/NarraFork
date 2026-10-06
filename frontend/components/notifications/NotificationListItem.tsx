import { Badge, Box, Button, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import type { NotificationListItem as NotificationListItemData } from "@shared/notification-center";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../lib/format";

export interface NotificationListItemProps {
	item: NotificationListItemData;
	onActivate?: (item: NotificationListItemData) => void;
}

export function NotificationListItem({ item, onActivate }: NotificationListItemProps) {
	const { t } = useTranslation("nav");
	const gone = item.sourceState === "gone";
	const resolved = item.sourceState === "resolved";
	const unread = item.readAt === null;
	if (gone)
		return (
			<Box
				p="sm"
				data-testid="notification-list-item"
				data-notification-id={item.id}
				data-notification-gone="true"
			>
				<Group justify="space-between" wrap="wrap">
					<Text size="sm" c="dimmed">
						{t("notificationGone")}
					</Text>
					{unread && (
						<Button size="compact-xs" variant="subtle" onClick={() => onActivate?.(item)}>
							{t("notificationMarkRead")}
						</Button>
					)}
				</Group>
			</Box>
		);
	return (
		<UnstyledButton
			data-notification-id={item.id}
			data-notification-resolved={resolved ? "true" : undefined}
			data-testid="notification-list-item"
			onClick={() => onActivate?.(item)}
			style={{ width: "100%", textAlign: "left", padding: "10px 12px", borderRadius: 8 }}
		>
			<Stack gap={4} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
				<Group gap="xs" wrap="nowrap">
					{unread && (
						<Box
							aria-label={t("notificationUnread")}
							style={{
								width: 6,
								height: 6,
								borderRadius: "50%",
								flexShrink: 0,
								background: "var(--mantine-color-blue-5)",
							}}
						/>
					)}
					<Text size="sm" fw={unread ? 600 : 400} lineClamp={1}>
						{item.title ||
							t(
								item.kind === "chat_message"
									? "notificationKindChat"
									: "notificationKindPermission",
							)}
					</Text>
				</Group>
				{item.preview && (
					<Text size="sm" c="dimmed" lineClamp={2}>
						{item.preview}
					</Text>
				)}
				<Group gap="xs" wrap="wrap">
					{item.projectTitle && (
						<Text size="xs" c="dimmed">
							{item.projectTitle}
						</Text>
					)}
					{item.chapterTitle && (
						<Text size="xs" c="dimmed">
							{item.chapterTitle}
						</Text>
					)}
					<Text size="xs" c="dimmed">
						{formatRelativeTime(new Date(item.createdAt).toISOString())}
					</Text>
					{item.groupSize > 1 && (
						<Text size="xs" c="dimmed">
							{t("notificationGroupSize", { count: item.groupSize })}
						</Text>
					)}
					{resolved && (
						<Badge size="xs" variant="light" color="gray" data-testid="notification-resolved-badge">
							{t("notificationResolved")}
						</Badge>
					)}
				</Group>
			</Stack>
		</UnstyledButton>
	);
}
