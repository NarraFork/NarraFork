/**
 * Notification Center Phase 1 shared contract.
 *
 * Source systems remain authoritative for actionable state; this center stores an
 * event history with only `unread | read` persisted. Display status such as
 * `resolved` / `gone` is derived at list time from the source, never written back.
 */

export type NotificationKind = "chat_message" | "permission_request";
export type NotificationPersistentStatus = "unread" | "read";
/** 展示时派生，不落库 */
export type NotificationDisplayStatus = "unread" | "read" | "resolved" | "gone";

export interface NotificationLink {
	type: "chat_room" | "narrator";
	roomId?: string;
	narratorId?: string;
}

export interface NotificationListItem {
	id: string;
	kind: NotificationKind;
	projectId: string | null;
	chapterId: string | null;
	narratorId: string | null;
	title: string;
	preview: string;
	link: NotificationLink;
	sourceKey: string;
	status: NotificationPersistentStatus;
	displayStatus: NotificationDisplayStatus;
	createdAt: number;
	readAt: number | null;
	/** 权限类：源是否仍可打开；Phase 1 仅跳转时用于灰态 */
	sourceAlive?: boolean;
}

export interface NotificationListPage {
	items: NotificationListItem[];
	nextCursor: string | null;
}

export interface NotificationUnreadCounts {
	total: number; // 有界：>阈值可显示为 cap+，见实现
	chat_message: number;
	permission_request: number;
	/** true 表示因 cap 导致 total 为下界 */
	lowerBound?: boolean;
}

export const NOTIFICATION_PREVIEW_MAX_LENGTH = 120;
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 30;
export const NOTIFICATION_LIST_MAX_LIMIT = 50;
export const NOTIFICATION_UNREAD_COUNT_CAP = 99;
export const NOTIFICATION_FANOUT_MAX_RECIPIENTS = 200;
