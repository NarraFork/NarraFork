import { createWriteStream, existsSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { generateShortId } from "../../id";
import { settings } from "../../settings";
import { createShare, getMaxShareSizeBytes, getShareDir } from "../../shares";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * Recursively compute the total size of a directory in bytes.
 */
function dirSize(dirPath: string): number {
	let total = 0;
	const entries = new Bun.Glob("**/*").scanSync({ cwd: dirPath, dot: true, onlyFiles: true });
	for (const entry of entries) {
		try {
			total += statSync(resolve(dirPath, entry)).size;
		} catch {
			// skip unreadable files
		}
	}
	return total;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Compute the size of a path (file or directory). */
function pathSize(fullPath: string): number {
	const stat = statSync(fullPath);
	return stat.isDirectory() ? dirSize(fullPath) : stat.size;
}

/** Check if the system `zip` command is available. Cached after first call. */
let _zipAvailable: boolean | null = null;
async function isZipCliAvailable(): Promise<boolean> {
	if (_zipAvailable !== null) return _zipAvailable;
	try {
		const proc = Bun.spawn(["zip", "--version"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		_zipAvailable = exitCode === 0;
	} catch {
		_zipAvailable = false;
	}
	return _zipAvailable;
}

/**
 * Find the longest common parent directory among a set of absolute paths.
 */
function commonParentDir(paths: string[]): string {
	if (paths.length === 0) return "/";
	if (paths.length === 1) return dirname(paths[0]);

	const segments = paths.map((p) => p.split("/").filter(Boolean));
	const minLen = Math.min(...segments.map((s) => s.length));
	let common = "";
	for (let i = 0; i < minLen; i++) {
		const seg = segments[0][i];
		if (segments.every((s) => s[i] === seg)) {
			common += `/${seg}`;
		} else {
			break;
		}
	}
	return common || "/";
}

/**
 * Create a zip archive using the system `zip` CLI.
 * Returns null on success, or an error string on failure.
 */
async function zipViaCli(
	outputPath: string,
	basedir: string,
	relativePaths: string[],
): Promise<string | null> {
	const proc = Bun.spawn(["zip", "-r", outputPath, ...relativePaths], {
		cwd: basedir,
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		return stderr.trim() || `zip exited with code ${exitCode}`;
	}
	return null;
}

/**
 * Create a zip archive using the `archiver` library (fallback for platforms
 * where the `zip` CLI is not available, e.g. Windows).
 */
async function zipViaArchiver(
	outputPath: string,
	basedir: string,
	relativePaths: string[],
): Promise<string | null> {
	const archiver = (await import("archiver")).default;
	return new Promise((res) => {
		const output = createWriteStream(outputPath);
		const archive = archiver("zip", { zlib: { level: 6 } });

		output.on("close", () => res(null));
		archive.on("error", (err: Error) => res(err.message));
		archive.pipe(output);

		for (const rel of relativePaths) {
			const abs = resolve(basedir, rel);
			const stat = statSync(abs);
			if (stat.isDirectory()) {
				archive.directory(abs, rel);
			} else {
				archive.file(abs, { name: rel });
			}
		}

		archive.finalize();
	});
}

export const shareFileTool: ToolDefinition = {
	name: "ShareFile",
	description:
		"Share a file or directory by generating a temporary download link. " +
		"Directories are automatically compressed into a .tar.gz archive. " +
		"Files can optionally be compressed with gzip. " +
		"Multiple files/directories can be packaged into a single .zip archive by passing an array of paths. " +
		"The link expires after a configurable period (default 24 hours) and is accessible to anyone with the URL.",
	parameters: z.object({
		path: z
			.union([z.string(), z.array(z.string())])
			.describe(
				"Path to the file or directory to share. Can be relative to cwd or absolute. " +
					"Pass an array of paths to package multiple files/directories into a single .zip archive.",
			),
		compress: z
			.boolean()
			.optional()
			.describe(
				"Whether to gzip-compress the file before sharing. " +
					"Directories are always compressed as .tar.gz regardless of this flag. " +
					"Ignored when path is an array (always creates .zip). " +
					"Default: false for files.",
			),
		preview: z
			.boolean()
			.optional()
			.describe(
				"Whether to enable inline preview in the frontend card. " +
					"When true, the shared file will be rendered directly in the chat " +
					"(supports images, videos, PDFs, and sanitized HTML). " +
					"Ignored for compressed archives and multi-file shares. " +
					"Default: false.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			path: inputPath,
			compress,
			preview,
		} = args as {
			path: string | string[];
			compress?: boolean;
			preview?: boolean;
		};

		const isMulti = Array.isArray(inputPath);

		// ── Multi-file mode: zip packaging ──────────────────────────────────
		if (isMulti) {
			return handleMultiFile(inputPath, ctx);
		}

		// ── Single path mode (original behaviour) ──────────────────────────
		return handleSinglePath(inputPath, compress, preview, ctx);
	},
};

// ── Multi-file zip handler ───────────────────────────────────────────────────

async function handleMultiFile(
	inputPaths: string[],
	ctx: { cwd: string; narratorId: string },
): Promise<ToolResult> {
	if (inputPaths.length === 0) {
		return { output: "No paths provided.", isError: true };
	}

	// Resolve all paths & validate existence
	const resolved: string[] = [];
	for (const p of inputPaths) {
		const full = resolve(ctx.cwd, p);
		if (!existsSync(full)) {
			return { output: `Path not found: ${full}`, isError: true };
		}
		resolved.push(full);
	}

	// Compute total size
	const maxSize = getMaxShareSizeBytes();
	let totalSize = 0;
	for (const full of resolved) {
		totalSize += pathSize(full);
	}
	if (totalSize > maxSize) {
		return {
			output: `Total source size (${formatSize(totalSize)}) exceeds the maximum allowed share size (${formatSize(maxSize)}).`,
			isError: true,
		};
	}

	const shareId = generateShortId();
	const shareDir = getShareDir(shareId);
	const finalName = `share-${Date.now()}.zip`;
	const storagePath = resolve(shareDir, finalName);

	// Compute common parent & relative paths for zip structure
	const basedir = commonParentDir(resolved);
	const relativePaths = resolved.map((p) => relative(basedir, p));

	try {
		// Prefer system zip; fall back to archiver
		let err: string | null;
		if (await isZipCliAvailable()) {
			err = await zipViaCli(storagePath, basedir, relativePaths);
		} else {
			err = await zipViaArchiver(storagePath, basedir, relativePaths);
		}
		if (err) {
			return { output: `Failed to create zip archive: ${err}`, isError: true };
		}

		const finalStat = statSync(storagePath);
		const expiryHours = settings.shares?.defaultExpiryHours ?? 24;

		const record = createShare({
			id: shareId,
			originalName: finalName,
			storagePath,
			size: finalStat.size,
			createdBy: ctx.narratorId,
			expiryHours,
		});

		const downloadUrl = `/api/shares/${record.id}`;
		const fileCount = inputPaths.length;

		return {
			output:
				`Files shared successfully.\n\n` +
				`Download link: ${downloadUrl}\n` +
				`Filename: ${finalName}\n` +
				`Files packaged: ${fileCount}\n` +
				`Size: ${formatSize(finalStat.size)}\n` +
				`Expires: ${record.expiresAt.toISOString()} (${expiryHours}h from now)`,
			title: `Shared: ${finalName} (${fileCount} files)`,
			metadata: {
				shareId: record.id,
				downloadUrl,
				filename: finalName,
				originalName: finalName,
				size: finalStat.size,
				sizeFormatted: formatSize(finalStat.size),
				expiresAt: record.expiresAt.toISOString(),
				expiryHours,
				isDirectory: false,
				compressed: true,
				format: "zip" as const,
				fileCount,
			},
		};
	} catch (err) {
		return {
			output: `Failed to share files: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}

// ── Previewable file extensions ──────────────────────────────────────────────

const PREVIEW_IMAGE_EXTS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".svg",
	".avif",
	".bmp",
	".ico",
]);
const PREVIEW_VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".ogg"]);
const PREVIEW_PDF_EXTS = new Set([".pdf"]);
const PREVIEW_HTML_EXTS = new Set([".html", ".htm"]);

function getPreviewType(filename: string): "image" | "video" | "pdf" | "html" | null {
	const ext = filename.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
	if (PREVIEW_IMAGE_EXTS.has(ext)) return "image";
	if (PREVIEW_VIDEO_EXTS.has(ext)) return "video";
	if (PREVIEW_PDF_EXTS.has(ext)) return "pdf";
	if (PREVIEW_HTML_EXTS.has(ext)) return "html";
	return null;
}

// ── Single-path handler (original logic) ─────────────────────────────────────

async function handleSinglePath(
	inputPath: string,
	compress: boolean | undefined,
	preview: boolean | undefined,
	ctx: { cwd: string; narratorId: string },
): Promise<ToolResult> {
	const fullPath = resolve(ctx.cwd, inputPath);

	if (!existsSync(fullPath)) {
		return { output: `Path not found: ${fullPath}`, isError: true };
	}

	const stat = statSync(fullPath);
	const isDir = stat.isDirectory();
	const maxSize = getMaxShareSizeBytes();

	const sourceSize = isDir ? dirSize(fullPath) : stat.size;
	if (sourceSize > maxSize) {
		return {
			output: `Source size (${formatSize(sourceSize)}) exceeds the maximum allowed share size (${formatSize(maxSize)}).`,
			isError: true,
		};
	}

	const shareId = generateShortId();
	const shareDir = getShareDir(shareId);
	const originalName = basename(fullPath);

	try {
		let storagePath: string;
		let finalName: string;
		let format: "tar.gz" | "gz" | "raw";

		if (isDir) {
			// Directory → always tar.gz
			finalName = `${originalName}.tar.gz`;
			storagePath = resolve(shareDir, finalName);
			format = "tar.gz";
			const proc = Bun.spawn(
				["tar", "-czf", storagePath, "-C", resolve(fullPath, ".."), originalName],
				{ stdout: "ignore", stderr: "pipe" },
			);
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				return {
					output: `Failed to create archive: ${stderr.trim() || `tar exited with code ${exitCode}`}`,
					isError: true,
				};
			}
		} else if (compress) {
			// File + compress → copy then gzip
			finalName = `${originalName}.gz`;
			format = "gz";
			const tempPath = resolve(shareDir, originalName);
			await Bun.write(tempPath, Bun.file(fullPath));
			const proc = Bun.spawn(["gzip", tempPath], {
				stdout: "ignore",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				return {
					output: `Failed to compress file: ${stderr.trim() || `gzip exited with code ${exitCode}`}`,
					isError: true,
				};
			}
			storagePath = resolve(shareDir, finalName);
		} else {
			// File, no compression → direct copy
			finalName = originalName;
			format = "raw";
			storagePath = resolve(shareDir, finalName);
			await Bun.write(storagePath, Bun.file(fullPath));
		}

		const finalStat = statSync(storagePath);
		const expiryHours = settings.shares?.defaultExpiryHours ?? 24;

		const record = createShare({
			id: shareId,
			originalName: finalName,
			storagePath,
			size: finalStat.size,
			createdBy: ctx.narratorId,
			expiryHours,
		});

		const downloadUrl = `/api/shares/${record.id}`;

		// Determine preview capability: only for raw (uncompressed) single files
		const canPreview = !isDir && !compress && !!preview;
		const previewType = canPreview ? getPreviewType(finalName) : null;
		const previewUrl = previewType ? `/api/shares/${record.id}/preview` : null;

		return {
			output:
				`File shared successfully.\n\n` +
				`Download link: ${downloadUrl}\n` +
				`Filename: ${finalName}\n` +
				`Size: ${formatSize(finalStat.size)}\n` +
				`Expires: ${record.expiresAt.toISOString()} (${expiryHours}h from now)` +
				(previewUrl ? `\nPreview: enabled (${previewType})` : ""),
			title: `Shared: ${finalName}`,
			metadata: {
				shareId: record.id,
				downloadUrl,
				filename: finalName,
				originalName,
				size: finalStat.size,
				sizeFormatted: formatSize(finalStat.size),
				expiresAt: record.expiresAt.toISOString(),
				expiryHours,
				isDirectory: isDir,
				compressed: isDir || !!compress,
				format,
				...(previewUrl && { preview: true, previewType, previewUrl }),
			},
		};
	} catch (err) {
		return {
			output: `Failed to share file: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}
