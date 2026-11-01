import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMediaContentBlock, MAX_MEDIA_FILE_SIZE } from "@shared/media-attachments";
import { AUDIO_MP4, wavBytes, wavFile, webmBytes } from "../../../tests/fixtures/native-media";
import {
	deleteUploadedMedia,
	getMediaPath,
	mediaToBase64,
	saveUploadedMedia,
	validateMediaBytes,
	validateUploadedMedia,
} from "../media-uploads";
import { setUploadsDirForTests } from "../uploads";

const home = mkdtempSync(join(tmpdir(), "nf-media-uploads-"));
setUploadsDirForTests(home);
afterAll(() => {
	setUploadsDirForTests(null);
	rmSync(home, { recursive: true, force: true });
});

describe("native media byte validation", () => {
	test("accepts a full PCM WAV and a real AAC MP4 without relying on MIME claims", () => {
		expect(validateMediaBytes(wavBytes(), "voice.wav")).toBe("audio/wav");
		expect(AUDIO_MP4.length).toBe(1493);
		expect(validateMediaBytes(AUDIO_MP4, "voice.mp4")).toBe("audio/mp4");
		expect(validateMediaBytes(AUDIO_MP4, "voice.m4a", "application/octet-stream")).toBe(
			"audio/mp4",
		);
		expect(validateMediaBytes(AUDIO_MP4, "book.m4b")).toBe("audio/mp4");
	});
	test("normalizes browser video declarations for structurally audio-only containers", () => {
		expect(validateMediaBytes(AUDIO_MP4, "voice.mp4", "video/mp4")).toBe("audio/mp4");
		expect(validateMediaBytes(webmBytes([2]), "voice.webm", "video/webm")).toBe("audio/webm");
	});
	test("rejects Theora and unknown Ogg streams instead of trusting audio/ogg", () => {
		function ogg(codec: string, serial: number) {
			const packet = Buffer.from(codec, "latin1"),
				page = Buffer.alloc(28 + packet.length);
			page.write("OggS");
			page[5] = 2;
			page.writeUInt32LE(serial, 14);
			page[26] = 1;
			page[27] = packet.length;
			packet.copy(page, 28);
			return page;
		}
		expect(validateMediaBytes(ogg("OpusHead", 1), "voice.ogg", "audio/ogg")).toBe("audio/ogg");
		expect(() => validateMediaBytes(ogg("\u0080theora", 2), "video.ogg", "audio/ogg")).toThrow();
		expect(() => validateMediaBytes(ogg("unknown", 2), "video.ogg", "audio/ogg")).toThrow();
		expect(() =>
			validateMediaBytes(
				Buffer.concat([ogg("OpusHead", 1), ogg("\u0080theora", 2)]),
				"mixed.ogg",
				"audio/ogg",
			),
		).toThrow();
	});
	test("infers WebM modality from Tracks, not its filename", () => {
		expect(validateMediaBytes(webmBytes([2]), "voice.webm")).toBe("audio/webm");
		expect(validateMediaBytes(webmBytes([1, 2]), "clip.webm")).toBe("video/webm");
	});
	test("does not let declared audio hide video tracks", () => {
		expect(() => validateMediaBytes(webmBytes([1, 2]), "clip.webm", "audio/webm")).toThrow(
			"Video tracks",
		);
		const mp4 = Buffer.from(AUDIO_MP4);
		mp4.write("vide", mp4.indexOf("soun"));
		expect(() => validateMediaBytes(mp4, "clip.mp4", "audio/mp4")).toThrow("Video tracks");
		expect(validateMediaBytes(mp4, "clip.mp4")).toBe("video/mp4");
	});
	test("rejects spoofed bytes, mismatched extensions and empty files", async () => {
		expect(() =>
			validateMediaBytes(Buffer.from("<script>not media</script>"), "clip.mp4", "video/mp4"),
		).toThrow();
		expect(() => validateMediaBytes(wavBytes(), "voice.mp3", "audio/wav")).toThrow();
		expect(() => validateMediaBytes(Buffer.alloc(0), "voice.wav")).toThrow("empty");
		await expect(
			validateUploadedMedia(new File([], "empty.wav", { type: "audio/wav" })),
		).rejects.toThrow();
		await expect(validateUploadedMedia("spoof" as unknown as File)).rejects.toThrow(
			"must be a file",
		);
	});
	test("rejects oversized uploads before reading their bytes", async () => {
		const file = wavFile();
		Object.defineProperty(file, "size", { value: MAX_MEDIA_FILE_SIZE + 1 });
		Object.defineProperty(file, "arrayBuffer", {
			value: () => {
				throw new Error("must not read");
			},
		});
		await expect(validateUploadedMedia(file)).rejects.toThrow("100 MiB");
	});
	test("rejects corrupt containers instead of scanning incidental handler strings", () => {
		const corrupt = Buffer.from(AUDIO_MP4);
		corrupt.writeUInt32BE(corrupt.length + 1, 0);
		expect(() => validateMediaBytes(corrupt, "voice.mp4")).toThrow("Truncated");
		expect(() => validateMediaBytes(webmBytes([]), "voice.webm", "audio/webm")).toThrow(
			"no verifiable audio tracks",
		);
	});
});

test("media references reject mismatched modalities and invalid sizes", () => {
	const ref = {
		type: "audio",
		mediaId: "ref",
		mediaType: "audio/wav",
		filename: "voice.wav",
		size: 60,
	};
	expect(isMediaContentBlock(ref)).toBe(true);
	for (const size of [
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])
		expect(isMediaContentBlock({ ...ref, size })).toBe(false);
	expect(isMediaContentBlock({ ...ref, type: "video" })).toBe(false);
	expect(isMediaContentBlock({ ...ref, mediaType: "text/plain" })).toBe(false);
});

test("MP4 structural parsing rejects excessive nesting and box counts", () => {
	function box(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
		const header = Buffer.alloc(8);
		header.writeUInt32BE(8 + body.length);
		header.write(type, 4);
		return Buffer.concat([header, body]);
	}
	const ftyp = AUDIO_MP4.subarray(0, AUDIO_MP4.readUInt32BE(0));
	let nested = box("free");
	for (let index = 0; index < 10; index++) nested = box("moov", nested);
	expect(() => validateMediaBytes(Buffer.concat([ftyp, nested]), "nested.mp4")).toThrow("nesting");
	const many = Buffer.concat([ftyp, ...Array.from({ length: 4097 }, () => box("free"))]);
	expect(() => validateMediaBytes(many, "many.mp4")).toThrow("complexity");
});

describe("durable media references", () => {
	test("saves source-owned bytes, reloads native base64, and rejects traversal", async () => {
		const ref = await saveUploadedMedia("owner", wavFile());
		expect(Object.keys(ref).sort()).toEqual([
			"filename",
			"mediaId",
			"mediaType",
			"size",
			"uploadNarratorId",
		]);
		expect(ref).toMatchObject({
			filename: "voice.wav",
			mediaType: "audio/wav",
			size: 60,
			uploadNarratorId: "owner",
		});
		expect(await mediaToBase64(ref, "fork")).toMatchObject({
			type: "audio",
			base64: wavBytes().toString("base64"),
		});
		expect(getMediaPath("../owner", ref.mediaId)).toBeNull();
		expect(getMediaPath("owner", "../asset")).toBeNull();
		deleteUploadedMedia("owner", ref.mediaId);
		await expect(mediaToBase64(ref)).rejects.toThrow("missing");
	});
	test("revalidates persisted bytes and does not trust reference metadata", async () => {
		const ref = await saveUploadedMedia("owner", wavFile());
		const path = getMediaPath("owner", ref.mediaId);
		if (!path) throw new Error("Missing saved fixture");
		writeFileSync(path, Buffer.alloc(ref.size));
		await expect(mediaToBase64(ref)).rejects.toThrow("does not match");
	});
});
