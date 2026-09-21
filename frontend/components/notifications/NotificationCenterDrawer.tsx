import {
	Button,
	Drawer,
	Group,
	Loader,
	ScrollArea,
	SegmentedControl,
	Stack,
	Text,
} from "@mantine/core";
import type { NotificationListItem as NotificationListItemData } from "@shared/notification-center";
import { IconBell } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMobileDrawerHistory } from "../../hooks/useMobileDrawerHistory";
import { NotificationListItem } from "./NotificationListItem";
import type { NotificationCenterFilter } from "./types";
import {
	useActivateNotification,
	useMarkNotificationsRead,
	useNotificationList,
} from "./useNotificationCenter";

const FILTERS: Array<{ value: NotificationCenterFilter; labelKey: string; fallback: string }> = [
	{ value: "all", labelKey: "notificationFilterAll", fallback: "All" },
	{ value: "actionable", labelKey: "notificationFilterActionable", fallback: "Actionable" },
	{ value: "messages", labelKey: "notificationFilterMessages", fallback: "Messages" },
	{ value: "permissions", labelKey: "notificationFilterPermissions", fallback: "Permissions" },
];

export interface NotificationCenterDrawerProps {
	opened: boolean;
	onClose: () => void;
}

export function NotificationCenterDrawer({ opened, onClose }: NotificationCenterDrawerProps) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const [filter, setFilter] = useState<NotificationCenterFilter>("all");
	const query = useNotificationList(filter, opened);
	const activate = useActivateNotification();
	const markAll = useMarkNotificationsRead();
	useMobileDrawerHistory(opened, onClose);

	const handleActivate = useCallback(
		(item: NotificationListItemData) => {
			const result = activate(item);
			if (!result.target) {
				// gone / missing link: stay in the drawer (gray state).
				return;
			}
			if (result.target.type === "chat_room") {
				void navigate({
					to: "/messages",
					search: { room: result.target.roomId },
				});
			} else {
				void navigate({
					to: "/narrators/$narratorId",
					params: { narratorId: result.target.narratorId },
				});
			}
			onClose();
		},
		[activate, navigate, onClose],
	);

	const handleMarkAllRead = useCallback(() => {
		void markAll.mutateAsync({ before: Date.now() }).catch(() => {
			// Non-fatal: user can retry; WS will also reconcile.
		});
	}, [markAll]);

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size="lg"
			title={
				<Group gap="xs">
					<IconBell size={18} />
					<Text fw={500}>{t("notificationCenter", "Notifications")}</Text>
				</Group>
			}
		>
			<Stack gap="md">
				<Group justify="space-between" align="center">
					<SegmentedControl
						data-testid="notification-filter-control"
						value={filter}
						onChange={(value) => setFilter(value as NotificationCenterFilter)}
						data={FILTERS.map((f) => ({
							value: f.value,
							label: t(f.labelKey, f.fallback),
						}))}
						size="xs"
					/>
					<Button
						variant="subtle"
						size="compact-sm"
						data-testid="notification-mark-all-read"
						loading={markAll.isPending}
						onClick={handleMarkAllRead}
					>
						{t("notificationMarkAllRead", "Mark all as read")}
					</Button>
				</Group>

				{query.isLoading ? (
					<Group justify="center" p="md">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							{t("notificationLoading", "Loading notifications…")}
						</Text>
					</Group>
				) : query.isError ? (
					<Stack gap="xs" align="center" p="md">
						<Text size="sm" c="red">
							{t("notificationLoadError", "Could not load notifications")}
						</Text>
						<Button variant="light" size="compact-sm" onClick={() => void query.refetch()}>
							{t("notificationRetry", "Retry")}
						</Button>
					</Stack>
				) : query.items.length === 0 ? (
					<Text size="sm" c="dimmed" ta="center" p="md" data-testid="notification-empty">
						{filter === "all"
							? t("notificationEmpty", "No notifications yet")
							: t("notificationEmptyFiltered", "No notifications in this filter")}
					</Text>
				) : (
					<ScrollArea.Autosize mah="calc(100vh - 220px)" offsetScrollbars>
						<Stack gap={4} data-testid="notification-list">
							{query.items.map((item) => (
								<NotificationListItem key={item.id} item={item} onActivate={handleActivate} />
							))}
						</Stack>
						{query.hasNextPage ? (
							<Group justify="center" pt="sm">
								<Button
									variant="default"
									size="compact-sm"
									loading={query.isFetchingNextPage}
									onClick={() => void query.fetchNextPage()}
								>
									{t("notificationLoadMore", "Load more")}
								</Button>
							</Group>
						) : null}
					</ScrollArea.Autosize>
				)}
			</Stack>
		</Drawer>
	);
}
