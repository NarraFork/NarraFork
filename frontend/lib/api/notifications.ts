/**
 * Notification Center HTTP client (task package D).
 *
 * Types come from package A's `@shared/notification-center`.
 * Endpoints: list / unread-count / read / delete (spec §4.2).
 */

import type {
	NotificationKind,
	NotificationListPage,
	NotificationUnreadCounts,
} from "@shared/notification-center";
import { request } from "./client";

export type {
	NotificationDisplayStatus,
	NotificationKind,
	NotificationLink,
	NotificationListItem,
	NotificationListPage,
	NotificationPersistentStatus,
	NotificationUnreadCounts,
} from "@shared/notification-center";

export interface ListNotificationsParams {
	kind?: NotificationKind;
	status?: "unread" | "all";
	cursor?: string | null;
	limit?: number;
}

export interface MarkNotificationsReadBody {
	ids?: string[];
	before?: number;
	kind?: NotificationKind;
}

export const notificationsApi = {
	listNotifications: (params?: ListNotificationsParams) => {
		const search = new URLSearchParams();
		if (params?.kind) search.set("kind", params.kind);
		if (params?.status) search.set("status", params.status);
		if (params?.cursor) search.set("cursor", params.cursor);
		if (params?.limit != null) search.set("limit", String(params.limit));
		const query = search.toString();
		return request<NotificationListPage>(query ? `/notifications?${query}` : "/notifications");
	},

	getNotificationUnreadCounts: () =>
		request<NotificationUnreadCounts>("/notifications/unread-count"),

	markNotificationsRead: (body: MarkNotificationsReadBody) =>
		request<{ updated: number }>("/notifications/read", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	deleteNotification: (id: string) =>
		request<void>(`/notifications/${encodeURIComponent(id)}/delete`, { method: "POST" }),
};
