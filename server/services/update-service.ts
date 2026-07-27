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
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import { downloadHelperBinary, getHelperBinaryServerBaseUrl } from "../lib/helper-binaries";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { beginGracefulRestartSession, cancelGracefulRestartSession } from "../lib/server-restart";
import { settings } from "../lib/settings";
import { APP_VERSION, BUILD_PLATFORM } from "../lib/version";
import { applyZstdPatch, type ZstdPatchMeta } from "../lib/zstd-patch";
import { toolContinuationService } from "./tool-continuation-service";
import {
	beginQuiescingTools,
	capturePlannedUpdateRecoverySnapshot,
	consumePlannedUpdateRecoverySnapshot,
	failScheduledUpdate,
	getUpdateCoordinationStatus,
	markUpdateRestarting,
	type PlannedUpdateRecoverySnapshot,
	removePlannedUpdateRecoverySnapshot,
	scheduleUpdate,
	waitForBackgroundBashDrain,
	waitForOrdinaryToolDrain,
	waitForUpdateCheckpointFence,
	writePlannedUpdateRecoverySnapshot,
} from "./update-coordinator";
import {
	checkpointPlannedUpdateContinuations,
	verifySendAwaitCheckpointEpoch,
} from "./update-recovery-service";

/**
 * Find or download the zstd CLI binary.
 * - Checks system PATH first.
 * - Falls back to a NarraFork-managed helper binary cached under ~/.narrafork/bin.
 * Returns the path to zstd binary, or null if unavailable.
 *
 * When `forceDownload` is true (explicit user retry), the recent-failure cache
 * is bypassed so a previous network timeout does not short-circuit the attempt.
 */
async function getZstdCliPath(forceDownload = false): Promise<string | null> {
	try {
		const result = Bun.spawnSync(["zstd", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) return "zstd";
	} catch {
		// zstd not in PATH
	}

	if (process.platform === "darwin") {
		// Keep the existing macOS behavior: Homebrew is the most reliable source
		// for a signed, architecture-correct zstd binary.
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
	}

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
	} else {
		return null;
	}

	return downloadHelperBinary(
		{ toolName, cachedName, displayName: "zstd CLI" },
		{ bypassFailureCache: forceDownload },
	);
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

const UPDATE_DIR = getNarraforkPath("updates");
const PLACED_UPDATE_INFO_PATH = join(UPDATE_DIR, "placed-update.json");
const REPLACEMENT_HANDOFF_WATCHDOG_MS = 75_000;
const CHECKPOINT_FENCE_TIMEOUT_MS = 30_000;
const CHECKPOINT_MAX_ROUNDS = 8;
const CHECKPOINT_REQUIRED_STABLE_PASSES = 2;
const CHECKPOINT_ACTIVE_TOOL_LIMIT = 10_001;

interface PlacedUpdateInfo {
	version: string;
	fromVersion: string;
	fileName: string;
	newBinaryPath?: string;
	updatePath?: string;
	placed: boolean;
	placedAt: string;
	sha512: string;
	sizeBytes: number;
}

/**
 * Get the platform identifier for update server.
 * In compiled binaries, uses the build-time injected constant (includes baseline suffix).
 * Falls back to runtime detection in dev mode.
 */
function getPlatform(): string {
	if (BUILD_PLATFORM) return BUILD_PLATFORM;
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

function normalizePathForCompare(filePath: string): string {
	const resolved = resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSamePath(a: string, b: string): boolean {
	return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function isPathInsideDirectory(childPath: string, parentPath: string): boolean {
	const relativePath = relative(resolve(parentPath), resolve(childPath));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function sanitizeVersionFragment(version: string): string {
	return version.replace(/[^a-zA-Z0-9._-]+/g, "-") || "unknown";
}

function sanitizeUpdateFileName(filePath: string, version: string): string {
	const fallbackExt = process.platform === "win32" ? ".exe" : "";
	const fallback = `narrafork-${sanitizeVersionFragment(version)}${fallbackExt}`;
	const baseName = basename(filePath).replace(/[<>:"/\\|?*]+/g, "-");
	if (!baseName || baseName === "." || baseName === "..") return fallback;
	return baseName;
}

function appendFileNameSuffix(fileName: string, suffix: string): string {
	const ext = extname(fileName);
	const stem = ext ? fileName.slice(0, -ext.length) : fileName;
	return `${stem}${suffix}${ext}`;
}

interface PreparedBinaryDestination {
	path: string;
	fileName: string;
	alreadyPresent: boolean;
}

function chooseNonOverwritingDestination({
	directory,
	baseName,
	version,
	sha512,
	disallowedPath,
}: {
	directory: string;
	baseName: string;
	version: string;
	sha512: string;
	disallowedPath?: string;
}): PreparedBinaryDestination {
	const versionSuffix = sanitizeVersionFragment(version);
	const candidates = [
		baseName,
		appendFileNameSuffix(baseName, `-${versionSuffix}-prepared`),
		...Array.from({ length: 20 }, (_, index) =>
			appendFileNameSuffix(baseName, `-${versionSuffix}-prepared-${index + 2}`),
		),
	];

	for (const fileName of candidates) {
		const candidatePath = resolve(directory, fileName);
		if (!isPathInsideDirectory(candidatePath, directory)) continue;
		if (disallowedPath && isSamePath(candidatePath, disallowedPath)) continue;

		if (existsSync(candidatePath)) {
			try {
				const stat = statSync(candidatePath);
				if (stat.isFile() && computeFileSha512Sync(candidatePath) === sha512) {
					return { path: candidatePath, fileName, alreadyPresent: true };
				}
			} catch {
				// If an existing candidate cannot be read, do not overwrite it.
			}
			continue;
		}

		return { path: candidatePath, fileName, alreadyPresent: false };
	}

	throw new Error("Unable to choose a safe update binary path without overwriting existing files");
}

function resolvePreparedBinaryDestination(
	execPath: string,
	releaseInfo: ReleaseInfo,
): PreparedBinaryDestination {
	return chooseNonOverwritingDestination({
		directory: dirname(execPath),
		baseName: sanitizeUpdateFileName(releaseInfo.path, releaseInfo.version),
		version: releaseInfo.version,
		sha512: releaseInfo.sha512,
		disallowedPath: execPath,
	});
}

function resolveUpdateCacheDestination(releaseInfo: ReleaseInfo): PreparedBinaryDestination {
	return chooseNonOverwritingDestination({
		directory: UPDATE_DIR,
		baseName: sanitizeUpdateFileName(releaseInfo.path, releaseInfo.version),
		version: releaseInfo.version,
		sha512: releaseInfo.sha512,
	});
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

/**
 * Build the base URL for the update server (strips trailing slash).
 * Falls back to the default update server when the configured URL is empty.
 */
function getServerBaseUrl(): string {
	return getHelperBinaryServerBaseUrl();
}

/**
 * Parse a semver string into comparable parts.
 * Pre-release versions (e.g. 0.2.0-beta.1) sort lower than the same version without pre-release.
 */
function parseSemver(v: string): { major: number; minor: number; patch: number; pre: string } {
	const [core, ...rest] = v.split("-");
	const [major = 0, minor = 0, patch = 0] = core.split(".").map(Number);
	return { major, minor, patch, pre: rest.join("-") };
}

/**
 * Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Pre-release identifiers are compared segment-by-segment with numeric awareness
 * (e.g. beta.9 < beta.10).
 */
function compareSemver(a: string, b: string): number {
	const va = parseSemver(a);
	const vb = parseSemver(b);
	if (va.major !== vb.major) return va.major - vb.major;
	if (va.minor !== vb.minor) return va.minor - vb.minor;
	if (va.patch !== vb.patch) return va.patch - vb.patch;
	// No pre-release > has pre-release (e.g. 0.2.0 > 0.2.0-beta.1)
	if (!va.pre && vb.pre) return 1;
	if (va.pre && !vb.pre) return -1;
	// Compare pre-release segment-by-segment (semver §11)
	const aParts = va.pre.split(".");
	const bParts = vb.pre.split(".");
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		if (i >= aParts.length) return -1; // fewer segments = lower precedence
		if (i >= bParts.length) return 1;
		const aNum = Number(aParts[i]);
		const bNum = Number(bParts[i]);
		const aIsNum = !Number.isNaN(aNum);
		const bIsNum = !Number.isNaN(bNum);
		if (aIsNum && bIsNum) {
			if (aNum !== bNum) return aNum - bNum;
		} else if (aIsNum !== bIsNum) {
			return aIsNum ? -1 : 1; // numeric < string per semver spec
		} else {
			const cmp = aParts[i].localeCompare(bParts[i]);
			if (cmp !== 0) return cmp;
		}
	}
	return 0;
}

/**
 * Fetch a single channel from the update server and build an UpdateCheckResult.
 */
async function checkChannel(
	serverUrl: string,
	product: string,
	channel: string,
	platform: string,
): Promise<UpdateCheckResult> {
	const checkUrl = `${serverUrl}/api/v2/products/${product}/releases/latest?channel=${channel}&platform=${platform}&version=${APP_VERSION}`;
	logger.debug("Checking for updates", { url: checkUrl, channel });

	const response = await fetch(checkUrl);
	if (!response.ok) {
		logger.warn("Update check failed", { status: response.status, channel });
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

	if (data.zstdPatch && data.zstdPatch.fromVersion === APP_VERSION) {
		zstdPatchSize = data.zstdPatch.patchSize;
		strategy = "zstd";
		downloadSize = zstdPatchSize;
	} else if (data.patchChain && data.patchChain.length > 0) {
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
}

/**
 * Check for updates from the update server (v2 API).
 * When on the beta channel, also checks stable — if a newer stable version exists,
 * it takes priority so beta users can upgrade to the next stable release.
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
		if (channel === "beta") {
			// Check both channels in parallel
			const [betaResult, stableResult] = await Promise.all([
				checkChannel(serverUrl, product, "beta", platform),
				checkChannel(serverUrl, product, "stable", platform),
			]);

			// Pick the higher version between the two channels
			if (stableResult.updateAvailable && betaResult.updateAvailable) {
				const sv = stableResult.latestVersion ?? "0.0.0";
				const bv = betaResult.latestVersion ?? "0.0.0";
				return compareSemver(sv, bv) >= 0 ? stableResult : betaResult;
			}
			if (stableResult.updateAvailable) return stableResult;
			if (betaResult.updateAvailable) return betaResult;
			return betaResult; // neither has update — return beta result for latestVersion info
		}

		return await checkChannel(serverUrl, product, channel, platform);
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
	options: { forceDownload?: boolean } = {},
): Promise<{
	success: boolean;
	error?: string;
	version?: string;
	updatePath?: string;
	newBinaryPath?: string;
	placed?: boolean;
}> {
	const forceDownload = options.forceDownload ?? false;
	const serverUrl = getServerBaseUrl();
	if (!serverUrl) {
		return { success: false, error: "Update server not configured" };
	}

	const execPath = getCurrentExecutablePath();

	// Ensure update directory exists
	mkdirSync(UPDATE_DIR, { recursive: true });

	const releaseFileName = sanitizeUpdateFileName(releaseInfo.path, releaseInfo.version);
	const updatePath = join(UPDATE_DIR, releaseFileName);
	const tempPath = `${updatePath}.${process.pid}.${Date.now()}.tmp`;

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
		let zstdCliMissing = false;

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
									const cli = await getZstdCliPath(forceDownload);
									if (!cli) {
										logger.warn("Zstd CLI not available for patch-from mode, skipping");
										zstdCliMissing = true;
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
					let currentBuf: Buffer<ArrayBufferLike> = readFileSync(execPath);

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
							const cli = await getZstdCliPath(forceDownload);
							if (!cli) {
								zstdCliMissing = true;
								throw new Error("zstd CLI required for patch-from mode");
							}
							zstdCliPath = cli;
						}

						currentBuf = applyZstdPatch(currentBuf, patchBuf, meta, zstdCliPath);
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
			if (zstdCliMissing) {
				return {
					success: false,
					error: "ZSTD_CLI_MISSING",
				};
			}
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

		let finalUpdatePath = updatePath;
		let newBinaryPath: string | undefined;
		let placed = false;
		let finalFileName = releaseFileName;

		if (execPath) {
			const destination = resolvePreparedBinaryDestination(execPath, releaseInfo);
			newBinaryPath = destination.path;
			finalFileName = destination.fileName;
			if (destination.alreadyPresent) {
				unlinkSync(tempPath);
			} else {
				moveFileNoOverwriteSync(tempPath, newBinaryPath);
			}
			if (process.platform !== "win32") {
				chmodSync(newBinaryPath, 0o755);
			}
			finalUpdatePath = newBinaryPath;
			placed = true;
			logger.info("Update binary placed next to current executable", {
				newBinaryPath,
				version: releaseInfo.version,
				reusedExisting: destination.alreadyPresent,
			});
		} else {
			// Development mode fallback: keep the rebuilt binary in the update cache.
			const destination = resolveUpdateCacheDestination(releaseInfo);
			finalUpdatePath = destination.path;
			finalFileName = destination.fileName;
			if (destination.alreadyPresent) {
				unlinkSync(tempPath);
			} else {
				moveFileNoOverwriteSync(tempPath, finalUpdatePath);
			}
		}

		const finalSize = statSync(finalUpdatePath).size;
		writePlacedUpdateInfo({
			version: releaseInfo.version,
			fromVersion: APP_VERSION,
			fileName: finalFileName,
			newBinaryPath,
			updatePath: finalUpdatePath,
			placed,
			placedAt: new Date().toISOString(),
			sha512: releaseInfo.sha512,
			sizeBytes: finalSize,
		});

		onProgress?.({
			phase: "complete",
			bytesDownloaded: releaseInfo.files[0]?.size ?? 0,
			totalBytes: releaseInfo.files[0]?.size ?? 0,
			percent: 100,
		});

		return {
			success: true,
			version: releaseInfo.version,
			updatePath: finalUpdatePath,
			newBinaryPath,
			placed,
		};
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

function computeFileSha512Sync(filePath: string): string {
	const hash = createHash("sha512");
	hash.update(readFileSync(filePath));
	return hash.digest("base64");
}

function writePlacedUpdateInfo(info: PlacedUpdateInfo): void {
	mkdirSync(UPDATE_DIR, { recursive: true });
	writeFileSync(PLACED_UPDATE_INFO_PATH, JSON.stringify(info, null, 2));
}

function readPlacedUpdateInfo(options: { targetVersion?: string } = {}): PlacedUpdateInfo | null {
	if (!existsSync(PLACED_UPDATE_INFO_PATH)) return null;
	try {
		const info = JSON.parse(readFileSync(PLACED_UPDATE_INFO_PATH, "utf8")) as PlacedUpdateInfo;
		if (options.targetVersion && info.version !== options.targetVersion) return null;
		if (info.fromVersion !== APP_VERSION) return null;
		if (typeof info.sha512 !== "string" || !info.sha512) return null;
		if (typeof info.sizeBytes !== "number" || !Number.isFinite(info.sizeBytes)) return null;

		const candidatePath = info.newBinaryPath ?? info.updatePath;
		if (!candidatePath) return null;
		const resolvedCandidatePath = resolve(candidatePath);
		const execPath = getCurrentExecutablePath();
		const allowedDirectories = [UPDATE_DIR, execPath ? dirname(execPath) : null].filter(
			(dir): dir is string => Boolean(dir),
		);
		if (!allowedDirectories.some((dir) => isPathInsideDirectory(resolvedCandidatePath, dir))) {
			return null;
		}
		if (execPath && isSamePath(resolvedCandidatePath, execPath)) return null;
		if (!existsSync(resolvedCandidatePath)) return null;

		const stat = statSync(resolvedCandidatePath);
		if (!stat.isFile() || stat.size !== info.sizeBytes) return null;
		if (computeFileSha512Sync(resolvedCandidatePath) !== info.sha512) return null;

		return {
			...info,
			newBinaryPath: info.newBinaryPath ? resolve(info.newBinaryPath) : undefined,
			updatePath: info.updatePath ? resolve(info.updatePath) : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Returns update instructions.
 * Compiled binaries are placed next to the current executable as soon as the
 * patch is verified; users can decide when to stop the old process and run it.
 * In dev mode, manual instructions are provided as a fallback.
 */
export function getUpdateInstructions(
	updatePath: string,
	newBinaryPath?: string,
): {
	manual: boolean;
	command?: string;
	newBinaryPath?: string;
	message: string;
} {
	const execPath = getCurrentExecutablePath();
	if (!execPath) {
		return {
			manual: true,
			message: "Running in development mode. Update rebuilt and saved to the update cache.",
		};
	}

	const finalBinaryPath = newBinaryPath ?? updatePath;
	return {
		manual: false,
		newBinaryPath: finalBinaryPath,
		command: `"${finalBinaryPath}"`,
		message: "Update ready. Run the new binary whenever you choose.",
	};
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
 * Get the path where updates are downloaded.
 */
export function getUpdateDirectory(): string {
	return UPDATE_DIR;
}

/**
 * Check if an update has been downloaded and is ready to apply.
 */
export function getUpdateStatus(targetVersion?: string): {
	ready: boolean;
	updateFile?: string;
	canAutoRestart: boolean;
	newBinaryPath?: string;
	updatePath?: string;
	placed?: boolean;
	version?: string;
} {
	const placedInfo = readPlacedUpdateInfo({ targetVersion });
	return {
		ready: !!placedInfo,
		updateFile: placedInfo?.fileName,
		canAutoRestart: !!getCurrentExecutablePath(),
		newBinaryPath: placedInfo?.newBinaryPath,
		updatePath: placedInfo?.updatePath,
		placed: placedInfo?.placed,
		version: placedInfo?.version,
		...getUpdateCoordinationStatus(),
	};
}

/**
 * Move a file without overwriting an existing destination.
 */
function moveFileNoOverwriteSync(src: string, dst: string): void {
	copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
	unlinkSync(src);
}

/**
 * Schedule a restart into the verified prepared update.
 *
 * The API returns immediately after entering the background-Bash draining phase.
 * The replacement process is spawned after background Bash drains, ordinary tools
 * quiesce, and the recovery snapshot is persisted.
 */
export function applyUpdate(options: { targetVersion?: string } = {}): {
	success: boolean;
	error?: string;
	/** Stable code for the fixed pre-flight failures so clients can localize them. */
	code?: "NOT_COMPILED_BINARY" | "NO_PREPARED_UPDATE" | "PREPARED_UPDATE_NOT_PLACED";
	newBinaryPath?: string;
	restarting?: boolean;
	scheduled?: boolean;
	phase?: "idle" | "draining_background_bash" | "quiescing_tools" | "restarting";
	targetVersion?: string;
	pendingExecutionCount?: number;
	pendingBackgroundBashCount?: number;
	pendingOrdinaryExecutionCount?: number;
	resumableExecutionCount?: number;
	pausedToolCount?: number;
	replacementPid?: number;
	drainStartedAt?: string;
} {
	const execPath = getCurrentExecutablePath();
	if (!execPath) {
		return { success: false, error: "Not running as compiled binary", code: "NOT_COMPILED_BINARY" };
	}

	const placedInfo = readPlacedUpdateInfo({ targetVersion: options.targetVersion });
	const newExecPath = placedInfo?.newBinaryPath ?? placedInfo?.updatePath;
	if (!placedInfo || !newExecPath) {
		return {
			success: false,
			error: "No verified prepared update file found",
			code: "NO_PREPARED_UPDATE",
		};
	}
	if (!placedInfo.placed) {
		return {
			success: false,
			error: "Prepared update is not placed next to the executable",
			code: "PREPARED_UPDATE_NOT_PLACED",
		};
	}

	if (process.platform !== "win32") {
		try {
			chmodSync(newExecPath, 0o755);
		} catch {}
	}

	const existing = getUpdateCoordinationStatus();
	if (existing.scheduled) {
		return {
			success: true,
			newBinaryPath: newExecPath,
			restarting: true,
			scheduled: true,
			phase: existing.phase,
			targetVersion: existing.targetVersion,
			pendingExecutionCount: existing.pendingExecutionCount,
			pendingBackgroundBashCount: existing.pendingBackgroundBashCount,
			pendingOrdinaryExecutionCount: existing.pendingOrdinaryExecutionCount,
			resumableExecutionCount: existing.resumableExecutionCount,
			pausedToolCount: existing.pausedToolCount,
		};
	}

	const scheduled = scheduleUpdate(placedInfo.version);
	// scheduleUpdate always assigns an epoch when it transitions an idle coordinator.
	const updateEpoch = scheduled.updateEpoch as string;
	const drainStartedAt = new Date().toISOString();
	void drainAndSpawnPreparedUpdate({
		execPath,
		newExecPath,
		targetVersion: placedInfo.version,
		updateEpoch,
	}).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		runFailedUpdateCleanup({
			updateEpoch,
			targetVersion: placedInfo.version,
			error: message,
		});
	});

	return {
		success: true,
		newBinaryPath: newExecPath,
		restarting: true,
		scheduled: true,
		phase: scheduled.phase,
		targetVersion: scheduled.targetVersion,
		pendingExecutionCount: scheduled.pendingExecutionCount,
		pendingBackgroundBashCount: scheduled.pendingBackgroundBashCount,
		pendingOrdinaryExecutionCount: scheduled.pendingOrdinaryExecutionCount,
		resumableExecutionCount: scheduled.resumableExecutionCount,
		pausedToolCount: scheduled.pausedToolCount,
		drainStartedAt,
	};
}

function preserveFailedUpdateRecoveryEvidence(options: {
	updateEpoch: string;
	targetVersion: string;
}): void {
	const existing = consumePlannedUpdateRecoverySnapshot();
	if (existing?.updateEpoch === options.updateEpoch) return;

	try {
		const captured = capturePlannedUpdateRecoverySnapshot();
		writePlannedUpdateRecoverySnapshot(
			{
				...captured,
				version: 2,
				updateEpoch: options.updateEpoch,
				targetVersion: options.targetVersion,
				capturedAt: new Date().toISOString(),
			},
			// Never clobber a manifest that a newer update epoch already owns.
			{ expectedEpoch: options.updateEpoch },
		);
		logger.warn(
			"Persisted planned-update recovery evidence after continuation cancellation failed",
			{
				updateEpoch: options.updateEpoch,
				targetVersion: options.targetVersion,
			},
		);
	} catch (error) {
		logger.error("Failed to persist planned-update recovery evidence", {
			updateEpoch: options.updateEpoch,
			targetVersion: options.targetVersion,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** @internal Exported for focused update failure-path tests. */
export async function failPreparedUpdateAttempt(options: {
	updateEpoch: string;
	targetVersion: string;
	error: string;
}): Promise<void> {
	const current = getUpdateCoordinationStatus();
	if (current.updateEpoch !== options.updateEpoch) {
		logger.warn("Ignoring stale prepared-update failure", {
			failedUpdateEpoch: options.updateEpoch,
			activeUpdateEpoch: current.updateEpoch,
			error: options.error,
		});
		return;
	}

	cancelGracefulRestartSession();
	try {
		const cancelledCount = await toolContinuationService.cancelEpoch(
			options.updateEpoch,
			options.error,
		);
		logger.info("Cancelled planned-update continuations after update failure", {
			updateEpoch: options.updateEpoch,
			cancelledCount,
		});
	} catch (error) {
		logger.error("Failed to cancel planned-update continuations; keeping recovery gate closed", {
			updateEpoch: options.updateEpoch,
			updateError: options.error,
			cancelError: error instanceof Error ? error.message : String(error),
		});
		preserveFailedUpdateRecoveryEvidence(options);
		return;
	}

	const latest = getUpdateCoordinationStatus();
	if (latest.updateEpoch !== options.updateEpoch) {
		logger.warn("Prepared-update failure cleanup became stale after continuation cancellation", {
			failedUpdateEpoch: options.updateEpoch,
			activeUpdateEpoch: latest.updateEpoch,
		});
		return;
	}

	// Only remove the manifest when it still belongs to the failed epoch. The epoch guard makes
	// this atomic (no consume-then-delete TOCTOU): a manifest owned by a different/newer epoch is
	// preserved for its owner.
	removePlannedUpdateRecoverySnapshot({ expectedEpoch: options.updateEpoch });
	failScheduledUpdate(options.error);
}

function runFailedUpdateCleanup(options: {
	updateEpoch: string;
	targetVersion: string;
	error: string;
}): void {
	void failPreparedUpdateAttempt(options).catch((error) => {
		logger.error("Unexpected prepared-update failure cleanup error", {
			updateEpoch: options.updateEpoch,
			error: error instanceof Error ? error.message : String(error),
		});
	});
}

export interface PlannedUpdateCheckpointHooks {
	waitForFence?: () => Promise<void>;
	checkpoint?: () => Promise<PlannedUpdateRecoverySnapshot>;
	listActiveToolCallIds?: () => Promise<string[]>;
	listCoveredToolCallIds?: (updateEpoch: string) => Promise<string[]>;
	verifySendAwaitContinuations?: (updateEpoch: string) => Promise<{
		stable: boolean;
		unstableToolCallIds: string[];
	}>;
}

async function listActiveToolCallIds(): Promise<string[]> {
	const rows = await db
		.select({ id: narratorToolCalls.id })
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.status, ["initializing", "pending", "running"]))
		.limit(CHECKPOINT_ACTIVE_TOOL_LIMIT);
	if (rows.length >= CHECKPOINT_ACTIVE_TOOL_LIMIT) {
		throw new Error(
			`Planned-update checkpoint exceeds the ${CHECKPOINT_ACTIVE_TOOL_LIMIT - 1}-row safety limit`,
		);
	}
	return rows.map((row) => row.id);
}

/**
 * Close the process-local checkpoint fence and converge durable coverage. Two consecutive
 * stable scans are required so a row inserted during the first checkpoint query is observed
 * and covered before the replacement process can be spawned.
 */
export async function checkpointPreparedUpdateFence(
	updateEpoch: string,
	hooks: PlannedUpdateCheckpointHooks = {},
): Promise<PlannedUpdateRecoverySnapshot> {
	const waitForFence =
		hooks.waitForFence ??
		(() => waitForUpdateCheckpointFence({ timeoutMs: CHECKPOINT_FENCE_TIMEOUT_MS }));
	const checkpoint = hooks.checkpoint ?? checkpointPlannedUpdateContinuations;
	const loadActiveToolCallIds = hooks.listActiveToolCallIds ?? listActiveToolCallIds;
	const loadCoveredToolCallIds =
		hooks.listCoveredToolCallIds ??
		(async (epoch: string) =>
			(await toolContinuationService.listByEpoch(epoch)).map((row) => row.toolCallId));
	const verifySendAwaits = hooks.verifySendAwaitContinuations ?? verifySendAwaitCheckpointEpoch;

	let stablePasses = 0;
	let snapshot: PlannedUpdateRecoverySnapshot | null = null;
	for (let round = 1; round <= CHECKPOINT_MAX_ROUNDS; round++) {
		await waitForFence();
		snapshot = await checkpoint();
		if (snapshot.updateEpoch !== updateEpoch) {
			throw new Error("Planned-update recovery snapshot epoch changed during checkpoint");
		}
		await waitForFence();

		const [activeToolCallIds, coveredToolCallIds, sendAwaitVerification] = await Promise.all([
			loadActiveToolCallIds(),
			loadCoveredToolCallIds(updateEpoch),
			verifySendAwaits(updateEpoch),
		]);
		const covered = new Set(coveredToolCallIds);
		const uncovered = activeToolCallIds.filter((toolCallId) => !covered.has(toolCallId));
		if (uncovered.length === 0 && sendAwaitVerification.stable) {
			stablePasses++;
			logger.debug("Planned-update checkpoint fence stable pass", {
				updateEpoch,
				round,
				stablePasses,
				activeToolCallCount: activeToolCallIds.length,
			});
			if (stablePasses >= CHECKPOINT_REQUIRED_STABLE_PASSES) return snapshot;
		} else {
			stablePasses = 0;
			logger.warn("Planned-update checkpoint has not converged; retrying", {
				updateEpoch,
				round,
				uncoveredCount: uncovered.length,
				uncoveredToolCallIds: uncovered.slice(0, 20),
				unstableSendAwaitCount: sendAwaitVerification.unstableToolCallIds.length,
				unstableSendAwaitToolCallIds: sendAwaitVerification.unstableToolCallIds.slice(0, 20),
			});
		}
		await Promise.resolve();
	}

	throw new Error(
		`Planned-update checkpoint did not converge after ${CHECKPOINT_MAX_ROUNDS} rounds`,
	);
}

async function drainAndSpawnPreparedUpdate(options: {
	execPath: string;
	newExecPath: string;
	targetVersion: string;
	updateEpoch: string;
}): Promise<void> {
	await waitForBackgroundBashDrain();
	beginQuiescingTools();
	await waitForOrdinaryToolDrain();
	const recoverySnapshot = await checkpointPreparedUpdateFence(options.updateEpoch);
	writePlannedUpdateRecoverySnapshot(recoverySnapshot);
	markUpdateRestarting();

	let session: ReturnType<typeof beginGracefulRestartSession>;
	try {
		session = beginGracefulRestartSession();
	} catch (error) {
		throw new Error(`Failed to prepare graceful restart handoff: ${error}`);
	}

	try {
		const env = {
			...process.env,
			NARRAFORK_GRACEFUL_RESTART_URL: session.url,
			NARRAFORK_GRACEFUL_RESTART_TOKEN: session.token,
			NARRAFORK_GRACEFUL_RESTART_MARKER_PATH: session.markerPath,
			NARRAFORK_GRACEFUL_RESTART_MARKER_NONCE: session.markerNonce,
		};
		const launchArgs = process.argv.slice(2);
		const isWindows = process.platform === "win32";
		const proc = isWindows
			? Bun.spawn(
					[
						process.env.ComSpec || "cmd.exe",
						"/d",
						"/c",
						"start",
						"",
						"/D",
						process.cwd(),
						options.newExecPath,
						...launchArgs,
					],
					{
						cwd: process.cwd(),
						env,
						stdio: ["ignore", "ignore", "ignore"],
					},
				)
			: Bun.spawn([options.newExecPath, ...launchArgs], {
					cwd: process.cwd(),
					env,
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				});
		(proc as { unref?: () => void }).unref?.();

		logger.info("Update replacement server spawned after scheduled drain", {
			oldExecPath: options.execPath,
			newExecPath: options.newExecPath,
			targetVersion: options.targetVersion,
			replacementPid: isWindows ? undefined : proc.pid,
			launcherPid: isWindows ? proc.pid : undefined,
			launchMode: isWindows ? "cmd-start" : "detached",
			handoffUrl: session.url,
			markerPath: session.markerPath,
		});

		// If the replacement process starts but never completes the authenticated
		// handoff, the old process would otherwise remain in `restarting` forever.
		// Keep the watchdog unref'ed so it cannot delay a normal shutdown.
		const watchdog = setTimeout(() => {
			const status = getUpdateCoordinationStatus();
			if (status.phase !== "restarting" || status.updateEpoch !== options.updateEpoch) return;
			runFailedUpdateCleanup({
				updateEpoch: options.updateEpoch,
				targetVersion: options.targetVersion,
				error: "Replacement server did not complete graceful handoff in time",
			});
		}, REPLACEMENT_HANDOFF_WATCHDOG_MS);
		(watchdog as { unref?: () => void }).unref?.();
	} catch (error) {
		throw new Error(`Failed to start replacement server: ${error}`);
	}
}
