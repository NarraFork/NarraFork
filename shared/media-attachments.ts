/** Portable references to native audio/video assets. Media bytes are never stored in messages. */
export type MediaModality = "audio" | "video";

export interface MediaRef {
	mediaId: string;
	filename: string;
	mediaType: string;
	size: number;
	uploadNarratorId?: string;
}

export interface MediaContentBlock extends MediaRef {
	type: MediaModality;
}

/** Materialized, bounded input for a provider, independent of its wire protocol. */
export interface NativeMediaInput {
	type: MediaModality;
	mediaType: string;
	base64: string;
	filename?: string;
}

export interface NativeMediaFallbackWarning {
	model: string;
	filename: string;
	mediaType: string;
	type: MediaModality;
	mediaId: string;
	uploadNarratorId: string;
	reason?: string;
}

export const MAX_MEDIA_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_MEDIA_ATTACHMENTS = 10;

export const MEDIA_MIME_TO_EXT: Readonly<Record<string, string>> = {
	"audio/wav": ".wav",
	"audio/mpeg": ".mp3",
	"audio/mp4": ".m4a",
	"audio/aac": ".aac",
	"audio/flac": ".flac",
	"audio/ogg": ".ogg",
	"audio/webm": ".webm",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"video/quicktime": ".mov",
	"video/mpeg": ".mpeg",
};

const MEDIA_MIME_ALIASES: Readonly<Record<string, string>> = {
	"audio/x-wav": "audio/wav",
	"audio/wave": "audio/wav",
	"audio/x-m4a": "audio/mp4",
	"audio/mp3": "audio/mpeg",
	"audio/x-flac": "audio/flac",
};
const MEDIA_EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
	...Object.fromEntries(
		Object.entries(MEDIA_MIME_TO_EXT).map(([mime, extension]) => [extension, mime]),
	),
	".m4b": "audio/mp4",
	".oga": "audio/ogg",
	".mpg": "video/mpeg",
};

/** A browser MIME hint, not a substitute for the server's container/signature validation. */
export function normalizeMediaMimeType(mediaType: string, filename: string): string | undefined {
	const declared = mediaType.split(";", 1)[0].trim().toLowerCase();
	const mime = Object.hasOwn(MEDIA_MIME_ALIASES, declared)
		? MEDIA_MIME_ALIASES[declared]
		: declared;
	if (Object.hasOwn(MEDIA_MIME_TO_EXT, mime)) return mime;
	// Only missing/generic MIME hints may fall back to an already supported extension.
	if (declared && declared !== "application/octet-stream") return undefined;
	const extension = /\.[^.\\/]+$/.exec(filename.toLowerCase())?.[0];
	return extension && Object.hasOwn(MEDIA_EXTENSION_TO_MIME, extension)
		? MEDIA_EXTENSION_TO_MIME[extension]
		: undefined;
}

/** Keep canonical File identity; MIME repair never decodes/transcodes or changes bytes. */
export function normalizeMediaFile(file: File): File {
	const type = normalizeMediaMimeType(file.type, file.name);
	return !type || type === file.type
		? file
		: new File([file], file.name, { type, lastModified: file.lastModified });
}
export function mediaModality(mediaType: string): MediaModality | undefined {
	if (mediaType.startsWith("audio/")) return "audio";
	if (mediaType.startsWith("video/")) return "video";
	return undefined;
}

export function mediaRefToContentBlock(
	media: MediaRef,
	fallbackUploadNarratorId?: string | null,
): MediaContentBlock {
	const type = mediaModality(media.mediaType);
	if (!type) throw new Error(`Unsupported media type: ${media.mediaType}`);
	const uploadNarratorId = media.uploadNarratorId || fallbackUploadNarratorId;
	return {
		type,
		mediaId: media.mediaId,
		filename: media.filename,
		mediaType: media.mediaType,
		size: media.size,
		...(uploadNarratorId ? { uploadNarratorId } : {}),
	};
}

export function isMediaContentBlock(value: unknown): value is MediaContentBlock {
	if (!value || typeof value !== "object") return false;
	const block = value as Partial<MediaContentBlock>;
	return (
		(block.type === "audio" || block.type === "video") &&
		typeof block.mediaId === "string" &&
		typeof block.mediaType === "string" &&
		mediaModality(block.mediaType) === block.type &&
		typeof block.filename === "string" &&
		typeof block.size === "number" &&
		Number.isSafeInteger(block.size) &&
		block.size > 0
	);
}
