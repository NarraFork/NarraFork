/** Separate from the buffered narrator routes and their work-admission lease. */
import { Hono } from "hono";
import { discardStagedAttachment, stageAttachment } from "../lib/attachment-staging";
import { AppError, ValidationError } from "../lib/errors";
import { requireNarratorAccess } from "../lib/narrator-access";

export const narratorAttachmentRoutes = new Hono();

function requireOctetStream(contentType: string | undefined): void {
	const media = contentType?.split(";")[0]?.trim().toLowerCase();
	if (media !== "application/octet-stream") {
		throw new AppError(
			"Attachment upload requires application/octet-stream",
			415,
			"ATTACHMENT_INVALID_MEDIA_TYPE",
		);
	}
}

function parseContentLength(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw)) throw new ValidationError("Invalid Content-Length");
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) throw new ValidationError("Invalid Content-Length");
	return value;
}

narratorAttachmentRoutes.post("/:narratorId", async (c) => {
	const narratorId = c.req.param("narratorId");
	await requireNarratorAccess(c, narratorId, "write");
	requireOctetStream(c.req.header("content-type"));

	const staged = await stageAttachment(c.req.raw.body, {
		narratorId,
		filename: c.req.header("x-attachment-filename"),
		mediaType: c.req.header("x-attachment-type"),
		declaredLength: parseContentLength(c.req.header("content-length")),
		signal: c.req.raw.signal,
	});
	return c.json(
		{
			uploadId: staged.uploadId,
			filename: staged.filename,
			mediaType: staged.mediaType,
			size: staged.size,
		},
		201,
	);
});

narratorAttachmentRoutes.delete("/:narratorId/:uploadId", async (c) => {
	const narratorId = c.req.param("narratorId");
	await requireNarratorAccess(c, narratorId, "write");
	discardStagedAttachment(narratorId, c.req.param("uploadId"));
	return c.json({ ok: true });
});
