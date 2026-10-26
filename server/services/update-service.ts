/**
 * Update service for delta updates.
 * Handles version checking, zstd patch application, and update downloading.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	existsSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { inArray } from "drizzle-orm";
import type { GithubPatchStep } from "../../shared/release-patch";
import {
	isLegacyMirrorSourceIdentity,
	type PreparedUpdateIdentity,
	parseRecoveryManifestVersions,
	parseUpdateSourceIdentity,
	sameUpdateSourceIdentity,
	type UpdateSourceIdentity,
} from "../../shared/update-identity";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import { downloadHelperBinary } from "../lib/helper-binaries";
import { getCliHelperSpec, isNativeCliHelper } from "../lib/helper-binary-platform";
import {
	createDistributionContext,
	type DistributionContext,
} from "../lib/helper-distribution-runtime";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { managerChildTokenEnv } from "../lib/manager-token";
import { getNarraforkPath } from "../lib/narrafork-home";
import { envWithAmbientProxy } from "../lib/net/proxy-env";
import { createUpdateFetchContext, type UpdateFetchContext } from "../lib/net/update-fetch";
import { replacementLaunchArgs } from "../lib/replacement-launch";
import {
	beginGracefulRestartSession,
	cancelGracefulRestartSession,
	canOperatorShutdown,
	scheduleOperatorShutdown,
} from "../lib/server-restart";
import { settings } from "../lib/settings";
import { DEFAULT_GITHUB_REPOSITORY } from "../lib/settings/update-source";
import { isTrustedUpdateServerUrl } from "../lib/update-server-url";
import { APP_VERSION, BUILD_PLATFORM } from "../lib/version";
import {
	createGithubUpdateDeadline,
	downloadGithubUpdateToFile,
} from "./github-release-patch-apply";
import {
	downloadGithubBinaryToFile,
	downloadGithubPatchToFile,
	GithubUpdateError,
	githubReleaseUpdater,
	type UpdateNotesRequest,
} from "./github-release-update";
import { getReservedRecoverySourceEpochs } from "./recovery-handoff";
import { toolContinuationService } from "./tool-continuation-service";
import {
	assertUpdateNotCancelled,
	beginQuiescingTools,
	cancelScheduledUpdate,
	capturePlannedUpdateRecoverySnapshot,
	consumePlannedUpdateRecoverySnapshot,
	failScheduledUpdate,
	getScheduledRecoveryEpochs,
	getUpdateCoordinationStatus,
	markUpdateRestarting,
	type PlannedUpdateRecoverySnapshot,
	releasePreparedUpdateRecoveryHandoff,
	removePlannedUpdateRecoverySnapshot,
	rollbackPreparedUpdateRecoverySnapshot,
	scheduleUpdate,
	UpdateCancelledError,
	type UpdateCoordinationStatus,
	waitForBackgroundBashDrain,
	waitForOrdinaryToolDrain,
	waitForScheduledRecoveryHandoff,
	waitForUpdateCheckpointFence,
	writePlannedUpdateRecoverySnapshot,
	writePreparedUpdateRecoverySnapshot,
} from "./update-coordinator";
import { checkMirrorUpdate, downloadMirrorPatch, getMirrorNotes } from "./update-mirror-client";
import {
	CHECKPOINT_ACTIVE_TOOL_LIMIT,
	checkpointPlannedUpdateContinuations,
	isLiveNarratorForCheckpoint,
} from "./update-recovery-service";

/** Probe budget for `zstd --version`; a hung probe must not stall the request. */
const ZSTD_PROBE_TIMEOUT_MS = 5_000;

/** Asynchronously check whether a zstd binary answers `--version`. */
async function zstdCliResponds(binary: string, signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted();
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn([binary, "--version"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
	} catch {
		return false;
	}
	const onAbort = () => proc.kill();
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const timer = setTimeout(() => proc.kill(), ZSTD_PROBE_TIMEOUT_MS);
	try {
		return (await proc.exited) === 0;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Resolve system zstd first, then prepare a verified helper from the frozen effective source. */
async function getZstdCliPath(
	forceDownload = false,
	allowDownload = true,
	signal?: AbortSignal,
	context?: DistributionContext,
): Promise<string | null> {
	signal?.throwIfAborted();
	const system = Bun.which("zstd");
	if (system && isNativeCliHelper(system) && (await zstdCliResponds(system, signal))) return system;
	const spec = getCliHelperSpec("zstd");
	if (!spec) return null;
	if (!allowDownload) return null;
	return downloadHelperBinary(spec, { bypassFailureCache: forceDownload, signal, context });
}

export interface ReleaseInfo {
	/** Selected delivery origin, re-resolved server-side before downloading. */
	source?: "github" | "update-server";
	repository?: string;
	/** Effective source policy captured before the check starts, never inferred at download time. */
	sourceIdentity?: UpdateSourceIdentity;
	/** Verified binary sidecar capability; never supplied by an apply request. */
	recoveryManifestVersions?: number[];
	_github?: { repository: string; downloadUrl: string; patchChain?: GithubPatchStep[] };
	_mirror?: {
		serverUrl: string;
		patch?: { name: string; size: number; sha256: string; url: string };
	};
	version: string;
	releaseDate: string;
	releaseNotes?: string | Record<string, string>;
	notesDeferred?: boolean;
	notesAvailable?: boolean;
	path: string;
	sha512: string;
	files: Array<{
		url: string;
		size: number;
		sha512: string;
	}>;
	/** V2 API URLs — populated by checkForUpdate when using v2 server */
	_v2?: {
		/** Snapshot the configured origin so concurrent settings changes cannot retarget a download. */
		serverUrl?: string;
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
	source?: "github" | "update-server";
	repository?: string;
	sourceIdentity?: UpdateSourceIdentity;
	error?: string;
	errorCode?: string;
	retryAfter?: number;
	updateAvailable: boolean;
	currentVersion: string;
	latestVersion?: string;
	releaseInfo?: ReleaseInfo;
	notesDeferred?: boolean;
	notesAvailable?: boolean;
	/** Actual download size based on chosen strategy */
	downloadSize?: number;
	totalSize?: number;
	/** Size of zstd dictionary patch if available */
	zstdPatchSize?: number;
	/** Which strategy will be used */
	strategy?: "full" | "zstd";
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
	strategy?: "full" | "zstd";
	fallback?: boolean;
}

const UPDATE_DIR = getNarraforkPath("updates");
const PLACED_UPDATE_INFO_PATH = join(UPDATE_DIR, "placed-update.json");
/** Recovery manifest name, owned by update-coordinator; cleanup must never delete it. */
const RECOVERY_SNAPSHOT_FILE_NAME = "planned-update-recovery.json";
const PLACED_UPDATE_INFO_FILE_NAME = "placed-update.json";
const MAX_BINARY_BYTES = 1024 * 1024 * 1024;
const REPLACEMENT_HANDOFF_WATCHDOG_MS = 75_000;
const CHECKPOINT_MAX_ROUNDS = 8;
const CHECKPOINT_REQUIRED_STABLE_PASSES = 2;

interface FailedUpdateCleanup {
	updateEpoch: string;
	targetVersion: string;
	error: string;
	cancelled?: boolean;
}

// A failed durable rollback keeps its gate closed. Preserve the current attempt
// so the operator can retry cleanup instead of being stranded after the watchdog.
const failedUpdateCleanup = hotSafe("update.failedHandoffCleanup", () => ({
	pending: null as { options: FailedUpdateCleanup; retrying: boolean; error: string } | null,
}));
function getUpdateCoordinationWithCleanup(): UpdateCoordinationStatus & {
	cleanupRetryPending: boolean;
} {
	const status = getUpdateCoordinationStatus();
	const pending = failedUpdateCleanup.pending;
	const needsRetry = status.scheduled && status.updateEpoch === pending?.options.updateEpoch;
	return {
		...status,
		cleanupRetryPending: needsRetry,
		...(needsRetry && pending ? { error: pending.error, errorKind: "failed" as const } : {}),
	};
}
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
	/** Absent on legacy metadata; never backfilled from the current source settings. */
	sourceIdentity?: UpdateSourceIdentity;
	/** Frozen with the verified binary identity, not inferred from its version. */
	recoveryManifestVersions?: number[];
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

function safeUnlink(filePath: string): void {
	try {
		if (existsSync(filePath)) unlinkSync(filePath);
	} catch {
		// Best effort cleanup.
	}
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

async function chooseNonOverwritingDestination({
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
}): Promise<PreparedBinaryDestination> {
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
				if (stat.isFile() && (await verifyFileSha512Cached(candidatePath, stat, sha512))) {
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
): Promise<PreparedBinaryDestination> {
	return chooseNonOverwritingDestination({
		directory: dirname(execPath),
		baseName: sanitizeUpdateFileName(releaseInfo.path, releaseInfo.version),
		version: releaseInfo.version,
		sha512: releaseInfo.sha512,
		disallowedPath: execPath,
	});
}

function resolveUpdateCacheDestination(
	releaseInfo: ReleaseInfo,
): Promise<PreparedBinaryDestination> {
	return chooseNonOverwritingDestination({
		directory: UPDATE_DIR,
		baseName: sanitizeUpdateFileName(releaseInfo.path, releaseInfo.version),
		version: releaseInfo.version,
		sha512: releaseInfo.sha512,
	});
}

export { isTrustedUpdateServerUrl };

function getServerBaseUrl(): string {
	// Application updates and helper distribution are separate paths; GitHub never uses this URL.
	const url = (settings.update?.serverUrl || "https://narrafork-update.b.domexie.cn").replace(
		/\/+$/,
		"",
	);
	if (!url) return "";
	if (!isTrustedUpdateServerUrl(url)) {
		logger.warn("Ignoring update server URL that cannot be trusted to deliver code", { url });
		return "";
	}
	return url;
}

/**
 * Resolve a URL reported by the update server against its own origin.
 *
 * String concatenation is not safe here: a value like `@evil.com/x` turns
 * `https://updates.example.com` + `@evil.com/x` into a request to `evil.com` with the update
 * host as userinfo. Parsing and asserting the origin keeps the update server's own response
 * from redirecting the download anywhere else.
 */
function resolveSameOriginUrl(serverBase: string, candidate: string): string | null {
	try {
		const base = new URL(serverBase);
		const resolved = new URL(candidate, base);
		if (resolved.origin !== base.origin) {
			logger.warn("Discarded update URL pointing at a different origin", {
				serverOrigin: base.origin,
				resolvedOrigin: resolved.origin,
			});
			return null;
		}
		return resolved.toString();
	} catch (error) {
		logger.warn("Discarded unparseable update URL", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** @internal Exported for update URL trust tests. */
export function __resolveSameOriginUrlForTests(
	serverBase: string,
	candidate: string,
): string | null {
	return resolveSameOriginUrl(serverBase, candidate);
}

/** Capture source policy before any asynchronous detection; cached results stay immutable. */
export async function checkForUpdate(
	options: { force?: boolean; transport?: UpdateFetchContext } = {},
): Promise<UpdateCheckResult> {
	const identity = getCurrentUpdateSourceIdentity();
	if (!identity)
		return {
			updateAvailable: false,
			currentVersion: APP_VERSION,
			errorCode: "INVALID_CONFIGURATION",
			error: "Invalid update source configuration",
		};
	const sourceIdentity = Object.freeze(identity);
	let result: UpdateCheckResult;
	if (sourceIdentity.source === "github") {
		const startedAt = Date.now();
		result = await githubReleaseUpdater.check(
			{
				repository: sourceIdentity.repository,
				channel: sourceIdentity.channel,
				platform: sourceIdentity.platform,
				currentVersion: APP_VERSION,
			},
			options,
		);
		if (result.errorCode || Date.now() - startedAt > 5000) {
			logger.warn("GitHub update check completed", {
				source: "github",
				errorCode: result.errorCode,
				durationMs: Date.now() - startedAt,
			});
		}
	} else {
		result = {
			...(await checkForServerUpdate(sourceIdentity, options.transport)),
			source: "update-server",
		};
	}
	return {
		...result,
		sourceIdentity,
		...(result.releaseInfo ? { releaseInfo: { ...result.releaseInfo, sourceIdentity } } : {}),
	};
}

/** Notes are optional, but must never cross a configuration or artifact identity boundary. */
export async function getUpdateNotes(request: UpdateNotesRequest, signal?: AbortSignal) {
	const captured = getCurrentUpdateSourceIdentity();
	if (!captured || !sameUpdateSourceIdentity(request.sourceIdentity, captured))
		throw new GithubUpdateError("UPDATE_SOURCE_CHANGED", "Update source changed; check again");
	const result =
		captured.source === "github"
			? await githubReleaseUpdater.getNotes({ ...request, sourceIdentity: captured }, signal)
			: await getMirrorNotes(
					captured,
					request.version,
					request.sha512,
					createUpdateFetchContext(),
					signal,
				);
	if (!sameUpdateSourceIdentity(captured, getCurrentUpdateSourceIdentity()))
		throw new GithubUpdateError(
			"UPDATE_SOURCE_CHANGED",
			"Update source changed while loading notes",
		);
	signal?.throwIfAborted();
	return result;
}

export function getCurrentUpdateSourceIdentity(): UpdateSourceIdentity | null {
	const common = { channel: settings.update?.channel ?? "stable", platform: getPlatform() };
	return parseUpdateSourceIdentity(
		(settings.update?.source ?? "github") === "github"
			? {
					...common,
					source: "github",
					repository: settings.update?.githubRepository ?? DEFAULT_GITHUB_REPOSITORY,
				}
			: {
					...common,
					source: "update-server",
					repository: settings.update?.githubRepository ?? DEFAULT_GITHUB_REPOSITORY,
					serverUrl: getServerBaseUrl(),
					product: settings.update?.product ?? "narrafork",
				},
	);
}

export function isUpdateSourceCurrent(releaseInfo: ReleaseInfo): boolean {
	const captured = parseUpdateSourceIdentity(releaseInfo.sourceIdentity);
	if (!captured || !sameUpdateSourceIdentity(captured, getCurrentUpdateSourceIdentity()))
		return false;
	if (captured.source !== (releaseInfo.source ?? "update-server")) return false;
	if (releaseInfo.repository?.trim().toLowerCase() !== captured.repository) return false;
	if (captured.source === "github") return true;
	if (releaseInfo._mirror?.serverUrl !== captured.serverUrl) return false;
	return (
		!releaseInfo._v2?.serverUrl ||
		sameUpdateSourceIdentity(captured, {
			...captured,
			serverUrl: releaseInfo._v2.serverUrl,
		})
	);
}

async function checkForServerUpdate(
	sourceIdentity: Extract<UpdateSourceIdentity, { source: "update-server" }>,
	transport?: UpdateFetchContext,
): Promise<UpdateCheckResult> {
	const { serverUrl } = sourceIdentity;
	if (!serverUrl) {
		return {
			updateAvailable: false,
			currentVersion: APP_VERSION,
			errorCode: "INVALID_CONFIGURATION",
			error: "Update server not configured or trusted",
		};
	}

	try {
		return await checkMirrorUpdate(
			sourceIdentity,
			APP_VERSION,
			transport ?? createUpdateFetchContext(),
		);
	} catch (err) {
		logger.error("Update check error", { error: String(err) });
		return {
			updateAvailable: false,
			currentVersion: APP_VERSION,
			repository: sourceIdentity.repository,
			errorCode: err instanceof GithubUpdateError ? err.code : "NETWORK_ERROR",
			error:
				err instanceof GithubUpdateError ? err.message : "Independent update server check failed",
		};
	}
}

function assertPreparedUpdateCanBeReplaced(releaseInfo: ReleaseInfo): void {
	if (!isUpdateSourceCurrent(releaseInfo))
		throw new Error("Update source changed during download; check for updates again");
	if (getUpdateCoordinationStatus().scheduled)
		throw new Error(
			"A restart is already scheduled; keep its prepared update until it finishes or is cancelled",
		);
}

/**
 * Download and apply an update using zstd patches.
 *
 * The whole pipeline is asynchronous and bounded: fetches carry timeouts, payloads stream to
 * disk under a byte ceiling, and patch reconstruction runs as a child process (or through the
 * async zlib binding for legacy dictionary patches). Nothing here holds a ~100MB binary on the
 * heap or blocks the event loop, which matters most during an update.
 */
export async function downloadUpdate(
	releaseInfo: ReleaseInfo,
	onProgress?: (progress: UpdateProgress) => void,
	options: { forceDownload?: boolean; signal?: AbortSignal } = {},
): Promise<{
	success: boolean;
	error?: string;
	version?: string;
	updatePath?: string;
	newBinaryPath?: string;
	placed?: boolean;
	preparedIdentity?: PreparedUpdateIdentity;
}> {
	const forceDownload = options.forceDownload ?? false;
	const sourceIdentity = parseUpdateSourceIdentity(releaseInfo.sourceIdentity);
	let recoveryManifestVersions: number[];
	try {
		recoveryManifestVersions = parseRecoveryManifestVersions(releaseInfo.recoveryManifestVersions);
	} catch {
		return {
			success: false,
			error: "Invalid recovery protocol capabilities; check for updates again",
		};
	}
	releaseInfo = {
		...releaseInfo,
		sourceIdentity: sourceIdentity ?? undefined,
		recoveryManifestVersions,
	};
	const isGithub =
		!!releaseInfo._github && (releaseInfo.source === "github" || !!releaseInfo._mirror);
	if (!sourceIdentity || !isUpdateSourceCurrent(releaseInfo)) {
		return { success: false, error: "Update source changed; check for updates again" };
	}
	if (getUpdateCoordinationStatus().scheduled) {
		return {
			success: false,
			error:
				"A restart is already scheduled; keep its prepared update until it finishes or is cancelled",
		};
	}
	if (!isGithub && !getServerBaseUrl()) {
		return { success: false, error: "Update server not configured" };
	}

	const execPath = getCurrentExecutablePath();

	// Ensure update directory exists
	mkdirSync(UPDATE_DIR, { recursive: true });

	const releaseFileName = sanitizeUpdateFileName(releaseInfo.path, releaseInfo.version);
	const updatePath = join(UPDATE_DIR, releaseFileName);
	const tempPath = `${updatePath}.${process.pid}.${randomUUID()}.tmp`;
	let ownsGithubTemp = false;

	logger.info("Starting update download", {
		version: releaseInfo.version,
		execPath,
		source: releaseInfo.source,
		repository: sourceIdentity.repository,
		hasMirror: !!releaseInfo._mirror,
	});

	const githubDeadline = isGithub ? createGithubUpdateDeadline(options.signal) : undefined;
	const signal = githubDeadline?.signal ?? options.signal;
	let githubStrategy: "full" | "zstd" = releaseInfo._github?.patchChain?.length ? "zstd" : "full";
	let githubFallback = false;
	let githubDownloadedBytes = 0;
	let githubDownloadTotal = releaseInfo.files[0]?.size ?? 0;
	const emitProgress = (progress: UpdateProgress) => {
		if (!isGithub) {
			onProgress?.(progress);
			return;
		}
		githubStrategy = progress.strategy ?? githubStrategy;
		githubFallback = progress.fallback ?? githubFallback;
		onProgress?.({ ...progress, strategy: githubStrategy, fallback: githubFallback });
	};
	try {
		signal?.throwIfAborted();
		const transport = createUpdateFetchContext();
		const helperContext = createDistributionContext(sourceIdentity, undefined, transport);
		emitProgress({
			phase: "downloading",
			bytesDownloaded: 0,
			totalBytes: releaseInfo.files[0]?.size ?? 0,
			percent: 0,
		});

		let applied = false;

		if (isGithub && githubDeadline) {
			const startedAt = Date.now();
			const strategy = await downloadGithubUpdateToFile(
				{
					release: { ...releaseInfo, source: "github" },
					currentVersion: APP_VERSION,
					basePath: execPath,
					outputPath: tempPath,
					signal: githubDeadline.signal,
					onProgress: (progress) => {
						githubDownloadedBytes = progress.bytesDownloaded;
						githubDownloadTotal = progress.totalBytes;
						emitProgress(progress);
					},
				},
				{
					downloadPatch: (step, path, downloadOptions) =>
						releaseInfo._mirror
							? downloadMirrorPatch(releaseInfo, path, downloadOptions, transport)
							: downloadGithubPatchToFile(step, path, {
									...downloadOptions,
									fetcher: transport.fetch,
								}),
					downloadFull: (release, path, downloadOptions) => {
						if (!isUpdateSourceCurrent(releaseInfo))
							throw new Error("Update source changed; check again");
						return downloadGithubBinaryToFile(release, path, {
							...downloadOptions,
							fetcher: transport.fetch,
						});
					},
					resolveZstd: (patchSignal) =>
						getZstdCliPath(forceDownload, true, patchSignal, helperContext),
					onFallback: (error) =>
						logger.warn(
							"Incremental update unavailable; downloading canonical GitHub full binary",
							{
								source: releaseInfo.source,
								error: String(error),
							},
						),
				},
			);
			ownsGithubTemp = true;
			applied = true;
			logger.info("Canonical update downloaded", {
				source: releaseInfo.source,
				strategy,
				version: releaseInfo.version,
				bytes: releaseInfo.files[0]?.size,
				durationMs: Date.now() - startedAt,
			});
		}

		if (!applied) throw new Error("Canonical GitHub descriptor required; check again");

		// Verify SHA512
		emitProgress({
			phase: "applying",
			bytesDownloaded: isGithub ? githubDownloadedBytes : (releaseInfo.files[0]?.size ?? 0),
			totalBytes: isGithub ? githubDownloadTotal : (releaseInfo.files[0]?.size ?? 0),
			percent: 100,
		});

		signal?.throwIfAborted();
		const actualSha512 = await computeFileSha512(tempPath, signal);
		signal?.throwIfAborted();
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
			const destination = await resolvePreparedBinaryDestination(execPath, releaseInfo);
			signal?.throwIfAborted();
			assertPreparedUpdateCanBeReplaced(releaseInfo);
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
			const destination = await resolveUpdateCacheDestination(releaseInfo);
			signal?.throwIfAborted();
			assertPreparedUpdateCanBeReplaced(releaseInfo);
			finalUpdatePath = destination.path;
			finalFileName = destination.fileName;
			if (destination.alreadyPresent) {
				unlinkSync(tempPath);
			} else {
				moveFileNoOverwriteSync(tempPath, finalUpdatePath);
			}
		}

		const finalSize = statSync(finalUpdatePath).size;
		const preparedInfo: PlacedUpdateInfo = {
			sourceIdentity,
			recoveryManifestVersions,
			version: releaseInfo.version,
			fromVersion: APP_VERSION,
			fileName: finalFileName,
			newBinaryPath,
			updatePath: finalUpdatePath,
			placed,
			placedAt: new Date().toISOString(),
			sha512: releaseInfo.sha512,
			sizeBytes: finalSize,
		};
		writePlacedUpdateInfo(preparedInfo);
		const preparedIdentity = preparedUpdateIdentity(preparedInfo);

		emitProgress({
			phase: "complete",
			bytesDownloaded: isGithub ? githubDownloadedBytes : (releaseInfo.files[0]?.size ?? 0),
			totalBytes: isGithub ? githubDownloadTotal : (releaseInfo.files[0]?.size ?? 0),
			percent: 100,
		});

		return {
			success: true,
			version: releaseInfo.version,
			updatePath: finalUpdatePath,
			newBinaryPath,
			placed,
			preparedIdentity,
		};
	} catch (err) {
		// The full-download helper owns cleanup on failure, including exclusive-create conflicts.
		if ((!isGithub || ownsGithubTemp) && existsSync(tempPath)) {
			try {
				unlinkSync(tempPath);
			} catch {}
		}

		const error = String(err);
		emitProgress({
			phase: "error",
			bytesDownloaded: 0,
			totalBytes: 0,
			percent: 0,
			error,
		});

		return { success: false, error };
	} finally {
		githubDeadline?.dispose();
	}
}

/**
 * Compute SHA512 hash of a file.
 */
async function computeFileSha512(filePath: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha512");
		const stream = createReadStream(filePath, { signal });

		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("base64")));
		stream.on("error", reject);
	});
}

interface VerifiedFileFingerprint {
	sizeBytes: number;
	mtimeMs: number;
	sha512: string;
}

/**
 * Remembers which (path, size, mtime) fingerprint already hashed to which digest.
 *
 * `/api/update/status` is polled roughly once a second while an update is draining, and the
 * prepared binary is around 100MB. Hashing it on every poll would be a ~100MB read plus a full
 * SHA-512 on the only JS thread — exactly the wrong thing to do while HTTP, WS and agent traffic
 * must stay responsive. The digest is therefore computed once per distinct fingerprint; any
 * change in size or mtime invalidates it and forces a real re-verification.
 */
const verifiedFileDigests = new Map<string, VerifiedFileFingerprint>();

interface InFlightFileDigest {
	sizeBytes: number;
	mtimeMs: number;
	promise: Promise<string>;
}

/**
 * Verifications currently reading a file, so overlapping callers share one read.
 *
 * The cache above only helps once a digest exists. Hashing a ~100MB binary takes longer than the
 * one-second status poll interval, so the very first verification is still in progress when the
 * next poll (or a second browser tab, or a concurrent `/apply`) asks the same question. Without
 * this every one of them would start its own full read of the same file and multiply the I/O the
 * cache exists to avoid. Sharing is keyed on the fingerprint as well as the path: a different
 * size or mtime means different bytes, which deserve their own read rather than another caller's
 * answer about the previous file.
 */
const inFlightFileDigests = new Map<string, InFlightFileDigest>();

/** Test seam: counts how often a real hash was computed rather than served from the cache. */
let verifiedFileDigestComputations = 0;

/** @internal Exported for the status-hash caching test. */
export function __getVerifiedDigestComputationCount(): number {
	return verifiedFileDigestComputations;
}

/** @internal Exported so tests can start from a known cache state. */
export function __resetVerifiedDigestCacheForTests(): void {
	verifiedFileDigests.clear();
	verifiedFileDigestComputations = 0;
}

async function verifyFileSha512Cached(
	filePath: string,
	stat: { size: number; mtimeMs: number },
	expectedSha512: string,
): Promise<boolean> {
	const cached = verifiedFileDigests.get(filePath);
	if (cached && cached.sizeBytes === stat.size && cached.mtimeMs === stat.mtimeMs) {
		return cached.sha512 === expectedSha512;
	}

	const pending = inFlightFileDigests.get(filePath);
	if (pending && pending.sizeBytes === stat.size && pending.mtimeMs === stat.mtimeMs) {
		return (await pending.promise) === expectedSha512;
	}

	verifiedFileDigestComputations++;
	// Streamed rather than read whole: a failed hash must not leave a stale in-flight entry
	// behind, or every later caller would await a promise that already rejected.
	const promise = computeFileSha512(filePath)
		.then((sha512) => {
			verifiedFileDigests.set(filePath, {
				sizeBytes: stat.size,
				mtimeMs: stat.mtimeMs,
				sha512,
			});
			return sha512;
		})
		.finally(() => {
			if (inFlightFileDigests.get(filePath)?.promise === promise) {
				inFlightFileDigests.delete(filePath);
			}
		});
	inFlightFileDigests.set(filePath, {
		sizeBytes: stat.size,
		mtimeMs: stat.mtimeMs,
		promise,
	});

	return (await promise) === expectedSha512;
}

function preparedUpdateIdentity(info: PlacedUpdateInfo): PreparedUpdateIdentity {
	const sourceIdentity = parseUpdateSourceIdentity(info.sourceIdentity);
	const recoveryManifestVersions = parseRecoveryManifestVersions(info.recoveryManifestVersions);
	const id = createHash("sha256")
		.update(
			JSON.stringify([
				"prepared-update-v1",
				info.version,
				info.fromVersion,
				info.fileName,
				info.newBinaryPath ? resolve(info.newBinaryPath) : null,
				info.updatePath ? resolve(info.updatePath) : null,
				info.placed,
				info.placedAt,
				info.sha512,
				info.sizeBytes,
				sourceIdentity,
				// Keep legacy selectors stable, but bind newly verified capabilities.
				...(info.recoveryManifestVersions === undefined ? [] : [recoveryManifestVersions]),
			]),
		)
		.digest("hex");
	return {
		id,
		version: info.version,
		sha512: info.sha512,
		sizeBytes: info.sizeBytes,
		sourceIdentity,
		recoveryManifestVersions,
	};
}

function readPlacedUpdateRecord(): PlacedUpdateInfo | null {
	try {
		const stat = lstatSync(PLACED_UPDATE_INFO_PATH);
		if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) return null;
		const info = JSON.parse(readFileSync(PLACED_UPDATE_INFO_PATH, "utf8")) as PlacedUpdateInfo;
		if (
			!info ||
			typeof info !== "object" ||
			Array.isArray(info) ||
			typeof info.version !== "string" ||
			!info.version ||
			info.version.length > 128 ||
			typeof info.fileName !== "string" ||
			typeof info.placed !== "boolean" ||
			typeof info.placedAt !== "string" ||
			info.fromVersion !== APP_VERSION ||
			typeof info.sha512 !== "string" ||
			!/^[A-Za-z0-9+/]{86}==$/.test(info.sha512) ||
			!Number.isSafeInteger(info.sizeBytes) ||
			info.sizeBytes <= 0 ||
			info.sizeBytes > MAX_BINARY_BYTES ||
			(info.newBinaryPath !== undefined && typeof info.newBinaryPath !== "string") ||
			(info.updatePath !== undefined && typeof info.updatePath !== "string") ||
			(info.sourceIdentity != null &&
				!parseUpdateSourceIdentity(info.sourceIdentity) &&
				!isLegacyMirrorSourceIdentity(info.sourceIdentity))
		)
			return null;
		if (info.recoveryManifestVersions !== undefined) {
			info.recoveryManifestVersions = parseRecoveryManifestVersions(info.recoveryManifestVersions);
		}
		return info;
	} catch {
		return null;
	}
}

function isPreparedRecordCurrent(info: PlacedUpdateInfo): boolean {
	const current = readPlacedUpdateRecord();
	return current !== null && preparedUpdateIdentity(current).id === preparedUpdateIdentity(info).id;
}

function writePlacedUpdateInfo(info: PlacedUpdateInfo): void {
	mkdirSync(UPDATE_DIR, { recursive: true });
	const temporary = `${PLACED_UPDATE_INFO_PATH}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(info, null, 2), { flag: "wx", mode: 0o600 });
		renameSync(temporary, PLACED_UPDATE_INFO_PATH);
	} finally {
		safeUnlink(temporary);
	}
}

async function readPlacedUpdateInfo(
	options: { targetVersion?: string } = {},
): Promise<PlacedUpdateInfo | null> {
	try {
		const info = readPlacedUpdateRecord();
		if (!info || (options.targetVersion && info.version !== options.targetVersion)) return null;

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
		if (!(await verifyFileSha512Cached(resolvedCandidatePath, stat, info.sha512))) return null;
		if (!isPreparedRecordCurrent(info)) return null;

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
 * Names in the update directory that age-based cleanup must never touch.
 *
 * These are live state, not stale artifacts: the recovery manifest is how a failed or
 * interrupted update finds its narrators again, and deleting the placed-update record would
 * leave a perfectly good verified binary on disk while `ready` flips to false, forcing the
 * user to download it all over again.
 */
const CLEANUP_PROTECTED_FILE_NAMES = new Set([
	RECOVERY_SNAPSHOT_FILE_NAME,
	PLACED_UPDATE_INFO_FILE_NAME,
]);

/**
 * Clean up old update artifacts (stale temp files and superseded binaries).
 */
export function cleanupOldUpdates(): void {
	if (!existsSync(UPDATE_DIR)) return;

	const files = readdirSync(UPDATE_DIR);
	const now = Date.now();
	const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

	for (const file of files) {
		if (CLEANUP_PROTECTED_FILE_NAMES.has(file)) continue;
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
 *
 * `instructions` mirrors what the download stream reports on completion, so a client that
 * reloaded (or opened the dialog in a second tab) can restore the same "run this binary" hint
 * instead of falling back to a locally reconstructed message.
 */
export async function getUpdateStatus(targetVersion?: string): Promise<
	UpdateCoordinationStatus & {
		ready: boolean;
		cleanupRetryPending: boolean;
		updateFile?: string;
		canAutoRestart: boolean;
		newBinaryPath?: string;
		updatePath?: string;
		placed?: boolean;
		version?: string;
		preparedIdentity?: PreparedUpdateIdentity;
		instructions?: ReturnType<typeof getUpdateInstructions>;
	}
> {
	const placedInfo = await readPlacedUpdateInfo({ targetVersion });
	const artifactPath = placedInfo?.updatePath ?? placedInfo?.newBinaryPath;
	return {
		ready: !!placedInfo,
		updateFile: placedInfo?.fileName,
		canAutoRestart: !!getCurrentExecutablePath(),
		newBinaryPath: placedInfo?.newBinaryPath,
		updatePath: placedInfo?.updatePath,
		placed: placedInfo?.placed,
		version: placedInfo?.version,
		...(placedInfo ? { preparedIdentity: preparedUpdateIdentity(placedInfo) } : {}),
		...(artifactPath
			? { instructions: getUpdateInstructions(artifactPath, placedInfo?.newBinaryPath) }
			: {}),
		...getUpdateCoordinationWithCleanup(),
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
export async function applyUpdate(
	options: { targetVersion?: string; preparedId?: string } = {},
): Promise<{
	success: boolean;
	error?: string;
	/** Stable code for the fixed pre-flight failures so clients can localize them. */
	code?:
		| "NOT_COMPILED_BINARY"
		| "NO_PREPARED_UPDATE"
		| "PREPARED_UPDATE_NOT_PLACED"
		| "PREPARED_UPDATE_IDENTITY_REQUIRED"
		| "PREPARED_UPDATE_CHANGED";
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
}> {
	if (!options.preparedId || !/^[a-f0-9]{64}$/.test(options.preparedId)) {
		return {
			success: false,
			error: "Read the prepared update identity before applying",
			code: "PREPARED_UPDATE_IDENTITY_REQUIRED",
		};
	}
	const changed = () => ({
		success: false as const,
		error: "Prepared update changed; inspect it again before applying",
		code: "PREPARED_UPDATE_CHANGED" as const,
	});
	const beforeVerification = readPlacedUpdateRecord();
	if (beforeVerification && preparedUpdateIdentity(beforeVerification).id !== options.preparedId)
		return changed();
	const placedInfo = await readPlacedUpdateInfo({ targetVersion: options.targetVersion });
	const newExecPath = placedInfo?.newBinaryPath ?? placedInfo?.updatePath;
	if (!placedInfo || !newExecPath) {
		if (
			beforeVerification &&
			(!isPreparedRecordCurrent(beforeVerification) ||
				(options.targetVersion && options.targetVersion !== beforeVerification.version))
		)
			return changed();
		return {
			success: false,
			error: "No verified prepared update file found",
			code: "NO_PREPARED_UPDATE",
		};
	}
	// The hash check awaited I/O. Recheck the record in this turn before admitting
	// a schedule; another download must not retarget this request to the same version.
	if (
		!isPreparedRecordCurrent(placedInfo) ||
		preparedUpdateIdentity(placedInfo).id !== options.preparedId
	)
		return changed();
	const execPath = getCurrentExecutablePath();
	if (!execPath) {
		return { success: false, error: "Not running as compiled binary", code: "NOT_COMPILED_BINARY" };
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
	if (existing.scheduled && existing.operation === "system_shutdown") {
		return { success: false, error: "System shutdown preparation is already scheduled" };
	}
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

	let scheduled: UpdateCoordinationStatus;
	try {
		scheduled = scheduleUpdate(placedInfo.version, "update", {
			supportedRecoveryManifestVersions: parseRecoveryManifestVersions(
				placedInfo.recoveryManifestVersions,
			),
		});
	} catch (reason) {
		return { success: false, error: reason instanceof Error ? reason.message : String(reason) };
	}
	// scheduleUpdate always assigns an epoch when it transitions an idle coordinator.
	const updateEpoch = scheduled.updateEpoch as string;
	const drainStartedAt = new Date().toISOString();
	void drainAndSpawnPreparedUpdate({
		execPath,
		newExecPath,
		targetVersion: placedInfo.version,
		updateEpoch,
	}).catch((error) => {
		const cancelled = error instanceof UpdateCancelledError;
		runFailedUpdateCleanup({
			updateEpoch,
			targetVersion: placedInfo.version,
			error: error instanceof Error ? error.message : String(error),
			cancelled,
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
	try {
		const existing = consumePlannedUpdateRecoverySnapshot();
		if (existing?.updateEpoch === options.updateEpoch) {
			// A failed automatic or manual handoff must not retain authorization.
			// Automatic snapshots normally have a nonce, not resumeOnNextStartup.
			if (!existing.evidenceOnly || existing.resumeOnNextStartup) {
				writePlannedUpdateRecoverySnapshot(
					{ ...existing, resumeOnNextStartup: false, evidenceOnly: true },
					{ expectedEpoch: options.updateEpoch },
				);
			}
			return;
		}

		const captured = capturePlannedUpdateRecoverySnapshot();
		writePlannedUpdateRecoverySnapshot(
			{
				...captured,
				version: 2,
				updateEpoch: options.updateEpoch,
				targetVersion: options.targetVersion,
				capturedAt: new Date().toISOString(),
				// This attempt failed, so no replacement process exists to claim this manifest.
				// Marking it evidence-only keeps it readable for diagnosis while ensuring no later
				// startup treats it as an instruction to resume these narrators.
				evidenceOnly: true,
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
export async function failPreparedUpdateAttempt(options: FailedUpdateCleanup): Promise<void> {
	try {
		await cleanupPreparedUpdateAttempt(options);
		if (
			!getUpdateCoordinationStatus().scheduled &&
			failedUpdateCleanup.pending?.options.updateEpoch === options.updateEpoch
		) {
			failedUpdateCleanup.pending = null;
		}
	} catch (error) {
		const current = getUpdateCoordinationStatus();
		if (
			current.scheduled &&
			current.updateEpoch === options.updateEpoch &&
			current.operation !== "system_shutdown"
		) {
			failedUpdateCleanup.pending = {
				options: { ...options },
				retrying: false,
				error: `${options.error}; cleanup failed: ${String(error)}`,
			};
		}
		throw error;
	}
}

async function cleanupPreparedUpdateAttempt(options: FailedUpdateCleanup): Promise<void> {
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
	// Inspect the immutable reservation, not source validators: a failed source
	// identity check is itself a rollback failure that must remain retryable.
	if (getReservedRecoverySourceEpochs(options.updateEpoch).length > 0) {
		// A new root may include waits owned by earlier recovery passes. Revoke
		// only our publication, then cancel only rows created by this attempt.
		// Any failure here deliberately keeps the ticket/gate for a retry.
		try {
			rollbackPreparedUpdateRecoverySnapshot(options.updateEpoch);
			const cancelledCount = await toolContinuationService.cancelEpoch(
				options.updateEpoch,
				options.error,
			);
			if (getUpdateCoordinationStatus().updateEpoch !== options.updateEpoch) return;
			releasePreparedUpdateRecoveryHandoff(options.updateEpoch);
			if (failedUpdateCleanup.pending?.options.updateEpoch === options.updateEpoch) {
				failedUpdateCleanup.pending = null;
			}
			failScheduledUpdate(options.error, { cancelled: options.cancelled });
			logger.info("Recovery handoff rolled back without cancelling inherited sources", {
				updateEpoch: options.updateEpoch,
				cancelledCount,
			});
		} catch (error) {
			logger.error("Recovery handoff rollback incomplete; retaining checkpoint gate", {
				updateEpoch: options.updateEpoch,
				error: String(error),
			});
			throw error;
		}
		return;
	}
	try {
		const manifest = consumePlannedUpdateRecoverySnapshot();
		if (manifest?.updateEpoch === options.updateEpoch && manifest.resumeOnNextStartup) {
			// Revoke before async cleanup and before best-effort unlink. A failed unlink must
			// never leave cancelled work authorized to resume on the next manual startup.
			writePlannedUpdateRecoverySnapshot(
				{ ...manifest, resumeOnNextStartup: false, evidenceOnly: true },
				{ expectedEpoch: options.updateEpoch },
			);
		}
		const cancelledCount = await toolContinuationService.cancelEpoch(
			options.updateEpoch,
			options.error,
		);
		logger.info("Cancelled planned-update continuations after update failure", {
			updateEpoch: options.updateEpoch,
			cancelledCount,
		});
	} catch (error) {
		const cancelError = error instanceof Error ? error.message : String(error);
		logger.error("Failed to cancel planned-update continuations; preserving recovery evidence", {
			updateEpoch: options.updateEpoch,
			updateError: options.error,
			cancelError,
		});
		// Keep the manifest: it is what a later recovery pass (or the next startup) needs to find
		// the affected narrators again. But do not also freeze the coordinator. Leaving the phase
		// at quiescing_tools/restarting means openUpdateGate() never runs, so every subsequent tool
		// call blocks forever in waitUntilUpdateGateOpens with no escape hatch left — cancel only
		// sets a flag, and the orchestration promise has already settled. Recovery evidence lives in
		// the manifest, not in a stuck phase.
		preserveFailedUpdateRecoveryEvidence(options);
		const stillOurs = getUpdateCoordinationStatus();
		if (stillOurs.updateEpoch === options.updateEpoch) {
			failScheduledUpdate(`${options.error} (continuation cleanup failed: ${cancelError})`, {
				cancelled: options.cancelled,
			});
		}
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
	failScheduledUpdate(options.error, { cancelled: options.cancelled });
}

function runFailedUpdateCleanup(options: {
	updateEpoch: string;
	targetVersion: string;
	error: string;
	cancelled?: boolean;
}): void {
	void failPreparedUpdateAttempt(options).catch((error) => {
		logger.error("Unexpected prepared-update failure cleanup error", {
			updateEpoch: options.updateEpoch,
			error: error instanceof Error ? error.message : String(error),
		});
	});
}

/**
 * Abandon the scheduled update on operator request.
 *
 * The coordination waits are unbounded, so this is the only way to get out of a restart that
 * is blocked behind long-running narrator work. Cleanup reuses the ordinary failure path:
 * continuations for this epoch are cancelled, the recovery manifest is removed, and the tool
 * gate reopens so paused work resumes. The prepared binary stays in place, so the update can
 * be scheduled again later.
 */
export function cancelPreparedUpdate(reason?: string): {
	cancelled: boolean;
	status: UpdateCoordinationStatus;
} {
	const before = getUpdateCoordinationWithCleanup();
	if (!before.scheduled || !before.updateEpoch || before.operation === "system_shutdown") {
		return { cancelled: false, status: before };
	}
	const pendingCleanup = failedUpdateCleanup.pending;
	if (pendingCleanup?.options.updateEpoch === before.updateEpoch) {
		// This epoch's handoff session has already been revoked by the failed
		// cleanup. Unlike a live replacement handshake, retrying is now safe.
		if (!pendingCleanup.retrying) {
			pendingCleanup.retrying = true;
			runFailedUpdateCleanup({
				...pendingCleanup.options,
				error: reason ?? pendingCleanup.options.error,
				cancelled: true,
			});
		}
		return { cancelled: true, status: getUpdateCoordinationWithCleanup() };
	}
	// Cancelling during `restarting` would leave the already-spawned replacement racing this
	// process for the same port and handoff; let the handoff watchdog resolve that instead.
	if (before.phase === "restarting") {
		return { cancelled: false, status: before };
	}
	cancelScheduledUpdate(reason);
	return { cancelled: true, status: getUpdateCoordinationWithCleanup() };
}

/**
 * Stop this server so an administrator can start the prepared binary themselves.
 *
 * This is the manual counterpart to `applyUpdate`. That path waits for narrator work to reach a
 * safe point and then spawns the replacement itself; here the user has decided not to wait and
 * will launch the new version by hand. Nothing is spawned, so no restart handoff session and no
 * recovery manifest are created — a manifest with no successor to claim it is exactly the stale
 * "resume these narrators" instruction that `classifyRecoveryManifestOwnership` exists to reject.
 *
 * A scheduled update is cancelled first, for two reasons. It reopens the tool gate so paused work
 * is not frozen mid-teardown, and it clears the coordinator's epoch, so the drain orchestration
 * cannot reach `markUpdateRestarting()` and write a manifest while the process is already going
 * away. Cancellation is skipped once the phase is `restarting`: a replacement has been spawned
 * already, so this process is being replaced rather than merely stopped.
 */
export function shutdownForManualUpdate(options: { reason: string }): {
	success: boolean;
	error?: string;
	code?: "SHUTDOWN_UNAVAILABLE" | "REPLACEMENT_ALREADY_STARTING";
	cancelledSchedule: boolean;
	newBinaryPath?: string;
} {
	const before = getUpdateCoordinationStatus();
	if (before.operation === "system_shutdown" || before.phase === "restarting") {
		return {
			success: false,
			error: "A replacement server is already starting; wait for it to finish",
			code: "REPLACEMENT_ALREADY_STARTING",
			cancelledSchedule: false,
		};
	}

	if (!canOperatorShutdown()) {
		return {
			success: false,
			error: "This server cannot shut itself down in the current runtime",
			code: "SHUTDOWN_UNAVAILABLE",
			cancelledSchedule: false,
		};
	}

	const cancelledSchedule = before.scheduled
		? cancelPreparedUpdate(`${options.reason} (superseded by manual shutdown)`).cancelled
		: false;

	// Reported so the UI can repeat the path the user is about to run. Absent in dev mode, where
	// no binary was placed next to the executable.
	const preparedInfo = readPlacedUpdateInfoPath();

	const scheduled = scheduleOperatorShutdown({ reason: options.reason });
	if (!scheduled) {
		return {
			success: false,
			error: "This server cannot shut itself down in the current runtime",
			code: "SHUTDOWN_UNAVAILABLE",
			cancelledSchedule,
		};
	}

	logger.warn("Shutting down for a manual update start", {
		reason: options.reason,
		cancelledSchedule,
		newBinaryPath: preparedInfo,
	});

	return {
		success: true,
		cancelledSchedule,
		...(preparedInfo ? { newBinaryPath: preparedInfo } : {}),
	};
}

/**
 * Best-effort read of the prepared binary path for the shutdown response.
 *
 * Deliberately skips the SHA-512 verification `readPlacedUpdateInfo` performs: this value is
 * only echoed back so the user can copy the command, and hashing a ~100MB binary on the request
 * path is exactly the kind of synchronous main-thread work the shutdown must not wait on. The
 * download and apply paths remain the ones that verify before treating a binary as usable.
 */
function readPlacedUpdateInfoPath(): string | undefined {
	if (!existsSync(PLACED_UPDATE_INFO_PATH)) return undefined;
	try {
		const info = JSON.parse(readFileSync(PLACED_UPDATE_INFO_PATH, "utf8")) as PlacedUpdateInfo;
		if (info.fromVersion !== APP_VERSION) return undefined;
		const candidate = info.newBinaryPath ?? info.updatePath;
		return candidate ? resolve(candidate) : undefined;
	} catch {
		return undefined;
	}
}

export interface PlannedUpdateCheckpointHooks {
	waitForFence?: () => Promise<void>;
	checkpoint?: () => Promise<PlannedUpdateRecoverySnapshot>;
	listActiveToolCallIds?: (
		snapshot: Pick<PlannedUpdateRecoverySnapshot, "narrators">,
	) => Promise<string[]>;
	listCoveredToolCallIds?: (updateEpoch: string) => Promise<string[]>;
}

/**
 * Non-terminal tool rows the fence requires a continuation for.
 *
 * Scoped to live narrators by the same predicate the checkpoint uses. The two MUST agree: the
 * fence demands a continuation for every row it reports, so counting a row the checkpoint
 * deliberately skips leaves it permanently uncovered and the update fails after
 * CHECKPOINT_MAX_ROUNDS instead of restarting. Abandoned rows accumulate from ordinary
 * provider errors, so that would make updates fail on exactly the installations that have
 * hit an error before.
 */
async function listActiveToolCallIds(
	snapshot: Pick<PlannedUpdateRecoverySnapshot, "narrators">,
): Promise<string[]> {
	const rows = await db
		.select({ id: narratorToolCalls.id, narratorId: narratorToolCalls.narratorId })
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.status, ["initializing", "pending", "running"]))
		.limit(CHECKPOINT_ACTIVE_TOOL_LIMIT);
	if (rows.length >= CHECKPOINT_ACTIVE_TOOL_LIMIT) {
		throw new Error(
			`Planned-update checkpoint exceeds the ${CHECKPOINT_ACTIVE_TOOL_LIMIT - 1}-row safety limit`,
		);
	}
	return rows
		.filter((row) => isLiveNarratorForCheckpoint(snapshot, row.narratorId))
		.map((row) => row.id);
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
	await waitForScheduledRecoveryHandoff();
	assertUpdateNotCancelled();
	const recoveryEpochs = () => {
		const epochs = getScheduledRecoveryEpochs();
		return epochs.length ? epochs : [updateEpoch];
	};
	const waitForFence = hooks.waitForFence ?? waitForUpdateCheckpointFence;
	const checkpoint = hooks.checkpoint ?? checkpointPlannedUpdateContinuations;
	const loadActiveToolCallIds = hooks.listActiveToolCallIds ?? listActiveToolCallIds;
	const loadCoveredToolCallIds =
		hooks.listCoveredToolCallIds ??
		(async () =>
			(await toolContinuationService.listByEpoch(recoveryEpochs())).map((row) => row.toolCallId));

	let stablePasses = 0;
	let snapshot: PlannedUpdateRecoverySnapshot | null = null;
	for (let round = 1; round <= CHECKPOINT_MAX_ROUNDS; round++) {
		await waitForFence();
		// Persisting continuations is observable work; do not start another round once the
		// operator asked to abandon this update.
		assertUpdateNotCancelled();
		snapshot = await checkpoint();
		if (snapshot.updateEpoch !== updateEpoch) {
			throw new Error("Planned-update recovery snapshot epoch changed during checkpoint");
		}
		await waitForFence();

		const [activeToolCallIds, coveredToolCallIds] = await Promise.all([
			loadActiveToolCallIds(snapshot),
			loadCoveredToolCallIds(updateEpoch),
		]);
		const covered = new Set(coveredToolCallIds);
		const uncovered = activeToolCallIds.filter((toolCallId) => !covered.has(toolCallId));
		if (uncovered.length === 0) {
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
	await waitForScheduledRecoveryHandoff();
	assertUpdateNotCancelled();
	await waitForBackgroundBashDrain();
	assertUpdateNotCancelled();
	beginQuiescingTools();
	await waitForOrdinaryToolDrain();
	const recoverySnapshot = await checkpointPreparedUpdateFence(options.updateEpoch);
	// Last cancellation checkpoint before the two irreversible steps: writing the recovery
	// manifest and spawning the replacement process.
	assertUpdateNotCancelled();
	writePreparedUpdateRecoverySnapshot(recoverySnapshot);
	markUpdateRestarting();

	let session: ReturnType<typeof beginGracefulRestartSession>;
	try {
		session = beginGracefulRestartSession();
	} catch (error) {
		throw new Error(`Failed to prepare graceful restart handoff: ${error}`);
	}

	// Bind the manifest to the process about to be spawned. The manifest had to exist before the
	// handoff session (so a crash between the two still leaves recovery evidence), so the nonce is
	// stamped in now that it is known. Only the replacement receiving this same nonce may act on
	// the manifest; any other startup discards it instead of resuming its narrators.
	writePreparedUpdateRecoverySnapshot(recoverySnapshot, {
		expectedEpoch: options.updateEpoch,
		handoffMarkerNonce: session.markerNonce,
	});

	try {
		// The ambient proxy variables are blanked in THIS process (see
		// lib/net/proxy-env.ts). Handing the blanked values to the replacement
		// would make it snapshot "no ambient proxy", so a user on "system" proxy
		// mode would silently fall back to direct connections after every update.
		const env = {
			...envWithAmbientProxy(),
			// 启动时已从 process.env 清掉。替换进程仍要能接受面板的关闭和更新。
			...managerChildTokenEnv(),
			NARRAFORK_GRACEFUL_RESTART_URL: session.url,
			NARRAFORK_GRACEFUL_RESTART_TOKEN: session.token,
			NARRAFORK_GRACEFUL_RESTART_MARKER_PATH: session.markerPath,
			NARRAFORK_GRACEFUL_RESTART_MARKER_NONCE: session.markerNonce,
		};
		const isWindows = process.platform === "win32";
		const launchArgs = replacementLaunchArgs(process.argv.slice(2), {
			platform: process.platform,
			managerManaged: process.env.NARRAFORK_MANAGER_MANAGED === "1",
		});
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
						windowsHide: true,
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
