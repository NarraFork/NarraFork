import { HUMAN_ATTENTION_CHANGED_WS_TYPE } from "@shared/human-attention";
import {
	type MarkNotificationsReadBody,
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	type NotificationListItem,
	type NotificationListPage,
} from "@shared/notification-center";
import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { listQueryParams, type NotificationCenterFilter, notificationQueryKeys } from "./types";

export { NOTIFICATION_CENTER_CHANGED_WS_TYPE } from "@shared/notification-center";

/** Prefer the newest page's version when live pagination shifts a group across page boundaries. */
export function flattenNotificationPages(
	pages: NotificationListPage[] | undefined,
): NotificationListItem[] {
	const groups = new Map<string, NotificationListItem>();
	for (const page of pages ?? []) {
		for (const item of page.items) if (!groups.has(item.groupKey)) groups.set(item.groupKey, item);
	}
	return [...groups.values()];
}

export function markNotificationCenterStale(client: QueryClient): void {
	void client.invalidateQueries({ queryKey: notificationQueryKeys.root });
}

const changeTypes = [
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	HUMAN_ATTENTION_CHANGED_WS_TYPE,
	"narrator_access_changed",
	"project_access_changed",
	"narrator_deleted",
	"narrators_deleted",
	"chapter_deleted",
	"project_deleted",
	"chat:message",
	"chat:message_deleted",
	"chat:read",
	"chat:unread_changed",
];

export function useNotificationCenterLive(enabled = true): void {
	const client = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		let queued = false;
		let disposed = false;
		const flush = () => {
			if (queued || disposed) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (!disposed) markNotificationCenterStale(client);
			});
		};
		const listener = narratorWSManager.addListener({ types: changeTypes }, flush);
		const offConnection = narratorWSManager.onConnectionChange((connected) => {
			if (connected) flush();
		});
		return () => {
			disposed = true;
			offConnection();
			narratorWSManager.removeListener(listener);
		};
	}, [enabled, client]);
}

export function useNotificationUnreadCounts(enabled = true) {
	useNotificationCenterLive(enabled);
	return useQuery({
		queryKey: notificationQueryKeys.unreadCount(),
		queryFn: ({ signal }) => api.getNotificationUnreadCounts(signal),
		enabled,
		staleTime: 30_000,
		retry: false,
		refetchOnWindowFocus: false,
	});
}

export function useNotificationList(filter: NotificationCenterFilter, enabled = true) {
	const params = listQueryParams(filter);
	const query = useInfiniteQuery({
		queryKey: notificationQueryKeys.list(params),
		queryFn: ({ pageParam, signal }) =>
			api.listNotifications({ ...params, cursor: pageParam, limit: 30 }, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (last: NotificationListPage) => last.nextCursor ?? undefined,
		enabled,
		staleTime: 10_000,
		retry: false,
		refetchOnWindowFocus: false,
	});
	return { ...query, items: flattenNotificationPages(query.data?.pages) };
}

/** Counts are source-derived conversation counts; never subtract notification IDs optimistically. */
export function useMarkNotificationsRead() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: MarkNotificationsReadBody) => api.markNotificationsRead(body),
		onSuccess: () => markNotificationCenterStale(client),
	});
}

export function useDeleteNotification() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteNotification(id),
		onSuccess: () => markNotificationCenterStale(client),
	});
}

export function notificationFilterFromValue(value: string): NotificationCenterFilter {
	return value === "messages" || value === "permissions" ? value : "all";
}
