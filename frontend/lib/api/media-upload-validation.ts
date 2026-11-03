import {
	MAX_MEDIA_ATTACHMENTS,
	MAX_MEDIA_FILE_SIZE,
	normalizeMediaMimeType,
} from "@shared/media-attachments";

/** Leave room for multipart headers as well as the files, under the unchanged server body cap. */
export const MAX_MEDIA_UPLOAD_BYTES = 128 * 1024 * 1024;
export function mediaUploadError(options: {
	media?: readonly File[];
	otherFiles?: readonly File[];
	text?: string;
	keptMediaCount?: number;
}): "mediaTooMany" | "mediaFileTooLarge" | "unsupportedFileType" | "mediaUploadTooLarge" | null {
	const media = options.media ?? [];
	if (media.length === 0) return null;
	if (media.length + (options.keptMediaCount ?? 0) > MAX_MEDIA_ATTACHMENTS) return "mediaTooMany";
	if (media.some((file) => !normalizeMediaMimeType(file.type, file.name)))
		return "unsupportedFileType";
	if (media.some((file) => !file.size || file.size > MAX_MEDIA_FILE_SIZE))
		return "mediaFileTooLarge";
	const bytes = [...media, ...(options.otherFiles ?? [])].reduce((sum, file) => sum + file.size, 0);
	if (
		bytes + new TextEncoder().encode(options.text ?? "").byteLength + 64 * 1024 >
		MAX_MEDIA_UPLOAD_BYTES
	)
		return "mediaUploadTooLarge";
	return null;
}
