import { z } from "zod";

/**
 * Chat input schemas.
 *
 * The body cap is duplicated from `CHAT_MESSAGE_MAX_CHARS` on purpose rather than
 * imported: validators must stay free of service imports (they are loaded by the
 * route layer before services initialize), and a request that exceeds the cap has
 * to be rejected at parse time, before anything reaches the write path.
 */
const CHAT_MESSAGE_MAX_CHARS = 8_000;

export const chatDirectoryQuerySchema = z.object({
	q: z.string().max(120).optional(),
});

export const createDmRoomSchema = z.object({
	userId: z.string().min(1).max(64),
});

export const chatMessagesQuerySchema = z.object({
	/** Exclusive upper bound cursor; omit for the newest page. */
	beforeSeq: z.coerce.number().int().positive().optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const postChatMessageSchema = z.object({
	text: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
	replyToMessageId: z.string().min(1).max(64).nullable().optional(),
});

/**
 * `seq` is only bounded from below here. An upper bound belongs in the service,
 * not the schema: whether a number is "in the future" depends on the room's
 * current `next_seq`, which validation has no access to. `markRead` clamps it —
 * without that, a single oversized value would pin the watermark above every seq
 * the room will ever reach and monotonicity makes the damage permanent.
 */
export const markChatReadSchema = z.object({
	seq: z.number().int().min(0),
});

export const summarizeChatSchema = z.object({
	messageIds: z.array(z.string().min(1).max(64)).min(1).max(200),
});
