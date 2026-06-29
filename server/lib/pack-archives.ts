import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getDbDir } from "../db/connection";
import { ValidationError } from "./errors";
import { logger } from "./logger";
import { loadSettings } from "./settings";

/** Supported pack archive formats. */
export type PackArchiveFormat = "tar.gz" | "zip";

const FORMAT_EXT: Record<PackArchiveFormat, string> = {
	"tar.gz": "tar.gz",
	zip: "zip",
};

/** Base dir for persistent pack archives (honors NARRAFORK_HOME for tests). */
export function getPackArchivesDir(): string {
	const dir = resolve(getDbDir(), "pack-archives");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Base dir for transient pack extractions (honors NARRAFORK_HOME). */
export function getPacksExtractRoot(): string {
	const dir = resolve(getDbDir(), "packs");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Absolute path of a pack archive on disk: <archives>/<packId>.<ext>. */
export function packArchivePath(packId: string, format: PackArchiveFormat): string {
	return resolve(getPackArchivesDir(), `${packId}.${FORMAT_EXT[format]}`);
}

/** Per-narrator, per-pack extraction dir: <packs>/<narratorId>/<packId>/. */
export function packExtractDir(narratorId: string, packId: string): string {
	return resolve(getPacksExtractRoot(), narratorId, packId);
}

/** Max archive upload size in bytes, from settings (packMaxSizeMb). */
export function maxPackArchiveBytes(): number {
	return (loadSettings().knowledge.packMaxSizeMb ?? 100) * 1024 * 1024;
}

/** Max uncompressed extraction size in bytes, from settings (packMaxUncompressedMb). */
export function maxPackUncompressedBytes(): number {
	return (loadSettings().knowledge.packMaxUncompressedMb ?? 500) * 1024 * 1024;
}

/**
 * Infer the pack archive format from a filename. Returns null when unsupported.
 * Only `.tar.gz`/`.tgz` and `.zip` are accepted; everything else is rejected so a
 * pack can never carry an unknown/uncontrolled archive type.
 */
export function inferArchiveFormat(filename: string): PackArchiveFormat | null {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
	if (lower.endsWith(".zip")) return "zip";
	return null;
}

export interface SavedArchive {
	format: PackArchiveFormat;
	size: number;
	hash: string;
}

/**
 * Validate (type + size) and persist a pack archive to <archives>/<packId>.<ext>.
 * Computes a sha256 hash for integrity/dedup. Throws ValidationError on bad type
 * or oversize. The file bytes are read once into memory (already capped by size).
 */
export async function savePackArchive(packId: string, file: File): Promise<SavedArchive> {
	const format = inferArchiveFormat(file.name);
	if (!format) {
		throw new ValidationError(
			`Unsupported pack archive type: ${file.name}. Only .tar.gz, .tgz and .zip are allowed.`,
		);
	}
	const max = maxPackArchiveBytes();
	if (file.size > max) {
		throw new ValidationError(
			`Pack archive too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${(max / 1024 / 1024).toFixed(0)}MB`,
		);
	}

	const buf = Buffer.from(await file.arrayBuffer());
	// Re-check the real byte length (file.size can be a hint, not a guarantee).
	if (buf.byteLength > max) {
		throw new ValidationError(
			`Pack archive too large: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB. Max: ${(max / 1024 / 1024).toFixed(0)}MB`,
		);
	}

	const hash = createHash("sha256").update(buf).digest("hex");
	const dest = packArchivePath(packId, format);
	await Bun.write(dest, buf);
	logger.info("Pack archive saved", { packId, format, size: buf.byteLength });
	return { format, size: buf.byteLength, hash };
}

/** Delete a pack's archive file from disk (best-effort). */
export function deletePackArchive(packId: string, format: PackArchiveFormat): void {
	const p = packArchivePath(packId, format);
	if (existsSync(p)) {
		rmSync(p, { force: true });
		logger.info("Pack archive deleted", { packId });
	}
}
