import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import {
	notificationIdParamSchema,
	notificationListQuerySchema,
	notificationMarkReadSchema,
} from "../lib/validators/notifications";
import {
	deleteNotification,
	getUnreadCounts,
	listNotifications,
	markNotificationsRead,
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

/** GET /api/notifications/unread-count — source-calibrated conversation/activity counts. */
notificationRoutes.get("/unread-count", async (c) => {
	const userId = c.get("user").sub;
	const counts = await getUnreadCounts(userId);
	return c.json(counts);
});

/** Enough for 500 maximum-length ids plus JSON framing, with a streaming hard cap. */
export const NOTIFICATION_READ_BODY_MAX_BYTES = 40 * 1024;

export const NOTIFICATION_READ_BODY_TIMEOUT_MS = 5_000;

/** A slow or disconnected client must not hold an unbounded body reader open. */
export async function readMarkReadBody(
	request: Request,
	timeoutMs = NOTIFICATION_READ_BODY_TIMEOUT_MS,
): Promise<unknown> {
	const declared = Number(request.headers.get("content-length"));
	if (declared > NOTIFICATION_READ_BODY_MAX_BYTES)
		throw new ValidationError("Notification body too large");
	if (!request.body) throw new ValidationError("Notification body is required");
	if (request.signal.aborted) throw new ValidationError("Notification request aborted");
	const reader = request.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort = () => {};
	const interrupted = new Promise<never>((_resolve, reject) => {
		const interrupt = (message: string) => {
			reject(new ValidationError(message));
			void reader.cancel().catch(() => {});
		};
		onAbort = () => interrupt("Notification request aborted");
		request.signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(
			() => interrupt("Notification body read timed out"),
			Math.min(timeoutMs, NOTIFICATION_READ_BODY_TIMEOUT_MS),
		);
	});
	const read = async () => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > NOTIFICATION_READ_BODY_MAX_BYTES) {
				void reader.cancel().catch(() => {});
				throw new ValidationError("Notification body too large");
			}
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	};
	try {
		return await Promise.race([read(), interrupted]);
	} catch (error) {
		if (error instanceof ValidationError) throw error;
		throw new ValidationError("Invalid notification JSON body");
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

notificationRoutes.post("/read", async (c) => {
	const userId = c.get("user").sub;
	const parsed = notificationMarkReadSchema.safeParse(await readMarkReadBody(c.req.raw));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result = await markNotificationsRead({ userId, ...parsed.data });
	return c.json(result);
});

/**
 * POST /api/notifications/:id/delete — delete one of the caller's notifications.
 * Missing and foreign rows both return 404.
 */
notificationRoutes.post("/:id/delete", async (c) => {
	const userId = c.get("user").sub;
	const parsed = notificationIdParamSchema.safeParse({ id: c.req.param("id") });
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await deleteNotification(userId, parsed.data.id);
	return c.json({ ok: true });
});
