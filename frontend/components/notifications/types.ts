/**
 * Notification-center UI helpers (task package D).
 *
 * Types/constants re-export from package A's shared contract.
 * Only UI-local artifacts (query keys, WS frame name, filter mapping) live here.
 */

export type {
	NotificationDisplayStatus,
	NotificationKind,
	NotificationLink,
	NotificationListItem,
	NotificationListPage,
	NotificationPersistentStatus,
	NotificationUnreadCounts,
} from "@shared/notification-center";

import {
	NOTIFICATION_UNREAD_COUNT_CAP,
	type NotificationKind,
	type NotificationListItem,
} from "@shared/notification-center";

export {
	NOTIFICATION_LIST_DEFAULT_LIMIT,
	NOTIFICATION_LIST_MAX_LIMIT,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	NOTIFICATION_UNREAD_COUNT_CAP,
} from "@shared/notification-center";

/**
 * WS frame type name for the data-free invalidation (spec §6.1).
 *
 * Kept on the frontend only — package A's shared module intentionally has no
 * transport constant. Server-side string lives in `server/websocket/narrator-ws-types.ts`.
 * Both sides must stay `notification_center_changed`.
 */
export const NOTIFICATION_CENTER_CHANGED_WS_TYPE = "notification_center_changed";

/** Drawer SegmentedControl keys (Phase 1, locked by spec §6.2). */
export type NotificationCenterFilter = "all" | "actionable" | "messages" | "permissions";

export type NotificationNavigateTarget =
	| { type: "chat_room"; roomId: string }
	| { type: "narrator"; narratorId: string };

export const notificationQueryKeys = {
	root: ["notifications"] as const,
	list: (params: { kind?: string; status: string }) => ["notifications", "list", params] as const,
	unreadCount: () => ["notifications", "unread-count"] as const,
};

/** Map drawer filter → list API query params (spec §4.2 / §6.2). */
export function listQueryParams(filter: NotificationCenterFilter): {
	kind?: NotificationKind;
	status: "unread" | "all";
} {
	switch (filter) {
		case "actionable":
		case "permissions":
			return { kind: "permission_request", status: "all" };
		case "messages":
			return { kind: "chat_message", status: "all" };
		default:
			return { status: "all" };
	}
}

/**
 * 「待处理」按源系统派生态过滤：权限请求且源仍可能可打开。
 * 标已读 ≠ 已处理，因此不过滤 `status=read`。
 */
export function filterItemsForDisplay(
	filter: NotificationCenterFilter,
	items: readonly NotificationListItem[],
): NotificationListItem[] {
	if (filter !== "actionable") return items.slice();
	return items.filter(
		(item) =>
			item.kind === "permission_request" &&
			item.displayStatus !== "gone" &&
			item.displayStatus !== "resolved" &&
			item.sourceAlive !== false,
	);
}

/**
 * Only true `gone` (source deleted / no ACL) is inert.
 * `resolved` keeps a live narrator/chat target so the row can mark-read and open
 * the session that finished the request (review M1 / spec §6.2.3).
 */
export function notificationNavigateTarget(
	item: Pick<NotificationListItem, "link" | "displayStatus" | "sourceAlive">,
): NotificationNavigateTarget | null {
	if (item.displayStatus === "gone") return null;
	if (item.displayStatus !== "resolved" && item.sourceAlive === false) return null;
	const { link } = item;
	if (link.type === "chat_room" && link.roomId) {
		return { type: "chat_room", roomId: link.roomId };
	}
	if (link.type === "narrator" && link.narratorId) {
		return { type: "narrator", narratorId: link.narratorId };
	}
	return null;
}

/** Badge text: null when zero; `99+` when capped/lower-bound. */
export function formatUnreadBadge(
	total: number | undefined | null,
	lowerBound?: boolean,
	cap: number = NOTIFICATION_UNREAD_COUNT_CAP,
): string | null {
	if (total == null || total <= 0) return null;
	if (lowerBound || total > cap) return `${cap}+`;
	return String(total);
}
