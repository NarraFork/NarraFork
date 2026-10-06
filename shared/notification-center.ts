/** Activity history is not the authority for human decisions. See shared/human-attention.ts. */
export type NotificationKind = "chat_message" | "permission_request";
/** Kept in storage for compatibility; clients use readAt instead. */
export type NotificationPersistentStatus = "unread" | "read";
export type NotificationSourceState = "active" | "resolved" | "gone";

export type NotificationLink =
	| { type: "chat_room"; roomId: string }
	| { type: "narrator"; narratorId: string }
	| { type: "unavailable" };

export interface NotificationListItem {
	/** Representative notification id; never a source id. */
	id: string;
	/** Stable grouping key; unavailable sources use only notification identity. */
	groupKey: string;
	/** Bounded ids captured in this row. New arrivals are never implicitly acknowledged. */
	notificationIds: string[];
	kind: NotificationKind;
	projectId: string | null;
	chapterId: string | null;
	narratorId: string | null;
	projectTitle: string | null;
	chapterTitle: string | null;
	title: string;
	preview: string;
	link: NotificationLink;
	sourceKey: string | null;
	sourceState: NotificationSourceState;
	createdAt: number;
	/** null means at least one visible member of the group has not been read. */
	readAt: number | null;
	groupSize: number;
}

export interface NotificationListPage {
	items: NotificationListItem[];
	nextCursor: string | null;
	/** Server time used to bound mark-all; the activity feed is not a database snapshot. */
	asOf: number;
}

export interface NotificationUnreadCounts {
	/** Unread DM conversations, not messages and not pending decisions. */
	unreadConversations: number;
	/** Unread grouped activities in the retained history, including permission history. */
	unreadActivities: number;
	/** Each bound belongs to its own counter; permission history must not cap the DM badge. */
	conversationsLowerBound: boolean;
	activitiesLowerBound: boolean;
}

export type MarkNotificationsReadBody =
	| { scope: "items"; ids: string[] }
	| { scope: "all"; before: number; kind?: NotificationKind };

export const NOTIFICATION_CENTER_CHANGED_WS_TYPE = "notification_center_changed";
export const NOTIFICATION_PREVIEW_MAX_LENGTH = 120;
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 30;
export const NOTIFICATION_LIST_MAX_LIMIT = 50;
export const NOTIFICATION_UNREAD_COUNT_CAP = 99;
export const NOTIFICATION_FANOUT_MAX_RECIPIENTS = 200;
/** Every feed operation works on this bounded event window, even before cleanup catches up. */
export const NOTIFICATION_RETENTION_MAX_ROWS = 500;
export const NOTIFICATION_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_MARK_READ_IDS_MAX = NOTIFICATION_RETENTION_MAX_ROWS;
