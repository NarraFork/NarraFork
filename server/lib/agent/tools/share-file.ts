import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
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

export const shareFileTool: ToolDefinition = {
	name: "ShareFile",
	description:
		"Share a file or directory by generating a temporary download link. " +
		"Directories are automatically compressed into a .tar.gz archive. " +
		"Files can optionally be compressed with gzip. " +
		"The link expires after a configurable period (default 24 hours) and is accessible to anyone with the URL.",
	parameters: z.object({
		path: z
			.string()
			.describe("Path to the file or directory to share. Can be relative to cwd or absolute."),
		compress: z
			.boolean()
			.optional()
			.describe(
				"Whether to gzip-compress the file before sharing. " +
					"Directories are always compressed as .tar.gz regardless of this flag. " +
					"Default: false for files.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { path: inputPath, compress } = args as {
			path: string;
			compress?: boolean;
		};

		// Resolve path relative to cwd
		const fullPath = resolve(ctx.cwd, inputPath);

		if (!existsSync(fullPath)) {
			return { output: `Path not found: ${fullPath}`, isError: true };
		}

		const stat = statSync(fullPath);
		const isDir = stat.isDirectory();
		const maxSize = getMaxShareSizeBytes();

		// Check size limit
		const sourceSize = isDir ? dirSize(fullPath) : stat.size;
		if (sourceSize > maxSize) {
			return {
				output: `Source size (${formatSize(sourceSize)}) exceeds the maximum allowed share size (${formatSize(maxSize)}).`,
				isError: true,
			};
		}

		// Use a single ID for both the directory and the share record
		const shareId = generateShortId();
		const shareDir = getShareDir(shareId);
		const originalName = basename(fullPath);

		try {
			let storagePath: string;
			let finalName: string;

			if (isDir) {
				// Directory → always tar.gz
				finalName = `${originalName}.tar.gz`;
				storagePath = resolve(shareDir, finalName);
				const proc = Bun.spawnSync(
					["tar", "-czf", storagePath, "-C", resolve(fullPath, ".."), originalName],
					{ stderr: "pipe" },
				);
				if (proc.exitCode !== 0) {
					const stderr = proc.stderr.toString().trim();
					return {
						output: `Failed to create archive: ${stderr || `tar exited with code ${proc.exitCode}`}`,
						isError: true,
					};
				}
			} else if (compress) {
				// File + compress → copy then gzip
				finalName = `${originalName}.gz`;
				const tempPath = resolve(shareDir, originalName);
				await Bun.write(tempPath, Bun.file(fullPath));
				const proc = Bun.spawnSync(["gzip", tempPath], { stderr: "pipe" });
				if (proc.exitCode !== 0) {
					const stderr = proc.stderr.toString().trim();
					return {
						output: `Failed to compress file: ${stderr || `gzip exited with code ${proc.exitCode}`}`,
						isError: true,
					};
				}
				storagePath = resolve(shareDir, finalName);
			} else {
				// File, no compression → direct copy
				finalName = originalName;
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

			return {
				output:
					`File shared successfully.\n\n` +
					`Download link: ${downloadUrl}\n` +
					`Filename: ${finalName}\n` +
					`Size: ${formatSize(finalStat.size)}\n` +
					`Expires: ${record.expiresAt.toISOString()} (${expiryHours}h from now)`,
				title: `Shared: ${finalName}`,
			};
		} catch (err) {
			return {
				output: `Failed to share file: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
