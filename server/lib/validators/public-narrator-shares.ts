import { z } from "zod";
import { PUBLIC_SHARE_LIMITS as L } from "../../services/public-narrator-share-limits";

export const createPublicShareSchema = z
	.object({
		guestName: z.string().trim().min(1).max(80),
		label: z.string().trim().max(200).optional(),
	})
	.strict();

export const publicSharePageSchema = z
	.object({
		beforeSeq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
		limit: z.coerce.number().int().min(1).max(L.maxPage).default(L.defaultPage),
		messageVersion: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
	})
	.strict();

export const publicShareListSchema = z
	.object({
		cursor: z.string().max(256).optional(),
		limit: z.coerce.number().int().min(1).max(L.maxPage).default(L.defaultPage),
	})
	.strict();

export const postPublicDiscussionSchema = z
	.object({
		text: z.string().trim().min(1).max(L.discussionChars),
		replyToMessageId: z.string().min(1).max(128).nullable().optional(),
	})
	.strict();
