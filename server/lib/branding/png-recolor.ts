/**
 * Minimal PNG decode/encode, just enough to recolour the shipped brand icons.
 *
 * Why hand-rolled instead of a library: the only images this touches are three
 * files in `frontend/public/` whose exact shape is known (8-bit RGBA, no
 * interlacing), and the alternative was adding an image dependency to a server
 * that otherwise has none. `node:zlib` already provides the only hard part.
 *
 * Scope is deliberately narrow. Anything that is not 8-bit RGBA non-interlaced
 * returns null so the caller can serve the ORIGINAL asset untouched. That matters
 * because these are repository assets, not user uploads: if a future logo ships in
 * a different form, the correct failure is "icons stay NarraFork indigo", not a
 * corrupt PNG that some browsers render and others reject.
 */

import { deflateSync, inflateSync } from "node:zlib";
import { DEFAULT_BRAND_ICON_COLOR, parseHexColor } from "@shared/branding";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RGBA — the only colour type this module handles. */
const COLOR_TYPE_RGBA = 6;
const BYTES_PER_PIXEL = 4;

/**
 * Upper bound on decoded pixel count (~16.7M, i.e. 4096x4096).
 *
 * The dimensions come from the file's own IHDR, so an inflated header could ask
 * for a multi-gigabyte allocation on the single-threaded server. The shipped
 * assets are at most 512x512; this bound leaves generous headroom while keeping
 * a malformed header from turning into a memory spike.
 */
const MAX_PIXELS = 4096 * 4096;

interface DecodedPng {
	width: number;
	height: number;
	/** Row-major RGBA bytes, `width * height * 4` long. */
	pixels: Buffer;
}

let crcTable: Int32Array | null = null;

function getCrcTable(): Int32Array {
	if (crcTable) return crcTable;
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	crcTable = table;
	return table;
}

/** CRC-32 as specified by PNG. `node:zlib` does not expose one. */
function crc32(buf: Buffer): number {
	const table = getCrcTable();
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function buildChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeBytes = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
	return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Decode an 8-bit RGBA non-interlaced PNG. Returns null for every other shape
 * and for structurally invalid input — see the module header.
 */
export function decodeRgbaPng(input: Uint8Array): DecodedPng | null {
	const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

	let offset = 8;
	let header: { width: number; height: number } | null = null;
	const idatParts: Buffer[] = [];

	while (offset + 12 <= buf.length) {
		const length = buf.readUInt32BE(offset);
		// A declared length past the end of the buffer means the file is truncated
		// or lying; either way there is nothing safe to read.
		if (length > buf.length - offset - 12) return null;
		const type = buf.toString("ascii", offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + length);

		if (type === "IHDR") {
			if (length < 13) return null;
			const bitDepth = data[8];
			const colorType = data[9];
			const interlace = data[12];
			if (bitDepth !== 8 || colorType !== COLOR_TYPE_RGBA || interlace !== 0) return null;
			const width = data.readUInt32BE(0);
			const height = data.readUInt32BE(4);
			if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) return null;
			header = { width, height };
		} else if (type === "IDAT") {
			idatParts.push(Buffer.from(data));
		} else if (type === "IEND") {
			break;
		}

		offset += 12 + length;
	}

	if (!header || idatParts.length === 0) return null;

	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idatParts));
	} catch {
		return null;
	}

	const { width, height } = header;
	const stride = width * BYTES_PER_PIXEL;
	if (raw.length < height * (stride + 1)) return null;

	const pixels = Buffer.alloc(height * stride);
	let cursor = 0;
	for (let y = 0; y < height; y++) {
		const filterType = raw[cursor++];
		const line = raw.subarray(cursor, cursor + stride);
		cursor += stride;
		const rowStart = y * stride;
		const prevRowStart = rowStart - stride;

		for (let x = 0; x < stride; x++) {
			const left = x >= BYTES_PER_PIXEL ? pixels[rowStart + x - BYTES_PER_PIXEL] : 0;
			const up = y > 0 ? pixels[prevRowStart + x] : 0;
			const upLeft = x >= BYTES_PER_PIXEL && y > 0 ? pixels[prevRowStart + x - BYTES_PER_PIXEL] : 0;
			let value = line[x];

			switch (filterType) {
				case 0:
					break;
				case 1:
					value = (value + left) & 0xff;
					break;
				case 2:
					value = (value + up) & 0xff;
					break;
				case 3:
					value = (value + ((left + up) >> 1)) & 0xff;
					break;
				case 4: {
					// Paeth: pick whichever neighbour the gradient predictor is closest to.
					// The shipped assets DO use this filter, so it is exercised in practice.
					const pa = Math.abs(up - upLeft);
					const pb = Math.abs(left - upLeft);
					const pc = Math.abs(left + up - 2 * upLeft);
					const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
					value = (value + predictor) & 0xff;
					break;
				}
				default:
					// Unknown filter type — the stream is not a PNG we understand.
					return null;
			}

			pixels[rowStart + x] = value;
		}
	}

	return { width, height, pixels };
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * Always uses filter type 0 (None) with max deflate. Measured on the shipped
 * 512x512 icon this produces a SMALLER file than the original (7.9 KB vs 10.2 KB),
 * so searching per-row filters would add complexity for no benefit.
 */
export function encodeRgbaPng(width: number, height: number, pixels: Buffer): Buffer {
	const stride = width * BYTES_PER_PIXEL;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = COLOR_TYPE_RGBA;
	// bytes 10-12 stay zero: deflate compression, adaptive filtering, no interlace.

	return Buffer.concat([
		PNG_SIGNATURE,
		buildChunk("IHDR", ihdr),
		buildChunk("IDAT", deflateSync(raw, { level: 9 })),
		buildChunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Recolour the brand accent in an RGBA buffer, in place on a copy.
 *
 * The icons are built from exactly two colours — the indigo square and white
 * strokes — plus antialiased blends between them. So each opaque pixel is treated
 * as `p ≈ t·white + (1-t)·brand`, `t` is recovered by least squares across the
 * three channels, and the pixel is rebuilt as `t·white + (1-t)·target`. Pure
 * indigo becomes pure target, pure white stays pure white, and edge pixels keep
 * their exact blend ratio — so the recoloured icon is as smooth as the original.
 *
 * A per-channel scale would have been wrong: scaling a white pixel by the ratio
 * of two accent colours tints the strokes, which is visible as a dirty outline at
 * favicon size.
 *
 * Alpha is copied untouched; fully transparent pixels are skipped entirely so the
 * rounded-corner cutouts cannot pick up a colour fringe.
 */
export function recolorRgbaPixels(
	pixels: Buffer,
	targetColor: [number, number, number],
	sourceColor: [number, number, number],
): Buffer {
	const out = Buffer.from(pixels);
	let denominator = 0;
	for (let k = 0; k < 3; k++) {
		const d = 255 - sourceColor[k];
		denominator += d * d;
	}
	// A source colour of pure white leaves no axis to project onto; there is no
	// meaningful blend to preserve, so leave the pixels alone.
	if (denominator === 0) return out;

	for (let i = 0; i < out.length; i += BYTES_PER_PIXEL) {
		if (out[i + 3] === 0) continue;
		let numerator = 0;
		for (let k = 0; k < 3; k++) {
			numerator += (out[i + k] - sourceColor[k]) * (255 - sourceColor[k]);
		}
		let t = numerator / denominator;
		if (t < 0) t = 0;
		else if (t > 1) t = 1;
		for (let k = 0; k < 3; k++) {
			out[i + k] = Math.round(targetColor[k] + t * (255 - targetColor[k]));
		}
	}

	return out;
}

/**
 * Recolour a brand PNG. Returns null when the input is not a shape this module
 * handles, or when the target colour is unparseable — the caller then serves the
 * original bytes.
 *
 * Returns the input unchanged (same reference semantics as a copy is not needed)
 * when the target equals the source, so a default install pays nothing.
 */
export function recolorBrandPng(
	input: Uint8Array,
	targetColorHex: string,
	sourceColorHex: string = DEFAULT_BRAND_ICON_COLOR,
): Uint8Array | null {
	const target = parseHexColor(targetColorHex);
	const source = parseHexColor(sourceColorHex);
	if (!target || !source) return null;
	if (target[0] === source[0] && target[1] === source[1] && target[2] === source[2]) {
		return input;
	}

	const decoded = decodeRgbaPng(input);
	if (!decoded) return null;

	const recolored = recolorRgbaPixels(decoded.pixels, target, source);
	return encodeRgbaPng(decoded.width, decoded.height, recolored);
}
