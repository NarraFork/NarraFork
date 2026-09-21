import { Badge, Group, Stack, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import type { NotificationListItem as NotificationListItemData } from "@shared/notification-center";
import { IconBell, IconMessage, IconShieldLock } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../lib/format";

export interface NotificationListItemProps {
	item: NotificationListItemData;
	onActivate?: (item: NotificationListItemData) => void;
}

function kindIcon(kind: NotificationListItemData["kind"]) {
	if (kind === "chat_message") return IconMessage;
	if (kind === "permission_request") return IconShieldLock;
	return IconBell;
}

export function NotificationListItem({ item, onActivate }: NotificationListItemProps) {
	const { t } = useTranslation("nav");
	const gone = item.displayStatus === "gone";
	// Resolved stays clickable: click marks read and may open the session (M1).
	const resolved = item.displayStatus === "resolved";
	const Icon = kindIcon(item.kind);
	const kindLabel =
		item.kind === "chat_message"
			? t("notificationKindChat", "Message")
			: t("notificationKindPermission", "Permission");

	return (
		<UnstyledButton
			data-notification-id={item.id}
			data-notification-gone={gone ? "true" : undefined}
			data-notification-resolved={resolved && !gone ? "true" : undefined}
			data-notification-kind={item.kind}
			data-testid="notification-list-item"
			onClick={() => onActivate?.(item)}
			style={{
				width: "100%",
				textAlign: "left",
				padding: "10px 12px",
				borderRadius: 8,
				opacity: gone ? 0.55 : 1,
				cursor: gone ? "default" : "pointer",
			}}
			aria-disabled={gone || undefined}
		>
			<Group wrap="nowrap" align="flex-start" gap="sm">
				<ThemeIcon
					variant="light"
					color={gone ? "gray" : item.kind === "chat_message" ? "blue" : "orange"}
					size="md"
				>
					<Icon size={16} />
				</ThemeIcon>
				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Group justify="space-between" wrap="nowrap" gap="xs">
						<Text size="sm" fw={item.status === "unread" ? 600 : 400} lineClamp={1}>
							{item.title || kindLabel}
						</Text>
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{formatRelativeTime(new Date(item.createdAt).toISOString())}
						</Text>
					</Group>
					{item.preview ? (
						<Text size="xs" c="dimmed" lineClamp={2}>
							{item.preview}
						</Text>
					) : null}
					<Group gap="xs">
						<Badge size="xs" variant="outline" color="gray">
							{kindLabel}
						</Badge>
						{gone ? (
							<Badge size="xs" variant="light" color="gray" data-testid="notification-gone-badge">
								{t("notificationGone", "Expired")}
							</Badge>
						) : resolved ? (
							<Badge
								size="xs"
								variant="light"
								color="teal"
								data-testid="notification-resolved-badge"
							>
								{t("notificationResolved", "Resolved")}
							</Badge>
						) : null}
					</Group>
				</Stack>
			</Group>
		</UnstyledButton>
	);
}
