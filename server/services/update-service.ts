/**
 * Update service for delta updates.
 * Handles version checking, zstd patch application, and update downloading.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
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
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { APP_VERSION } from "../lib/version";
import { applyZstdPatch, type ZstdPatchMeta } from "../lib/zstd-patch";

const NARRAFORK_DIR = join(homedir(), ".narrafork");
const BIN_DIR = join(NARRAFORK_DIR, "bin");

/**
 * Find or download the zstd CLI binary.
 * - Linux/macOS: check system PATH
 * - Windows: check BIN_DIR for cached zstd.exe, download from update server if missing
 * Returns the path to zstd binary, or null if unavailable.
 */
async function getZstdCliPath(): Promise<string | null> {
	// Check system PATH first
	try {
		const result = Bun.spawnSync(["zstd", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) return "zstd";
	} catch {
		// zstd not in PATH
	}

	// Determine platform-specific binary name
	let toolName: string;
	let cachedName: string;
	if (process.platform === "win32") {
		toolName = "zstd-win64.exe";
		cachedName = "zstd.exe";
	} else if (process.platform === "linux" && process.arch === "arm64") {
		toolName = "zstd-linux-arm64";
		cachedName = "zstd";
	} else if (process.platform === "linux") {
		toolName = "zstd-linux-x64";
		cachedName = "zstd";
	} else if (process.platform === "darwin") {
		// macOS: try installing via Homebrew
		const brewResult = Bun.spawnSync(["brew", "install", "zstd"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (brewResult.exitCode === 0) {
			const recheck = Bun.spawnSync(["zstd", "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (recheck.exitCode === 0) {
				logger.info("Installed zstd via Homebrew");
				return "zstd";
			}
		}
		return null;
	} else {
		// Unknown platform
		return null;
	}

	// Check cached binary
	const cached = join(BIN_DIR, cachedName);
	if (existsSync(cached)) {
		// Ensure executable
		try {
			chmodSync(cached, 0o755);
		} catch {}
		return cached;
	}

	// Download from update server
	const serverUrl = getServerBaseUrl();
	if (!serverUrl) return null;

	try {
		const resp = await fetch(`${serverUrl}/api/v2/tools/${toolName}`);
		if (resp.ok) {
			mkdirSync(BIN_DIR, { recursive: true });
			const buf = Buffer.from(await resp.arrayBuffer());
			writeFileSync(cached, buf);
			chmodSync(cached, 0o755);
			logger.info("Downloaded zstd CLI", { path: cached, size: buf.length });
			return cached;
		}
	} catch (err) {
		logger.debug("Failed to download zstd CLI", { error: String(err) });
	}

	return null;
}

export interface ReleaseInfo {
	version: string;
	releaseDate: string;
	releaseNotes?: string | Record<string, string>;
	path: string;
	sha512: string;
	files: Array<{
		url: string;
		size: number;
		sha512: string;
	}>;
	/** V2 API URLs — populated by checkForUpdate when using v2 server */
	_v2?: {
		zstdPatchUrl?: string;
		zstdPatchMetaUrl?: string;
		patchChain?: Array<{
			fromVersion: string;
			toVersion: string;
			patchSize: number;
			url: string;
			metaUrl: string;
		}>;
	};
	/** Release notes for each version in the update path */
	releaseNotesPerVersion?: Array<{
		version: string;
		releaseDate: string;
		releaseNotes?: string | Record<string, string>;
	}>;
}

export interface UpdateCheckResult {
	updateAvailable: boolean;
	currentVersion: string;
	latestVersion?: string;
	releaseInfo?: ReleaseInfo;
	/** Actual download size based on chosen strategy */
	downloadSize?: number;
	totalSize?: number;
	/** Size of zstd dictionary patch if available */
	zstdPatchSize?: number;
	/** Which strategy will be used */
	strategy?: "zstd";
	/** Patch chain for multi-step updates when direct patch is unavailable */
	patchChain?: Array<{
		fromVersion: string;
		toVersion: string;
		patchSize: number;
		url: string;
		metaUrl: string;
	}>;
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
	// Linux/macOS: $bunfs, Windows: ~BUN/%7EBUN
	if (import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/")) {
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
	releaseNotes?: string | Record<string, string>;
	platform?: string;
	file?: {
		filename: string;
		size: number;
		sha512: string;
	};
	zstdPatch?: {
		fromVersion: string;
		patchSize: number;
		url: string;
		metaUrl: string;
	} | null;
	patchChain?: Array<{
		fromVersion: string;
		toVersion: string;
		patchSize: number;
		url: string;
		metaUrl: string;
	}> | null;
	releaseNotesPerVersion?: Array<{
		version: string;
		releaseDate: string;
		releaseNotes?: string | Record<string, string>;
	}>;
}

const DEFAULT_UPDATE_SERVER_URL = "https://narrafork-update.b.domexie.cn";

/**
 * Build the base URL for the update server (strips trailing slash).
 * Falls back to the default update server when the configured URL is empty.
 */
function getServerBaseUrl(): string {
	const url = settings.update?.serverUrl || DEFAULT_UPDATE_SERVER_URL;
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
			_v2: {
				zstdPatchUrl: data.zstdPatch ? `${serverUrl}${data.zstdPatch.url}` : undefined,
				zstdPatchMetaUrl: data.zstdPatch ? `${serverUrl}${data.zstdPatch.metaUrl}` : undefined,
				patchChain: data.patchChain?.map((step) => ({
					...step,
					url: `${serverUrl}${step.url}`,
					metaUrl: `${serverUrl}${step.metaUrl}`,
				})),
			},
			releaseNotesPerVersion: data.releaseNotesPerVersion,
		};

		let downloadSize: number | undefined;
		let zstdPatchSize: number | undefined;
		let strategy: "zstd" | undefined;
		let patchChain: UpdateCheckResult["patchChain"];

		// Check zstd patch availability
		if (data.zstdPatch && data.zstdPatch.fromVersion === APP_VERSION) {
			zstdPatchSize = data.zstdPatch.patchSize;
			strategy = "zstd";
			downloadSize = zstdPatchSize;
		} else if (data.patchChain && data.patchChain.length > 0) {
			// No direct patch — use chain
			patchChain = data.patchChain.map((step) => ({
				...step,
				url: `${serverUrl}${step.url}`,
				metaUrl: `${serverUrl}${step.metaUrl}`,
			}));
			strategy = "zstd";
			downloadSize = patchChain.reduce((sum, s) => sum + s.patchSize, 0);
		}

		const totalSize = data.file.size;
		if (!downloadSize) downloadSize = totalSize;

		return {
			updateAvailable: true,
			currentVersion: APP_VERSION,
			latestVersion: data.version,
			releaseInfo,
			downloadSize,
			totalSize,
			zstdPatchSize,
			strategy,
			patchChain,
		};
	} catch (err) {
		logger.error("Update check error", { error: String(err) });
		return { updateAvailable: false, currentVersion: APP_VERSION };
	}
}

/**
 * Download and apply an update using zstd patches.
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

	// Ensure update directory exists
	mkdirSync(UPDATE_DIR, { recursive: true });

	const updatePath = join(UPDATE_DIR, basename(releaseInfo.path));
	const tempPath = `${updatePath}.tmp`;

	logger.info("Starting update download", {
		version: releaseInfo.version,
		execPath,
		hasV2: !!releaseInfo._v2,
	});

	try {
		onProgress?.({
			phase: "downloading",
			bytesDownloaded: 0,
			totalBytes: releaseInfo.files[0]?.size ?? 0,
			percent: 0,
		});

		let applied = false;

		// Strategy: direct zstd patch
		if (execPath && existsSync(execPath)) {
			const zstdMetaUrl = releaseInfo._v2?.zstdPatchMetaUrl;
			const zstdPatchUrl = releaseInfo._v2?.zstdPatchUrl;

			if (zstdMetaUrl && zstdPatchUrl) {
				try {
					const metaResp = await fetch(zstdMetaUrl);
					if (metaResp.ok) {
						const meta = (await metaResp.json()) as ZstdPatchMeta;
						if (meta.fromVersion === APP_VERSION) {
							onProgress?.({
								phase: "downloading",
								bytesDownloaded: 0,
								totalBytes: meta.patchSize,
								percent: 0,
							});

							const patchResp = await fetch(zstdPatchUrl);
							if (patchResp.ok) {
								const patchBuf = Buffer.from(await patchResp.arrayBuffer());
								onProgress?.({
									phase: "downloading",
									bytesDownloaded: patchBuf.length,
									totalBytes: patchBuf.length,
									percent: 100,
								});

								logger.info("Applying zstd patch", {
									patchSize: patchBuf.length,
									newFileSize: meta.newFileSize,
									mode: meta.mode ?? "dictionary",
								});

								onProgress?.({
									phase: "applying",
									bytesDownloaded: patchBuf.length,
									totalBytes: meta.newFileSize,
									percent: 50,
								});

								// For patch-from mode, we need zstd CLI
								let zstdCliPath: string | undefined;
								if (meta.mode === "patch-from") {
									const cli = await getZstdCliPath();
									if (!cli) {
										logger.warn("Zstd CLI not available for patch-from mode, skipping");
										throw new Error("zstd CLI required for patch-from mode");
									}
									zstdCliPath = cli;
								}

								const oldBuf = readFileSync(execPath);
								const newBuf = applyZstdPatch(oldBuf, patchBuf, meta, zstdCliPath);
								writeFileSync(tempPath, newBuf);
								applied = true;

								onProgress?.({
									phase: "applying",
									bytesDownloaded: patchBuf.length,
									totalBytes: meta.newFileSize,
									percent: 100,
								});

								logger.info("Zstd patch applied successfully", {
									patchSize: patchBuf.length,
									resultSize: newBuf.length,
								});
							}
						} else {
							logger.debug("Zstd patch version mismatch", {
								patchFrom: meta.fromVersion,
								current: APP_VERSION,
							});
						}
					}
				} catch (err) {
					logger.warn("Zstd patch failed", { error: String(err) });
				}
			}
		}

		// Strategy: patch chain (multi-step)
		if (!applied && execPath && existsSync(execPath)) {
			const chain = releaseInfo._v2?.patchChain;
			if (chain && chain.length > 0) {
				try {
					logger.info("Using patch chain", { steps: chain.length });
					let currentBuf = readFileSync(execPath);

					for (let i = 0; i < chain.length; i++) {
						const step = chain[i];
						onProgress?.({
							phase: "downloading",
							bytesDownloaded: 0,
							totalBytes: step.patchSize,
							percent: Math.round((i / chain.length) * 100),
						});

						const metaResp = await fetch(step.metaUrl);
						if (!metaResp.ok) {
							throw new Error(
								`Failed to fetch patch meta for step ${i + 1}/${chain.length}: ${metaResp.status}`,
							);
						}
						const meta = (await metaResp.json()) as ZstdPatchMeta;

						const patchResp = await fetch(step.url);
						if (!patchResp.ok) {
							throw new Error(
								`Failed to fetch patch for step ${i + 1}/${chain.length}: ${patchResp.status}`,
							);
						}
						const patchBuf = Buffer.from(await patchResp.arrayBuffer());

						logger.info("Applying patch chain step", {
							step: `${i + 1}/${chain.length}`,
							from: step.fromVersion,
							to: step.toVersion,
							patchSize: patchBuf.length,
						});

						onProgress?.({
							phase: "applying",
							bytesDownloaded: patchBuf.length,
							totalBytes: meta.newFileSize,
							percent: Math.round(((i + 0.5) / chain.length) * 100),
						});

						let zstdCliPath: string | undefined;
						if (meta.mode === "patch-from") {
							const cli = await getZstdCliPath();
							if (!cli) {
								throw new Error("zstd CLI required for patch-from mode");
							}
							zstdCliPath = cli;
						}

						currentBuf = Buffer.from(applyZstdPatch(currentBuf, patchBuf, meta, zstdCliPath));
					}

					writeFileSync(tempPath, currentBuf);
					applied = true;

					onProgress?.({
						phase: "applying",
						bytesDownloaded: currentBuf.length,
						totalBytes: currentBuf.length,
						percent: 100,
					});

					logger.info("Patch chain applied successfully", {
						steps: chain.length,
						resultSize: currentBuf.length,
					});
				} catch (err) {
					logger.warn("Patch chain failed", { error: String(err) });
				}
			}
		}

		if (!applied) {
			return {
				success: false,
				error:
					"No applicable update strategy: neither direct zstd patch nor patch chain available.",
			};
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
	newBinaryPath?: string;
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

	const execDir = join(execPath, "..");
	const updateFile = basename(updatePath);
	const newExecPath = join(execDir, updateFile);

	if (process.platform === "win32") {
		return {
			manual: false,
			newBinaryPath: newExecPath,
			command: `"${newExecPath}"`,
			message: "Update ready. Click apply to stop the server, then run the new binary.",
		};
	}

	return {
		manual: false,
		newBinaryPath: newExecPath,
		command: `"${newExecPath}"`,
		message: "Update ready. Click apply to stop the server, then run the new binary.",
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
	return files.find((f) => f.startsWith("narrafork-") && !f.endsWith(".tmp")) ?? null;
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
 * Apply a downloaded update: place the new binary next to the current one and spawn it.
 *
 * Flow:
 * 1. Locate the downloaded update file (e.g. narrafork-0.1.1-linux-x64)
 * 2. Move it to the same directory as the current executable, keeping the new filename
 * 3. Spawn the new binary as a detached process with --replace-pid=<our PID>
 * 4. The new process will kill us after it starts successfully
 */
/**
 * Apply a downloaded update:
 * 1. Move the update file to the same directory as the current executable
 * 2. Exit the process so the user can start the new binary
 */
export function applyUpdate(): { success: boolean; error?: string; newBinaryPath?: string } {
	const execPath = getCurrentExecutablePath();
	if (!execPath) {
		return { success: false, error: "Not running as compiled binary" };
	}

	const updateFile = findUpdateFile();
	if (!updateFile) {
		return { success: false, error: "No update file found" };
	}

	const updatePath = join(UPDATE_DIR, updateFile);
	const execDir = join(execPath, "..");
	const newExecPath = join(execDir, updateFile);
	const isWindows = process.platform === "win32";

	try {
		// Move update file to the same directory as current executable, with new filename
		if (existsSync(newExecPath)) {
			try {
				unlinkSync(newExecPath);
			} catch {}
		}
		moveFileSync(updatePath, newExecPath);
		if (!isWindows) {
			chmodSync(newExecPath, 0o755);
		}
	} catch (err) {
		return { success: false, error: `Failed to place new binary: ${err}` };
	}

	logger.info("Update applied, shutting down", {
		oldExecPath: execPath,
		newExecPath,
	});

	// Exit after a short delay to allow the response to be sent
	setTimeout(() => {
		process.exit(0);
	}, 500);

	return { success: true, newBinaryPath: newExecPath };
}
