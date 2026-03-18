/**
 * Update service for delta updates.
 * Handles version checking, blockmap diffing, and update downloading.
 */
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/**
 * Check for updates from the update server.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
	const serverUrl = settings.update?.serverUrl;
	if (!serverUrl) {
		return { updateAvailable: false, currentVersion: APP_VERSION };
	}

	const channel = settings.update?.channel ?? "stable";
	const platform = getPlatform();

	try {
		// Support both old API (/api/check/) and new API (/api/v1/{product}/check/)
		const product = settings.update?.product ?? "narrafork";
		let checkUrl: string;

		// Try new API format first
		if (serverUrl.includes("/api/v1/")) {
			checkUrl = `${serverUrl}/check/${channel}?platform=${platform}&version=${APP_VERSION}`;
		} else {
			// New server with product support
			checkUrl = `${serverUrl}/api/v1/${product}/check/${channel}?platform=${platform}&version=${APP_VERSION}`;
		}

		logger.debug("Checking for updates", { url: checkUrl });

		let response = await fetch(checkUrl);

		// Fallback to legacy API if new API fails
		if (!response.ok && response.status === 404) {
			const legacyUrl = `${serverUrl}/api/check/${channel}?platform=${platform}`;
			logger.debug("Trying legacy API", { url: legacyUrl });
			response = await fetch(legacyUrl);
		}

		if (!response.ok) {
			logger.warn("Update check failed", { status: response.status });
			return { updateAvailable: false, currentVersion: APP_VERSION };
		}

		// Handle new API response format
		const data = (await response.json()) as ReleaseInfo & { updateAvailable?: boolean };

		// New API returns updateAvailable field
		if (data.updateAvailable === false) {
			return { updateAvailable: false, currentVersion: APP_VERSION };
		}

		const releaseInfo = data;
		const latestVersion = releaseInfo.version;

		if (!latestVersion || latestVersion === APP_VERSION) {
			return {
				updateAvailable: false,
				currentVersion: APP_VERSION,
				latestVersion,
			};
		}

		// Compare versions (simple semver comparison)
		if (!isNewerVersion(latestVersion, APP_VERSION)) {
			return {
				updateAvailable: false,
				currentVersion: APP_VERSION,
				latestVersion,
			};
		}

		// Calculate diff size if we have a local blockmap
		let downloadSize: number | undefined;
		let totalSize: number | undefined;
		let diffBlocks: number | undefined;
		let totalBlocks: number | undefined;
		let zstdPatchSize: number | undefined;

		const execPath = getCurrentExecutablePath();
		if (execPath) {
			// Run blockmap diff and zstd meta check in parallel
			const blockmapPromise = (async () => {
				try {
					const blockmapUrl = `${serverUrl}/${channel}/${releaseInfo.path}.blockmap`;
					const blockmapResponse = await fetch(blockmapUrl);
					if (blockmapResponse.ok) {
						const blockmapBuffer = Buffer.from(await blockmapResponse.arrayBuffer());
						const newBlockmap = await parseBlockmapBuffer(blockmapBuffer);

						const localResult = await generateBlockmap(execPath);
						const localBlockmap = localResult.blockmap;

						const diff = calculateDiff(localBlockmap, newBlockmap);
						downloadSize = calculateDiffSize(diff);
						totalSize = calculateTotalSize(newBlockmap);
						diffBlocks = diff.length;
						totalBlocks = newBlockmap.files[0]?.checksums.length ?? 0;
					}
				} catch (err) {
					logger.debug("Failed to calculate diff size", { error: String(err) });
					totalSize = releaseInfo.files[0]?.size;
					downloadSize = totalSize;
				}
			})();

			const zstdPromise = (async () => {
				try {
					const zstdMetaUrl = buildZstdPatchMetaUrl(serverUrl, channel, product, releaseInfo.path);
					const metaResp = await fetch(zstdMetaUrl);
					if (metaResp.ok) {
						const meta = (await metaResp.json()) as ZstdPatchMeta;
						// Only count if the patch is from our current version
						if (meta.fromVersion === APP_VERSION) {
							zstdPatchSize = meta.patchSize;
						}
					}
				} catch {
					// zstd patch not available, no problem
				}
			})();

			await Promise.all([blockmapPromise, zstdPromise]);

			// Use zstd patch size as the effective download size if smaller
			if (zstdPatchSize && (!downloadSize || zstdPatchSize < downloadSize)) {
				downloadSize = zstdPatchSize;
			}
		}

		return {
			updateAvailable: true,
			currentVersion: APP_VERSION,
			latestVersion,
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
 * Simple semver comparison.
 * Returns true if version a is newer than version b.
 */
function isNewerVersion(a: string, b: string): boolean {
	const partsA = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const partsB = b.split(".").map((n) => Number.parseInt(n, 10) || 0);

	for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
		const numA = partsA[i] ?? 0;
		const numB = partsB[i] ?? 0;
		if (numA > numB) return true;
		if (numA < numB) return false;
	}
	return false;
}

/**
 * Download and apply an update using delta updates when possible.
 */
export async function downloadUpdate(
	releaseInfo: ReleaseInfo,
	onProgress?: (progress: UpdateProgress) => void,
): Promise<{ success: boolean; error?: string; updatePath?: string }> {
	const serverUrl = settings.update?.serverUrl;
	if (!serverUrl) {
		return { success: false, error: "Update server not configured" };
	}

	const channel = settings.update?.channel ?? "stable";
	const product = settings.update?.product ?? "narrafork";
	const execPath = getCurrentExecutablePath();

	// Build download base URL (support both old and new API)
	let downloadBaseUrl: string;
	if (serverUrl.includes("/api/v1/")) {
		downloadBaseUrl = `${serverUrl}/download/${channel}/${releaseInfo.version}`;
	} else {
		// Try new API format
		downloadBaseUrl = `${serverUrl}/api/v1/${product}/download/${channel}/${releaseInfo.version}`;
	}

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
			try {
				const zstdMetaUrl = buildZstdPatchMetaUrl(serverUrl, channel, product, releaseInfo.path);
				const metaResp = await fetch(zstdMetaUrl);
				if (metaResp.ok) {
					zstdPatchMeta = (await metaResp.json()) as ZstdPatchMeta;

					// Only use if the patch is from our current version
					if (zstdPatchMeta.fromVersion === APP_VERSION) {
						const zstdPatchUrl = buildZstdPatchUrl(serverUrl, channel, product, releaseInfo.path);
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

			// Strategy 2: blockmap delta (fallback, ~17MB)
			if (!useZstdPatch) {
				try {
					// Download new blockmap
					const blockmapUrl = `${downloadBaseUrl}/${releaseInfo.path}.blockmap`;
					const blockmapResponse = await fetch(blockmapUrl);

					// Fallback to legacy URL if new API fails
					let blockmapBuffer: Buffer;
					if (blockmapResponse.ok) {
						blockmapBuffer = Buffer.from(await blockmapResponse.arrayBuffer());
					} else {
						const legacyUrl = `${serverUrl}/${channel}/${releaseInfo.path}.blockmap`;
						const legacyResponse = await fetch(legacyUrl);
						if (!legacyResponse.ok) {
							throw new Error("Blockmap not available");
						}
						blockmapBuffer = Buffer.from(await legacyResponse.arrayBuffer());
					}

					newBlockmap = await parseBlockmapBuffer(blockmapBuffer);

					// Generate local blockmap
					const localResult = await generateBlockmap(execPath);
					localBlockmap = localResult.blockmap;

					// Calculate diff
					diff = calculateDiff(localBlockmap, newBlockmap);
					const diffSize = calculateDiffSize(diff);
					const totalSize = calculateTotalSize(newBlockmap);

					// Use delta if it saves at least 20% of download
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
				} catch (err) {
					logger.debug("Delta update not available, falling back to full download", {
						error: String(err),
					});
				}
			}
		}

		// Build file download URL
		const fileDownloadUrl = `${downloadBaseUrl}/${releaseInfo.path}`;
		const legacyFileUrl = `${serverUrl}/${channel}/${releaseInfo.path}`;

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

				// applyZstdPatch verifies SHA512 internally
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
				// Fall through to blockmap or full download
				useZstdPatch = false;
			}
		}

		if (!useZstdPatch) {
			if (useDelta && newBlockmap && localBlockmap && diff.length > 0 && execPath) {
				// Blockmap delta download
				await downloadDelta(
					execPath,
					fileDownloadUrl,
					tempPath,
					localBlockmap,
					newBlockmap,
					diff,
					onProgress,
				);
			} else {
				// Full download - try new API first, fallback to legacy
				await downloadFull(
					fileDownloadUrl,
					tempPath,
					releaseInfo.files[0]?.size ?? 0,
					onProgress,
					legacyFileUrl,
				);
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
	fallbackUrl?: string,
): Promise<void> {
	let response = await fetch(url);

	// Try fallback URL if primary fails
	if (!response.ok && fallbackUrl) {
		response = await fetch(fallbackUrl);
	}

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
 * Apply a downloaded update by replacing the current executable.
 * Returns instructions for the user since we can't replace a running binary.
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

	const _execDir = dirname(execPath);
	const execName = basename(execPath);
	const _updateName = basename(updatePath);

	if (process.platform === "win32") {
		// Windows: provide PowerShell command
		return {
			manual: true,
			command: `Stop-Process -Name "${execName.replace(".exe", "")}" -Force; Move-Item -Force "${updatePath}" "${execPath}"; Start-Process "${execPath}"`,
			message: `Update downloaded. Run the following command in PowerShell to apply:\n\nStop-Process -Name "${execName.replace(".exe", "")}" -Force; Move-Item -Force "${updatePath}" "${execPath}"; Start-Process "${execPath}"`,
		};
	}

	// Unix: provide shell command
	return {
		manual: true,
		command: `pkill -f "${execName}" && mv "${updatePath}" "${execPath}" && chmod +x "${execPath}" && "${execPath}"`,
		message: `Update downloaded to ${updatePath}. Run the following command to apply:\n\npkill -f "${execName}" && mv "${updatePath}" "${execPath}" && chmod +x "${execPath}" && "${execPath}"`,
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

	const { readdirSync, unlinkSync, statSync } = require("node:fs");
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
 * Check if running under launcher (supports hot restart)
 */
export function isRunningUnderLauncher(): boolean {
	return !!process.env.NARRAFORK_LAUNCHER_PID;
}

/**
 * Request launcher to restart with new version
 */
export function requestRestart(): boolean {
	if (!isRunningUnderLauncher()) {
		logger.warn("Cannot request restart: not running under launcher");
		return false;
	}

	try {
		// Send IPC message to launcher
		if (process.send) {
			process.send({ type: "restart" });
			logger.info("Restart request sent to launcher");
			return true;
		}
	} catch (err) {
		logger.error("Failed to send restart request", { error: String(err) });
	}

	return false;
}

/**
 * Apply update and restart (for launcher mode)
 */
export async function applyUpdateAndRestart(): Promise<{ success: boolean; error?: string }> {
	if (!isRunningUnderLauncher()) {
		return {
			success: false,
			error: "Hot restart only available when running under launcher",
		};
	}

	// Check if update is downloaded
	if (!existsSync(UPDATE_DIR)) {
		return { success: false, error: "No update downloaded" };
	}

	const files = require("node:fs").readdirSync(UPDATE_DIR) as string[];
	const updateFile = files.find(
		(f: string) => f.startsWith("narrafork-") && !f.endsWith(".blockmap") && !f.endsWith(".tmp"),
	);

	if (!updateFile) {
		return { success: false, error: "No update file found" };
	}

	// Request restart - launcher will apply the update
	if (requestRestart()) {
		return { success: true };
	}

	return { success: false, error: "Failed to request restart" };
}

// ============================================================================
// Zstd patch URL helpers
// ============================================================================

/**
 * Build URL for the zstd patch metadata JSON.
 */
function buildZstdPatchMetaUrl(
	serverUrl: string,
	channel: string,
	product: string,
	releasePath: string,
): string {
	if (serverUrl.includes("/api/v1/")) {
		return `${serverUrl}/download/${channel}/${releasePath}.zstd-patch.meta.json`;
	}
	return `${serverUrl}/api/v1/${product}/download/${channel}/${releasePath}.zstd-patch.meta.json`;
}

/**
 * Build URL for the zstd patch binary.
 */
function buildZstdPatchUrl(
	serverUrl: string,
	channel: string,
	product: string,
	releasePath: string,
): string {
	if (serverUrl.includes("/api/v1/")) {
		return `${serverUrl}/download/${channel}/${releasePath}.zstd-patch`;
	}
	return `${serverUrl}/api/v1/${product}/download/${channel}/${releasePath}.zstd-patch`;
}
