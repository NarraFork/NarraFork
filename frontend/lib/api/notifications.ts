import type {
	MarkNotificationsReadBody,
	NotificationKind,
	NotificationListPage,
	NotificationUnreadCounts,
} from "@shared/notification-center";
import { request } from "./client";

export type {
	MarkNotificationsReadBody,
	NotificationKind,
	NotificationLink,
	NotificationListItem,
	NotificationListPage,
	NotificationPersistentStatus,
	NotificationSourceState,
	NotificationUnreadCounts,
} from "@shared/notification-center";

export interface ListNotificationsParams {
	kind?: NotificationKind;
	status?: "unread" | "all";
	cursor?: string | null;
	limit?: number;
}

export const notificationsApi = {
	listNotifications: (params?: ListNotificationsParams, signal?: AbortSignal) => {
		const search = new URLSearchParams();
		if (params?.kind) search.set("kind", params.kind);
		if (params?.status) search.set("status", params.status);
		if (params?.cursor) search.set("cursor", params.cursor);
		if (params?.limit != null) search.set("limit", String(params.limit));
		const query = search.toString();
		return request<NotificationListPage>(query ? `/notifications?${query}` : "/notifications", {
			signal,
		});
	},
	getNotificationUnreadCounts: (signal?: AbortSignal) =>
		request<NotificationUnreadCounts>("/notifications/unread-count", { signal }),
	markNotificationsRead: (body: MarkNotificationsReadBody) =>
		request<{ updated: number }>("/notifications/read", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	deleteNotification: (id: string) =>
		request<void>(`/notifications/${encodeURIComponent(id)}/delete`, { method: "POST" }),
};
