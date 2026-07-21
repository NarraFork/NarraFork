import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getNarraforkPath } from "../narrafork-home";
import {
	contentJsonHasImageBlocks,
	getUploadedImageInfo,
	getUploadsDir,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_HEADER_SIZE,
	MAX_IMAGE_PIXELS,
	MAX_IMAGE_SEGMENT_SCANS,
	parseImageDimensions,
	saveAvatarImage,
	saveUploadedImage,
	setUploadsDirForTests,
} from "../uploads";

function fileBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function pngHeader(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

function gifHeader(width: number, height: number): Buffer {
	const buf = Buffer.alloc(10);
	buf.write("GIF89a", 0, "ascii");
	buf.writeUInt16LE(width, 6);
	buf.writeUInt16LE(height, 8);
	return buf;
}

function webpChunk(type: string, data: Buffer): Buffer {
	const padding = data.length & 1;
	const buf = Buffer.alloc(20 + data.length + padding);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(buf.length - 8, 4);
	buf.write("WEBP", 8, "ascii");
	buf.write(type, 12, "ascii");
	buf.writeUInt32LE(data.length, 16);
	data.copy(buf, 20);
	return buf;
}

function webpVp8xHeader(width: number, height: number): Buffer {
	const data = Buffer.alloc(10);
	data.writeUIntLE(width - 1, 4, 3);
	data.writeUIntLE(height - 1, 7, 3);
	return webpChunk("VP8X", data);
}

function webpVp8Header(width: number, height: number): Buffer {
	const data = Buffer.alloc(10);
	data.set([0x9d, 0x01, 0x2a], 3);
	data.writeUInt16LE(width, 6);
	data.writeUInt16LE(height, 8);
	return webpChunk("VP8 ", data);
}

function webpVp8lHeader(width: number, height: number): Buffer {
	const widthBits = width - 1;
	const heightBits = height - 1;
	const data = Buffer.from([
		0x2f,
		widthBits & 0xff,
		((widthBits >> 8) & 0x3f) | ((heightBits & 0x03) << 6),
		(heightBits >> 2) & 0xff,
		(heightBits >> 10) & 0x0f,
	]);
	return webpChunk("VP8L", data);
}

function jpegHeader(width: number, height: number, orientation?: number): Buffer {
	const segments: Buffer[] = [Buffer.from([0xff, 0xd8])];
	if (orientation !== undefined) {
		const exif = Buffer.alloc(32);
		exif.write("Exif\0\0", 0, "ascii");
		exif.write("II", 6, "ascii");
		exif.writeUInt16LE(42, 8);
		exif.writeUInt32LE(8, 10);
		exif.writeUInt16LE(1, 14);
		exif.writeUInt16LE(0x0112, 16);
		exif.writeUInt16LE(3, 18);
		exif.writeUInt32LE(1, 20);
		exif.writeUInt16LE(orientation, 24);
		const app1 = Buffer.alloc(exif.length + 4);
		app1.set([0xff, 0xe1]);
		app1.writeUInt16BE(exif.length + 2, 2);
		exif.copy(app1, 4);
		segments.push(app1);
	}
	const sof = Buffer.alloc(13);
	sof.set([0xff, 0xc0]);
	sof.writeUInt16BE(11, 2);
	sof[4] = 8;
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	sof[9] = 1;
	segments.push(sof, Buffer.from([0xff, 0xd9]));
	return Buffer.concat(segments);
}

afterEach(() => {
	setUploadsDirForTests(null);
});

describe("uploads helpers", () => {
	test("getUploadsDir uses the default path without a test override", () => {
		expect(getUploadsDir()).toBe(getNarraforkPath("uploads"));
	});

	test("getUploadsDir uses the test override when provided", () => {
		const testDir = resolve("/tmp", "narrafork-uploads-test");
		setUploadsDirForTests(testDir);
		expect(getUploadsDir()).toBe(testDir);
	});

	test("saveUploadedImage records the narrator that owns the file", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-owner-"));
		try {
			setUploadsDirForTests(testDir);
			const header = fileBytes(pngHeader(4, 4));
			const file = new File([header], "shot.png", {
				type: "image/png",
			});
			const ref = await saveUploadedImage("source-narrator", file);
			expect(ref.uploadNarratorId).toBe("source-narrator");
			expect(getUploadedImageInfo("source-narrator", ref.imageId)?.size).toBe(header.byteLength);
			expect(getUploadedImageInfo("other-narrator", ref.imageId)).toBeNull();
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("parses PNG, GIF, and WebP dimensions from headers", () => {
		expect(parseImageDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
		expect(parseImageDimensions(gifHeader(320, 200))).toEqual({ width: 320, height: 200 });
		expect(parseImageDimensions(webpVp8xHeader(1280, 720))).toEqual({
			width: 1280,
			height: 720,
		});
		expect(parseImageDimensions(webpVp8Header(640, 360))).toEqual({
			width: 640,
			height: 360,
		});
		expect(parseImageDimensions(webpVp8lHeader(511, 257))).toEqual({
			width: 511,
			height: 257,
		});
	});

	test("parses JPEG dimensions and applies EXIF orientation", () => {
		expect(parseImageDimensions(jpegHeader(1200, 800))).toEqual({
			width: 1200,
			height: 800,
		});
		expect(parseImageDimensions(jpegHeader(1200, 800, 3))).toEqual({
			width: 1200,
			height: 800,
		});
		expect(parseImageDimensions(jpegHeader(1200, 800, 6))).toEqual({
			width: 800,
			height: 1200,
		});
		expect(parseImageDimensions(jpegHeader(1200, 800, 8))).toEqual({
			width: 800,
			height: 1200,
		});
	});

	test("bounds JPEG header scanning", () => {
		const paddingSegment = Buffer.alloc(65_535);
		paddingSegment.set([0xff, 0xe2]);
		paddingSegment.writeUInt16BE(65_533, 2);
		const oversizedHeader = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			paddingSegment,
			paddingSegment,
			paddingSegment,
			paddingSegment,
			jpegHeader(640, 480).subarray(2),
		]);
		expect(oversizedHeader.length).toBeGreaterThan(MAX_IMAGE_HEADER_SIZE);
		expect(parseImageDimensions(oversizedHeader)).toBeUndefined();
	});

	test("rejects JPEG dimensions hidden beyond the bounded header scan", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-jpeg-header-limit-"));
		try {
			setUploadsDirForTests(testDir);
			const paddingSegment = Buffer.alloc(65_535);
			paddingSegment.set([0xff, 0xe2]);
			paddingSegment.writeUInt16BE(65_533, 2);
			const oversizedPixels = Buffer.concat([
				Buffer.from([0xff, 0xd8]),
				paddingSegment,
				paddingSegment,
				paddingSegment,
				paddingSegment,
				jpegHeader(40_000, 40_000).subarray(2),
			]);
			await expect(
				saveUploadedImage(
					"source-narrator",
					new File([fileBytes(oversizedPixels)], "hidden-dimensions.jpg", {
						type: "image/jpeg",
					}),
				),
			).rejects.toThrow(/Unable to parse image dimensions/);
			expect(existsSync(resolve(testDir, "source-narrator"))).toBe(false);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("saveUploadedImage returns parsed dimensions for a valid image", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-dimensions-"));
		try {
			setUploadsDirForTests(testDir);
			const parsed = await saveUploadedImage(
				"source-narrator",
				new File([fileBytes(pngHeader(800, 600))], "shot.png", { type: "image/png" }),
			);
			expect(parsed.width).toBe(800);
			expect(parsed.height).toBe(600);
			expect(getUploadedImageInfo("source-narrator", parsed.imageId)).not.toBeNull();
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("saveUploadedImage fail-closes on content that is not a real image", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-failclosed-"));
		try {
			setUploadsDirForTests(testDir);

			// Declares image/png but the magic bytes do not match any supported format.
			await expect(
				saveUploadedImage(
					"source-narrator",
					new File([new Uint8Array([1, 2, 3, 4])], "legacy.png", { type: "image/png" }),
				),
			).rejects.toThrow(/Unrecognized image content/);

			// Valid PNG signature but truncated before IHDR, so dimensions are unparseable.
			const truncatedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			await expect(
				saveUploadedImage(
					"source-narrator",
					new File([fileBytes(truncatedPng)], "truncated.png", { type: "image/png" }),
				),
			).rejects.toThrow(/Unable to parse image dimensions/);

			// Nothing should have been written for either rejected upload.
			expect(existsSync(resolve(testDir, "source-narrator"))).toBe(false);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("rejects declared MIME types that do not match the image bytes", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-mime-mismatch-"));
		try {
			setUploadsDirForTests(testDir);
			const spoofedPng = new File([fileBytes(gifHeader(16, 16))], "spoofed.png", {
				type: "image/png",
			});
			await expect(saveUploadedImage("source-narrator", spoofedPng)).rejects.toThrow(
				/Image content type mismatch/,
			);
			await expect(saveAvatarImage("user-1", spoofedPng)).rejects.toThrow(
				/Image content type mismatch/,
			);
			expect(existsSync(resolve(testDir, "source-narrator"))).toBe(false);
			expect(existsSync(resolve(testDir, "avatars", "user-1"))).toBe(false);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("rejects parsed dimensions above side and pixel safety limits", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-limits-"));
		try {
			setUploadsDirForTests(testDir);
			const tooWide = new File([fileBytes(pngHeader(MAX_IMAGE_DIMENSION + 1, 1))], "wide.png", {
				type: "image/png",
			});
			await expect(saveUploadedImage("source-narrator", tooWide)).rejects.toThrow(
				/Image dimensions too large/,
			);

			const pixelWidth = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
			const tooManyPixels = new File([fileBytes(pngHeader(pixelWidth, pixelWidth))], "pixels.png", {
				type: "image/png",
			});
			await expect(saveUploadedImage("source-narrator", tooManyPixels)).rejects.toThrow(
				/Image dimensions too large/,
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("saveUploadedImage reads the file bytes exactly once", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-single-read-"));
		try {
			setUploadsDirForTests(testDir);
			const file = new File([fileBytes(pngHeader(64, 48))], "shot.png", { type: "image/png" });
			let arrayBufferCalls = 0;
			const realArrayBuffer = file.arrayBuffer.bind(file);
			file.arrayBuffer = () => {
				arrayBufferCalls++;
				return realArrayBuffer();
			};
			const ref = await saveUploadedImage("source-narrator", file);
			expect(arrayBufferCalls).toBe(1);
			expect(ref.width).toBe(64);
			expect(ref.height).toBe(48);
			expect(getUploadedImageInfo("source-narrator", ref.imageId)?.size).toBe(
				pngHeader(64, 48).byteLength,
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("bounds JPEG segment scans against pathological headers", () => {
		// Pack many tiny APP2 segments so the marker walk would loop far more than
		// the scan cap allows before reaching the SOF frame that carries dimensions.
		const tinySegment = Buffer.from([0xff, 0xe2, 0x00, 0x02]);
		const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
		for (let i = 0; i < MAX_IMAGE_SEGMENT_SCANS + 10; i++) parts.push(tinySegment);
		parts.push(jpegHeader(320, 240).subarray(2));
		const pathological = Buffer.concat(parts);
		expect(pathological.length).toBeLessThan(MAX_IMAGE_HEADER_SIZE);
		expect(parseImageDimensions(pathological)).toBeUndefined();
	});

	test("contentJsonHasImageBlocks detects persisted image blocks", () => {
		expect(
			contentJsonHasImageBlocks([
				{ type: "text", text: "hello" },
				{ type: "image", imageId: "img_123", filename: "shot.png", mediaType: "image/png" },
			]),
		).toBe(true);
		expect(contentJsonHasImageBlocks([{ type: "text", text: "hello" }])).toBe(false);
		expect(contentJsonHasImageBlocks(null)).toBe(false);
	});
});
