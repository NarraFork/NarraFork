import { Alert, Button, Drawer, Group, Loader, Stack, Tabs, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import type { NotificationListItem as NotificationListItemData } from "@shared/notification-center";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMobileDrawerHistory } from "../../hooks/useMobileDrawerHistory";
import { NotificationListItem } from "./NotificationListItem";
import {
	listQueryParams,
	type NotificationCenterFilter,
	type NotificationCenterTab,
	notificationNavigateTarget,
} from "./types";
import { useMarkNotificationsRead, useNotificationList } from "./useNotificationCenter";

const HumanAttentionInboxContent = lazy(() =>
	import("../narrator/question/GlobalQuestionInbox").then((module) => ({
		default: module.HumanAttentionInboxContent,
	})),
);

export interface NotificationCenterDrawerProps {
	opened: boolean;
	onClose: () => void;
	initialTab?: NotificationCenterTab;
	summaryError?: boolean;
	onRetrySummary?: () => void;
}

export function NotificationCenterDrawer({
	opened,
	onClose,
	initialTab = "activity",
	summaryError,
	onRetrySummary,
}: NotificationCenterDrawerProps) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const mobile = useMediaQuery("(max-width: 48em)");
	const [tab, setTab] = useState<NotificationCenterTab>(initialTab);
	// Mount on first visit, then retain form-local state and in-flight draft recovery until close.
	const [visitedAttention, setVisitedAttention] = useState(initialTab === "attention");
	const [filter, setFilter] = useState<NotificationCenterFilter>("all");
	const query = useNotificationList(filter, opened && tab === "activity");
	const markRead = useMarkNotificationsRead();
	useMobileDrawerHistory(opened, onClose);
	const activate = (item: NotificationListItemData) => {
		if (item.readAt === null)
			// A per-mutate observer callback is dropped on unmount. This promise outlives navigation.
			void markRead.mutateAsync({ scope: "items", ids: item.notificationIds }).catch(() => {
				notifications.show({ color: "red", message: t("notificationMarkReadFailed") });
			});
		const target = notificationNavigateTarget(item);
		if (!target) return;
		if (target.type === "chat_room")
			void navigate({ to: "/messages", search: { room: target.roomId } });
		else void navigate({ to: "/narrators/$narratorId", params: { narratorId: target.narratorId } });
		onClose();
	};
	// First page defines the displayed feed's boundary, never the browser clock or a later page.
	const asOf = query.data?.pages[0]?.asOf;
	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size={mobile ? "100%" : 600}
			title={t("notificationCenter")}
			onKeyDown={(event) => {
				if (["Enter", "ArrowLeft", "ArrowRight"].includes(event.key)) event.stopPropagation();
			}}
		>
			<Stack gap="md" style={{ minWidth: 0 }}>
				{summaryError && (
					<Alert color="red" role="alert">
						<Text size="sm">{t("notificationCountUnknown")}</Text>
						<Button size="compact-sm" variant="light" onClick={onRetrySummary}>
							{t("notificationRetry")}
						</Button>
					</Alert>
				)}
				<Tabs
					keepMounted={false}
					value={tab}
					onChange={(value) => {
						setTab(value === "attention" ? "attention" : "activity");
						if (value === "attention") setVisitedAttention(true);
					}}
				>
					<Tabs.List grow>
						<Tabs.Tab value="attention">{t("notificationTabAttention")}</Tabs.Tab>
						<Tabs.Tab value="activity">{t("notificationTabActivity")}</Tabs.Tab>
					</Tabs.List>
					<Tabs.Panel value="attention" pt="md" keepMounted>
						<Suspense fallback={<Loader size="sm" />}>
							{opened && visitedAttention && <HumanAttentionInboxContent onClose={onClose} />}
						</Suspense>
					</Tabs.Panel>
					<Tabs.Panel value="activity" pt="md">
						<Stack gap="md">
							<Group justify="space-between" gap="xs" wrap="wrap">
								<Group
									gap={4}
									wrap="wrap"
									data-testid="notification-filter-control"
									aria-label={t("notificationFilterLabel")}
								>
									{(["all", "messages", "permissions"] as const).map((value) => (
										<Button
											key={value}
											size="compact-sm"
											variant={filter === value ? "light" : "subtle"}
											aria-pressed={filter === value}
											data-filter={value}
											onClick={() => setFilter(value)}
										>
											{t(
												value === "all"
													? "notificationFilterAll"
													: value === "messages"
														? "notificationFilterMessages"
														: "notificationFilterPermissions",
											)}
										</Button>
									))}
								</Group>
								<Button
									variant="subtle"
									size="compact-sm"
									data-testid="notification-mark-all-read"
									loading={markRead.isPending}
									disabled={asOf == null || query.isError || query.isFetching}
									onClick={() => {
										if (asOf != null)
											markRead.mutate({
												scope: "all",
												before: asOf,
												...(listQueryParams(filter).kind
													? { kind: listQueryParams(filter).kind }
													: {}),
											});
									}}
								>
									{t("notificationMarkAllRead")}
								</Button>
							</Group>
							<Text size="xs" c="dimmed">
								{t("notificationHistoryWindow")}
							</Text>
							{markRead.isError && (
								<Alert color="red" role="alert">
									{t("notificationMarkReadFailed")}
								</Alert>
							)}
							{query.isLoading && (
								<Group justify="center">
									<Loader size="sm" />
									<Text size="sm">{t("notificationLoading")}</Text>
								</Group>
							)}
							{query.isError && (
								<Alert color="red" role="alert">
									<Text size="sm">{t("notificationLoadError")}</Text>
									<Button variant="light" size="compact-sm" onClick={() => void query.refetch()}>
										{t("notificationRetry")}
									</Button>
								</Alert>
							)}
							{!query.isLoading && !query.isError && !query.items.length && !query.hasNextPage && (
								<Text size="sm" c="dimmed" ta="center" p="md" data-testid="notification-empty">
									{t(filter === "all" ? "notificationEmpty" : "notificationEmptyFiltered")}
								</Text>
							)}
							<Stack gap={4} data-testid="notification-list">
								{query.items.map((item) => (
									<NotificationListItem key={item.groupKey} item={item} onActivate={activate} />
								))}
							</Stack>
							{query.hasNextPage && (
								<Button
									variant="default"
									size="compact-sm"
									loading={query.isFetchingNextPage}
									onClick={() => void query.fetchNextPage()}
								>
									{t("notificationLoadMore")}
								</Button>
							)}
						</Stack>
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</Drawer>
	);
}
