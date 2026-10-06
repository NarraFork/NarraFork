import type { NotificationKind, NotificationListItem } from "@shared/notification-center";

export type {
	NotificationKind,
	NotificationLink,
	NotificationListItem,
	NotificationListPage,
	NotificationSourceState,
	NotificationUnreadCounts,
} from "@shared/notification-center";
export { NOTIFICATION_CENTER_CHANGED_WS_TYPE } from "@shared/notification-center";

export type NotificationCenterFilter = "all" | "messages" | "permissions";
export type NotificationCenterTab = "attention" | "activity";
export type NotificationNavigateTarget =
	| { type: "chat_room"; roomId: string }
	| { type: "narrator"; narratorId: string };

export const notificationQueryKeys = {
	root: ["notifications"] as const,
	list: (params: { kind?: NotificationKind; status: string }) =>
		["notifications", "list", params] as const,
	unreadCount: () => ["notifications", "unread-count"] as const,
};

export function listQueryParams(filter: NotificationCenterFilter): {
	kind?: NotificationKind;
	status: "all";
} {
	if (filter === "messages") return { kind: "chat_message", status: "all" };
	if (filter === "permissions") return { kind: "permission_request", status: "all" };
	return { status: "all" };
}

export function notificationNavigateTarget(
	item: Pick<NotificationListItem, "link" | "sourceState">,
): NotificationNavigateTarget | null {
	if (item.sourceState === "gone" || item.link.type === "unavailable") return null;
	return item.link;
}

/** Show the actual loaded lower bound, including an empty candidate page with a cursor. */
export function formatUnreadBadge(
	total: number | undefined | null,
	lowerBound = false,
): string | null {
	if (total == null || (total <= 0 && !lowerBound)) return null;
	return `${total}${lowerBound ? "+" : ""}`;
}
