import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getNarraforkPath } from "../narrafork-home";
import {
	contentJsonHasImageBlocks,
	deleteAvatarImage,
	getAvatarPath,
	getUploadedImageInfo,
	getUploadsDir,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_HEADER_SIZE,
	MAX_IMAGE_PIXELS,
	MAX_IMAGE_SEGMENT_SCANS,
	parseImageDimensions,
	sanitizeParsedDimensions,
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

	test("avatar replacement keeps the old file until the new reference is committed", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-avatar-replacement-"));
		try {
			setUploadsDirForTests(testDir);
			const userId = "avatar-user";
			const oldAvatar = await saveAvatarImage(
				userId,
				new File([fileBytes(pngHeader(16, 16))], "old.png", { type: "image/png" }),
			);
			const oldPath = getAvatarPath(userId, oldAvatar.imageId);
			expect(oldPath).not.toBeNull();

			const newAvatar = await saveAvatarImage(
				userId,
				new File([fileBytes(pngHeader(32, 24))], "new.png", { type: "image/png" }),
			);
			expect(getAvatarPath(userId, oldAvatar.imageId)).toBe(oldPath);
			expect(getAvatarPath(userId, newAvatar.imageId)).not.toBeNull();

			// This is the auth route's DB-failure cleanup path: remove only the uncommitted
			// file, never the still-authoritative old avatar.
			deleteAvatarImage(userId, newAvatar.imageId);
			expect(getAvatarPath(userId, newAvatar.imageId)).toBeNull();
			expect(getAvatarPath(userId, oldAvatar.imageId)).toBe(oldPath);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("avatar write failure cleans the new file and preserves the old file", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-avatar-write-failure-"));
		const runtimeBun = Bun as unknown as { write: typeof Bun.write };
		const originalWrite = runtimeBun.write;
		try {
			setUploadsDirForTests(testDir);
			const userId = "avatar-write-failure";
			const oldAvatar = await saveAvatarImage(
				userId,
				new File([fileBytes(pngHeader(16, 16))], "old.png", { type: "image/png" }),
			);
			const oldPath = getAvatarPath(userId, oldAvatar.imageId);
			expect(oldPath).not.toBeNull();

			runtimeBun.write = (async () => {
				throw new Error("disk full");
			}) as typeof Bun.write;
			await expect(
				saveAvatarImage(
					userId,
					new File([fileBytes(pngHeader(32, 24))], "new.png", { type: "image/png" }),
				),
			).rejects.toThrow();
			expect(getAvatarPath(userId, oldAvatar.imageId)).toBe(oldPath);
			expect(readdirSync(resolve(testDir, "avatars", userId))).toEqual([
				`${oldAvatar.imageId}.png`,
			]);
		} finally {
			runtimeBun.write = originalWrite;
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

	test("saveUploadedImage repairs a non-writable narrator directory", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-chmod-"));
		try {
			setUploadsDirForTests(testDir);
			// Simulate a directory left behind with a read-only mode: the process still
			// owns it, so restoring the mode must recover instead of failing the upload.
			const narratorDir = resolve(testDir, "source-narrator");
			mkdirSync(narratorDir, { recursive: true, mode: 0o500 });
			const file = new File([fileBytes(pngHeader(8, 8))], "shot.png", { type: "image/png" });
			const ref = await saveUploadedImage("source-narrator", file);
			expect(getUploadedImageInfo("source-narrator", ref.imageId)?.size).toBe(
				pngHeader(8, 8).byteLength,
			);
			// The repair restores owner-only access; uploads are user content, so it must
			// never widen the directory to group or world.
			expect(statSync(narratorDir).mode & 0o777).toBe(0o700);
		} finally {
			chmodSync(resolve(testDir, "source-narrator"), 0o700);
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	// The unrepairable case (chmod itself denied) is deliberately not covered here: chmod
	// only requires ownership, so a directory this process created can always be repaired.
	// Reproducing it needs a directory owned by a different uid, which a same-uid test
	// cannot create.

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

	test("imageRefToContentBlock carries the intrinsic dimensions when valid", async () => {
		const { imageRefToContentBlock } = await import("../uploads");
		expect(
			imageRefToContentBlock({
				imageId: "img_1",
				filename: "wide.png",
				mediaType: "image/png",
				width: 1200,
				height: 100,
			}),
		).toEqual({
			type: "image",
			imageId: "img_1",
			filename: "wide.png",
			mediaType: "image/png",
			width: 1200,
			height: 100,
		});
		// Invalid/missing dimensions are omitted, not persisted as junk.
		expect(
			imageRefToContentBlock({
				imageId: "img_2",
				filename: "a.png",
				mediaType: "image/png",
				width: 0,
				height: 100,
			}),
		).toEqual({ type: "image", imageId: "img_2", filename: "a.png", mediaType: "image/png" });
		// The fallback narrator id is applied only when the ref lacks its own.
		expect(
			imageRefToContentBlock(
				{ imageId: "img_3", filename: "b.png", mediaType: "image/png" },
				"nar_fallback",
			).uploadNarratorId,
		).toBe("nar_fallback");
	});

	test("imageBytesToBase64 also reports the parsed dimensions", async () => {
		const { imageBytesToBase64 } = await import("../uploads");
		const result = imageBytesToBase64(new Uint8Array(pngHeader(640, 360)));
		expect(result.detectedMediaType).toBe("image/png");
		expect(result.dimensions).toEqual({ width: 640, height: 360 });
	});

	test("imageBytesToBase64 encodes a Uint8Array without a full copy", async () => {
		const { imageBytesToBase64 } = await import("../uploads");
		// The remote branch of the Read tool passes a Uint8Array, not a Buffer. The old
		// `Buffer.from(bytes)` preamble duplicated the entire (up to 20 MiB) payload on
		// the main thread purely so the 256 KiB header could be parsed. Spying on
		// `Buffer.from` pins the intent stated in `imageHeaderView`'s comment: header
		// inspection uses a view, so no allocation sized to the payload happens.
		const png = pngHeader(64, 48);
		const payload = new Uint8Array(png.byteLength + 4096);
		payload.set(png);

		const realFrom = Buffer.from;
		const copiedLengths: number[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: test spy over an overloaded builtin
		(Buffer as any).from = (...args: unknown[]) => {
			// A view is `Buffer.from(arrayBuffer, byteOffset, length)`; a copy is the
			// single-argument form over a typed array.
			if (args.length === 1 && args[0] instanceof Uint8Array) {
				copiedLengths.push((args[0] as Uint8Array).byteLength);
			}
			// biome-ignore lint/suspicious/noExplicitAny: forwarding to the real overloads
			return (realFrom as any)(...args);
		};
		try {
			const result = imageBytesToBase64(payload);
			expect(result.detectedMediaType).toBe("image/png");
			expect(result.dimensions).toEqual({ width: 64, height: 48 });
			// Correctness of the encoding is still the point of the function.
			expect(result.base64).toBe(realFrom(payload).toString("base64"));
		} finally {
			Buffer.from = realFrom;
		}
		expect(copiedLengths, "payload must not be copied to parse its header").toEqual([]);
	});

	test("sanitizeParsedDimensions drops sizes the layout cannot trust", () => {
		// The Read and share-file tools parse arbitrary on-disk files, so these numbers
		// come straight from an attacker-controlled header. The frontend only rejects
		// non-finite values, so an absurd ratio survives into the aspect-ratio division
		// and collapses the reserved box to ~1px — "pretending to have data" rather than
		// falling back to the placeholder height. Undefined is the honest answer here,
		// which is why this filters instead of throwing like the upload path does.
		expect(sanitizeParsedDimensions({ width: 1920, height: 1080 })).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(sanitizeParsedDimensions(undefined)).toBeUndefined();
		// A PNG IHDR can declare the full uint32 range; this is the concrete case.
		expect(
			sanitizeParsedDimensions({ width: 4_294_967_295, height: 4_294_967_295 }),
		).toBeUndefined();
		expect(sanitizeParsedDimensions({ width: MAX_IMAGE_DIMENSION + 1, height: 1 })).toBeUndefined();
		expect(sanitizeParsedDimensions({ width: 1, height: MAX_IMAGE_DIMENSION + 1 })).toBeUndefined();
		// Each side is within bounds but the product is not.
		const pixelSide = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
		expect(sanitizeParsedDimensions({ width: pixelSide, height: pixelSide })).toBeUndefined();
		// Degenerate and non-integral values are equally unusable.
		expect(sanitizeParsedDimensions({ width: 0, height: 100 })).toBeUndefined();
		expect(sanitizeParsedDimensions({ width: -10, height: 100 })).toBeUndefined();
		expect(sanitizeParsedDimensions({ width: 1.5, height: 100 })).toBeUndefined();
		expect(
			sanitizeParsedDimensions({ width: Number.POSITIVE_INFINITY, height: 100 }),
		).toBeUndefined();
		expect(sanitizeParsedDimensions({ width: Number.NaN, height: 100 })).toBeUndefined();
		// The exact boundary is accepted: the cap is inclusive.
		expect(sanitizeParsedDimensions({ width: MAX_IMAGE_DIMENSION, height: 1 })).toEqual({
			width: MAX_IMAGE_DIMENSION,
			height: 1,
		});
	});

	test("a header declaring an absurd size yields no forwardable dimensions", () => {
		// End-to-end shape of the share-file / Read path: parsing succeeds (the file is a
		// well-formed PNG as far as the header goes) but the result must not reach a
		// consumer. Parsing and sanitizing are separate steps precisely so a caller
		// cannot get the first without the second by accident.
		const hostile = pngHeader(4_294_967_295, 4_294_967_295);
		expect(parseImageDimensions(hostile)).toEqual({
			width: 4_294_967_295,
			height: 4_294_967_295,
		});
		expect(sanitizeParsedDimensions(parseImageDimensions(hostile))).toBeUndefined();
	});
});
