/**
 * tool-output.ts — the stored form of a tool result (`narrator_tool_calls.outputJson`):
 * how it is written, and how the text, broken marker and images are read back.
 *
 * Lived in `sidecar.ts` until the side-car channel was retired, purely because that
 * file happened to be where the history builders already imported from. It has nothing
 * to do with injected content.
 */

import {
	isMediaContentBlock,
	type MediaContentBlock,
	mediaRefToContentBlock,
} from "../media-attachments";

/** Keep durable media references alongside text, never inline binary payloads. */
export function toolOutputForPersistence(
	text: string,
	metadata?: Record<string, unknown>,
	mediaRefs?: readonly MediaContentBlock[],
): string | { _text: string; _metadata?: Record<string, unknown>; _media?: MediaContentBlock[] } {
	if (!metadata && !mediaRefs?.length) return text;
	return {
		_text: text,
		...(metadata ? { _metadata: metadata } : {}),
		...(mediaRefs?.length
			? {
					_media: mediaRefs.map((ref) => ({
						type: ref.type,
						mediaId: ref.mediaId,
						mediaType: ref.mediaType,
						filename: ref.filename,
						size: ref.size,
						...(ref.uploadNarratorId ? { uploadNarratorId: ref.uploadNarratorId } : {}),
					})),
				}
			: {}),
	};
}

/**
 * Coerce a stored tool output to text.
 *
 * Three shapes reach this, in order of how often:
 *   - a plain string — the normal case, returned untouched
 *   - `{ _text: "…" }` — the wrapper some tools use to carry text plus metadata
 *   - anything else — serialized, because a model can still read JSON, whereas
 *     `[object Object]` tells it nothing
 *
 * `null`/`undefined` become `""` rather than the string "null": an absent output is an
 * empty one, and a literal "null" in a tool result reads as a value the tool returned.
 */
export function outputToText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const maybeText = (value as { _text?: unknown })._text;
		if (typeof maybeText === "string") return maybeText;
	}
	return value == null ? "" : JSON.stringify(value);
}

/**
 * An image a tool returned. A stored ledger keeps only the reference to the saved upload;
 * a loop's in-memory rows (`loop-transcript.ts`) have no upload store and keep the bytes.
 */
export type ToolOutputImageRef =
	| {
			imageId: string;
			mediaType: string;
			/** Narrator whose upload directory holds the file. */
			uploadNarratorId: string;
	  }
	| { imageId: string; mediaType: string /** Base64 bytes, in memory only. */; data: string };

/**
 * Encode a tool result for `narrator_tool_calls.outputJson`.
 *
 * Plain text stays a plain string. Anything else uses the `_text` wrapper:
 *   - `_metadata` — the tool's structured result for the reader's card;
 *   - `_broken`   — the call's input was invalid and it never ran; the model's
 *                   history leaves the call and its result out (a notice row says why);
 *   - `_images`   — images the tool returned, by upload reference;
 *   - `_media`    — original audio/video assets, by durable upload reference.
 */
export function encodeToolOutput(
	text: string,
	extra: {
		metadata?: Record<string, unknown>;
		broken?: boolean;
		images?: readonly ToolOutputImageRef[];
		/** Original media assets, referenced durably without inline bytes. */
		media?: readonly MediaContentBlock[];
	} = {},
): unknown {
	if (!extra.metadata && !extra.broken && !extra.images?.length && !extra.media?.length)
		return text;
	return {
		_text: text,
		...(extra.metadata ? { _metadata: extra.metadata } : {}),
		...(extra.broken ? { _broken: true } : {}),
		...(extra.images?.length ? { _images: extra.images.map((image) => ({ ...image })) } : {}),
		...(extra.media?.length
			? { _media: extra.media.map((ref) => mediaRefToContentBlock(ref)) }
			: {}),
	};
}

/** Native media references must be complete: silently skipping malformed data loses attachments. */
export function toolOutputMedia(value: unknown): MediaContentBlock[] {
	const media = outputRecord(value)?._media;
	if (media === undefined) return [];
	if (!Array.isArray(media) || media.some((ref) => !isMediaContentBlock(ref)))
		throw new Error("Stored tool media references are invalid.");
	return media;
}

function outputRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Whether a stored output belongs to a call whose input was invalid and never ran. */
export function isBrokenToolOutput(value: unknown): boolean {
	return outputRecord(value)?._broken === true;
}

/** Keep saved image references in a live text preview without sending inline image bytes. */
export function toolOutputImagePreview(preview: unknown, persistedOutput: unknown): unknown {
	const images = toolOutputImages(persistedOutput).filter((image) => "uploadNarratorId" in image);
	return images.length ? { _text: preview, _images: images } : preview;
}

/** Image references of a stored output; malformed entries are skipped. */
export function toolOutputImages(value: unknown): ToolOutputImageRef[] {
	const images = outputRecord(value)?._images;
	if (!Array.isArray(images)) return [];
	return images.flatMap((image): ToolOutputImageRef[] => {
		const ref = outputRecord(image);
		if (!ref || typeof ref.imageId !== "string" || typeof ref.mediaType !== "string") return [];
		if (typeof ref.uploadNarratorId === "string")
			return [
				{ imageId: ref.imageId, mediaType: ref.mediaType, uploadNarratorId: ref.uploadNarratorId },
			];
		return typeof ref.data === "string"
			? [{ imageId: ref.imageId, mediaType: ref.mediaType, data: ref.data }]
			: [];
	});
}
