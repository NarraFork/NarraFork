import { createHash } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { lstat, open, opendir, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod/v4";
import {
	classifySharePreview,
	isShareText,
	SHARE_HTML_MAX_BYTES,
} from "../../../../shared/share-preview";
import { generateId, generateShortId } from "../../id";
import { settings } from "../../settings";
import { createShare, getMaxShareSizeBytes, getShareDir } from "../../shares";
import { safeSpawn } from "../../spawn";
import { assertSpecPath } from "../../spec-uri";
import {
	MAX_IMAGE_HEADER_SIZE,
	parseImageDimensions,
	sanitizeParsedDimensions,
} from "../../uploads";
import type { ExecutionBackend } from "../execution/backend";
import { withDeviceParam } from "../execution/device-schema";
import { toolExecutionCwd } from "../execution/path-resolve";
import type { ShareArchiveEntry } from "../execution/share-archive-rpc";
import { getToolBackend } from "../execution/tool-backend";
import { zodToJsonSchema } from "../tool-registry";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

export type WorkspaceShareReadAuthorizer = (
	canonicalPath: string,
	backend: ExecutionBackend,
	signal?: AbortSignal,
) => Promise<boolean | undefined>;
const SHARE_MAX_ENTRIES = 4096;
const SHARE_CHUNK_BYTES = 1024 * 1024;
const SHARE_REMOTE_MAX_BYTES = 1024 * 1024 * 1024;

async function authorizeRemoteShareEntries(
	ctx: ToolContext,
	backend: ExecutionBackend,
	entries: ReadonlyArray<Pick<ShareArchiveEntry, "path">>,
	signal: AbortSignal,
): Promise<void> {
	const authorize = (ctx as ToolContext & { authorizeWorkspaceRead?: WorkspaceShareReadAuthorizer })
		.authorizeWorkspaceRead;
	if (!authorize)
		throw new Error("Remote sharing requires live actor/device/project/read-policy authorization.");
	await ctx.recheckAuthorization?.();
	for (const entry of entries) {
		signal.throwIfAborted();
		if ((await authorize(entry.path, backend, signal)) !== true)
			throw new Error("Remote share source read denied.");
	}
}

/** The executor enumerates and archives; only one opaque, bounded artifact reaches the host. */
async function handleRemoteShare(
	inputPaths: string[],
	compress: boolean | undefined,
	preview: boolean | undefined,
	ctx: ToolContext,
	backend: ExecutionBackend,
): Promise<ToolResult> {
	if (!backend.supportsShareArchive || !backend.shareArchive)
		return {
			isError: true,
			output:
				"Remote sharing requires an executor upgrade with share.archive.v1; directories are supported by that capability.",
		};
	const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)]);
	const operationId = generateId();
	const limit = Math.min(getMaxShareSizeBytes(), SHARE_REMOTE_MAX_BYTES);
	let shareDir: string | undefined;
	let published = false;
	try {
		if (
			inputPaths.length < 1 ||
			inputPaths.length > 64 ||
			!Number.isSafeInteger(limit) ||
			limit < 1
		)
			throw new Error("Share requires 1-64 paths and a positive bounded size allowance.");
		const base = toolExecutionCwd(backend, ctx);
		const sources = ctx.executionPlan?.endpoints.filter(
			(endpoint) => endpoint.operation === "read",
		);
		const roots = inputPaths.map((input, index) => {
			const target =
				sources?.[index]?.target ?? (inputPaths.length === 1 ? ctx.executionTarget : undefined);
			if (target && target.deviceId !== backend.deviceId)
				throw new Error("Share endpoint changed device.");
			return target?.canonicalPath ?? target?.lexicalPath ?? backend.paths.resolve(base, input);
		});
		await authorizeRemoteShareEntries(
			ctx,
			backend,
			roots.map((path) => ({ path })),
			signal,
		);
		const inspected = await backend.shareArchive(
			{
				operation: "inspect",
				operationId,
				paths: roots,
				maxEntries: SHARE_MAX_ENTRIES,
				maxExpandedBytes: limit,
				maxBytes: SHARE_CHUNK_BYTES,
				timeoutMs: 30_000,
			},
			signal,
		);
		const entries = inspected.entries;
		if (
			inspected.operationId !== operationId ||
			inspected.truncated ||
			!entries ||
			entries.length < 1 ||
			entries.length > SHARE_MAX_ENTRIES ||
			inspected.entryCount !== entries.length ||
			!/^[a-f0-9]{64}$/.test(inspected.manifestHash ?? "")
		)
			throw new Error("Remote share inspection returned an incomplete or invalid manifest.");
		let expanded = 0;
		for (const entry of entries) {
			if (
				!backend.paths.isAbsolute(entry.path) ||
				!roots.some((root) => backend.paths.contains(root, entry.path)) ||
				!Number.isSafeInteger(entry.sizeBytes) ||
				entry.sizeBytes < 0
			)
				throw new Error("Remote share manifest escaped its admitted source or size limits.");
			expanded += entry.sizeBytes;
			if (!Number.isSafeInteger(expanded) || expanded > limit)
				throw new Error("Remote share expanded-byte limit exceeded.");
		}
		if (expanded !== inspected.expandedBytes)
			throw new Error("Remote share manifest size mismatch.");
		await authorizeRemoteShareEntries(ctx, backend, entries, signal);
		const format =
			roots.length > 1 ? "zip" : inspected.isDirectory ? "tar.gz" : compress ? "gz" : "raw";
		const artifact = await backend.shareArchive(
			{
				operation: "prepare",
				operationId,
				manifestHash: inspected.manifestHash,
				format,
				maxArchiveBytes: limit,
				timeoutMs: ARCHIVE_TIMEOUT_MS,
			},
			signal,
		);
		const size = artifact.archiveSizeBytes;
		const filename = artifact.filename;
		if (
			artifact.operationId !== operationId ||
			!artifact.artifactId ||
			!Number.isSafeInteger(size) ||
			(size as number) < 0 ||
			(size as number) > limit ||
			!/^[a-f0-9]{64}$/.test(artifact.archiveDigest ?? "") ||
			!filename ||
			filename === "." ||
			filename === ".." ||
			filename.length > 255 ||
			/[\\/\p{Cc}]/u.test(filename) ||
			artifact.format !== format
		)
			throw new Error("Remote share artifact is invalid or exceeds its byte limit.");
		const shareId = generateId();
		shareDir = getShareDir(shareId);
		const storagePath = resolve(shareDir, filename);
		const file = await open(storagePath, "wx", 0o600);
		const hash = createHash("sha256");
		let offset = 0;
		try {
			while (offset < (size as number)) {
				await ctx.recheckAuthorization?.();
				signal.throwIfAborted();
				const result = await backend.shareArchive(
					{
						operation: "readChunk",
						operationId,
						artifactId: artifact.artifactId,
						offset,
						maxChunkBytes: Math.min(SHARE_CHUNK_BYTES, (size as number) - offset),
						timeoutMs: 10_000,
					},
					signal,
				);
				if (
					result.operationId !== operationId ||
					result.artifactId !== artifact.artifactId ||
					result.offset !== offset ||
					typeof result.contentBase64 !== "string" ||
					result.contentBase64.length > Math.ceil(SHARE_CHUNK_BYTES / 3) * 4 + 4
				)
					throw new Error("Remote share chunk identity or byte cap mismatch.");
				const bytes = Buffer.from(result.contentBase64, "base64");
				if (
					bytes.length < 1 ||
					bytes.length > SHARE_CHUNK_BYTES ||
					offset + bytes.length > (size as number)
				)
					throw new Error("Remote share chunk length mismatch.");
				let written = 0;
				while (written < bytes.length) {
					const next = await file.write(bytes, written, bytes.length - written, offset + written);
					if (next.bytesWritten < 1) throw new Error("Share storage stopped accepting bytes.");
					written += next.bytesWritten;
				}
				hash.update(bytes);
				offset += bytes.length;
				if (!!result.eof !== (offset === size)) throw new Error("Remote share EOF mismatch.");
			}
		} finally {
			await file.close();
		}
		if (hash.digest("hex") !== artifact.archiveDigest)
			throw new Error("Remote share artifact digest mismatch.");
		await authorizeRemoteShareEntries(ctx, backend, entries, signal);
		const previewMetadata = await remoteSharePreview(
			storagePath,
			filename,
			size as number,
			!!preview && format === "raw",
		);
		const expiryHours = settings.shares?.defaultExpiryHours ?? 24;
		const record = createShare({
			id: shareId,
			originalName: filename,
			storagePath,
			size: size as number,
			createdBy: ctx.narratorId,
			expiryHours,
		});
		published = true;
		const downloadUrl = `/api/shares/${record.id}`;
		return {
			output: `File shared successfully.\n\nDownload link: ${downloadUrl}\nFilename: ${filename}\nSize: ${formatSize(size as number)}\nExpires: ${record.expiresAt.toISOString()}`,
			title: `Shared: ${filename}`,
			metadata: {
				shareId,
				downloadUrl,
				filename,
				originalName: artifact.originalName ?? filename,
				size,
				sizeFormatted: formatSize(size as number),
				expiresAt: record.expiresAt.toISOString(),
				expiryHours,
				isDirectory: !!inspected.isDirectory,
				compressed: format !== "raw",
				format,
				fileCount: roots.length,
				sourceManifestHash: inspected.manifestHash,
				sourceEntryCount: entries.length,
				expandedSourceBytes: expanded,
				coverage: "inspected_entries",
				previewRequested: !!preview,
				deviceId: backend.deviceId,
				workspaceContextKey: ctx.workspaceContext?.contextKey,
				...previewMetadata,
				...(previewMetadata.previewType && previewMetadata.previewType !== "unsupported"
					? { previewUrl: `/api/shares/${record.id}/preview` }
					: {}),
			},
		};
	} catch (error) {
		return {
			isError: true,
			output: `Failed to share remote source: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (!published && shareDir) await rm(shareDir, { recursive: true, force: true });
		try {
			await backend.shareArchive(
				{ operation: "release", operationId, timeoutMs: 5_000 },
				AbortSignal.timeout(5_000),
			);
		} catch {
			/* Offline artifacts remain private and expire under executor ownership. */
		}
	}
}

async function remoteSharePreview(
	storagePath: string,
	filename: string,
	size: number,
	enabled: boolean,
): Promise<Record<string, unknown>> {
	if (!enabled) return { previewType: "unsupported", previewReason: "compressed" };
	let capability = classifySharePreview(filename);
	if (
		capability.kind === "text" &&
		!isShareText(
			new Uint8Array(await Bun.file(storagePath).slice(0, 4096).arrayBuffer()),
			size <= 4096,
		)
	)
		capability = { kind: "unsupported", mime: "application/octet-stream" };
	if (
		capability.kind === "unsupported" ||
		(capability.kind === "html" && size > SHARE_HTML_MAX_BYTES)
	)
		return {
			previewType: "unsupported",
			previewReason: capability.kind === "html" ? "tooLarge" : "unsupported",
		};
	let dimensions: { width: number; height: number } | undefined;
	if (capability.kind === "image")
		dimensions = sanitizeParsedDimensions(
			parseImageDimensions(
				new Uint8Array(await Bun.file(storagePath).slice(0, MAX_IMAGE_HEADER_SIZE).arrayBuffer()),
			),
		);
	return {
		preview: true,
		previewType: capability.kind,
		previewMime: capability.mime,
		textFormat: capability.textFormat,
		...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
	};
}

/**
 * Recursively compute the total size of a directory in bytes.
 */
async function dirSize(dirPath: string, signal?: AbortSignal): Promise<number> {
	let total = 0;
	let count = 0;
	const deadline = Date.now() + 30_000;
	const pending = [{ path: dirPath, depth: 0 }];
	while (pending.length > 0) {
		signal?.throwIfAborted();
		if (Date.now() > deadline) throw new Error("Share directory enumeration timed out");
		const next = pending.pop();
		if (!next) break;
		if (next.depth > 64) throw new Error("Share directory depth limit exceeded");
		const directory = await opendir(next.path);
		for await (const entry of directory) {
			signal?.throwIfAborted();
			if (++count > SHARE_MAX_ENTRIES || Date.now() > deadline)
				throw new Error("Share directory entry/time limit exceeded");
			const path = resolve(next.path, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink()) throw new Error("Share refuses symbolic links in directories");
			if (info.isDirectory()) pending.push({ path, depth: next.depth + 1 });
			else if (info.isFile()) total += info.size;
			else throw new Error("Share refuses unsupported filesystem objects");
			if (total > getMaxShareSizeBytes()) throw new Error("Share source byte limit exceeded");
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
async function pathSize(fullPath: string, signal?: AbortSignal): Promise<number> {
	const stat = await lstat(fullPath);
	if (stat.isSymbolicLink()) throw new Error("Share refuses symbolic links");
	return stat.isDirectory() ? dirSize(fullPath, signal) : stat.size;
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
	return runArchiver("zip", ["zip", "-r", "-y", outputPath, "--", ...relativePaths], {
		cwd: basedir,
	});
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
	executionRouting: {
		kind: "multi",
		resolve(input) {
			const paths =
				typeof input.path === "string" ? [input.path] : Array.isArray(input.path) ? input.path : [];
			if (paths.length === 0) return null;
			if (paths.length > 64 || paths.some((path) => typeof path !== "string" || !path))
				throw new Error("ShareFile requires 1-64 nonempty source paths.");
			return {
				primaryKey: "source:0",
				endpoints: paths.map((path, index) => ({
					key: `source:${index}`,
					operation: "read" as const,
					path: path as string,
					deviceId: typeof input.device === "string" ? input.device : undefined,
				})),
			};
		},
	},
	getRawJsonSchema(config) {
		return withDeviceParam(zodToJsonSchema(shareFileTool.parameters), config);
	},
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
					"(supports images, browser-playable video/audio, PDFs, sanitized HTML, and UTF-8 text/code/JSON/Markdown). Unsupported types return an explicit preview notice; media is streamed without transcoding. " +
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
		const paths = isMulti ? inputPath : [inputPath];
		if (paths.length === 0) return { output: "No paths provided.", isError: true };
		if (paths.length > 64 || paths.some((path) => typeof path !== "string" || !path))
			return { output: "ShareFile requires 1-64 nonempty source paths.", isError: true };
		try {
			for (const path of paths) assertSpecPath(path);
		} catch (error) {
			return { output: error instanceof Error ? error.message : String(error), isError: true };
		}
		const backend = getToolBackend(ctx, typeof args.device === "string" ? args.device : undefined);
		if (backend.kind === "remote") return handleRemoteShare(paths, compress, preview, ctx, backend);
		const endpoints = ctx.executionPlan?.endpoints;
		const resolved = paths.map(
			(path, index) =>
				endpoints?.[index]?.target.canonicalPath ??
				endpoints?.[index]?.target.lexicalPath ??
				backend.paths.resolve(toolExecutionCwd(backend, ctx), path),
		);

		// ── Multi-file mode: zip packaging ──────────────────────────────────
		if (isMulti) {
			return handleMultiFile(resolved, ctx, preview);
		}

		// ── Single path mode (original behaviour) ──────────────────────────
		return handleSinglePath(resolved[0], compress, preview, ctx);
	},
};

// ── Multi-file zip handler ───────────────────────────────────────────────────

async function handleMultiFile(
	inputPaths: string[],
	ctx: ToolContext,
	preview?: boolean,
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
		totalSize += await pathSize(full, ctx.signal);
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
				`Expires: ${record.expiresAt.toISOString()} (${expiryHours}h from now)` +
				(preview ? "\nPreview unavailable (compressed). Please download the archive." : ""),
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
				previewRequested: !!preview,
				...(preview ? { previewType: "unsupported", previewReason: "compressed" } : {}),
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

// Preview types and MIME are shared with the route and UI (shared/share-preview.ts).

// ── Single-path handler (original logic) ─────────────────────────────────────

async function handleSinglePath(
	inputPath: string,
	compress: boolean | undefined,
	preview: boolean | undefined,
	ctx: ToolContext,
): Promise<ToolResult> {
	const fullPath = resolve(ctx.cwd, inputPath);

	if (!existsSync(fullPath)) {
		return { output: `Path not found: ${fullPath}`, isError: true };
	}

	const stat = statSync(fullPath);
	const isDir = stat.isDirectory();
	const maxSize = getMaxShareSizeBytes();

	const sourceSize = isDir ? await dirSize(fullPath, ctx.signal) : stat.size;
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
				"--",
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
		let capability = classifySharePreview(finalName);
		if (canPreview && capability.kind === "text") {
			const prefix = new Uint8Array(await Bun.file(storagePath).slice(0, 4096).arrayBuffer());
			if (!isShareText(prefix, finalStat.size <= 4096))
				capability = { kind: "unsupported", mime: "application/octet-stream" };
		}
		const tooLarge = capability.kind === "html" && finalStat.size > SHARE_HTML_MAX_BYTES;
		const previewType =
			canPreview && !tooLarge && capability.kind !== "unsupported" ? capability.kind : null;
		const previewUrl = previewType ? `/api/shares/${record.id}/preview` : null;
		const previewReason =
			preview && !previewUrl
				? !canPreview
					? "compressed"
					: tooLarge
						? "tooLarge"
						: "unsupported"
				: undefined;

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
				(previewUrl
					? `\nPreview: enabled (${previewType}); playback depends on browser support.`
					: previewReason
						? `\nPreview unavailable (${previewReason}). Please download the file.`
						: ""),
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
				previewRequested: !!preview,
				...(previewReason ? { previewReason, previewType: "unsupported" } : {}),
				...(previewUrl && {
					previewMime: capability.mime,
					textFormat: capability.textFormat,
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
