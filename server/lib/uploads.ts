import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ValidationError } from "./errors";
import { generateShortId } from "./id";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";

const DEFAULT_UPLOADS_DIR = getNarraforkPath("uploads");
let uploadsDirTestOverride: string | null = null;

function isWithinDir(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Tests only: override the uploads root for this process. */
export function setUploadsDirForTests(dir?: string | null): void {
	uploadsDirTestOverride = dir ? resolve(dir) : null;
}

export function getUploadsDir(): string {
	return uploadsDirTestOverride ?? DEFAULT_UPLOADS_DIR;
}

function getAvatarsDir(): string {
	return resolve(getUploadsDir(), "avatars");
}

export function contentJsonHasImageBlocks(contentJson: unknown): boolean {
	if (!Array.isArray(contentJson)) return false;
	return contentJson.some((block) => {
		if (!block || typeof block !== "object") return false;
		const candidate = block as { type?: unknown; imageId?: unknown };
		return candidate.type === "image" && typeof candidate.imageId === "string";
	});
}

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB — images are loaded into memory for processing
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB
/** Only this prefix is inspected, keeping JPEG marker scans and metadata reads bounded. */
export const MAX_IMAGE_HEADER_SIZE = 256 * 1024;
export const MAX_IMAGE_DIMENSION = 32_768;
export const MAX_IMAGE_PIXELS = 100_000_000;
/**
 * Hard cap on how many JPEG markers / WebP chunks the header parsers will walk
 * before giving up. A malicious file can pack the 256 KiB header prefix with
 * thousands of tiny segments; bounding the loop keeps parsing O(bounded) on the
 * main thread. Normal images use only a handful of segments, so exceeding this
 * count means the input is pathological and is treated as unparseable.
 */
export const MAX_IMAGE_SEGMENT_SCANS = 4096;

export interface ImageRef {
	imageId: string;
	filename: string;
	mediaType: string;
	width?: number;
	height?: number;
	/** Original narrator that owns the uploaded image file. */
	uploadNarratorId?: string;
}

export interface ImageDimensions {
	width: number;
	height: number;
}

function readUint24LE(buf: Buffer, offset: number): number | undefined {
	if (offset < 0 || offset + 3 > buf.length) return undefined;
	return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function parsePngDimensions(buf: Buffer): ImageDimensions | undefined {
	if (
		buf.length < 24 ||
		buf[0] !== 0x89 ||
		buf[1] !== 0x50 ||
		buf[2] !== 0x4e ||
		buf[3] !== 0x47 ||
		buf[4] !== 0x0d ||
		buf[5] !== 0x0a ||
		buf[6] !== 0x1a ||
		buf[7] !== 0x0a ||
		buf.toString("ascii", 12, 16) !== "IHDR"
	) {
		return undefined;
	}
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseGifDimensions(buf: Buffer): ImageDimensions | undefined {
	if (buf.length < 10) return undefined;
	const signature = buf.toString("ascii", 0, 6);
	if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
	return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function parseWebpDimensions(buf: Buffer): ImageDimensions | undefined {
	if (
		buf.length < 20 ||
		buf.toString("ascii", 0, 4) !== "RIFF" ||
		buf.toString("ascii", 8, 12) !== "WEBP"
	) {
		return undefined;
	}

	let offset = 12;
	let scans = 0;
	while (offset + 8 <= buf.length) {
		if (++scans > MAX_IMAGE_SEGMENT_SCANS) return undefined;
		const chunkType = buf.toString("ascii", offset, offset + 4);
		const chunkSize = buf.readUInt32LE(offset + 4);
		const dataOffset = offset + 8;
		const availableSize = Math.min(chunkSize, buf.length - dataOffset);

		if (chunkType === "VP8X" && availableSize >= 10) {
			const width = readUint24LE(buf, dataOffset + 4);
			const height = readUint24LE(buf, dataOffset + 7);
			if (width !== undefined && height !== undefined) {
				return { width: width + 1, height: height + 1 };
			}
		}
		if (
			chunkType === "VP8 " &&
			availableSize >= 10 &&
			buf[dataOffset + 3] === 0x9d &&
			buf[dataOffset + 4] === 0x01 &&
			buf[dataOffset + 5] === 0x2a
		) {
			return {
				width: buf.readUInt16LE(dataOffset + 6) & 0x3fff,
				height: buf.readUInt16LE(dataOffset + 8) & 0x3fff,
			};
		}
		if (chunkType === "VP8L" && availableSize >= 5 && buf[dataOffset] === 0x2f) {
			const b1 = buf[dataOffset + 1];
			const b2 = buf[dataOffset + 2];
			const b3 = buf[dataOffset + 3];
			const b4 = buf[dataOffset + 4];
			return {
				width: 1 + b1 + ((b2 & 0x3f) << 8),
				height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
			};
		}

		const nextOffset = dataOffset + chunkSize + (chunkSize & 1);
		if (nextOffset <= offset || nextOffset > buf.length) break;
		offset = nextOffset;
	}
	return undefined;
}

function parseExifOrientation(
	buf: Buffer,
	dataOffset: number,
	dataLength: number,
): number | undefined {
	const dataEnd = dataOffset + dataLength;
	if (
		dataLength < 14 ||
		dataEnd > buf.length ||
		buf.toString("ascii", dataOffset, dataOffset + 6) !== "Exif\0\0"
	) {
		return undefined;
	}

	const tiffOffset = dataOffset + 6;
	const byteOrder = buf.toString("ascii", tiffOffset, tiffOffset + 2);
	const littleEndian = byteOrder === "II";
	if (!littleEndian && byteOrder !== "MM") return undefined;

	const read16 = (offset: number): number | undefined => {
		if (offset < tiffOffset || offset + 2 > dataEnd) return undefined;
		return littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
	};
	const read32 = (offset: number): number | undefined => {
		if (offset < tiffOffset || offset + 4 > dataEnd) return undefined;
		return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
	};

	if (read16(tiffOffset + 2) !== 42) return undefined;
	const ifdRelativeOffset = read32(tiffOffset + 4);
	if (ifdRelativeOffset === undefined) return undefined;
	const ifdOffset = tiffOffset + ifdRelativeOffset;
	const entryCount = read16(ifdOffset);
	if (entryCount === undefined) return undefined;

	const maxEntries = Math.min(entryCount, Math.floor((dataEnd - (ifdOffset + 2)) / 12));
	for (let i = 0; i < maxEntries; i++) {
		const entryOffset = ifdOffset + 2 + i * 12;
		if (read16(entryOffset) !== 0x0112) continue;
		if (read16(entryOffset + 2) !== 3 || read32(entryOffset + 4) !== 1) return undefined;
		const orientation = read16(entryOffset + 8);
		return orientation !== undefined && orientation >= 1 && orientation <= 8
			? orientation
			: undefined;
	}
	return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function parseJpegDimensions(buf: Buffer): ImageDimensions | undefined {
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;

	let offset = 2;
	let scans = 0;
	let orientation: number | undefined;
	let dimensions: ImageDimensions | undefined;
	while (offset < buf.length) {
		if (++scans > MAX_IMAGE_SEGMENT_SCANS) return undefined;
		while (offset < buf.length && buf[offset] !== 0xff) offset++;
		while (offset < buf.length && buf[offset] === 0xff) offset++;
		if (offset >= buf.length) break;

		const marker = buf[offset++];
		if (marker === 0xd9 || marker === 0xda) break;
		if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
		if (offset + 2 > buf.length) break;

		const segmentLength = buf.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > buf.length) break;
		const dataOffset = offset + 2;
		const dataLength = segmentLength - 2;

		if (marker === 0xe1 && orientation === undefined) {
			orientation = parseExifOrientation(buf, dataOffset, dataLength);
		}
		if (isJpegStartOfFrame(marker) && dataLength >= 6) {
			dimensions = {
				width: buf.readUInt16BE(dataOffset + 3),
				height: buf.readUInt16BE(dataOffset + 1),
			};
		}
		offset += segmentLength;
	}

	if (!dimensions) return undefined;
	if (orientation !== undefined && orientation >= 5) {
		return { width: dimensions.height, height: dimensions.width };
	}
	return dimensions;
}

/**
 * A Buffer view over the bounded header prefix of an image, without copying the
 * (up to 20 MiB) payload. `Buffer.from(uint8array)` copies the whole array, so
 * we build a view over the underlying ArrayBuffer instead — parsing only ever
 * touches this bounded prefix on the main thread.
 */
function imageHeaderView(bytes: Uint8Array): Buffer {
	const headerLen = Math.min(bytes.length, MAX_IMAGE_HEADER_SIZE);
	return Buffer.isBuffer(bytes)
		? bytes.subarray(0, headerLen)
		: Buffer.from(bytes.buffer, bytes.byteOffset, headerLen);
}

/** Parse dimensions from a bounded PNG/JPEG/GIF/WebP byte prefix. */
export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
	const buf = imageHeaderView(bytes);
	return (
		parsePngDimensions(buf) ??
		parseJpegDimensions(buf) ??
		parseGifDimensions(buf) ??
		parseWebpDimensions(buf)
	);
}

function validateImageDimensions(dimensions: ImageDimensions | undefined): void {
	if (!dimensions) return;
	const { width, height } = dimensions;
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		width > MAX_IMAGE_DIMENSION ||
		height > MAX_IMAGE_DIMENSION ||
		width * height > MAX_IMAGE_PIXELS
	) {
		throw new ValidationError(
			`Image dimensions too large: ${width}x${height}. Max side: ${MAX_IMAGE_DIMENSION}px; max pixels: ${MAX_IMAGE_PIXELS}.`,
		);
	}
}

export function validateUploadedImage(file: File): void {
	if (!ALLOWED_MIME_TYPES.has(file.type)) {
		throw new ValidationError(
			`Unsupported image type: ${file.type}. Supported: PNG, JPEG, GIF, WebP`,
		);
	}
	if (file.size > MAX_IMAGE_SIZE) {
		throw new ValidationError(
			`Image too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 20MB`,
		);
	}
}

export interface ProcessedImageUpload {
	/** The image payload, read from the File exactly once and reused for the write. */
	bytes: Uint8Array;
	dimensions: ImageDimensions;
	/** Real media type sniffed from the content magic bytes. */
	detectedMediaType: string;
}

/**
 * Read an uploaded image's bytes exactly once and derive everything needed to
 * persist it: the content-sniffed media type and the pixel dimensions. The
 * returned {@link ProcessedImageUpload.bytes} are reused for the write to disk,
 * so the (up to 20 MiB) payload is never read from the File twice — only a
 * bounded header prefix is ever scanned on the main thread.
 *
 * Fail-closed: a file that declares an image MIME type but whose magic bytes do
 * not match a supported format, or whose dimensions cannot be parsed, is
 * rejected rather than silently stored. This blocks disguised or corrupt
 * uploads from later being served back as images or sent to AI providers.
 * Callers must validate the declared MIME type and size *before* calling this.
 */
async function processImageUpload(file: File): Promise<ProcessedImageUpload> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const detectedMediaType = detectImageMime(imageHeaderView(bytes));
	if (!detectedMediaType) {
		throw new ValidationError(
			"Unrecognized image content: file does not match a supported PNG, JPEG, GIF, or WebP signature.",
		);
	}
	if (detectedMediaType !== file.type) {
		throw new ValidationError(
			`Image content type mismatch: declared ${file.type}, detected ${detectedMediaType}.`,
		);
	}
	const dimensions = parseImageDimensions(bytes);
	if (!dimensions) {
		throw new ValidationError("Unable to parse image dimensions from file content.");
	}
	validateImageDimensions(dimensions);
	return { bytes, dimensions, detectedMediaType };
}

export async function saveUploadedImage(narratorId: string, file: File): Promise<ImageRef> {
	validateUploadedImage(file);
	const { bytes, dimensions, detectedMediaType } = await processImageUpload(file);

	const imageId = generateShortId();
	const ext = MIME_TO_EXT[detectedMediaType] ?? (extname(file.name) || ".bin");
	const uploadsDir = getUploadsDir();
	const dir = resolve(uploadsDir, narratorId);
	if (!isWithinDir(uploadsDir, dir)) {
		throw new ValidationError("Invalid narrator ID");
	}
	mkdirSync(dir, { recursive: true });

	const filePath = resolve(dir, `${imageId}${ext}`);
	try {
		await Bun.write(filePath, bytes);
	} catch (error) {
		rmSync(filePath, { force: true });
		throw error;
	}

	logger.info("Image uploaded", { narratorId, imageId, size: file.size });

	return {
		imageId,
		filename: file.name,
		mediaType: detectedMediaType,
		uploadNarratorId: narratorId,
		...dimensions,
	};
}

export function getImagePath(narratorId: string, imageId: string): string | null {
	const uploadsDir = getUploadsDir();
	const dir = resolve(uploadsDir, narratorId);
	if (!isWithinDir(uploadsDir, dir)) return null; // prevent path traversal
	if (!existsSync(dir)) return null;

	const files = readdirSync(dir);
	const match = files.find((f) => f.startsWith(imageId));
	if (!match) return null;

	const filePath = resolve(dir, match);
	if (!isWithinDir(dir, filePath)) return null; // belt-and-suspenders
	return filePath;
}

export function getUploadedImageInfo(
	narratorId: string,
	imageId: string,
): { filePath: string; size: number } | null {
	const filePath = getImagePath(narratorId, imageId);
	if (!filePath) return null;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile()) return null;
		return { filePath, size: stat.size };
	} catch {
		return null;
	}
}

/** Delete one image created during a failed pre-commit attachment edit. */
export function deleteUploadedImage(narratorId: string, imageId: string): void {
	const filePath = getImagePath(narratorId, imageId);
	if (filePath) rmSync(filePath, { force: true });
}

/** Delete worktree attachment files created during a failed pre-commit edit. */
export function deleteCreatedAttachmentFiles(filePaths: Iterable<string>): void {
	for (const filePath of filePaths) rmSync(filePath, { force: true });
}

/**
 * Detect the real image MIME type from file content magic bytes.
 * Returns undefined if the format is unrecognized.
 */
function detectImageMime(buf: Buffer): string | undefined {
	if (buf.length < 4) return undefined;
	// PNG: 89 50 4E 47
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return "image/png";
	}
	// JPEG: FF D8 FF
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	// GIF: 47 49 46 38
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
		return "image/gif";
	}
	// WebP: RIFF....WEBP
	if (
		buf.length >= 12 &&
		buf[0] === 0x52 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x46 &&
		buf[8] === 0x57 &&
		buf[9] === 0x45 &&
		buf[10] === 0x42 &&
		buf[11] === 0x50
	) {
		return "image/webp";
	}
	return undefined;
}

export interface ImageBase64Result {
	base64: string;
	/** The real media type detected from file content (may differ from the stored mediaType). */
	detectedMediaType?: string;
}

/**
 * Encode already-read image bytes to base64 + detect the real format from the
 * content magic bytes. Used both by {@link imageToBase64} (local files) and by
 * the Read tool when it fetches image bytes from a remote execution device, so
 * remote images are handled identically without a filesystem round trip.
 */
export function imageBytesToBase64(bytes: Uint8Array): ImageBase64Result {
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	const detectedMediaType = detectImageMime(buf);
	return { base64: buf.toString("base64"), detectedMediaType };
}

/**
 * Read an image file and return its base64 encoding + detected real format.
 * The returned `detectedMediaType` reflects the actual file content (e.g. a
 * file named `.jpg` that is really PNG will return `image/png`). Callers
 * should prefer this over the stored mediaType when sending to AI providers.
 */
export async function imageToBase64(filePath: string): Promise<ImageBase64Result> {
	const buf = Buffer.from(await Bun.file(filePath).arrayBuffer());
	const result = imageBytesToBase64(buf);
	if (result.detectedMediaType) {
		const ext = extname(filePath).toLowerCase();
		const extMime: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
		};
		if (extMime[ext] && extMime[ext] !== result.detectedMediaType) {
			logger.debug("Image format mismatch: extension vs content", {
				filePath,
				extension: ext,
				detected: result.detectedMediaType,
			});
		}
	}
	return result;
}

// === Text file uploads ===

import { isTextFile, MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";

export { MAX_TEXT_FILE_SIZE };

export interface TextFileRef {
	filename: string;
	/** Absolute path where the file was saved (inside the worktree). */
	filePath: string;
	size: number;
}

/**
 * Validate a text file upload (type + size). Does NOT save the file.
 * Saving happens later in feedMessage when the worktree cwd is known.
 */
export function validateTextFile(file: File): void {
	if (!isTextFile(file.name)) {
		throw new ValidationError(
			`Unsupported text file type: ${file.name}. Only common text and code files are allowed.`,
		);
	}
	if (file.size > MAX_TEXT_FILE_SIZE) {
		throw new ValidationError(
			`Text file too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 100MB`,
		);
	}
}

function allocateWorktreeAttachmentPath(cwd: string, filename: string): string {
	const dir = resolve(cwd, ".narrafork", "attached");
	mkdirSync(dir, { recursive: true });

	const safeName = (filename.split("/").pop() ?? filename).replace(/[\\/:*?"<>|]/g, "_");
	let filePath = resolve(dir, safeName);
	if (existsSync(filePath)) {
		const base = safeName.replace(/(\.[^.]+)$/, "");
		const ext2 = extname(safeName) || "";
		filePath = resolve(dir, `${base}_${generateShortId()}${ext2}`);
	}
	if (!isWithinDir(dir, filePath)) throw new ValidationError("Invalid filename");
	return filePath;
}

export function isFileWithinWorktree(cwd: string, filePath: string): boolean {
	return isWithinDir(resolve(cwd), resolve(filePath));
}

/**
 * Save a text file into the worktree's `.narrafork/attached/` directory
 * using the original filename. Returns the absolute path.
 */
export async function saveTextFileToWorktree(cwd: string, file: File): Promise<TextFileRef> {
	const filePath = allocateWorktreeAttachmentPath(cwd, file.name);
	try {
		const buffer = await file.arrayBuffer();
		await Bun.write(filePath, buffer);
	} catch (error) {
		rmSync(filePath, { force: true });
		throw error;
	}

	logger.info("Text file saved to worktree", {
		cwd,
		filename: file.name,
		filePath,
		size: file.size,
	});

	return { filename: file.name, filePath, size: file.size };
}

/** Copy a modern text attachment into the active worktree without loading it all into JS memory. */
export async function copyTextFileToWorktree(
	cwd: string,
	source: TextFileRef,
): Promise<TextFileRef> {
	const sourceFile = Bun.file(source.filePath);
	if (!(await sourceFile.exists())) {
		throw new ValidationError(`Attached file not found: ${source.filename}`);
	}
	const filePath = allocateWorktreeAttachmentPath(cwd, source.filename);
	try {
		await Bun.write(filePath, sourceFile);
	} catch (error) {
		rmSync(filePath, { force: true });
		throw error;
	}
	return { filename: source.filename, filePath, size: source.size };
}

export async function deleteNarratorUploads(narratorId: string): Promise<void> {
	const uploadsDir = getUploadsDir();
	const dir = resolve(uploadsDir, narratorId);
	if (!isWithinDir(uploadsDir, dir)) return;
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
		logger.info("Narrator uploads cleaned up", { narratorId });
	}
}

// === Avatar uploads ===

const AVATAR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function saveAvatarImage(userId: string, file: File): Promise<ImageRef> {
	if (!AVATAR_MIME_TYPES.has(file.type)) {
		throw new ValidationError(`Unsupported avatar type: ${file.type}. Supported: PNG, JPEG, WebP`);
	}
	if (file.size > MAX_AVATAR_SIZE) {
		throw new ValidationError(
			`Avatar too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 2MB`,
		);
	}
	// Shares the upload pipeline: bytes are read once, the content is sniffed
	// and dimensions parsed (fail-closed), and the same buffer is written to disk.
	const { bytes, dimensions, detectedMediaType } = await processImageUpload(file);

	const imageId = generateShortId();
	const ext = MIME_TO_EXT[detectedMediaType] ?? ".bin";
	const avatarsDir = getAvatarsDir();
	const dir = resolve(avatarsDir, userId);
	if (!isWithinDir(avatarsDir, dir)) {
		throw new ValidationError("Invalid user ID");
	}

	// Remove old avatar files before saving new one
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
	mkdirSync(dir, { recursive: true });

	const filePath = resolve(dir, `${imageId}${ext}`);
	try {
		await Bun.write(filePath, bytes);
	} catch (error) {
		rmSync(filePath, { force: true });
		throw error;
	}

	logger.info("Avatar uploaded", { userId, imageId, size: file.size });
	return { imageId, filename: file.name, mediaType: detectedMediaType, ...dimensions };
}

export function getAvatarPath(userId: string, imageId: string): string | null {
	const avatarsDir = getAvatarsDir();
	const dir = resolve(avatarsDir, userId);
	if (!isWithinDir(avatarsDir, dir)) return null;
	if (!existsSync(dir)) return null;

	const files = readdirSync(dir);
	const match = files.find((f) => f.startsWith(imageId));
	if (!match) return null;

	const filePath = resolve(dir, match);
	if (!isWithinDir(dir, filePath)) return null;
	return filePath;
}

export function deleteAvatarImage(userId: string): void {
	const avatarsDir = getAvatarsDir();
	const dir = resolve(avatarsDir, userId);
	if (!isWithinDir(avatarsDir, dir)) return;
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
		logger.info("Avatar deleted", { userId });
	}
}
