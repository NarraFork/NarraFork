/**
 * Zstd dictionary-based patch generation/application
 * for efficient delta updates.
 */
import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

/** Default block size: 64KB (same as electron-builder) */
export const DEFAULT_BLOCK_SIZE = 64 * 1024;

/**
 * Metadata for a zstd dictionary patch.
 * Stored alongside the patch as `.zstd-patch.meta.json`.
 */
export interface ZstdPatchMeta {
	/** Version of the old (source) binary */
	fromVersion: string;
	/** Version of the new (target) binary */
	toVersion: string;
	/** Byte offset where the stable (identical) head region ends */
	stableEnd: number;
	/** Size of the new binary's tail (after stableEnd) */
	newTailSize: number;
	/** Size of the compressed patch in bytes */
	patchSize: number;
	/** Total size of the new binary in bytes */
	newFileSize: number;
	/** SHA512 of the complete new binary (base64) */
	newFileSha512: string;
	/** Patch mode: "patch-from" uses zstd CLI long-range matching, "dictionary" uses Bun zstd API */
	mode?: "patch-from" | "dictionary";
}

/**
 * Find the byte boundary where two buffers stop being identical.
 * Compares in 64KB-aligned blocks; returns the end offset of the last
 * matching block (i.e. everything before this offset is identical).
 */
export function findStableEnd(
	oldBuf: Buffer,
	newBuf: Buffer,
	blockSize = DEFAULT_BLOCK_SIZE,
): number {
	let stableEnd = 0;
	const limit = Math.min(oldBuf.length, newBuf.length);
	for (let i = 0; i < limit; i += blockSize) {
		const end = Math.min(i + blockSize, limit);
		if (Buffer.compare(oldBuf.subarray(i, end), newBuf.subarray(i, end)) === 0) {
			stableEnd = end;
		} else {
			break;
		}
	}
	return stableEnd;
}

/**
 * Generate a zstd patch from old → new binary.
 *
 * Tries two strategies:
 * 1. zstd CLI `--patch-from` (best compression via long-range matching, ~276KB for 134MB)
 * 2. Bun zstd dictionary API (fallback, larger patches but no external dependency)
 */
export function generateZstdPatch(
	oldBuf: Buffer,
	newBuf: Buffer,
	opts: { fromVersion: string; toVersion: string; level?: number },
): { patch: Buffer; meta: ZstdPatchMeta } {
	const level = opts.level ?? 19;
	const newFileSha512 = createHash("sha512").update(newBuf).digest("base64");

	// Try CLI --patch-from first (much better compression)
	const cliPatch = tryZstdCliPatchFrom(oldBuf, newBuf, level);
	if (cliPatch) {
		const meta: ZstdPatchMeta = {
			fromVersion: opts.fromVersion,
			toVersion: opts.toVersion,
			stableEnd: 0,
			newTailSize: newBuf.length,
			patchSize: cliPatch.length,
			newFileSize: newBuf.length,
			newFileSha512,
			mode: "patch-from",
		};
		return { patch: cliPatch, meta };
	}

	// Fallback: Bun dictionary mode
	const stableEnd = findStableEnd(oldBuf, newBuf);
	const oldTail = oldBuf.subarray(stableEnd);
	const newTail = newBuf.subarray(stableEnd);

	const patch =
		oldTail.length > 0
			? zstdCompressSync(newTail, { dictionary: oldTail, level } as Parameters<
					typeof zstdCompressSync
				>[1])
			: zstdCompressSync(newTail, { level } as Parameters<typeof zstdCompressSync>[1]);

	const meta: ZstdPatchMeta = {
		fromVersion: opts.fromVersion,
		toVersion: opts.toVersion,
		stableEnd,
		newTailSize: newTail.length,
		patchSize: patch.length,
		newFileSize: newBuf.length,
		newFileSha512,
		mode: "dictionary",
	};

	return { patch, meta };
}

/**
 * Try generating a patch using zstd CLI --patch-from.
 * Returns null if zstd CLI is not available.
 */
function tryZstdCliPatchFrom(oldBuf: Buffer, newBuf: Buffer, level: number): Buffer | null {
	try {
		const { tmpdir } = require("node:os");
		const { join } = require("node:path");
		const { writeFileSync, readFileSync, unlinkSync } = require("node:fs");

		const tmp = tmpdir();
		const id = Date.now().toString(36);
		const oldPath = join(tmp, `nf-zstd-old-${id}`);
		const newPath = join(tmp, `nf-zstd-new-${id}`);
		const patchPath = join(tmp, `nf-zstd-patch-${id}.zst`);

		writeFileSync(oldPath, oldBuf);
		writeFileSync(newPath, newBuf);

		const result = Bun.spawnSync(
			[
				"zstd",
				`--patch-from=${oldPath}`,
				newPath,
				"-o",
				patchPath,
				`-${level}`,
				"--force",
				"--long=31",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		// Cleanup temp files
		try {
			unlinkSync(oldPath);
		} catch {}
		try {
			unlinkSync(newPath);
		} catch {}

		if (result.exitCode !== 0) {
			try {
				unlinkSync(patchPath);
			} catch {}
			return null;
		}

		const patch = readFileSync(patchPath);
		try {
			unlinkSync(patchPath);
		} catch {}
		return patch;
	} catch {
		return null;
	}
}

/**
 * Apply a zstd patch to reconstruct the new binary.
 *
 * Supports two modes:
 * - "patch-from": uses zstd CLI `--patch-from` (or `zstdPath` override)
 * - "dictionary" (default/legacy): uses Bun zstd API with dictionary
 *
 * Throws on decompression failure or SHA512 mismatch.
 */
export function applyZstdPatch(
	oldBuf: Buffer,
	patch: Buffer,
	meta: ZstdPatchMeta,
	zstdPath?: string,
): Buffer {
	let result: Buffer;

	if (meta.mode === "patch-from") {
		result = applyZstdCliPatch(oldBuf, patch, meta.newFileSize, zstdPath);
	} else {
		// Legacy dictionary mode
		if (meta.stableEnd > oldBuf.length) {
			throw new Error(
				`Old binary too small: expected at least ${meta.stableEnd} bytes, got ${oldBuf.length}`,
			);
		}

		const oldTail = oldBuf.subarray(meta.stableEnd);
		const restoredTail =
			oldTail.length > 0
				? zstdDecompressSync(patch, { dictionary: oldTail })
				: zstdDecompressSync(patch);

		if (restoredTail.length !== meta.newTailSize) {
			throw new Error(
				`Zstd patch tail size mismatch: expected ${meta.newTailSize}, got ${restoredTail.length}`,
			);
		}

		result = Buffer.concat([oldBuf.subarray(0, meta.stableEnd), restoredTail]);
	}

	if (result.length !== meta.newFileSize) {
		throw new Error(
			`Zstd patch file size mismatch: expected ${meta.newFileSize}, got ${result.length}`,
		);
	}

	const actualSha512 = createHash("sha512").update(result).digest("base64");
	if (actualSha512 !== meta.newFileSha512) {
		throw new Error(
			`Zstd patch SHA512 mismatch: expected ${meta.newFileSha512.slice(0, 16)}..., got ${actualSha512.slice(0, 16)}...`,
		);
	}

	return result;
}

/**
 * Apply a zstd --patch-from patch using CLI.
 * `zstdPath` can be a custom path to the zstd binary (e.g. downloaded zstd.exe on Windows).
 */
function applyZstdCliPatch(
	oldBuf: Buffer,
	patch: Buffer,
	_expectedSize: number,
	zstdPath?: string,
): Buffer {
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	const { writeFileSync, readFileSync, unlinkSync } = require("node:fs");

	const zstdBin = zstdPath ?? "zstd";
	const tmp = tmpdir();
	const id = Date.now().toString(36);
	const oldPath = join(tmp, `nf-zstd-old-${id}`);
	const patchPath = join(tmp, `nf-zstd-patch-${id}.zst`);
	const outPath = join(tmp, `nf-zstd-out-${id}`);

	writeFileSync(oldPath, oldBuf);
	writeFileSync(patchPath, patch);

	try {
		const result = Bun.spawnSync(
			[zstdBin, "-d", `--patch-from=${oldPath}`, patchPath, "-o", outPath, "--force", "--long=31"],
			{ stdout: "pipe", stderr: "pipe" },
		);

		if (result.exitCode !== 0) {
			const stderr = new TextDecoder().decode(result.stderr);
			throw new Error(`zstd CLI decompression failed (exit ${result.exitCode}): ${stderr}`);
		}

		return readFileSync(outPath);
	} finally {
		try {
			unlinkSync(oldPath);
		} catch {}
		try {
			unlinkSync(patchPath);
		} catch {}
		try {
			unlinkSync(outPath);
		} catch {}
	}
}
