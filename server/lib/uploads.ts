import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ValidationError } from "./errors";
import { generateShortId } from "./id";
import { logger } from "./logger";

const DEFAULT_UPLOADS_DIR = resolve(homedir(), ".narrafork", "uploads");
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

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB — images are loaded into memory for processing
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

export interface ImageRef {
	imageId: string;
	filename: string;
	mediaType: string;
	/** Original narrator that owns the uploaded image file. */
	uploadNarratorId?: string;
}

export async function saveUploadedImage(narratorId: string, file: File): Promise<ImageRef> {
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

	const imageId = generateShortId();
	const ext = MIME_TO_EXT[file.type] ?? (extname(file.name) || ".bin");
	const uploadsDir = getUploadsDir();
	const dir = resolve(uploadsDir, narratorId);
	if (!isWithinDir(uploadsDir, dir)) {
		throw new ValidationError("Invalid narrator ID");
	}
	mkdirSync(dir, { recursive: true });

	const filePath = resolve(dir, `${imageId}${ext}`);
	const buffer = await file.arrayBuffer();
	await Bun.write(filePath, buffer);

	logger.info("Image uploaded", { narratorId, imageId, size: file.size });

	return { imageId, filename: file.name, mediaType: file.type };
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
 * Read an image file and return its base64 encoding + detected real format.
 * The returned `detectedMediaType` reflects the actual file content (e.g. a
 * file named `.jpg` that is really PNG will return `image/png`). Callers
 * should prefer this over the stored mediaType when sending to AI providers.
 */
export async function imageToBase64(filePath: string): Promise<ImageBase64Result> {
	const buf = Buffer.from(await Bun.file(filePath).arrayBuffer());
	const detectedMediaType = detectImageMime(buf);
	if (detectedMediaType) {
		const ext = extname(filePath).toLowerCase();
		const extMime: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
		};
		if (extMime[ext] && extMime[ext] !== detectedMediaType) {
			logger.debug("Image format mismatch: extension vs content", {
				filePath,
				extension: ext,
				detected: detectedMediaType,
			});
		}
	}
	return { base64: buf.toString("base64"), detectedMediaType };
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

/**
 * Save a text file into the worktree's `.narrafork/attached/` directory
 * using the original filename. Returns the absolute path.
 */
export async function saveTextFileToWorktree(cwd: string, file: File): Promise<TextFileRef> {
	const dir = resolve(cwd, ".narrafork", "attached");
	mkdirSync(dir, { recursive: true });

	// Use original filename, but sanitize path separators
	const safeName = (file.name.split("/").pop() ?? file.name).replace(/[\\/:*?"<>|]/g, "_");
	let filePath = resolve(dir, safeName);

	// If file already exists, add a short suffix to avoid overwriting
	if (existsSync(filePath)) {
		const base = safeName.replace(/(\.[^.]+)$/, "");
		const ext2 = extname(safeName) || "";
		filePath = resolve(dir, `${base}_${generateShortId()}${ext2}`);
	}

	// Belt-and-suspenders: ensure we're still inside the target dir
	if (!filePath.startsWith(dir)) {
		throw new ValidationError("Invalid filename");
	}

	const buffer = await file.arrayBuffer();
	await Bun.write(filePath, buffer);

	logger.info("Text file saved to worktree", {
		cwd,
		filename: file.name,
		filePath,
		size: file.size,
	});

	return { filename: file.name, filePath, size: file.size };
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

	const imageId = generateShortId();
	const ext = MIME_TO_EXT[file.type] ?? ".bin";
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
	const buffer = await file.arrayBuffer();
	await Bun.write(filePath, buffer);

	logger.info("Avatar uploaded", { userId, imageId, size: file.size });
	return { imageId, filename: file.name, mediaType: file.type };
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
