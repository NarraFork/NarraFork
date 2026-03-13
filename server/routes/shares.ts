import { basename } from "node:path";
import { Hono } from "hono";
import { NotFoundError } from "../lib/errors";
import { getShare } from "../lib/shares";

export const shareRoutes = new Hono();

shareRoutes.get("/:shareId", async (c) => {
	const { shareId } = c.req.param();
	const record = getShare(shareId);
	if (!record) throw new NotFoundError("Share", shareId);

	const file = Bun.file(record.storagePath);
	if (!(await file.exists())) {
		throw new NotFoundError("Share file", shareId);
	}

	const filename = record.originalName;
	// RFC 5987 encoding for non-ASCII filenames
	const encodedFilename = encodeURIComponent(filename).replace(/%20/g, "+");

	return new Response(file, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Content-Disposition": `attachment; filename="${basename(filename)}"; filename*=UTF-8''${encodedFilename}`,
			"Content-Length": String(record.size),
			"Cache-Control": "no-cache",
		},
	});
});
