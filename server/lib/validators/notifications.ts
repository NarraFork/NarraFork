import {
	NOTIFICATION_LIST_DEFAULT_LIMIT,
	NOTIFICATION_LIST_MAX_LIMIT,
} from "@shared/notification-center";
import { z } from "zod";

/**
 * Notification center input schemas (Phase 1 / task package B).
 *
 * Caps come from `@shared/notification-center` (package A) — validators may
 * import shared constants but must not import services.
 */
const NOTIFICATION_MARK_READ_IDS_MAX = 200;

export const notificationKindSchema = z.enum(["chat_message", "permission_request"]);

export const notificationListQuerySchema = z.object({
	kind: notificationKindSchema.optional(),
	/** `unread` filters to unread; `all` (or omitted) returns everything. */
	status: z.enum(["unread", "all"]).optional(),
	/** Opaque keyset cursor from a previous page. */
	cursor: z.string().min(1).max(512).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(NOTIFICATION_LIST_MAX_LIMIT)
		.optional()
		.default(NOTIFICATION_LIST_DEFAULT_LIMIT),
});

/**
 * POST /api/notifications/read body.
 *
 * Empty body `{}` is valid and means "mark all of my unread notifications read"
 * (the Drawer's mark-all button; may also send `before=now`).
 * - `ids` present (including `[]`): only those ids; empty array is a no-op.
 * - `before`: non-negative ms epoch.
 * - `kind`: optional narrowing when not using explicit ids.
 */
export const notificationMarkReadSchema = z.object({
	ids: z.array(z.string().min(1).max(64)).max(NOTIFICATION_MARK_READ_IDS_MAX).optional(),
	/** Non-negative ms epoch; marks unread rows with created_at <= before. */
	before: z.number().int().min(0).optional(),
	kind: notificationKindSchema.optional(),
});

/** Path param for POST /api/notifications/:id/delete */
export const notificationIdParamSchema = z.object({
	id: z.string().min(1).max(64),
});
