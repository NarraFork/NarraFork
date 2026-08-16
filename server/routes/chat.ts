/**
 * chat.ts — `/api/chat` — human-to-human messaging.
 *
 * Mounted after `requireSessionAuth`, so every handler has `c.get("user")`.
 * Authorization for a room is never assembled here: it goes through
 * `assertCanRead` in chat-service, which the WebSocket subscribe path also uses.
 */

import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/prompt-i18n";
import {
	chatDirectoryQuerySchema,
	chatMessagesQuerySchema,
	createDmRoomSchema,
	markChatReadSchema,
	postChatMessageSchema,
	summarizeChatSchema,
} from "../lib/validators";
import {
	getUnreadSummary,
	listDirectory,
	listDmRooms,
	listMessages,
	markRead,
	postMessage,
	resolveDmRoom,
	resolveNarratorRoom,
	softDeleteMessage,
	summarizeMessages,
} from "../services/chat-service";

export const chatRoutes = new Hono();

/**
 * User directory for the DM picker.
 *
 * ⚠️ Readable by NON-ADMIN accounts, which is a deliberate widening: picking
 * someone to message is impossible otherwise. The payload is held to id +
 * username + avatar (see `listDirectory`).
 */
chatRoutes.get("/directory", async (c) => {
	const parsed = chatDirectoryQuerySchema.safeParse({ q: c.req.query("q") });
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	return c.json(await listDirectory(userId, parsed.data.q));
});

chatRoutes.get("/rooms", async (c) => {
	const userId = c.get("user").sub;
	return c.json(await listDmRooms(userId));
});

chatRoutes.get("/unread", async (c) => {
	const userId = c.get("user").sub;
	return c.json(await getUnreadSummary(userId));
});

chatRoutes.post("/rooms/dm", async (c) => {
	const parsed = createDmRoomSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	return c.json(await resolveDmRoom(userId, parsed.data.userId));
});

chatRoutes.get("/rooms/narrator/:narratorId", async (c) => {
	const userId = c.get("user").sub;
	return c.json(await resolveNarratorRoom(c.req.param("narratorId"), userId));
});

chatRoutes.get("/rooms/:roomId/messages", async (c) => {
	const parsed = chatMessagesQuerySchema.safeParse({
		beforeSeq: c.req.query("beforeSeq"),
		limit: c.req.query("limit"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	return c.json(
		await listMessages({
			roomId: c.req.param("roomId"),
			userId,
			beforeSeq: parsed.data.beforeSeq,
			limit: parsed.data.limit,
		}),
	);
});

chatRoutes.post("/rooms/:roomId/messages", async (c) => {
	const parsed = postChatMessageSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const message = await postMessage({
		roomId: c.req.param("roomId"),
		senderUserId: userId,
		text: parsed.data.text,
		replyToMessageId: parsed.data.replyToMessageId ?? null,
	});
	return c.json(message, 201);
});

chatRoutes.post("/rooms/:roomId/read", async (c) => {
	const parsed = markChatReadSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const lastReadSeq = await markRead(c.req.param("roomId"), userId, parsed.data.seq);
	return c.json({ lastReadSeq });
});

chatRoutes.delete("/rooms/:roomId/messages/:messageId", async (c) => {
	const user = c.get("user");
	const roomId = c.req.param("roomId");
	const messageId = c.req.param("messageId");
	await softDeleteMessage(roomId, messageId, user.sub, user.role === "admin");
	// Deletion is rare and carries no body, so it is pushed straight rather than
	// going through the event bus (which exists for the message fan-out's routing).
	const { broadcastToChatRoom } = await import("../websocket/narrator-ws");
	broadcastToChatRoom(roomId, { type: "chat:message_deleted", roomId, messageId });
	return c.json({ ok: true });
});

/**
 * Summarize a selection with the summary model.
 *
 * Rate limited per user inside `summarizeMessages` rather than by middleware
 * here: this is the only chat path that spends model quota, and the limit has to
 * hold for any future caller, not just this handler. It surfaces as a 429 with
 * `Retry-After` through the global `RateLimitError` branch.
 */
chatRoutes.post("/rooms/:roomId/summarize", async (c) => {
	const parsed = summarizeChatSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	return c.json(
		await summarizeMessages({
			roomId: c.req.param("roomId"),
			userId,
			messageIds: parsed.data.messageIds,
			locale,
		}),
	);
});
