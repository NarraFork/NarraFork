/**
 * Prefetch the bytes a projection needs (§7.1): uploaded images of inputs, images local
 * tools returned, and the saved result of provider image generations. Reading happens
 * here, asynchronously, so the projection itself is a pure function of the view and
 * these bytes.
 */

import type { NativeMediaInput } from "@shared/media-attachments";
import type { CanonicalEnvelope, ImagePart } from "@shared/narrator-blocks/types";
import { logger } from "../../logger";
import { getImagePath, imageToBase64 } from "../../uploads";
import { resolveNativeMediaBlocks } from "../native-media";
import type { ProjectionAssets, ResolvedImage } from "./turns";

const FORMAT_BY_MEDIA_TYPE: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/**
 * Resolved uploads, reused across requests by file path. Every request of a session run
 * is a fresh projection, and an upload never changes under its id, so its bytes are read
 * once while they fit the budget (least recently used first out).
 */
const UPLOAD_CACHE_BUDGET_CHARS = 64 * 1024 * 1024;
const uploadCache = new Map<string, ResolvedImage>();
let uploadCacheChars = 0;

function cachedUpload(key: string): ResolvedImage | undefined {
	const hit = uploadCache.get(key);
	if (!hit) return undefined;
	uploadCache.delete(key);
	uploadCache.set(key, hit);
	return hit;
}

function rememberUpload(key: string, image: ResolvedImage): void {
	if (image.base64.length > UPLOAD_CACHE_BUDGET_CHARS / 4) return;
	uploadCache.set(key, image);
	uploadCacheChars += image.base64.length;
	for (const [oldest, value] of uploadCache) {
		if (uploadCacheChars <= UPLOAD_CACHE_BUDGET_CHARS) break;
		uploadCache.delete(oldest);
		uploadCacheChars -= value.base64.length;
	}
}

async function readUpload(
	uploadNarratorId: string,
	imageId: string,
	storedMediaType: string | undefined,
	context: Record<string, unknown>,
): Promise<ResolvedImage | null> {
	const filePath = getImagePath(uploadNarratorId, imageId);
	if (!filePath) {
		logger.warn("History image missing on disk; skipping replay", {
			...context,
			uploadNarratorId,
			imageId,
		});
		return null;
	}
	// Keyed by the resolved path: a deleted file is never served from memory.
	const cached = cachedUpload(filePath);
	if (cached) return cached;
	try {
		const result = await imageToBase64(filePath);
		// The detected type wins over the stored one: bytes saved under the wrong
		// extension would otherwise be declared as a type the API rejects.
		const mediaType = result.detectedMediaType ?? storedMediaType ?? "image/png";
		const image = {
			mediaType,
			format: FORMAT_BY_MEDIA_TYPE[mediaType] ?? "png",
			base64: result.base64,
		};
		rememberUpload(filePath, image);
		return image;
	} catch (error) {
		logger.warn("Failed to read history image; skipping replay", {
			...context,
			uploadNarratorId,
			imageId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** Bytes a loop's in-memory row carries itself; there is no upload to read. */
function inlineImage(part: ImagePart): ResolvedImage | null {
	if (!part.data) return null;
	const mediaType = part.mediaType ?? "image/png";
	return { mediaType, format: FORMAT_BY_MEDIA_TYPE[mediaType] ?? "png", base64: part.data };
}

/** Load the image bytes of every input, tool result and generated image in the view. */
export async function resolveProjectionAssets(
	envelopes: readonly CanonicalEnvelope[],
	narratorId?: string,
): Promise<ProjectionAssets> {
	const inputMedia = new Map<string, NativeMediaInput[]>();
	const toolResultMedia = new Map<string, NativeMediaInput[]>();
	const inputImages = new Map<string, Array<ResolvedImage | null>>();
	const generatedImages = new Map<string, string>();
	const toolResultImages = new Map<string, ResolvedImage[]>();
	for (const envelope of envelopes) {
		const owner = envelope.narratorId ?? narratorId;
		for (const block of envelope.blocks) {
			if (block.kind === "input") {
				const media = block.payload.parts.filter(
					(part) => part.type === "audio" || part.type === "video",
				);
				if (media.length) inputMedia.set(block.id, await resolveNativeMediaBlocks(media, owner));
				const images = block.payload.parts.filter((part) => part.type === "image");
				if (!images.length) continue;
				const slots: Array<ResolvedImage | null> = [];
				for (const image of images) {
					const uploader = image.uploadNarratorId ?? owner;
					slots.push(
						image.data || !uploader
							? inlineImage(image)
							: await readUpload(uploader, image.assetId, image.mediaType, {
									narratorId,
									messageId: envelope.id,
								}),
					);
				}
				inputImages.set(block.id, slots);
				continue;
			}
			if (block.kind === "tool" && block.payload.executor === "local") {
				const parts = block.payload.result?.parts ?? [];
				if (!parts.length || block.phase !== "done") continue;
				const media = parts.filter((part) => part.type === "audio" || part.type === "video");
				if (media.length)
					toolResultMedia.set(block.id, await resolveNativeMediaBlocks(media, owner));
				const images: ResolvedImage[] = [];
				for (const part of parts) {
					if (part.type !== "image") continue;
					const uploader = part.uploadNarratorId ?? owner;
					const image =
						part.data || !uploader
							? inlineImage(part)
							: await readUpload(uploader, part.assetId, part.mediaType, {
									narratorId,
									messageId: envelope.id,
									toolUseId: block.wireId,
								});
					if (image) images.push(image);
				}
				if (images.length) toolResultImages.set(block.id, images);
				continue;
			}
			if (block.kind === "tool" && block.subtype === "image_generation") {
				const result = block.providerMeta?.result as Record<string, unknown> | undefined;
				const savedPath = typeof result?.savedPath === "string" ? result.savedPath : undefined;
				if (!savedPath || (typeof result?.result === "string" && result.result)) continue;
				try {
					const bytes = Buffer.from(await Bun.file(savedPath).arrayBuffer());
					generatedImages.set(block.id, bytes.toString("base64"));
				} catch {
					// The file may have been removed; the call is then replayed without its image.
				}
			}
		}
	}
	return { inputImages, generatedImages, toolResultImages, inputMedia, toolResultMedia };
}
