/**
 * Helper binary download/cache utilities.
 *
 * Small command-line helpers such as zstd and ripgrep can be served by the
 * update server and cached under ~/.narrafork/bin when they are not available
 * on the user's PATH.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";
import { narraforkDir, settings } from "./settings";

const DEFAULT_UPDATE_SERVER_URL = "https://narrafork-update.b.domexie.cn";
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BINARY_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_FAILURE_CACHE_MS = 60_000;

export const HELPER_BIN_DIR = join(narraforkDir, "bin");

const downloadFailureCache = new Map<string, number>();

export interface HelperBinarySpec {
	/** Filename exposed by the update server under /api/v2/tools/:filename. */
	toolName: string;
	/** Local cached filename under ~/.narrafork/bin. */
	cachedName: string;
	/** Human-readable tool name for logs. */
	displayName: string;
	/** Optional trusted SHA-256 digest for integrity verification. */
	expectedSha256?: string;
}

/** Build the base URL for the update server (strips trailing slash). */
export function getHelperBinaryServerBaseUrl(): string {
	const url = settings.update?.serverUrl || DEFAULT_UPDATE_SERVER_URL;
	return url.replace(/\/+$/, "");
}

/** Return a cached helper binary path if it exists, ensuring it is executable. */
export function getCachedHelperBinaryPath(cachedName: string): string | null {
	const cached = join(HELPER_BIN_DIR, cachedName);
	if (!existsSync(cached)) return null;
	try {
		chmodSync(cached, 0o755);
	} catch {
		// Best effort; Windows may not support POSIX modes.
	}
	return cached;
}

export interface DownloadHelperBinaryOptions {
	/** Reuse an existing cached helper binary when present. Defaults to true. */
	useCache?: boolean;
	/** Abort the network fetch after this many milliseconds. */
	timeoutMs?: number;
	/** Reject unexpectedly large downloads. */
	maxBytes?: number;
	/** Allow downloads without an expectedSha256 value. Defaults to true for legacy update flow. */
	allowUnsignedDownload?: boolean;
	/**
	 * Ignore (and clear) the recent-failure cache for this download. Used by
	 * explicit user retries so a previous timeout does not short-circuit the
	 * next attempt. Defaults to false.
	 */
	bypassFailureCache?: boolean;
}

function rememberDownloadFailure(cacheKey: string): void {
	downloadFailureCache.set(cacheKey, Date.now() + DOWNLOAD_FAILURE_CACHE_MS);
}

function isDownloadFailureCached(cacheKey: string): boolean {
	const until = downloadFailureCache.get(cacheKey);
	if (!until) return false;
	if (until <= Date.now()) {
		downloadFailureCache.delete(cacheKey);
		return false;
	}
	return true;
}

function verifySha256(buf: Buffer, expectedSha256: string): boolean {
	const actual = createHash("sha256").update(buf).digest("hex");
	return actual.toLowerCase() === expectedSha256.toLowerCase();
}

/** Download a helper binary from the update server into ~/.narrafork/bin. */
export async function downloadHelperBinary(
	spec: HelperBinarySpec,
	options: DownloadHelperBinaryOptions = {},
): Promise<string | null> {
	if (options.useCache !== false) {
		const cached = getCachedHelperBinaryPath(spec.cachedName);
		if (cached) return cached;
	}

	const serverUrl = getHelperBinaryServerBaseUrl();
	if (!serverUrl) return null;
	const cacheKey = `${serverUrl}\u0000${spec.toolName}`;
	if (options.bypassFailureCache) {
		downloadFailureCache.delete(cacheKey);
	} else if (isDownloadFailureCached(cacheKey)) {
		return null;
	}

	const allowUnsignedDownload = options.allowUnsignedDownload ?? true;
	if (!spec.expectedSha256 && !allowUnsignedDownload) {
		logger.warn("Refusing unsigned helper binary download", {
			displayName: spec.displayName,
			toolName: spec.toolName,
		});
		rememberDownloadFailure(cacheKey);
		return null;
	}

	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BINARY_BYTES);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let tempPath: string | null = null;

	try {
		const resp = await fetch(`${serverUrl}/api/v2/tools/${spec.toolName}`, {
			signal: controller.signal,
		});
		if (!resp.ok) {
			logger.debug("Helper binary not available from update server", {
				displayName: spec.displayName,
				toolName: spec.toolName,
				status: resp.status,
			});
			rememberDownloadFailure(cacheKey);
			return null;
		}

		const contentLength = Number(resp.headers.get("content-length") ?? 0);
		if (contentLength > maxBytes) {
			logger.warn("Helper binary download exceeds size limit", {
				displayName: spec.displayName,
				toolName: spec.toolName,
				contentLength,
				maxBytes,
			});
			rememberDownloadFailure(cacheKey);
			return null;
		}

		const buf = Buffer.from(await resp.arrayBuffer());
		if (buf.length > maxBytes) {
			logger.warn("Helper binary download exceeded size limit", {
				displayName: spec.displayName,
				toolName: spec.toolName,
				size: buf.length,
				maxBytes,
			});
			rememberDownloadFailure(cacheKey);
			return null;
		}
		if (spec.expectedSha256 && !verifySha256(buf, spec.expectedSha256)) {
			logger.warn("Helper binary SHA-256 verification failed", {
				displayName: spec.displayName,
				toolName: spec.toolName,
			});
			rememberDownloadFailure(cacheKey);
			return null;
		}

		mkdirSync(HELPER_BIN_DIR, { recursive: true });
		const path = join(HELPER_BIN_DIR, spec.cachedName);
		tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tempPath, buf);
		try {
			chmodSync(tempPath, 0o755);
		} catch {
			// Best effort; Windows may not support POSIX modes.
		}
		renameSync(tempPath, path);
		tempPath = null;
		logger.info("Downloaded helper binary", {
			displayName: spec.displayName,
			path,
			size: buf.length,
			verified: Boolean(spec.expectedSha256),
		});
		return path;
	} catch (err) {
		logger.debug("Failed to download helper binary", {
			displayName: spec.displayName,
			toolName: spec.toolName,
			error: String(err),
		});
		rememberDownloadFailure(cacheKey);
		return null;
	} finally {
		clearTimeout(timeout);
		if (tempPath) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Best effort cleanup for failed atomic writes.
			}
		}
	}
}
