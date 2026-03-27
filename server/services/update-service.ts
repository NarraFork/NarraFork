/**
 * Update service for delta updates.
 * Handles version checking, blockmap diffing, and update downloading.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	applyZstdPatch,
	type Blockmap,
	calculateDiff,
	calculateDiffSize,
	calculateTotalSize,
	type DiffBlock,
	diffToRangeHeader,
	generateBlockmap,
	parseBlockmapBuffer,
	writeBlockmapFile,
	type ZstdPatchMeta,
} from "../lib/blockmap";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { APP_VERSION } from "../lib/version";

export interface ReleaseInfo {
	version: string;
	releaseDate: string;
	releaseNotes?: string;
	path: string;
	sha512: string;
	files: Array<{
		url: string;
		size: number;
		sha512: string;
	}>;
	/** V2 API URLs — populated by checkForUpdate when using v2 server */
	_v2?: {
		downloadUrl: string;
		blockmapUrl?: string;
		zstdPatchUrl?: string;
		zstdPatchMetaUrl?: string;
		/** Whether the server has the full binary for download. */
		hasFullFile?: boolean;
	};
}

export interface UpdateCheckResult {
	updateAvailable: boolean;
	currentVersion: string;
	latestVersion?: string;
	releaseInfo?: ReleaseInfo;
	downloadSize?: number;
	totalSize?: number;
	diffBlocks?: number;
	totalBlocks?: number;
	/** Size of zstd dictionary patch if available (smaller than blockmap diff) */
	zstdPatchSize?: number;
}

export interface UpdateProgress {
	phase: "checking" | "downloading" | "applying" | "complete" | "error";
	bytesDownloaded: number;
	totalBytes: number;
	percent: number;
	error?: string;
}

const UPDATE_DIR = resolve(homedir(), ".narrafork", "updates");

/**
 * Get the platform identifier for update server.
 */
function getPlatform(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	switch (process.platform) {
		case "darwin":
			return `darwin-${arch}`;
		case "win32":
			return `win-${arch}`;
		default:
			return `linux-${arch}`;
	}
}

/**
 * Get the current executable path.
 * For compiled binaries, this is the running executable.
 * For dev mode, returns null.
 */
function getCurrentExecutablePath(): string | null {
	// Check if running as compiled binary
	if (import.meta.url.startsWith("file:///$bunfs/")) {
		return process.execPath;
	}
	return null;
}

/** V2 API response from the update server */
interface V2CheckResponse {
	updateAvailable: boolean;
	currentVersion?: string;
	version?: string;
	releaseDate?: string;
	releaseNotes?: string;
	platform?: string;
	file?: {
		filename: string;
		size: number;
		sha512: string;
	};
	/** Whether the full binary is available for download (false = delta only). */
	hasFullFile?: boolean;
	blockmap?: {
		url: string;
	};
	zstdPatch?: {
		fromVersion: string;
		patchSize: number;
		url: string;
		metaUrl: string;
	} | null;
}

/**
 * Build the base URL for the update server (strips trailing slash).
 */
function getServerBaseUrl(): string {
	const url = settings.update?.serverUrl ?? "";
	return url.replace(/\/+$/, "");
}

/**
 * Check for updates from the update server (v2 API).
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
	const serverUrl = getServerBaseUrl();
	if (!serverUrl) {
		return { updateAvailable: false, currentVersion: APP_VERSION };
	}

	const channel = settings.update?.channel ?? "stable";
	const platform = getPlatform();
	const product = settings.update?.product ?? "narrafork";

	try {
		const checkUrl = `${serverUrl}/api/v2/products/${product}/releases/latest?channel=${channel}&platform=${platform}&version=${APP_VERSION}`;
		logger.debug("Checking for updates", { url: checkUrl });

		const response = await fetch(checkUrl);
		if (!response.ok) {
			logger.warn("Update check failed", { status: response.status });
			return { updateAvailable: false, currentVersion: APP_VERSION };
		}

		const data = (await response.json()) as V2CheckResponse;

		if (!data.updateAvailable || !data.version || !data.file) {
			return {
				updateAvailable: false,
				currentVersion: APP_VERSION,
				latestVersion: data.version,
			};
		}

		// Build ReleaseInfo from v2 response for downstream compatibility
		const releaseInfo: ReleaseInfo = {
			version: data.version,
			releaseDate: data.releaseDate ?? new Date().toISOString(),
			releaseNotes: data.releaseNotes,
			path: data.file.filename,
			sha512: data.file.sha512,
			files: [
				{
					url: data.file.filename,
					size: data.file.size,
					sha512: data.file.sha512,
				},
			],
			// Store v2-specific URLs for download phase
			_v2: {
				downloadUrl: `${serverUrl}/api/v2/products/${product}/releases/${data.version}/download/${data.file.filename}`,
				blockmapUrl: data.blockmap ? `${serverUrl}${data.blockmap.url}` : undefined,
				zstdPatchUrl: data.zstdPatch ? `${serverUrl}${data.zstdPatch.url}` : undefined,
				zstdPatchMetaUrl: data.zstdPatch ? `${serverUrl}${data.zstdPatch.metaUrl}` : undefined,
				hasFullFile: data.hasFullFile ?? true,
			},
		};

		// Calculate diff size if we have a local blockmap
		let downloadSize: number | undefined;
		let totalSize: number | undefined;
		let diffBlocks: number | undefined;
		let totalBlocks: number | undefined;
		let zstdPatchSize: number | undefined;

		// Use zstd patch size from server response directly
		if (data.zstdPatch) {
			zstdPatchSize = data.zstdPatch.patchSize;
			downloadSize = zstdPatchSize;
		}

		const execPath = getCurrentExecutablePath();
		if (execPath && releaseInfo._v2?.blockmapUrl) {
			try {
				const blockmapResponse = await fetch(releaseInfo._v2.blockmapUrl);
				if (blockmapResponse.ok) {
					const blockmapBuffer = Buffer.from(await blockmapResponse.arrayBuffer());
					const newBlockmap = await parseBlockmapBuffer(blockmapBuffer);

					const localResult = await generateBlockmap(execPath);
					const localBlockmap = localResult.blockmap;

					const diff = calculateDiff(localBlockmap, newBlockmap);
					const blockDiffSize = calculateDiffSize(diff);
					totalSize = calculateTotalSize(newBlockmap);
					diffBlocks = diff.length;
					totalBlocks = newBlockmap.files[0]?.checksums.length ?? 0;

					// Use blockmap diff size if no zstd patch or blockmap is smaller
					if (!downloadSize || blockDiffSize < downloadSize) {
						downloadSize = blockDiffSize;
					}
				}
			} catch (err) {
				logger.debug("Failed to calculate diff size", { error: String(err) });
				totalSize = data.file.size;
				if (!downloadSize) downloadSize = totalSize;
			}
		}

		if (!totalSize) totalSize = data.file.size;
		if (!downloadSize) downloadSize = totalSize;

		return {
			updateAvailable: true,
			currentVersion: APP_VERSION,
			latestVersion: data.version,
			releaseInfo,
			downloadSize,
			totalSize,
			diffBlocks,
			totalBlocks,
			zstdPatchSize,
		};
	} catch (err) {
		logger.error("Update check error", { error: String(err) });
		return { updateAvailable: false, currentVersion: APP_VERSION };
	}
}

/**
 * Download and apply an update using delta updates when possible.
 */
export async function downloadUpdate(
	releaseInfo: ReleaseInfo,
	onProgress?: (progress: UpdateProgress) => void,
): Promise<{ success: boolean; error?: string; updatePath?: string }> {
	const serverUrl = getServerBaseUrl();
	if (!serverUrl) {
		return { success: false, error: "Update server not configured" };
	}

	const execPath = getCurrentExecutablePath();

	// Use v2 URLs if available, otherwise build from server URL
	const product = settings.update?.product ?? "narrafork";
	const fileDownloadUrl =
		releaseInfo._v2?.downloadUrl ??
		`${serverUrl}/api/v2/products/${product}/releases/${releaseInfo.version}/download/${releaseInfo.path}`;

	// Ensure update directory exists
	mkdirSync(UPDATE_DIR, { recursive: true });

	const updatePath = join(UPDATE_DIR, basename(releaseInfo.path));
	const tempPath = `${updatePath}.tmp`;

	try {
		onProgress?.({
			phase: "downloading",
			bytesDownloaded: 0,
			totalBytes: releaseInfo.files[0]?.size ?? 0,
			percent: 0,
		});

		let useDelta = false;
		let useZstdPatch = false;
		let diff: DiffBlock[] = [];
		let newBlockmap: Blockmap | null = null;
		let localBlockmap: Blockmap | null = null;
		let zstdPatchMeta: ZstdPatchMeta | null = null;
		let zstdPatchBuf: Buffer | null = null;

		// Try delta update if we have a local executable
		if (execPath && existsSync(execPath)) {
			// Strategy 1: zstd dictionary patch (smallest, ~4MB)
			const zstdMetaUrl = releaseInfo._v2?.zstdPatchMetaUrl;
			const zstdPatchUrl = releaseInfo._v2?.zstdPatchUrl;

			if (zstdMetaUrl && zstdPatchUrl) {
				try {
					const metaResp = await fetch(zstdMetaUrl);
					if (metaResp.ok) {
						zstdPatchMeta = (await metaResp.json()) as ZstdPatchMeta;

						if (zstdPatchMeta.fromVersion === APP_VERSION) {
							const patchResp = await fetch(zstdPatchUrl);
							if (patchResp.ok) {
								zstdPatchBuf = Buffer.from(await patchResp.arrayBuffer());
								useZstdPatch = true;
								onProgress?.({
									phase: "downloading",
									bytesDownloaded: zstdPatchBuf.length,
									totalBytes: zstdPatchBuf.length,
									percent: 100,
								});
								logger.info("Using zstd dictionary patch", {
									fromVersion: zstdPatchMeta.fromVersion,
									toVersion: zstdPatchMeta.toVersion,
									patchSize: zstdPatchBuf.length,
									totalSize: zstdPatchMeta.newFileSize,
									savings: `${Math.round((1 - zstdPatchBuf.length / zstdPatchMeta.newFileSize) * 100)}%`,
								});
							}
						} else {
							logger.debug("Zstd patch version mismatch", {
								patchFrom: zstdPatchMeta.fromVersion,
								current: APP_VERSION,
							});
						}
					}
				} catch (err) {
					logger.debug("Zstd patch not available", { error: String(err) });
				}
			}

			// Strategy 2: blockmap delta (fallback, ~17MB)
			if (!useZstdPatch) {
				const blockmapUrl = releaseInfo._v2?.blockmapUrl;
				if (blockmapUrl) {
					try {
						const blockmapResponse = await fetch(blockmapUrl);
						if (blockmapResponse.ok) {
							const blockmapBuffer = Buffer.from(await blockmapResponse.arrayBuffer());
							newBlockmap = await parseBlockmapBuffer(blockmapBuffer);

							const localResult = await generateBlockmap(execPath);
							localBlockmap = localResult.blockmap;

							diff = calculateDiff(localBlockmap, newBlockmap);
							const diffSize = calculateDiffSize(diff);
							const totalSize = calculateTotalSize(newBlockmap);

							if (diffSize < totalSize * 0.8) {
								useDelta = true;
								logger.info("Using blockmap delta update", {
									diffBlocks: diff.length,
									totalBlocks: newBlockmap.files[0]?.checksums.length,
									diffSize,
									totalSize,
									savings: `${Math.round((1 - diffSize / totalSize) * 100)}%`,
								});
							}
						}
					} catch (err) {
						logger.debug("Delta update not available, falling back to full download", {
							error: String(err),
						});
					}
				}
			}
		}

		if (useZstdPatch && zstdPatchBuf && zstdPatchMeta && execPath) {
			// Zstd dictionary patch — read local binary, apply patch, write result
			try {
				const oldBuf = readFileSync(execPath);

				onProgress?.({
					phase: "applying",
					bytesDownloaded: zstdPatchBuf.length,
					totalBytes: zstdPatchMeta.newFileSize,
					percent: 50,
				});

				const newBuf = applyZstdPatch(oldBuf, zstdPatchBuf, zstdPatchMeta);
				writeFileSync(tempPath, newBuf);

				onProgress?.({
					phase: "applying",
					bytesDownloaded: zstdPatchBuf.length,
					totalBytes: zstdPatchMeta.newFileSize,
					percent: 100,
				});

				logger.info("Zstd patch applied successfully", {
					patchSize: zstdPatchBuf.length,
					resultSize: newBuf.length,
				});
			} catch (err) {
				logger.warn("Zstd patch failed, falling back to full download", {
					error: String(err),
				});
				useZstdPatch = false;
			}
		}

		if (!useZstdPatch) {
			if (useDelta && newBlockmap && localBlockmap && diff.length > 0 && execPath) {
				await downloadDelta(
					execPath,
					fileDownloadUrl,
					tempPath,
					localBlockmap,
					newBlockmap,
					diff,
					onProgress,
				);
			} else if (releaseInfo._v2?.hasFullFile !== false) {
				await downloadFull(fileDownloadUrl, tempPath, releaseInfo.files[0]?.size ?? 0, onProgress);
			} else {
				return {
					success: false,
					error:
						"Delta update not available for this version. No full download provided by the update server.",
				};
			}
		}

		// Verify SHA512
		onProgress?.({
			phase: "applying",
			bytesDownloaded: releaseInfo.files[0]?.size ?? 0,
			totalBytes: releaseInfo.files[0]?.size ?? 0,
			percent: 100,
		});

		const actualSha512 = await computeFileSha512(tempPath);
		if (actualSha512 !== releaseInfo.sha512) {
			unlinkSync(tempPath);
			return {
				success: false,
				error: `SHA512 mismatch: expected ${releaseInfo.sha512.slice(0, 16)}..., got ${actualSha512.slice(0, 16)}...`,
			};
		}

		// Move to final location
		if (existsSync(updatePath)) {
			unlinkSync(updatePath);
		}
		renameSync(tempPath, updatePath);

		// Save blockmap for future delta updates
		if (newBlockmap) {
			await writeBlockmapFile(newBlockmap, `${updatePath}.blockmap`);
		}

		onProgress?.({
			phase: "complete",
			bytesDownloaded: releaseInfo.files[0]?.size ?? 0,
			totalBytes: releaseInfo.files[0]?.size ?? 0,
			percent: 100,
		});

		return { success: true, updatePath };
	} catch (err) {
		// Cleanup temp file
		if (existsSync(tempPath)) {
			try {
				unlinkSync(tempPath);
			} catch {}
		}

		const error = String(err);
		onProgress?.({
			phase: "error",
			bytesDownloaded: 0,
			totalBytes: 0,
			percent: 0,
			error,
		});

		return { success: false, error };
	}
}

/**
 * Download using delta (only changed blocks).
 */
async function downloadDelta(
	localPath: string,
	remoteUrl: string,
	outputPath: string,
	localBlockmap: Blockmap,
	newBlockmap: Blockmap,
	diff: DiffBlock[],
	onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
	const newFile = newBlockmap.files[0];
	if (!newFile) throw new Error("Invalid blockmap");

	const _totalSize = calculateTotalSize(newBlockmap);
	const diffSize = calculateDiffSize(diff);
	let bytesDownloaded = 0;

	// Create output file
	const output = createWriteStream(outputPath);

	// Track which blocks we need to download
	const diffSet = new Set(diff.map((d) => d.index));

	// Download changed blocks using Range requests
	// Group adjacent blocks to minimize requests
	const rangeHeader = diffToRangeHeader(diff);

	let downloadedBlocks: Map<number, Buffer>;
	if (rangeHeader) {
		const response = await fetch(remoteUrl, {
			headers: { Range: rangeHeader },
		});

		if (response.status === 206) {
			// Partial content - parse multipart response or single range
			downloadedBlocks = await parseRangeResponse(response, diff);
		} else if (response.ok) {
			// Server doesn't support Range, download full file
			const buffer = Buffer.from(await response.arrayBuffer());
			downloadedBlocks = new Map();
			let offset = 0;
			for (let i = 0; i < newFile.sizes.length; i++) {
				if (diffSet.has(i)) {
					downloadedBlocks.set(i, buffer.subarray(offset, offset + newFile.sizes[i]));
				}
				offset += newFile.sizes[i];
			}
		} else {
			throw new Error(`Download failed: ${response.status}`);
		}
	} else {
		downloadedBlocks = new Map();
	}

	// Reconstruct file: copy unchanged blocks from local, use downloaded for changed
	return new Promise((resolve, reject) => {
		const localStream = createReadStream(localPath);
		const localFile = localBlockmap.files[0];
		if (!localFile) {
			reject(new Error("Invalid local blockmap"));
			return;
		}

		let blockIndex = 0;
		let localBuffer = Buffer.alloc(0);
		let _localOffset = 0;

		const writeNextBlock = () => {
			while (blockIndex < newFile.sizes.length) {
				const _blockSize = newFile.sizes[blockIndex];

				if (diffSet.has(blockIndex)) {
					// Use downloaded block
					const downloadedBlock = downloadedBlocks.get(blockIndex);
					if (!downloadedBlock) {
						reject(new Error(`Missing downloaded block ${blockIndex}`));
						return;
					}
					output.write(downloadedBlock);
					bytesDownloaded += downloadedBlock.length;
				} else {
					// Copy from local file
					const localBlockSize = localFile.sizes[blockIndex] ?? 0;
					if (localBuffer.length < localBlockSize) {
						// Need more data from local file
						return;
					}
					const localBlock = localBuffer.subarray(0, localBlockSize);
					output.write(localBlock);
					localBuffer = localBuffer.subarray(localBlockSize);
					_localOffset += localBlockSize;
				}

				blockIndex++;

				onProgress?.({
					phase: "downloading",
					bytesDownloaded,
					totalBytes: diffSize,
					percent: Math.round((bytesDownloaded / diffSize) * 100),
				});
			}

			// All blocks written
			output.end();
		};

		localStream.on("data", (chunk: Buffer) => {
			localBuffer = Buffer.concat([localBuffer, chunk]);
			writeNextBlock();
		});

		localStream.on("end", () => {
			writeNextBlock();
		});

		localStream.on("error", reject);
		output.on("finish", resolve);
		output.on("error", reject);
	});
}

/**
 * Parse HTTP Range response (single range or multipart).
 */
async function parseRangeResponse(
	response: Response,
	diff: DiffBlock[],
): Promise<Map<number, Buffer>> {
	const result = new Map<number, Buffer>();
	const contentType = response.headers.get("content-type") ?? "";

	if (contentType.includes("multipart/byteranges")) {
		// Multipart response - parse boundaries
		const boundary = contentType.match(/boundary=([^\s;]+)/)?.[1];
		if (!boundary) throw new Error("Missing boundary in multipart response");

		const buffer = Buffer.from(await response.arrayBuffer());
		const parts = parseMultipartBuffer(buffer, boundary);

		// Match parts to diff blocks by offset
		for (let i = 0; i < parts.length && i < diff.length; i++) {
			result.set(diff[i].index, parts[i]);
		}
	} else {
		// Single range response
		const buffer = Buffer.from(await response.arrayBuffer());
		if (diff.length === 1) {
			result.set(diff[0].index, buffer);
		} else {
			// Multiple ranges requested but got single response - split by sizes
			let offset = 0;
			for (const block of diff) {
				result.set(block.index, buffer.subarray(offset, offset + block.size));
				offset += block.size;
			}
		}
	}

	return result;
}

/**
 * Parse multipart buffer into parts.
 */
function parseMultipartBuffer(buffer: Buffer, boundary: string): Buffer[] {
	const parts: Buffer[] = [];
	const boundaryBuffer = Buffer.from(`--${boundary}`);
	const endBoundary = Buffer.from(`--${boundary}--`);

	let start = 0;
	while (start < buffer.length) {
		const boundaryStart = buffer.indexOf(boundaryBuffer, start);
		if (boundaryStart === -1) break;

		// Find end of headers (double CRLF)
		const headersEnd = buffer.indexOf("\r\n\r\n", boundaryStart);
		if (headersEnd === -1) break;

		const contentStart = headersEnd + 4;

		// Find next boundary
		const nextBoundary = buffer.indexOf(boundaryBuffer, contentStart);
		const contentEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2; // -2 for CRLF before boundary

		if (contentEnd > contentStart) {
			parts.push(buffer.subarray(contentStart, contentEnd));
		}

		start = nextBoundary === -1 ? buffer.length : nextBoundary;

		// Check for end boundary
		if (buffer.subarray(start, start + endBoundary.length).equals(endBoundary)) {
			break;
		}
	}

	return parts;
}

/**
 * Download full file (fallback when delta not available).
 */
async function downloadFull(
	url: string,
	outputPath: string,
	totalSize: number,
	onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Download failed: ${response.status}`);
	}

	const output = createWriteStream(outputPath);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("No response body");

	let bytesDownloaded = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		output.write(Buffer.from(value));
		bytesDownloaded += value.length;

		onProgress?.({
			phase: "downloading",
			bytesDownloaded,
			totalBytes: totalSize,
			percent: totalSize > 0 ? Math.round((bytesDownloaded / totalSize) * 100) : 0,
		});
	}

	return new Promise((resolve, reject) => {
		output.on("finish", resolve);
		output.on("error", reject);
		output.end();
	});
}

/**
 * Compute SHA512 hash of a file.
 */
async function computeFileSha512(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha512");
		const stream = createReadStream(filePath);

		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("base64")));
		stream.on("error", reject);
	});
}

/**
 * Returns update instructions.
 * When running as a compiled binary, `manual` is false — the frontend can use
 * the /api/update/apply endpoint for automatic restart.
 * In dev mode, manual instructions are provided as a fallback.
 */
export function getUpdateInstructions(updatePath: string): {
	manual: boolean;
	command?: string;
	message: string;
} {
	const execPath = getCurrentExecutablePath();
	if (!execPath) {
		return {
			manual: true,
			message:
				"Running in development mode. Update downloaded but cannot be applied automatically.",
		};
	}

	// Compiled binary — auto-restart is available via /api/update/apply
	const execName = basename(execPath);

	if (process.platform === "win32") {
		return {
			manual: false,
			command: `Stop-Process -Name "${execName.replace(".exe", "")}" -Force; Move-Item -Force "${updatePath}" "${execPath}"; Start-Process "${execPath}"`,
			message: "Update ready. Click apply to restart automatically.",
		};
	}

	return {
		manual: false,
		command: `pkill -f "${execName}" && mv "${updatePath}" "${execPath}" && chmod +x "${execPath}" && "${execPath}"`,
		message: "Update ready. Click apply to restart automatically.",
	};
}

/**
 * Get the path where updates are downloaded.
 */
export function getUpdateDirectory(): string {
	return UPDATE_DIR;
}

/**
 * Clean up old update files.
 */
export function cleanupOldUpdates(): void {
	if (!existsSync(UPDATE_DIR)) return;

	const files = readdirSync(UPDATE_DIR);
	const now = Date.now();
	const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

	for (const file of files) {
		const filePath = join(UPDATE_DIR, file);
		try {
			const stat = statSync(filePath);
			if (now - stat.mtimeMs > maxAge) {
				unlinkSync(filePath);
				logger.debug("Cleaned up old update file", { file });
			}
		} catch {}
	}
}

/**
 * Find the downloaded update file in the updates directory.
 */
function findUpdateFile(): string | null {
	if (!existsSync(UPDATE_DIR)) return null;
	const files = readdirSync(UPDATE_DIR);
	return (
		files.find(
			(f) => f.startsWith("narrafork-") && !f.endsWith(".blockmap") && !f.endsWith(".tmp"),
		) ?? null
	);
}

/**
 * Check if an update has been downloaded and is ready to apply.
 */
export function getUpdateStatus(): {
	ready: boolean;
	updateFile?: string;
	canAutoRestart: boolean;
} {
	const execPath = getCurrentExecutablePath();
	const updateFile = findUpdateFile();
	return {
		ready: !!updateFile,
		updateFile: updateFile ?? undefined,
		canAutoRestart: !!execPath,
	};
}

/**
 * Move a file, falling back to copy+delete when src and dst are on different filesystems.
 */
function moveFileSync(src: string, dst: string): void {
	try {
		renameSync(src, dst);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "EXDEV") {
			copyFileSync(src, dst);
			unlinkSync(src);
		} else {
			throw err;
		}
	}
}

/**
 * Apply a downloaded update: replace the current binary and spawn the new process.
 *
 * Flow:
 * 1. Locate the downloaded update file
 * 2. Replace the current executable (Unix: mv; Windows: rename .old then mv)
 * 3. Spawn the new binary as a detached process with --replace-pid=<our PID>
 * 4. The new process will kill us after it starts successfully
 */
export function applyUpdate(): { success: boolean; error?: string } {
	const execPath = getCurrentExecutablePath();
	if (!execPath) {
		return { success: false, error: "Not running as compiled binary" };
	}

	const updateFile = findUpdateFile();
	if (!updateFile) {
		return { success: false, error: "No update file found" };
	}

	const updatePath = join(UPDATE_DIR, updateFile);
	const isWindows = process.platform === "win32";

	try {
		if (isWindows) {
			// Windows: can't overwrite running exe, rename it first
			const oldPath = `${execPath}.old`;
			if (existsSync(oldPath)) {
				try {
					unlinkSync(oldPath);
				} catch {}
			}
			moveFileSync(execPath, oldPath);
			try {
				moveFileSync(updatePath, execPath);
			} catch (err) {
				// Rollback: restore original exe
				moveFileSync(oldPath, execPath);
				throw err;
			}
		} else {
			// Unix: can overwrite running binary (inode stays valid for current process)
			moveFileSync(updatePath, execPath);
			chmodSync(execPath, 0o755);
		}
	} catch (err) {
		return { success: false, error: `Failed to replace binary: ${err}` };
	}

	// Build args for the new process: inherit current args, add --replace-pid
	const newArgs = process.argv.slice(1).filter((a) => !a.startsWith("--replace-pid="));
	newArgs.push(`--replace-pid=${process.pid}`);

	try {
		const proc = Bun.spawn([execPath, ...newArgs], {
			stdio: ["ignore", "ignore", "ignore"],
			env: { ...process.env },
		});
		proc.unref();

		logger.info("Spawned new process for update", {
			newPid: proc.pid,
			oldPid: process.pid,
			execPath,
		});
	} catch (err) {
		return { success: false, error: `Failed to spawn new process: ${err}` };
	}

	return { success: true };
}
