import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	notificationListQuerySchema,
	notificationMarkReadSchema,
} from "../lib/validators/notifications";
import {
	deleteNotification,
	getUnreadCounts,
	listNotifications,
	markNotificationsRead,
	type NotificationKind,
} from "../services/notification-center-service";
import { sendTestDingtalk, sendTestFeishu } from "../services/notification-service";

const testWebhookSchema = z.object({
	webhook: z.string().min(1),
	secret: z.string().optional(),
});

export const notificationRoutes = new Hono();

// ─── Legacy IM test webhooks (settings page) ────────────────────────────────
// Mounted under the global session-auth gate in app.ts; kept here so the
// settings "test webhook" buttons continue to work.

notificationRoutes.post("/test-dingtalk", async (c) => {
	const body = await c.req.json();
	const parsed = testWebhookSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	try {
		await sendTestDingtalk(parsed.data.webhook, parsed.data.secret ?? "");
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ ok: false, error: message }, 502);
	}
});

notificationRoutes.post("/test-feishu", async (c) => {
	const body = await c.req.json();
	const parsed = testWebhookSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	try {
		await sendTestFeishu(parsed.data.webhook, parsed.data.secret ?? "");
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ ok: false, error: message }, 502);
	}
});

// ─── Notification center (Phase 1) ──────────────────────────────────────────
// Auth: first-party session via global `requireSessionAuth` on /api/*.
// Ownership: every handler scopes by `c.get("user").sub`; foreign resources
// surface as 404 (never 403) so existence is not confirmed.

/** GET /api/notifications — cursor-paginated list for the current user. */
notificationRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
	const parsed = notificationListQuerySchema.safeParse(query);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const page = await listNotifications({
		userId,
		kind: parsed.data.kind,
		status: parsed.data.status,
		cursor: parsed.data.cursor ?? null,
		limit: parsed.data.limit,
	});
	return c.json(page);
});

/** GET /api/notifications/unread-count — bounded per-kind unread probes. */
notificationRoutes.get("/unread-count", async (c) => {
	const userId = c.get("user").sub;
	const counts = await getUnreadCounts(userId);
	return c.json(counts);
});

/**
 * POST /api/notifications/read — mark own notifications read.
 * Body: `{ ids?: string[], before?: number, kind?: NotificationKind }`.
 * Empty `ids` is a no-op (does NOT mark everything).
 */
notificationRoutes.post("/read", async (c) => {
	const userId = c.get("user").sub;
	let body: unknown = {};
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}
	const parsed = notificationMarkReadSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const result = await markNotificationsRead({
		userId,
		ids: parsed.data.ids,
		before: parsed.data.before,
		kind: parsed.data.kind as NotificationKind | undefined,
	});
	return c.json({ updated: Math.max(0, result.updated) });
});

/**
 * POST /api/notifications/:id/delete — delete one of the caller's notifications.
 * Missing and foreign rows both return 404.
 */
notificationRoutes.post("/:id/delete", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");
	if (!id) throw new NotFoundError("Notification", id);

	await deleteNotification(userId, id);
	return c.json({ ok: true });
});
