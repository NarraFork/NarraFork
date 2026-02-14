import { Hono } from "hono";
import { NotFoundError } from "../lib/errors";
import { getImagePath } from "../lib/uploads";

export const uploadRoutes = new Hono();

// Serve uploaded images
uploadRoutes.get("/:narratorId/:imageId", async (c) => {
	const { narratorId, imageId } = c.req.param();
	const filePath = getImagePath(narratorId, imageId);
	if (!filePath) throw new NotFoundError("Image", imageId);

	const file = Bun.file(filePath);
	return new Response(file, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
});
