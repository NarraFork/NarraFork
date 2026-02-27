import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import { sendTestDingtalk, sendTestFeishu } from "../services/notification-service";

const testWebhookSchema = z.object({
	webhook: z.string().min(1),
	secret: z.string().optional(),
});

export const notificationRoutes = new Hono();

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
