import { Hono } from "hono";
import { NotFoundError } from "../lib/errors";
import { getMediaPath } from "../lib/media-uploads";
import { requireNarratorAccess } from "../lib/narrator-access";
import { getAvatarPath, getImagePath } from "../lib/uploads";
import { narratorReferencesMedia } from "../services/narrator-media-access";

export const uploadRoutes = new Hono();

// Serve avatar images (public, no auth required) — must be before the generic route
uploadRoutes.get("/avatars/:userId/:imageId", async (c) => {
	const { userId, imageId } = c.req.param();
	const filePath = getAvatarPath(userId, imageId);
	if (!filePath) throw new NotFoundError("Avatar", imageId);

	const file = Bun.file(filePath);
	return new Response(file, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
});

// Native media remains behind the same first-party session gate as uploaded images.
uploadRoutes.get("/:narratorId/media/:mediaId", async (c) => {
	const { narratorId, mediaId } = c.req.param();
	const referencingNarratorId = c.req.query("referencingNarratorId");
	await requireNarratorAccess(c, referencingNarratorId || narratorId, "read");
	const path = getMediaPath(narratorId, mediaId);
	if (!path) throw new NotFoundError("Media", mediaId);
	if (
		referencingNarratorId &&
		!(await narratorReferencesMedia(referencingNarratorId, narratorId, mediaId, c.req.raw.signal))
	) {
		throw new NotFoundError("Media", mediaId);
	}
	const file = Bun.file(path);
	const headers = new Headers({
		"Content-Type": file.type || "application/octet-stream",
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
	});
	const range = c.req.header("range");
	if (!range) {
		headers.set("Content-Length", String(file.size));
		return new Response(file, { headers });
	}
	const match = /^bytes=(\d*)-(\d*)$/.exec(range);
	const invalid = () => {
		headers.set("Content-Range", `bytes */${file.size}`);
		return new Response(null, { status: 416, headers });
	};
	if (!match || (!match[1] && !match[2])) return invalid();
	const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
	const end = match[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start > end ||
		start >= file.size ||
		(!match[1] && Number(match[2]) === 0)
	)
		return invalid();
	headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
	headers.set("Content-Length", String(end - start + 1));
	return new Response(file.slice(start, end + 1), { status: 206, headers });
});

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
