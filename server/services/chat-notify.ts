/**
 * chat-notify.ts — `chat:*` event-bus events → WebSocket fan-out.
 *
 * Same shape as `knowledge-notify.ts`: the service that writes emits an
 * id-and-scalars event, and this module decides who hears about it. Keeping the
 * routing here means `chat-service` never imports the WebSocket layer, so it stays
 * testable without a live server.
 *
 * Two deliveries per message, deliberately different:
 *
 *   1. **Room subscribers** get the full row (`chat:message`). They authorized the
 *      room at subscribe time and are looking at it right now, so a refetch round
 *      trip per message would turn a live conversation into polling.
 *   2. **Members who are NOT viewing** get an id + count (`chat:unread_changed`)
 *      via `broadcastToUser`, which is all a navigation badge needs. Sending the
 *      body to someone with the room closed would be content they never asked for.
 *
 * Failures are logged and dropped: a missing badge must never fail the write that
 * already committed.
 */

import { db } from "@server/db";
import { chatMessages } from "@server/db/schema";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { eq } from "drizzle-orm";
import type { NarratorServerMessage } from "../websocket/narrator-ws-types";
import { hydrateMessageForBroadcast, listRoomUnreadForFanout } from "./chat-service";

/** Injectable so tests can assert routing without a live WebSocket server. */
interface ChatNotifyChannel {
	broadcastToChatRoom: (roomId: string, message: NarratorServerMessage) => void;
	broadcastToUser: (userId: string, message: NarratorServerMessage) => void;
	getChatRoomSubscriberUserIds: (roomId: string) => Set<string>;
}

let channel: ChatNotifyChannel | null = null;

/** Override the delivery channel (tests only). Pass null to restore the default. */
export function setChatNotifyChannel(next: ChatNotifyChannel | null): void {
	channel = next;
}

async function resolveChannel(): Promise<ChatNotifyChannel> {
	if (channel) return channel;
	// Imported lazily: narrator-ws pulls in the whole WS/session graph, while this
	// module is also loaded by tests that only care about the routing decisions.
	const ws = await import("../websocket/narrator-ws");
	return {
		broadcastToChatRoom: ws.broadcastToChatRoom,
		broadcastToUser: ws.broadcastToUser,
		getChatRoomSubscriberUserIds: ws.getChatRoomSubscriberUserIds,
	};
}

/**
 * Seam for the unread lookup. Exists so a test can COUNT the queries: the property that
 * matters here is not just the number a badge carries but how much work producing it
 * costs, and that is invisible from the delivered message alone.
 */
interface ChatNotifyDeps {
	listRoomUnread: typeof listRoomUnreadForFanout;
}

async function onMessageCreated(
	event: {
		roomId: string;
		messageId: string;
		seq: number;
		senderUserId: string;
	},
	deps: ChatNotifyDeps = { listRoomUnread: listRoomUnreadForFanout },
): Promise<void> {
	const row = await db.query.chatMessages.findFirst({
		where: eq(chatMessages.id, event.messageId),
	});
	if (!row) return;

	// Assembled by chat-service rather than field-by-field here. The frame and the
	// REST page must carry the same shape, and hand-rolling it in two places is how
	// a newly added field ends up present on one path and missing on the other —
	// which shows up only as "it works after a refresh".
	const message = await hydrateMessageForBroadcast(row);

	const target = await resolveChannel();

	target.broadcastToChatRoom(event.roomId, {
		type: "chat:message",
		roomId: event.roomId,
		message,
	});

	// Badge refresh for members who do not have the room open. The sender and anyone
	// currently viewing are excluded before the lookup, not after: they either wrote the
	// message or already received it live, so counting for them is work with no reader.
	//
	// Two bounded queries for the whole fan-out (a capped member slice and one batched
	// count), scoped to THIS room. Two earlier shapes are ruled out here: calling
	// `getUnreadSummary` per recipient walked every room they belong to and threw all but
	// one number away, and probing each recipient separately put one statement per member
	// on the path that runs for every posted message. Both scale with a narrator room's
	// popularity, which is what CLAUDE.md's SQLite discipline excludes from a write path.
	const viewing = target.getChatRoomSubscriberUserIds(event.roomId);
	const exclude = new Set(viewing);
	exclude.add(event.senderUserId);
	for (const { userId, unread } of await deps.listRoomUnread(event.roomId, exclude)) {
		target.broadcastToUser(userId, {
			type: "chat:unread_changed",
			roomId: event.roomId,
			unread,
		});
	}
}

async function onRoomRead(event: {
	roomId: string;
	userId: string;
	lastReadSeq: number;
}): Promise<void> {
	const target = await resolveChannel();
	target.broadcastToChatRoom(event.roomId, {
		type: "chat:read",
		roomId: event.roomId,
		userId: event.userId,
		lastReadSeq: event.lastReadSeq,
	});
	// The reader's own badge just changed, and they may be reading in another tab
	// that does not have this room subscribed.
	target.broadcastToUser(event.userId, {
		type: "chat:unread_changed",
		roomId: event.roomId,
		unread: 0,
	});
}

function guard(label: string, run: () => Promise<void>): void {
	run().catch((err) => {
		logger.error("Chat notify handler failed", {
			handler: label,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

let registered = false;

/** Register the chat notification listeners. Idempotent. */
export function initChatNotify(): void {
	if (registered) return;
	registered = true;

	eventBus.on("chat:message_created", (event) => {
		guard("chat:message_created", () => onMessageCreated(event));
	});
	eventBus.on("chat:room_read", (event) => {
		guard("chat:room_read", () => onRoomRead(event));
	});
}

/**
 * The handlers, for tests only.
 *
 * Invoked directly rather than through `eventBus.emit` because emit is
 * fire-and-forget (`guard` swallows the promise): a test that emitted would have
 * to race the handler instead of awaiting it.
 */
export const chatNotifyTesting = { onMessageCreated, onRoomRead };
