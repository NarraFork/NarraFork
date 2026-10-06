/**
 * Source events → bounded activity projections. This consumer is independent of
 * WebSocket delivery: a missing socket must not prevent durable history.
 * Failures are logged without rolling back the source write. Human Attention
 * remains authoritative for decisions even if an activity projection is lost.
 */

import { db } from "@server/db";
import {
	chapters,
	chatMessages,
	chatRoomMembers,
	chatRooms,
	narrators,
	narratorToolCalls,
	users,
} from "@server/db/schema";
import { eventBus } from "@server/lib/event-bus";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	NOTIFICATION_FANOUT_MAX_RECIPIENTS,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	type NotificationKind,
	type NotificationLink,
} from "@shared/notification-center";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { CHAT_MEMBER_FANOUT_LIMIT } from "./chat-service";
import { canReadNarrator, listNarratorAudience, type NarratorAclRow } from "./narrator-acl";
import {
	type RecordNotificationInput,
	recordNotifications as recordNotificationsImpl,
	syncChatNotificationReads,
} from "./notification-center-service";
import { getRecentTabUserIdsForNarrator } from "./recent-tabs-service";

export type { NotificationKind, NotificationLink, RecordNotificationInput };
export { NOTIFICATION_FANOUT_MAX_RECIPIENTS, NOTIFICATION_PREVIEW_MAX_LENGTH };

export type RecordNotificationsFn = (inputs: RecordNotificationInput[]) => Promise<void>;

let recordImpl: RecordNotificationsFn | null = null;

/** Tests only. Pass null to restore production resolution via B's service. */
export function setRecordNotifications(next: RecordNotificationsFn | null): void {
	recordImpl = next;
}

async function resolveRecordNotifications(): Promise<RecordNotificationsFn> {
	if (recordImpl) return recordImpl;
	return recordNotificationsImpl;
}

// ─── Shared helpers ───

function clampPreview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const max = NOTIFICATION_PREVIEW_MAX_LENGTH;
	if (flat.length <= max) return flat;
	// Produce a string that is already ≤ max, including the ellipsis, so B's
	// re-clamp cannot strip the visible truncation marker (review m1).
	if (max <= 1) return "…";
	return `${flat.slice(0, max - 1)}…`;
}

const pendingFanouts = new Set<Promise<void>>();
const MAX_PENDING_FANOUTS = 256;

function guard(label: string, run: () => Promise<void>): void {
	if (pendingFanouts.size >= MAX_PENDING_FANOUTS) {
		logger.warn("Notification projection backlog full", { handler: label });
		return;
	}
	const work = run().catch((err) => {
		logger.error("Notification fan-out failed", {
			handler: label,
			error: err instanceof Error ? err.message : String(err),
		});
	});
	pendingFanouts.add(work);
	void work.finally(() => pendingFanouts.delete(work));
}

// ─── Chat DM fan-out ───

export interface ChatMessageFanoutEvent {
	roomId: string;
	messageId: string;
	seq: number;
	senderUserId: string | null;
	roomKind?: "dm" | "narrator";
	narratorId?: string | null;
}

/**
 * Project a newly posted DM into notification-center rows for eligible members.
 *
 * Eligibility (spec §5): member, not the sender, not muted, unread
 * (`seq > lastReadSeq`), and still able to read the room (DM membership is the
 * ACL). Soft-deleted bodies are skipped entirely — an empty-body "notification"
 * is noise. Narrator discussion rooms are out of the Phase-1 DM table.
 *
 * Unlike WS badges, viewers are NOT excluded: the notification center is an
 * event history, not a live badge.
 */
export async function fanoutChatMessageNotifications(event: ChatMessageFanoutEvent): Promise<void> {
	const record = await resolveRecordNotifications();
	const [message] = await db
		.select({
			id: chatMessages.id,
			roomId: chatMessages.roomId,
			seq: chatMessages.seq,
			senderUserId: chatMessages.senderUserId,
			senderGuestName: chatMessages.senderGuestName,
			deletedAt: chatMessages.deletedAt,
			contentText: sql<string>`substr(${chatMessages.contentText}, 1, ${NOTIFICATION_PREVIEW_MAX_LENGTH * 4})`,
		})
		.from(chatMessages)
		.where(eq(chatMessages.id, event.messageId))
		.limit(1);
	if (!message || message.deletedAt || message.roomId !== event.roomId) return;

	const room = await db.query.chatRooms.findFirst({
		where: eq(chatRooms.id, event.roomId),
		columns: { id: true, kind: true },
	});
	if (!room || room.kind !== "dm") return;
	if (event.roomKind && event.roomKind !== "dm") return;

	const members = await db
		.select({
			userId: chatRoomMembers.userId,
			lastReadSeq: chatRoomMembers.lastReadSeq,
			muted: chatRoomMembers.muted,
		})
		.from(chatRoomMembers)
		.where(eq(chatRoomMembers.roomId, event.roomId))
		.orderBy(asc(chatRoomMembers.lastReadSeq))
		.limit(CHAT_MEMBER_FANOUT_LIMIT);

	const senderId = message.senderUserId ?? event.senderUserId;
	const recipients = members.filter((member) => {
		if (member.muted) return false;
		if (senderId !== null && member.userId === senderId) return false;
		if (message.seq <= member.lastReadSeq) return false;
		return true;
	});
	if (recipients.length === 0) return;

	if (members.length >= CHAT_MEMBER_FANOUT_LIMIT) {
		logger.warn("Chat notification fan-out truncated by member cap", {
			roomId: event.roomId,
			memberCap: CHAT_MEMBER_FANOUT_LIMIT,
		});
	}

	let title = "";
	if (senderId) {
		const sender = await db.query.users.findFirst({
			where: eq(users.id, senderId),
			columns: { username: true },
		});
		if (sender?.username) title = sender.username;
	} else if (message.senderGuestName) {
		title = message.senderGuestName;
	}

	const preview = clampPreview(message.contentText);
	const capped = recipients.slice(0, NOTIFICATION_FANOUT_MAX_RECIPIENTS);
	if (recipients.length > NOTIFICATION_FANOUT_MAX_RECIPIENTS) {
		logger.warn("Chat notification fan-out truncated by recipient cap", {
			roomId: event.roomId,
			candidates: recipients.length,
			cap: NOTIFICATION_FANOUT_MAX_RECIPIENTS,
		});
	}

	const inputs: RecordNotificationInput[] = capped.map((member) => ({
		userId: member.userId,
		kind: "chat_message" as const,
		sourceKey: message.id,
		title,
		preview,
		link: { type: "chat_room" as const, roomId: event.roomId },
		narratorId: null,
	}));

	try {
		await record(inputs);
	} catch (err) {
		logger.error("Chat notification record failed", {
			roomId: event.roomId,
			messageId: event.messageId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ─── Permission offer fan-out ───

export interface PermissionFanoutEvent {
	narratorId: string;
	/** narrator_tool_calls.id — the notification sourceKey. */
	requestId: string;
}

/** Short, non-secret hint for the permission preview. Never dumps tool input. */
function buildPermissionPreview(toolName: string, hint: string | null | undefined): string {
	if (!hint) return toolName;
	const short = hint.length > 60 ? `…${hint.slice(-57)}` : hint;
	return clampPreview(`${toolName}: ${short}`);
}

/**
 * Candidate recipients for a permission offer: people who can still read the
 * narrator.
 *
 * Bounded deliberately: recent-tab viewers are the "someone is watching this
 * session" set used by IM, unioned with owner + explicit grantees so a private
 * session still notifies its owner even before any tab is opened. `everyone`
 * visibility does NOT expand to all users — that would be unbounded; recent
 * tabs stand in for the interested audience and the cap applies.
 */
async function resolvePermissionRecipients(row: NarratorAclRow): Promise<string[]> {
	const candidates = new Set<string>();
	if (row.ownerUserId) candidates.add(row.ownerUserId);

	const audience = await listNarratorAudience(row, NOTIFICATION_FANOUT_MAX_RECIPIENTS);
	if (!audience.everyone) {
		for (const id of audience.userIds) candidates.add(id);
	}

	// Union recent tabs: a grantee/tab-holder is still a legitimate recipient.
	// The set is usage-bounded; the explicit cap below is the hard stop.
	const tabs = await getRecentTabUserIdsForNarrator(row.id, NOTIFICATION_FANOUT_MAX_RECIPIENTS);
	for (const id of tabs) candidates.add(id);

	if (candidates.size === 0) return [];

	// Bound the candidate lookup itself, not merely the eventual allowed rows.
	const ids = [...candidates].slice(0, NOTIFICATION_FANOUT_MAX_RECIPIENTS);
	const adminIds = new Set(
		(
			await db
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.role, "admin"), inArray(users.id, ids)))
		).map((u) => u.id),
	);

	const allowed: string[] = [];
	for (const userId of ids) {
		if (adminIds.has(userId)) {
			allowed.push(userId);
		} else if (await canReadNarrator(row, { userId, isAdmin: false })) {
			allowed.push(userId);
		}
		if (allowed.length >= NOTIFICATION_FANOUT_MAX_RECIPIENTS) break;
	}
	return allowed;
}

/**
 * Project a new pending permission offer into notification-center rows.
 *
 * Hooked on `narrator:permission_request` (ids only). Re-subscribe/re-offer may
 * re-enter this path with the same toolCallId; unique `(userId, kind,
 * sourceKey)` makes the second insert a no-op. Decided tool calls are skipped
 * so a late event cannot resurrect history.
 */
export async function fanoutPermissionRequestNotifications(
	event: PermissionFanoutEvent,
): Promise<void> {
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, event.requestId),
		columns: {
			id: true,
			narratorId: true,
			status: true,
			permissionDecidedAt: true,
			toolName: true,
			canonicalFilePath: true,
			resolvedFilePath: true,
		},
	});
	if (!toolCall || toolCall.narratorId !== event.narratorId) return;
	if (toolCall.permissionDecidedAt) return;
	// Only live offers — not success/fail historical rows replayed through events.
	if (toolCall.status !== "pending" && toolCall.status !== "initializing") return;

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, event.narratorId),
		columns: {
			id: true,
			title: true,
			ownerUserId: true,
			visibility: true,
			writeAudience: true,
			type: true,
			aclRootNarratorId: true,
			chapterId: true,
			contextProjectId: true,
		},
	});
	if (!narrator) return;

	const aclRow: NarratorAclRow = {
		id: narrator.id,
		ownerUserId: narrator.ownerUserId,
		visibility: narrator.visibility,
		writeAudience: narrator.writeAudience,
		type: narrator.type,
		aclRootNarratorId: narrator.aclRootNarratorId,
		chapterId: narrator.chapterId,
		contextProjectId: narrator.contextProjectId,
	};

	const recipients = await resolvePermissionRecipients(aclRow);
	if (recipients.length === 0) return;

	const chapterId: string | null = narrator.chapterId ?? null;
	let projectId: string | null = narrator.contextProjectId ?? null;
	if (chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, chapterId),
			columns: { projectId: true },
		});
		projectId = chapter?.projectId ?? null;
	}

	// Short summary: prefer a path column; never inputJson/outputJson.
	const pathHint = toolCall.canonicalFilePath || toolCall.resolvedFilePath || null;
	const title = narrator.title || "";
	const preview = buildPermissionPreview(toolCall.toolName, pathHint);

	const record = await resolveRecordNotifications();
	const inputs: RecordNotificationInput[] = recipients.map((userId) => ({
		userId,
		kind: "permission_request" as const,
		sourceKey: toolCall.id,
		title,
		preview,
		link: { type: "narrator" as const, narratorId: event.narratorId },
		projectId,
		chapterId,
		narratorId: event.narratorId,
	}));

	try {
		await record(inputs);
	} catch (err) {
		logger.error("Permission notification record failed", {
			narratorId: event.narratorId,
			toolCallId: event.requestId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ─── Source subscriptions ───

const subscriptions = hotSafe("narrafork.notificationFanout.subscriptions", () => ({
	dispose: null as (() => void) | null,
}));

/** Replace old closures on hot reload instead of installing duplicate listeners. */
export function initNotificationFanout(): void {
	void stopNotificationFanout();
	const created = (event: ChatMessageFanoutEvent) => {
		guard("chat:message_created", () => fanoutChatMessageNotifications(event));
	};
	const permission = (event: PermissionFanoutEvent) => {
		guard("narrator:permission_request", () => fanoutPermissionRequestNotifications(event));
	};
	const read = (event: { roomId: string; userId: string; lastReadSeq: number }) => {
		guard("chat:room_read", async () => {
			await syncChatNotificationReads(event.roomId, event.userId, event.lastReadSeq);
			// Source-derived unread can change even if no stored row needed an update.
			eventBus.emit({
				type: "notification_center_changed",
				userId: event.userId,
				kinds: ["chat_message"],
			});
		});
	};
	const deleted = (event: { roomId: string }) => {
		guard("chat:message_deleted", async () => {
			const members = await db
				.select({ userId: chatRoomMembers.userId })
				.from(chatRoomMembers)
				.where(eq(chatRoomMembers.roomId, event.roomId))
				.limit(NOTIFICATION_FANOUT_MAX_RECIPIENTS);
			for (const member of members) {
				eventBus.emit({
					type: "notification_center_changed",
					userId: member.userId,
					kinds: ["chat_message"],
				});
			}
		});
	};
	eventBus.on("chat:message_created", created);
	eventBus.on("chat:room_read", read);
	eventBus.on("chat:message_deleted", deleted);
	eventBus.on("narrator:permission_request", permission);
	subscriptions.dispose = () => {
		eventBus.off("chat:message_created", created);
		eventBus.off("chat:room_read", read);
		eventBus.off("chat:message_deleted", deleted);
		eventBus.off("narrator:permission_request", permission);
	};
}

export async function stopNotificationFanout(): Promise<void> {
	subscriptions.dispose?.();
	subscriptions.dispose = null;
	await Promise.all([...pendingFanouts]);
}

/** Await real asynchronous event consumers in integration tests. */
export const notificationFanoutTesting = {
	fanoutChatMessageNotifications,
	fanoutPermissionRequestNotifications,
	drain: () => Promise.all([...pendingFanouts]),
};
