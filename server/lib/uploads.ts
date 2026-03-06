import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { ValidationError } from "./errors";
import { generateShortId } from "./id";
import { logger } from "./logger";

const UPLOADS_DIR = resolve(homedir(), ".narrafork", "uploads");
const AVATARS_DIR = resolve(UPLOADS_DIR, "avatars");

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

export interface ImageRef {
	imageId: string;
	filename: string;
	mediaType: string;
}

export async function saveUploadedImage(narratorId: string, file: File): Promise<ImageRef> {
	if (!ALLOWED_MIME_TYPES.has(file.type)) {
		throw new ValidationError(
			`Unsupported image type: ${file.type}. Supported: PNG, JPEG, GIF, WebP`,
		);
	}
	if (file.size > MAX_FILE_SIZE) {
		throw new ValidationError(
			`Image too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 10MB`,
		);
	}

	const imageId = generateShortId();
	const ext = MIME_TO_EXT[file.type] ?? (extname(file.name) || ".bin");
	const dir = resolve(UPLOADS_DIR, narratorId);
	if (!dir.startsWith(UPLOADS_DIR)) {
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
	const dir = resolve(UPLOADS_DIR, narratorId);
	if (!dir.startsWith(UPLOADS_DIR)) return null; // prevent path traversal
	if (!existsSync(dir)) return null;

	const files = readdirSync(dir);
	const match = files.find((f) => f.startsWith(imageId));
	if (!match) return null;

	const filePath = resolve(dir, match);
	if (!filePath.startsWith(dir)) return null; // belt-and-suspenders
	return filePath;
}

export async function imageToBase64(filePath: string): Promise<string> {
	const buffer = await Bun.file(filePath).arrayBuffer();
	return Buffer.from(buffer).toString("base64");
}

export async function deleteNarratorUploads(narratorId: string): Promise<void> {
	const dir = resolve(UPLOADS_DIR, narratorId);
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
	const dir = resolve(AVATARS_DIR, userId);
	if (!dir.startsWith(AVATARS_DIR)) {
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
	const dir = resolve(AVATARS_DIR, userId);
	if (!dir.startsWith(AVATARS_DIR)) return null;
	if (!existsSync(dir)) return null;

	const files = readdirSync(dir);
	const match = files.find((f) => f.startsWith(imageId));
	if (!match) return null;

	const filePath = resolve(dir, match);
	if (!filePath.startsWith(dir)) return null;
	return filePath;
}

export function deleteAvatarImage(userId: string): void {
	const dir = resolve(AVATARS_DIR, userId);
	if (!dir.startsWith(AVATARS_DIR)) return;
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
		logger.info("Avatar deleted", { userId });
	}
}
