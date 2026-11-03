import { type Context, Hono } from "hono";
import { NotFoundError } from "../lib/errors";
import { getMediaPath } from "../lib/media-uploads";
import { requireNarratorAccess } from "../lib/narrator-access";
import { getAvatarPath, getImagePath } from "../lib/uploads";
import {
	narratorReferencesImage,
	narratorReferencesMedia,
} from "../services/narrator-media-access";

export const uploadRoutes = new Hono();

// Serve avatar images — must be before the generic route. Still behind the session gate,
// but deliberately readable by every signed-in user: user and bot (narrator) avatars
// label authors on shared surfaces such as chat rooms and member lists, whose readers
// need not be able to read the narrator.
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
//
// An image is exactly as visible as a session that shows it. Read access to the owner
// narrator (the upload directory) is enough. Otherwise `referencingNarratorId` names a
// narrator the caller can read whose history references this exact owner/image, which
// is how a fork or COW copy shows its source's images to someone who cannot read the
// source. Unlike the media route the owner is tried first, so the common case (the
// reader can see both) never pays for the paged reference scan.
//
// Every refusal and every missing file is the same 404, so the route cannot be used to
// learn whether an image or a narrator exists.
//
// `private` keeps shared caches out. The long lifetime stays because an image id names
// one file that is never rewritten, and `Vary: Authorization` ties the browser's copy to
// the session token that passed this check: another login in the same browser profile
// misses the cache and comes back here.
uploadRoutes.get("/:narratorId/:imageId", async (c) => {
	const { narratorId, imageId } = c.req.param();
	const referencingNarratorId = c.req.query("referencingNarratorId");
	const notFound = () => new NotFoundError("Image", imageId);

	let referenceContext: string | null = null;
	if (!(await mayReadNarrator(c, narratorId))) {
		if (
			!referencingNarratorId ||
			referencingNarratorId === narratorId ||
			!(await mayReadNarrator(c, referencingNarratorId))
		) {
			throw notFound();
		}
		referenceContext = referencingNarratorId;
	}
	const filePath = getImagePath(narratorId, imageId);
	if (!filePath) throw notFound();
	if (
		referenceContext &&
		!(await narratorReferencesImage(referenceContext, narratorId, imageId, c.req.raw.signal))
	) {
		throw notFound();
	}

	const file = Bun.file(filePath);
	return new Response(file, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Cache-Control": "private, max-age=31536000, immutable",
			Vary: "Authorization",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

/** Read access as a yes/no: an unknown narrator and a forbidden one both answer false. */
async function mayReadNarrator(c: Context, narratorId: string): Promise<boolean> {
	try {
		await requireNarratorAccess(c, narratorId, "read");
		return true;
	} catch (error) {
		if (error instanceof NotFoundError) return false;
		throw error;
	}
}
