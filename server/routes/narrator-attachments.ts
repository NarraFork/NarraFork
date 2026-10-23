import { Hono } from "hono";
import { AppError } from "../lib/errors";
import { previewNarratorAttachment } from "../services/narrator-attachment-preview";

export const narratorAttachmentRoutes = new Hono();
narratorAttachmentRoutes.get(
	"/:id/messages/:messageId/attachments/:attachmentId/preview",
	async (c) => {
		c.header("Cache-Control", "no-store");
		const userId = c.get("user")?.sub;
		if (!userId) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
		if (Object.keys(c.req.query()).length)
			throw new AppError(
				"Attachment preview accepts only persisted selectors",
				400,
				"VALIDATION_ERROR",
			);
		const preview = await previewNarratorAttachment(
			c.req.param("id"),
			userId,
			c.req.param("messageId"),
			c.req.param("attachmentId"),
			c.req.raw.signal,
		);
		c.header("Content-Type", preview.contentType);
		c.header("Content-Length", String(preview.size));
		c.header("X-Attachment-Size", String(preview.size));
		c.header("X-Attachment-Truncated", String(preview.truncated));
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Security-Policy", "default-src 'none'; sandbox");
		// No await between final authority fence and body release.
		preview.assertStillCurrent();
		return c.body(preview.bytes);
	},
);
