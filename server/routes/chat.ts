/**
 * chat.ts — `/api/chat` — human-to-human messaging.
 *
 * Mounted after `requireSessionAuth`, so every handler has `c.get("user")`.
 * Authorization for a room is never assembled here: it goes through
 * `assertCanRead` in chat-service, which the WebSocket subscribe path also uses.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CHAT_ATTACHMENT_TOTAL_BYTES_MAX } from "../lib/chat-attachments";
import { ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/prompt-i18n";
import {
	chatDirectoryQuerySchema,
	chatMessagesQuerySchema,
	createDmRoomSchema,
	markChatReadSchema,
	materializeChatAttachmentsSchema,
	postChatMessageSchema,
	summarizeChatSchema,
} from "../lib/validators";
import {
	createChatAttachment,
	discardChatAttachment,
	getChatMessageLocation,
	getUnreadSummary,
	listDirectory,
	listDmRooms,
	listMessages,
	loadChatAttachmentForRead,
	markRead,
	materializeAttachmentsForNarrator,
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

chatRoutes.get("/rooms/:roomId/messages/:messageId/location", async (c) => {
	return c.json(
		await getChatMessageLocation({
			roomId: c.req.param("roomId"),
			messageId: c.req.param("messageId"),
			userId: c.get("user").sub,
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
		text: parsed.data.text ?? "",
		replyToMessageId: parsed.data.replyToMessageId ?? null,
		attachmentIds: parsed.data.attachmentIds,
	});
	return c.json(message, 201);
});

// ─────────────────────────────────────────────────────────────────────────────
// Attachments
//
// Two-phase by necessity: the composer shows a thumbnail before the message
// exists, so the upload has to persist first and the send claims it. See the
// `chat_attachments` schema note.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upload one attachment as a draft for a room.
 *
 * `bodyLimit` is a STREAM-level defence that rejects an oversized request before the
 * whole body is buffered; the per-kind rules (image magic bytes, the text-file
 * allowlist, the size ceilings) run afterwards in `saveChatAttachment`. Both are
 * needed: the limit alone would accept a 1 KiB disguised executable, and the
 * business validation alone would first have to hold the entire payload in memory.
 */
chatRoutes.post(
	"/rooms/:roomId/attachments",
	bodyLimit({
		maxSize: CHAT_ATTACHMENT_TOTAL_BYTES_MAX,
		onError: (c) =>
			c.json(
				{
					error: `Attachment exceeds the ${(CHAT_ATTACHMENT_TOTAL_BYTES_MAX / 1024 / 1024).toFixed(
						0,
					)} MiB limit`,
					code: "CHAT_ATTACHMENT_TOO_LARGE",
				},
				413,
			),
	}),
	async (c) => {
		const formData = await c.req.formData();
		const file = formData.get("file");
		if (!(file instanceof File)) throw new ValidationError("A file is required");
		const userId = c.get("user").sub;
		const attachment = await createChatAttachment(c.req.param("roomId"), userId, file);
		return c.json(attachment, 201);
	},
);

/**
 * Serve one attachment's bytes.
 *
 * Access follows the ROOM, resolved inside `loadChatAttachmentForRead` — not the
 * public-ish `/api/uploads/:narratorId/:imageId` path, which any authenticated user
 * can hit with the right ids. `Cache-Control: private` because the response is
 * behind an ACL: `public` would let a shared proxy hand it to someone the room
 * check would have refused. `immutable` is safe because an attachment id names one
 * unchanging file.
 *
 * `Content-Disposition: attachment` for non-images: a stored file is only ever
 * downloaded, never rendered, so this stops a `.svg`/`.html` upload from executing
 * in the app's origin.
 */
chatRoutes.get("/attachments/:attachmentId", async (c) => {
	const userId = c.get("user").sub;
	const target = await loadChatAttachmentForRead(c.req.param("attachmentId"), userId);
	// Streamed by Bun rather than read into memory; the size cap was enforced at
	// upload time, so nothing here buffers the payload.
	const headers: Record<string, string> = {
		"Content-Type": target.kind === "image" ? target.mediaType : "application/octet-stream",
		"Cache-Control": "private, max-age=31536000, immutable",
		"X-Content-Type-Options": "nosniff",
	};
	if (target.kind !== "image") {
		// RFC 5987 encoding so a non-ASCII filename survives the header.
		headers["Content-Disposition"] =
			`attachment; filename*=UTF-8''${encodeURIComponent(target.filename)}`;
	}
	return new Response(Bun.file(target.filePath), { headers });
});

/** Discard a still-unclaimed draft attachment (composer removed a pending chip). */
chatRoutes.delete("/attachments/:attachmentId", async (c) => {
	const userId = c.get("user").sub;
	await discardChatAttachment(c.req.param("attachmentId"), userId);
	return c.json({ ok: true });
});

/**
 * Copy selected attachments into a narrator's worktree, ahead of a forward.
 *
 * Returns the `<attached_files>` hint the client appends to the forwarded text, so
 * the wording a model sees is identical to a natively attached file's (both come
 * from `buildAttachedFilesHint`). Requires WRITE access to the narrator — this
 * writes files into its working directory.
 */
chatRoutes.post("/rooms/:roomId/materialize-attachments", async (c) => {
	const parsed = materializeChatAttachmentsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const result = await materializeAttachmentsForNarrator({
		roomId: c.req.param("roomId"),
		userId,
		narratorId: parsed.data.narratorId,
		attachmentIds: parsed.data.attachmentIds,
	});
	return c.json({
		hint: result.hint,
		files: result.files.map((file) => ({
			filename: file.filename,
			filePath: file.filePath,
			size: file.size,
		})),
	});
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
