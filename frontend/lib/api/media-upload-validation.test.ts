import { describe, expect, test } from "bun:test";
import {
	MAX_MEDIA_FILE_SIZE,
	MEDIA_MIME_TO_EXT,
	normalizeMediaFile,
	normalizeMediaMimeType,
} from "@shared/media-attachments";
import { mediaUploadError } from "./media-upload-validation";

function file(size: number, type = "audio/wav"): File {
	return { size, type } as File;
}

const mediaMimeCases = [
	["audio/x-wav", "speech.WAV", "audio/wav"],
	["audio/wave", "speech.wav", "audio/wav"],
	["audio/mp3", "speech.MP3", "audio/mpeg"],
	["audio/x-m4a", "speech.M4A", "audio/mp4"],
	["audio/x-flac", "speech.FLAC", "audio/flac"],
	["", "speech.WAV", "audio/wav"],
	["", "speech.MP3", "audio/mpeg"],
	["", "speech.M4A", "audio/mp4"],
	["", "speech.M4B", "audio/mp4"],
	["", "speech.AAC", "audio/aac"],
	["", "speech.FLAC", "audio/flac"],
	["", "speech.OGG", "audio/ogg"],
	["", "speech.OGA", "audio/ogg"],
	["", "clip.MP4", "video/mp4"],
	["", "clip.WEBM", "video/webm"],
	["", "clip.MOV", "video/quicktime"],
	["", "clip.MPEG", "video/mpeg"],
	["", "clip.MPG", "video/mpeg"],
	["application/octet-stream", "speech.WAV", "audio/wav"],
	["application/octet-stream", "speech.MP3", "audio/mpeg"],
	["application/octet-stream", "speech.M4A", "audio/mp4"],
	["application/octet-stream", "speech.FLAC", "audio/flac"],
	["application/octet-stream", "clip.MP4", "video/mp4"],
	["application/octet-stream", "clip.WEBM", "video/webm"],
] as const;

describe("native media MIME normalization", () => {
	for (const [type, name, expectedType] of mediaMimeCases) {
		test(`normalizes ${type || "empty MIME"} ${name} without altering file data`, async () => {
			const bytes = new Uint8Array([0, 255, 13, 10, 128, 1]);
			const original = new File([bytes], name, { type, lastModified: 1_701_234_567_890 });
			const normalized = normalizeMediaFile(original);
			expect(normalizeMediaMimeType(type, name)).toBe(expectedType);
			expect(normalized).not.toBe(original);
			expect(normalized.type).toBe(expectedType);
			expect(normalized.name).toBe(original.name);
			expect(normalized.size).toBe(original.size);
			expect(normalized.lastModified).toBe(original.lastModified);
			expect(new Uint8Array(await normalized.arrayBuffer())).toEqual(bytes);
			expect(original.type).toBe(type);
			expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
			expect(mediaUploadError({ media: [original] })).toBeNull();
		});
	}

	test("keeps canonical media File identities unchanged", () => {
		for (const [type, extension] of Object.entries(MEDIA_MIME_TO_EXT)) {
			const original = new File(["media"], `original${extension}`, { type, lastModified: 123 });
			expect(normalizeMediaMimeType(type, original.name)).toBe(type);
			expect(normalizeMediaFile(original)).toBe(original);
			expect(mediaUploadError({ media: [original] })).toBeNull();
		}
	});

	for (const [type, name] of [
		["audio/x-unsupported", "speech.WAV"],
		["video/x-unsupported", "clip.MP4"],
		["text/plain", "speech.MP3"],
		["image/png", "speech.WAV"],
		["application/json", "speech.WAV"],
		["", "speech.unknown"],
		["application/octet-stream", "speech.unknown"],
		["", "speech.wav.txt"],
		["", "speech"],
	] as const) {
		test(`does not infer media from ${type || "empty MIME"} ${name}`, () => {
			const original = new File(["not media"], name, { type });
			expect(normalizeMediaMimeType(type, name)).toBeUndefined();
			expect(normalizeMediaFile(original)).toBe(original);
			expect(mediaUploadError({ media: [original] })).toBe("unsupportedFileType");
		});
	}
});
describe("native media upload bounds", () => {
	test("does not impose the media request budget on image-only or text-only uploads", () => {
		expect(
			mediaUploadError({ otherFiles: [file(130 * 1024 * 1024, "image/png")], text: "message" }),
		).toBeNull();
		expect(mediaUploadError({ otherFiles: [file(130 * 1024 * 1024, "text/plain")] })).toBeNull();
	});
	test("accepts a media-only message and the inclusive 100 MiB file limit", () => {
		expect(mediaUploadError({ media: [file(MAX_MEDIA_FILE_SIZE)] })).toBeNull();
	});
	test("rejects empty, oversized and unsupported media", () => {
		expect(mediaUploadError({ media: [file(0)] })).toBe("mediaFileTooLarge");
		expect(mediaUploadError({ media: [file(MAX_MEDIA_FILE_SIZE + 1)] })).toBe("mediaFileTooLarge");
		expect(mediaUploadError({ media: [file(10, "audio/unknown")] })).toBe("unsupportedFileType");
	});
	test("counts retained media against the ten-file edit bound", () => {
		expect(mediaUploadError({ media: [file(10)], keptMediaCount: 9 })).toBeNull();
		expect(mediaUploadError({ media: [file(10)], keptMediaCount: 10 })).toBe("mediaTooMany");
	});
	test("applies the unchanged 128 MiB request cap to mixed attachments", () => {
		expect(
			mediaUploadError({
				media: [file(100 * 1024 * 1024)],
				otherFiles: [file(29 * 1024 * 1024, "text/plain")],
			}),
		).toBe("mediaUploadTooLarge");
		expect(
			mediaUploadError({
				media: [file(100 * 1024 * 1024)],
				otherFiles: [file(27 * 1024 * 1024, "image/png")],
			}),
		).toBeNull();
	});
});
