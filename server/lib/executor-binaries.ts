/**
 * Remote executor distribution on the NarraFork side.
 *
 * The update server publishes executor binaries plus a manifest to its public
 * `tools/` channel. A NarraFork instance mirrors them into ~/.narrafork/bin and
 * re-serves them to the machines being enrolled, so a target host only needs to
 * reach NarraFork itself — the common case for an internal network box that can
 * dial the server but has no route to the public update server.
 *
 * Integrity is anchored on the manifest's SHA-256 digests: a binary is never
 * cached or served without matching one.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	EXECUTOR_MANIFEST_FILENAME,
	type ExecutorManifest,
	type ExecutorPlatform,
	executorCachedFilename,
} from "@shared/remote-executor";
import { parseExecutorManifest } from "@shared/remote-executor-manifest";
import {
	downloadHelperBinary,
	getCachedHelperBinaryPath,
	getHelperBinaryServerBaseUrl,
	HELPER_BIN_DIR,
} from "./helper-binaries";
import { logger } from "./logger";

/** In-memory manifest freshness. Short enough to pick up a new release promptly. */
const MANIFEST_CACHE_MS = 10 * 60 * 1000;
const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
/** The manifest is a small JSON document; anything larger is not one. */
const MANIFEST_MAX_BYTES = 64 * 1024;
/** Executor binaries are ~8 MB; the ceiling leaves headroom without being unbounded. */
const BINARY_MAX_BYTES = 32 * 1024 * 1024;
const BINARY_DOWNLOAD_TIMEOUT_MS = 120_000;

const LOCAL_MANIFEST_PATH = join(HELPER_BIN_DIR, EXECUTOR_MANIFEST_FILENAME);

interface ManifestCacheEntry {
	manifest: ExecutorManifest;
	fetchedAt: number;
}

let manifestCache: ManifestCacheEntry | null = null;
/** Coalesce concurrent fetches so a burst of UI requests makes one network call. */
let inflightManifestFetch: Promise<ExecutorManifest | null> | null = null;

export class ExecutorDistributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutorDistributionError";
	}
}

/** Reset cached state. Test-only seam. */
export function resetExecutorManifestCache(): void {
	manifestCache = null;
	inflightManifestFetch = null;
}

function readLocalManifest(): ExecutorManifest | null {
	if (!existsSync(LOCAL_MANIFEST_PATH)) return null;
	try {
		return parseExecutorManifest(JSON.parse(readFileSync(LOCAL_MANIFEST_PATH, "utf-8")));
	} catch (error) {
		logger.debug("Ignoring unusable cached executor manifest", { error: String(error) });
		return null;
	}
}

function writeLocalManifest(manifest: ExecutorManifest): void {
	try {
		mkdirSync(HELPER_BIN_DIR, { recursive: true });
		const temp = `${LOCAL_MANIFEST_PATH}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
		renameSync(temp, LOCAL_MANIFEST_PATH);
	} catch (error) {
		// A missing offline copy only costs us the fallback, never correctness.
		logger.debug("Failed to persist executor manifest", { error: String(error) });
	}
}

async function fetchManifest(): Promise<ExecutorManifest | null> {
	const serverUrl = getHelperBinaryServerBaseUrl();
	if (!serverUrl) return null;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(`${serverUrl}/api/v2/tools/${EXECUTOR_MANIFEST_FILENAME}`, {
			signal: controller.signal,
		});
		if (!response.ok) {
			logger.debug("Executor manifest not available", { status: response.status });
			return null;
		}
		const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(declaredLength) && declaredLength > MANIFEST_MAX_BYTES) {
			logger.warn("Executor manifest exceeds size limit", { declaredLength });
			return null;
		}
		const text = await response.text();
		if (text.length > MANIFEST_MAX_BYTES) {
			logger.warn("Executor manifest exceeds size limit", { size: text.length });
			return null;
		}
		const manifest = parseExecutorManifest(JSON.parse(text));
		writeLocalManifest(manifest);
		return manifest;
	} catch (error) {
		logger.debug("Failed to fetch executor manifest", { error: String(error) });
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Resolve the published executor manifest.
 *
 * Falls back to the last persisted copy when the update server is unreachable so
 * an air-gapped instance can keep enrolling devices for binaries it already
 * mirrored.
 */
export async function getExecutorManifest(
	options: { forceRefresh?: boolean } = {},
): Promise<ExecutorManifest | null> {
	if (!options.forceRefresh && manifestCache) {
		if (Date.now() - manifestCache.fetchedAt < MANIFEST_CACHE_MS) return manifestCache.manifest;
	}
	if (!options.forceRefresh && inflightManifestFetch) return inflightManifestFetch;

	const pending = (async () => {
		const fetched = await fetchManifest();
		if (fetched) {
			manifestCache = { manifest: fetched, fetchedAt: Date.now() };
			return fetched;
		}
		const local = readLocalManifest();
		if (local) {
			// Cache the offline copy too, otherwise every request retries the network.
			manifestCache = { manifest: local, fetchedAt: Date.now() };
			logger.debug("Using cached executor manifest", { version: local.version });
			return local;
		}
		return null;
	})();
	inflightManifestFetch = pending;
	try {
		return await pending;
	} finally {
		if (inflightManifestFetch === pending) inflightManifestFetch = null;
	}
}

export interface ExecutorArtifactLocation {
	path: string;
	filename: string;
	version: string;
	size: number;
	sha256: string;
}

/**
 * Verify a cached binary's SHA-256 digest using async streaming.
 *
 * Changed from sync `readFileSync` + in-memory hash to streaming to avoid blocking
 * the main thread with up to 32 MB of synchronous file IO + crypto. Uses
 * `Bun.file().stream()` with `Bun.CryptoHasher` for chunk-wise processing, keeping
 * memory usage bounded regardless of file size.
 */
async function verifyCachedDigest(path: string, expectedSha256: string): Promise<boolean> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return false;
		const hasher = new Bun.CryptoHasher("sha256");
		const stream = file.stream();
		for await (const chunk of stream) {
			hasher.update(chunk);
		}
		return hasher.digest("hex").toLowerCase() === expectedSha256.toLowerCase();
	} catch {
		return false;
	}
}

/**
 * Ensure the executor binary for a platform is present in ~/.narrafork/bin,
 * downloading and verifying it against the manifest digest when needed.
 */
export async function ensureExecutorBinary(
	platform: ExecutorPlatform,
	options: { manifest?: ExecutorManifest } = {},
): Promise<ExecutorArtifactLocation> {
	const manifest = options.manifest ?? (await getExecutorManifest());
	if (!manifest) {
		throw new ExecutorDistributionError(
			"Executor manifest is unavailable; check the update server URL in settings",
		);
	}
	const entry = manifest.platforms[platform];
	if (!entry) {
		throw new ExecutorDistributionError(
			`Executor version ${manifest.version} does not publish a build for ${platform}`,
		);
	}

	const cachedName = executorCachedFilename(manifest.version, platform);
	const cached = getCachedHelperBinaryPath(cachedName);
	if (cached) {
		// Re-verify rather than trusting the filename: a truncated earlier download
		// or an edited cache directory must not be handed to a target machine.
		if (await verifyCachedDigest(cached, entry.sha256)) {
			return {
				path: cached,
				filename: entry.filename,
				version: manifest.version,
				size: entry.size,
				sha256: entry.sha256,
			};
		}
		logger.warn("Cached executor binary failed digest verification; re-downloading", {
			platform,
			path: cached,
		});
		try {
			unlinkSync(cached);
		} catch {
			// Best effort; the download below overwrites it atomically anyway.
		}
	}

	const downloaded = await downloadHelperBinary(
		{
			toolName: entry.filename,
			cachedName,
			displayName: `narrafork-executor ${manifest.version} (${platform})`,
			expectedSha256: entry.sha256,
		},
		{
			useCache: false,
			allowUnsignedDownload: false,
			maxBytes: BINARY_MAX_BYTES,
			timeoutMs: BINARY_DOWNLOAD_TIMEOUT_MS,
			bypassFailureCache: true,
		},
	);
	if (!downloaded) {
		throw new ExecutorDistributionError(
			`Failed to download the executor binary for ${platform} from the update server`,
		);
	}
	return {
		path: downloaded,
		filename: entry.filename,
		version: manifest.version,
		size: entry.size,
		sha256: entry.sha256,
	};
}

/** Look up a platform's published digest without downloading anything. */
export function getExecutorArtifactDigest(
	manifest: ExecutorManifest,
	platform: ExecutorPlatform,
): string {
	const entry = manifest.platforms[platform];
	if (!entry) {
		throw new ExecutorDistributionError(
			`Executor version ${manifest.version} does not publish a build for ${platform}`,
		);
	}
	return entry.sha256;
}
