import {
	NOTIFICATION_LIST_DEFAULT_LIMIT,
	NOTIFICATION_LIST_MAX_LIMIT,
	NOTIFICATION_MARK_READ_IDS_MAX,
} from "@shared/notification-center";
import { z } from "zod";

export const notificationKindSchema = z.enum(["chat_message", "permission_request"]);

export const notificationListQuerySchema = z.object({
	kind: notificationKindSchema.optional(),
	status: z.enum(["unread", "all"]).optional(),
	cursor: z.string().min(1).max(512).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(NOTIFICATION_LIST_MAX_LIMIT)
		.optional()
		.default(NOTIFICATION_LIST_DEFAULT_LIMIT),
});

/** No implicit all: malformed requests must never acknowledge history. */
export const notificationMarkReadSchema = z.discriminatedUnion("scope", [
	z
		.object({
			scope: z.literal("items"),
			ids: z.array(z.string().min(1).max(64)).max(NOTIFICATION_MARK_READ_IDS_MAX),
		})
		.strict(),
	z
		.object({
			scope: z.literal("all"),
			before: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
			kind: notificationKindSchema.optional(),
		})
		.strict(),
]);

export const notificationIdParamSchema = z.object({
	id: z.string().min(1).max(64),
});
