import { createWriteStream, existsSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { generateShortId } from "../../id";
import { settings } from "../../settings";
import { createShare, getMaxShareSizeBytes, getShareDir } from "../../shares";
import { safeSpawn } from "../../spawn";
import {
	MAX_IMAGE_HEADER_SIZE,
	parseImageDimensions,
	sanitizeParsedDimensions,
} from "../../uploads";
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

/**
 * Hard timeout for the archiving/compression subprocesses.
 *
 * These run on the agent loop's thread of execution: `await proc.exited` with no timeout
 * means a wedged child stalls the narrator indefinitely with nothing to show for it. The
 * input size is already bounded by the share ceiling, so the cap only has to cover a slow
 * disk — but the stall cases it protects against (a hung network mount, a symlink cycle
 * `tar` is walking) do not scale with the declared size at all, which is why a timeout is
 * needed rather than trusting the pre-flight size check.
 */
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;

/** Version probes answer instantly or not at all. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Cap on captured stderr from an archiver.
 *
 * The text goes into a tool result a model reads; a few KB names the failure, and more only
 * costs context. Unbounded capture also let a child with a pathological error loop (one line
 * per file across a deep tree) decide how much memory we allocate.
 */
const ARCHIVE_STDERR_MAX_BYTES = 8 * 1024;

/**
 * Run an archiving subprocess under a hard timeout and a bounded stderr capture.
 *
 * Returns `null` on success or a human-readable failure. A timeout is named as such:
 * `safeSpawn` kills the child and reports a non-zero exit with empty stderr, which surfaces
 * as a bare "exited with code N" — indistinguishable from a corrupt archive, and it sends
 * whoever reads the tool result looking in the wrong place. `safeSpawn` does not report the
 * reason, so elapsed time is what distinguishes them.
 */
export async function runArchiver(
	tool: string,
	cmd: string[],
	opts?: { cwd?: string; timeoutMs?: number; maxStderrBytes?: number },
): Promise<string | null> {
	// Overridable so a test can assert the timeout and the stderr cap on a real subprocess:
	// waiting out the production 5 minutes is not a test, and stubbing `safeSpawn` would only
	// verify which arguments were passed, not that a wedged child is actually killed.
	const timeoutMs = opts?.timeoutMs ?? ARCHIVE_TIMEOUT_MS;
	const started = Date.now();
	const result = await safeSpawn({
		cmd,
		cwd: opts?.cwd,
		timeout: timeoutMs,
		maxOutputBytes: opts?.maxStderrBytes ?? ARCHIVE_STDERR_MAX_BYTES,
	});
	if (result.exitCode === 0) return null;
	if (Date.now() - started >= timeoutMs) {
		return `${tool} timed out after ${Math.round(timeoutMs / 1000)}s`;
	}
	return result.stderr.trim() || `${tool} exited with code ${result.exitCode}`;
}

/** Check if the system `zip` command is available. Cached after first call. */
let _zipAvailable: boolean | null = null;
async function isZipCliAvailable(): Promise<boolean> {
	if (_zipAvailable !== null) return _zipAvailable;
	try {
		const result = await safeSpawn({
			cmd: ["zip", "--version"],
			timeout: PROBE_TIMEOUT_MS,
			maxOutputBytes: 0,
		});
		_zipAvailable = result.exitCode === 0;
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
	return runArchiver("zip", ["zip", "-r", outputPath, ...relativePaths], { cwd: basedir });
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
			const failure = await runArchiver("tar", [
				"tar",
				"-czf",
				storagePath,
				"-C",
				resolve(fullPath, ".."),
				originalName,
			]);
			if (failure) return { output: `Failed to create archive: ${failure}`, isError: true };
		} else if (compress) {
			// File + compress → copy then gzip
			finalName = `${originalName}.gz`;
			format = "gz";
			const tempPath = resolve(shareDir, originalName);
			await Bun.write(tempPath, Bun.file(fullPath));
			const failure = await runArchiver("gzip", ["gzip", tempPath]);
			if (failure) return { output: `Failed to compress file: ${failure}`, isError: true };
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

		// For image previews, forward the intrinsic pixel size so the frontend can
		// reserve an aspect-ratio box instead of a fixed placeholder height. Only a
		// bounded header prefix is read; unparseable formats (svg/bmp/…) just omit it.
		//
		// The parsed numbers are sanitized rather than forwarded raw: this tool shares
		// arbitrary paths, so the declared size is whatever the file's header says. A
		// PNG announcing 4294967295x4294967295 would otherwise reach the frontend,
		// which only rejects non-finite values — the aspect-ratio division then
		// degenerates and the "reserved" box is ~1px tall. Dropping implausible sizes
		// returns to the placeholder-height fallback, which is at least honest.
		let previewDimensions: { width: number; height: number } | undefined;
		if (previewType === "image") {
			try {
				const header = new Uint8Array(
					await Bun.file(storagePath).slice(0, MAX_IMAGE_HEADER_SIZE).arrayBuffer(),
				);
				previewDimensions = sanitizeParsedDimensions(parseImageDimensions(header));
			} catch {
				// Best effort: the preview still works, it just falls back to the
				// fixed placeholder height.
			}
		}

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
				...(previewUrl && {
					preview: true,
					previewType,
					previewUrl,
					...(previewDimensions
						? { width: previewDimensions.width, height: previewDimensions.height }
						: {}),
				}),
			},
		};
	} catch (err) {
		return {
			output: `Failed to share file: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}
