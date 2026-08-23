import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { DEFAULT_BRAND_ICON_COLOR } from "@shared/branding";
import {
	decodeRgbaPng,
	encodeRgbaPng,
	recolorBrandPng,
} from "../../../server/lib/branding/png-recolor";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The real shipped assets, so the tests exercise the actual byte shapes. */
const SHIPPED_ICONS = [
	"frontend/public/pwa-192x192.png",
	"frontend/public/pwa-512x512.png",
	"frontend/public/apple-touch-icon-180x180.png",
] as const;

const BRAND_RGB = [0x4c, 0x6e, 0xf5] as const;
const TARGET_HEX = "#e64980";
const TARGET_RGB = [0xe6, 0x49, 0x80] as const;

async function readIcon(path: string): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(path).arrayBuffer());
}

function crc32(buf: Buffer): number {
	let c = -1;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	}
	return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeBytes = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
	return Buffer.concat([length, typeBytes, data, crc]);
}

/** Build a tiny valid PNG with an arbitrary IHDR, for the rejection cases. */
function makePng(options: {
	width: number;
	height: number;
	bitDepth: number;
	colorType: number;
	interlace?: number;
	bytesPerPixel: number;
}): Uint8Array {
	const { width, height, bitDepth, colorType, interlace = 0, bytesPerPixel } = options;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	ihdr[12] = interlace;
	const stride = width * bytesPerPixel;
	const raw = Buffer.alloc(height * (stride + 1));
	return new Uint8Array(
		Buffer.concat([
			PNG_SIGNATURE,
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

describe("recolorBrandPng on the shipped icons", () => {
	for (const path of SHIPPED_ICONS) {
		test(`${path} recolours every accent pixel and preserves white and transparency`, async () => {
			const source = await readIcon(path);
			const before = decodeRgbaPng(source);
			expect(before).not.toBeNull();
			if (!before) return;

			const recolored = recolorBrandPng(source, TARGET_HEX);
			expect(recolored).not.toBeNull();
			if (!recolored) return;

			const after = decodeRgbaPng(recolored);
			expect(after).not.toBeNull();
			if (!after) return;

			expect(after.width).toBe(before.width);
			expect(after.height).toBe(before.height);

			let accentPixels = 0;
			let whitePixels = 0;
			let transparentPixels = 0;

			for (let i = 0; i < before.pixels.length; i += 4) {
				const alpha = before.pixels[i + 3];
				// Alpha is never touched — the rounded-corner cutouts depend on it.
				expect(after.pixels[i + 3]).toBe(alpha);

				if (alpha === 0) {
					transparentPixels++;
					continue;
				}

				const isAccent =
					before.pixels[i] === BRAND_RGB[0] &&
					before.pixels[i + 1] === BRAND_RGB[1] &&
					before.pixels[i + 2] === BRAND_RGB[2];
				const isWhite =
					before.pixels[i] === 255 && before.pixels[i + 1] === 255 && before.pixels[i + 2] === 255;

				if (isAccent) {
					accentPixels++;
					expect([after.pixels[i], after.pixels[i + 1], after.pixels[i + 2]]).toEqual([
						...TARGET_RGB,
					]);
				} else if (isWhite) {
					whitePixels++;
					// A per-channel scale would tint the strokes here; that shows up as a
					// dirty outline at favicon size.
					expect([after.pixels[i], after.pixels[i + 1], after.pixels[i + 2]]).toEqual([
						255, 255, 255,
					]);
				}
			}

			// Guard the assertions above against a decode that silently produced nothing
			// to check.
			expect(accentPixels).toBeGreaterThan(1000);
			expect(whitePixels).toBeGreaterThan(100);
			expect(transparentPixels).toBeGreaterThan(0);
		});
	}

	/**
	 * Every output pixel must sit ON the target→white line.
	 *
	 * This is the property that makes edges clean, and it is what a naive
	 * per-channel scale violates: scaling by the ratio of two accent colours pushes
	 * blend pixels off that line, which reads as a dirty, tinted outline at favicon
	 * size. Asserted as a geometric invariant rather than by recomputing the
	 * expected value, which would just restate the implementation.
	 *
	 * The tolerance is 8-bit rounding, expressed in channel units so it does not
	 * depend on how far apart the two colours happen to be. (A `t`-space tolerance
	 * would: with target red 0xe6 the line spans only 25 levels, so a single LSB is
	 * already 0.04 in `t`.)
	 */
	test("recoloured pixels stay on the target-to-white line, so edges do not tint", async () => {
		const source = await readIcon("frontend/public/pwa-512x512.png");
		const before = decodeRgbaPng(source);
		const recolored = recolorBrandPng(source, TARGET_HEX);
		expect(before).not.toBeNull();
		expect(recolored).not.toBeNull();
		if (!before || !recolored) return;
		const after = decodeRgbaPng(recolored);
		if (!after) return;

		let blendPixels = 0;
		let worstDeviation = 0;

		for (let i = 0; i < before.pixels.length; i += 4) {
			if (before.pixels[i + 3] === 0) continue;

			// Position along the line, taken from the channel with the longest span so
			// the estimate is least affected by quantization.
			const spans = TARGET_RGB.map((c) => 255 - c);
			let axis = 0;
			for (let k = 1; k < 3; k++) if (spans[k] > spans[axis]) axis = k;
			const t = (after.pixels[i + axis] - TARGET_RGB[axis]) / spans[axis];

			for (let k = 0; k < 3; k++) {
				const expected = TARGET_RGB[k] + t * (255 - TARGET_RGB[k]);
				worstDeviation = Math.max(worstDeviation, Math.abs(after.pixels[i + k] - expected));
			}

			// Count genuine antialiased pixels (neither pure accent nor pure white) so
			// the assertion below is known to have covered the interesting case.
			if (t > 0.15 && t < 0.85) blendPixels++;
		}

		// 1.5 channel levels: one rounding step on the sampled axis plus one on the
		// channel being checked.
		expect(worstDeviation).toBeLessThanOrEqual(1.5);
		expect(blendPixels).toBeGreaterThan(50);
	});

	/**
	 * Exact check on a synthetic image whose blend factors are known by construction,
	 * so the expected output can be computed independently of the recolour code.
	 */
	test("a known accent-to-white gradient maps to the exact target gradient", async () => {
		const width = 256;
		const pixels = Buffer.alloc(width * 4);
		for (let x = 0; x < width; x++) {
			const t = x / (width - 1);
			for (let k = 0; k < 3; k++) {
				pixels[x * 4 + k] = Math.round(BRAND_RGB[k] + t * (255 - BRAND_RGB[k]));
			}
			pixels[x * 4 + 3] = 255;
		}

		const recolored = recolorBrandPng(encodeRgbaPng(width, 1, pixels), TARGET_HEX);
		expect(recolored).not.toBeNull();
		if (!recolored) return;
		const after = decodeRgbaPng(recolored);
		if (!after) return;

		for (let x = 0; x < width; x++) {
			const t = x / (width - 1);
			for (let k = 0; k < 3; k++) {
				const expected = TARGET_RGB[k] + t * (255 - TARGET_RGB[k]);
				// ±1.5 absorbs the rounding already baked into the synthetic input.
				expect(Math.abs(after.pixels[x * 4 + k] - expected)).toBeLessThanOrEqual(1.5);
			}
		}
	});

	test("the default colour short-circuits without re-encoding", async () => {
		const source = await readIcon("frontend/public/pwa-512x512.png");
		// Identity is asserted, not just equality: an unbranded instance must pay
		// nothing, and a copy would mean the codec ran.
		expect(recolorBrandPng(source, DEFAULT_BRAND_ICON_COLOR)).toBe(source);
	});

	test("an unparseable colour returns null so the caller serves the original", async () => {
		const source = await readIcon("frontend/public/pwa-512x512.png");
		expect(recolorBrandPng(source, "chartreuse")).toBeNull();
	});
});

describe("decodeRgbaPng rejects shapes it cannot handle", () => {
	test("non-RGBA colour type", () => {
		// colorType 2 is RGB without alpha — a valid PNG this module must decline
		// rather than misread as 4-byte pixels.
		expect(
			decodeRgbaPng(makePng({ width: 2, height: 2, bitDepth: 8, colorType: 2, bytesPerPixel: 3 })),
		).toBeNull();
	});

	test("non-8-bit depth", () => {
		expect(
			decodeRgbaPng(makePng({ width: 2, height: 2, bitDepth: 16, colorType: 6, bytesPerPixel: 8 })),
		).toBeNull();
	});

	test("interlaced", () => {
		expect(
			decodeRgbaPng(
				makePng({ width: 2, height: 2, bitDepth: 8, colorType: 6, interlace: 1, bytesPerPixel: 4 }),
			),
		).toBeNull();
	});

	test("not a PNG at all", () => {
		expect(decodeRgbaPng(new Uint8Array([1, 2, 3, 4]))).toBeNull();
		expect(decodeRgbaPng(new TextEncoder().encode("<svg/>"))).toBeNull();
	});

	test("a chunk length past the end of the buffer", () => {
		// Truncated or lying input: there is nothing safe to read, so it must not be
		// treated as a partially valid image.
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(2, 0);
		ihdr.writeUInt32BE(2, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		const good = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr)]);
		const bogusLength = Buffer.alloc(12);
		bogusLength.writeUInt32BE(0xffff, 0);
		bogusLength.write("IDAT", 4, "ascii");
		expect(decodeRgbaPng(new Uint8Array(Buffer.concat([good, bogusLength])))).toBeNull();
	});
});

describe("encodeRgbaPng round trip", () => {
	test("preserves dimensions and every pixel", () => {
		const width = 3;
		const height = 2;
		const pixels = Buffer.from([
			// biome-ignore format: one row per line reads as an image
			10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0,
			// biome-ignore format: one row per line reads as an image
			100, 110, 120, 255, 130, 140, 150, 64, 160, 170, 180, 255,
		]);
		const decoded = decodeRgbaPng(encodeRgbaPng(width, height, pixels));
		expect(decoded).not.toBeNull();
		if (!decoded) return;
		expect(decoded.width).toBe(width);
		expect(decoded.height).toBe(height);
		expect(Buffer.compare(decoded.pixels, pixels)).toBe(0);
	});
});
