/**
 * Release management routes — upload, delete, list.
 * Requires authentication.
 *
 * POST   /api/v2/products/:product/releases          — upload a release
 * GET    /api/v2/products/:product/releases           — list releases
 * DELETE /api/v2/products/:product/releases/:version  — delete a release
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { isValidChannel, isValidPlatform } from "../lib/platform";
import {
	getAllReleases,
	getReleaseByVersion,
	removeCachedRelease,
	setCachedRelease,
} from "../lib/release-cache";
import { getPatchSourceMismatch, getReleaseIdentityMismatch } from "../lib/release-integrity";
import type { StorageBackend } from "../storage/types";
import type { PlatformFileInfo, ReleaseListItem, ReleaseMeta, ZstdPatchMeta } from "../types";

/**
 * Per-version write locks to prevent concurrent meta.json corruption.
 * Key: "product/version"
 */
const metaLocks = new Map<string, Promise<void>>();
const PATCH_BASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?$/;

function versionedPatchFilename(filename: string, fromVersion: string): string {
	return `${filename}.from-${fromVersion}.zstd-patch`;
}

async function withMetaLock<T>(product: string, version: string, fn: () => Promise<T>): Promise<T> {
	const key = `${product}/${version}`;
	// Wait for any existing lock on this version
	while (metaLocks.has(key)) {
		await metaLocks.get(key);
	}
	// Acquire lock
	let releaseLock: (() => void) | undefined;
	const lockPromise = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	metaLocks.set(key, lockPromise);

	try {
		return await fn();
	} finally {
		metaLocks.delete(key);
		releaseLock?.();
	}
}

export function createReleaseRoutes(storage: StorageBackend) {
	const routes = new Hono();

	// POST /api/v2/products/:product/releases
	routes.post("/:product/releases", requireAuth("upload"), async (c) => {
		const product = c.req.param("product") as string;

		const formData = await c.req.formData();
		const version = formData.get("version") as string | null;
		const channel = formData.get("channel") as string | null;
		const platform = formData.get("platform") as string | null;
		const releaseNotesRaw = formData.get("releaseNotes") as string | null;
		let releaseNotes: string | Record<string, string> | undefined;
		if (releaseNotesRaw) {
			try {
				const parsed = JSON.parse(releaseNotesRaw);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					releaseNotes = parsed as Record<string, string>;
				} else {
					releaseNotes = releaseNotesRaw;
				}
			} catch {
				releaseNotes = releaseNotesRaw;
			}
		}
		const file = formData.get("file") as File | null;
		const zstdPatchFile = formData.get("zstdPatch") as File | null;
		const zstdPatchMetaFile = formData.get("zstdPatchMeta") as File | null;

		// When no full file is provided, these fields describe the target binary
		const metaFilename = formData.get("filename") as string | null;
		const metaSize = formData.get("size") as string | null;
		const metaSha512 = formData.get("sha512") as string | null;

		// Validate required fields
		if (!version) return c.json({ error: "Missing version" }, 400);
		if (!channel || !isValidChannel(channel)) {
			return c.json({ error: "Invalid or missing channel" }, 400);
		}
		if (!platform || !isValidPlatform(platform)) {
			return c.json({ error: "Invalid or missing platform" }, 400);
		}

		// Either full file or metadata fields are required
		if (!file && (!metaFilename || !metaSize || !metaSha512)) {
			return c.json({ error: "Provide either 'file' or 'filename'+'size'+'sha512' fields" }, 400);
		}

		const basePath = `products/${product}/releases/${version}/${platform}`;
		let filename: string;
		let fileSize: number;
		let sha512: string;
		let fileBuffer: Buffer | undefined;

		if (file) {
			// Full file upload — compute identity before entering the write transaction.
			filename = file.name;
			fileBuffer = Buffer.from(await file.arrayBuffer());
			fileSize = fileBuffer.length;
			sha512 = createHash("sha512").update(fileBuffer).digest("base64");
		} else {
			// Delta-only upload — use provided metadata.
			filename = metaFilename as string;
			fileSize = Number.parseInt(metaSize as string, 10);
			sha512 = metaSha512 as string;

			if (Number.isNaN(fileSize) || fileSize <= 0) {
				return c.json({ error: "Invalid size" }, 400);
			}
		}

		// Save zstd patch if provided. Each base version gets its own file so one
		// target release can serve multiple direct upgrade paths. The canonical
		// filenames are also refreshed for rollback compatibility with older servers.
		let uploadedPatchFromVersion: string | undefined;
		let patchBuffer: Buffer | undefined;
		let patchMetaBuffer: Buffer | undefined;
		let patchMeta: ZstdPatchMeta | undefined;
		if (Boolean(zstdPatchFile) !== Boolean(zstdPatchMetaFile)) {
			return c.json({ error: "Provide both 'zstdPatch' and 'zstdPatchMeta'" }, 400);
		}
		if (zstdPatchFile && zstdPatchMetaFile) {
			patchBuffer = Buffer.from(await zstdPatchFile.arrayBuffer());
			patchMetaBuffer = Buffer.from(await zstdPatchMetaFile.arrayBuffer());
			try {
				patchMeta = JSON.parse(patchMetaBuffer.toString("utf-8")) as ZstdPatchMeta;
			} catch {
				return c.json({ error: "Invalid zstd patch metadata JSON" }, 400);
			}

			if (!PATCH_BASE_VERSION_RE.test(patchMeta.fromVersion)) {
				return c.json({ error: "Invalid zstd patch base version" }, 400);
			}
			if (patchMeta.toVersion !== version) {
				return c.json({ error: "Zstd patch target version does not match release" }, 400);
			}
			if (patchMeta.patchSize !== patchBuffer.length) {
				return c.json({ error: "Zstd patch size does not match metadata" }, 400);
			}
			if (patchMeta.newFileSize !== fileSize || patchMeta.newFileSha512 !== sha512) {
				return c.json({ error: "Zstd patch target metadata does not match release file" }, 400);
			}

			uploadedPatchFromVersion = patchMeta.fromVersion;
		}

		// Validate and persist the release atomically under the per-version lock.
		const result = await withMetaLock(product, version, async () => {
			const metaPath = `products/${product}/releases/${version}/meta.json`;
			let m: ReleaseMeta;

			const existingMeta = await storage.getFile(metaPath);
			if (existingMeta) {
				m = JSON.parse(existingMeta.toString("utf-8")) as ReleaseMeta;
			} else {
				m = {
					version,
					channel,
					releaseDate: new Date().toISOString(),
					releaseNotes: releaseNotes ?? undefined,
					platforms: {},
				};
			}

			const existingPlatformInfo: PlatformFileInfo | undefined = m.platforms[platform];
			const identityMismatch = existingPlatformInfo
				? getReleaseIdentityMismatch(existingPlatformInfo, { filename, size: fileSize, sha512 })
				: null;
			if (identityMismatch) {
				return {
					error: `Release v${version} ${platform} is immutable once published. ${identityMismatch}. Publish the replacement binary under a new version.`,
					status: 409 as const,
				};
			}

			if (patchMeta) {
				const sourceRelease = await getReleaseByVersion(storage, product, patchMeta.fromVersion);
				const sourceMismatch = getPatchSourceMismatch(
					patchMeta,
					sourceRelease?.platforms[platform],
				);
				if (sourceMismatch) {
					return { error: sourceMismatch, status: 400 as const };
				}
			}

			if (fileBuffer) {
				await storage.saveFile(`${basePath}/${filename}`, fileBuffer);
				logger.info("Saved release file", {
					product,
					version,
					platform,
					filename,
					size: fileSize,
				});
			} else {
				logger.info("Delta-only release (no full file)", {
					product,
					version,
					platform,
					filename,
					size: fileSize,
				});
			}

			if (patchBuffer && patchMetaBuffer && uploadedPatchFromVersion) {
				const versionedName = versionedPatchFilename(filename, uploadedPatchFromVersion);
				await storage.saveFile(`${basePath}/${versionedName}`, patchBuffer);
				await storage.saveFile(`${basePath}/${versionedName}.meta.json`, patchMetaBuffer);
				await storage.saveFile(`${basePath}/${filename}.zstd-patch`, patchBuffer);
				await storage.saveFile(`${basePath}/${filename}.zstd-patch.meta.json`, patchMetaBuffer);
				logger.info("Saved zstd patch", {
					filename: versionedName,
					fromVersion: uploadedPatchFromVersion,
					size: patchBuffer.length,
				});
			}

			if (releaseNotes) {
				m.releaseNotes = releaseNotes;
			}

			const patchFromVersions = new Set(existingPlatformInfo?.zstdPatchFromVersions ?? []);
			if (existingPlatformInfo?.zstdPatchFromVersion) {
				patchFromVersions.add(existingPlatformInfo.zstdPatchFromVersion);
			}
			if (uploadedPatchFromVersion) patchFromVersions.add(uploadedPatchFromVersion);

			const platformInfo: PlatformFileInfo = {
				filename,
				size: fileSize,
				sha512,
				hasZstdPatch:
					existingPlatformInfo?.hasZstdPatch === true || Boolean(uploadedPatchFromVersion),
				zstdPatchFromVersion:
					uploadedPatchFromVersion ?? existingPlatformInfo?.zstdPatchFromVersion,
				zstdPatchFromVersions:
					patchFromVersions.size > 0 ? [...patchFromVersions].sort() : undefined,
			};

			m.platforms[platform] = platformInfo;
			await storage.saveFile(metaPath, Buffer.from(JSON.stringify(m, null, "\t")));
			return { meta: m };
		});

		if ("error" in result) {
			return c.json({ error: result.error }, result.status);
		}
		const { meta } = result;

		// Update in-memory cache
		setCachedRelease(product, meta);

		return c.json({
			success: true,
			version,
			platform,
			filename,
			size: fileSize,
			sha512: `${sha512.slice(0, 16)}...`,
			hasZstdPatch: meta.platforms[platform]?.hasZstdPatch === true,
			zstdPatchFromVersions: meta.platforms[platform]?.zstdPatchFromVersions ?? [],
		});
	});

	// GET /api/v2/products/:product/releases
	routes.get("/:product/releases", requireAuth("upload"), async (c) => {
		const product = c.req.param("product") as string;

		// Use cache instead of filesystem scan
		const allReleases = await getAllReleases(storage, product);

		const releases: ReleaseListItem[] = allReleases.map((meta) => ({
			version: meta.version,
			channel: meta.channel,
			releaseDate: meta.releaseDate,
			releaseNotes: meta.releaseNotes,
			platforms: Object.keys(meta.platforms),
		}));

		return c.json({ releases });
	});

	// POST /api/v2/products/:product/releases/:version/promote
	// Promote a release from beta to stable (or change channel).
	routes.post("/:product/releases/:version/promote", requireAuth("upload"), async (c) => {
		const product = c.req.param("product") as string;
		const version = c.req.param("version") as string;

		let targetChannel = "stable";
		try {
			const body = await c.req.json();
			if (body?.channel && typeof body.channel === "string") {
				targetChannel = body.channel;
			}
		} catch {
			// no body or invalid JSON — default to stable
		}

		if (targetChannel !== "stable" && targetChannel !== "beta") {
			return c.json({ error: "Invalid channel (must be 'stable' or 'beta')" }, 400);
		}

		const meta = await withMetaLock(product, version, async () => {
			const metaPath = `products/${product}/releases/${version}/meta.json`;
			const existingMeta = await storage.getFile(metaPath);
			if (!existingMeta) return null;

			const m = JSON.parse(existingMeta.toString("utf-8")) as ReleaseMeta;
			const oldChannel = m.channel;
			m.channel = targetChannel as "stable" | "beta";
			await storage.saveFile(metaPath, Buffer.from(JSON.stringify(m, null, "\t")));

			logger.info("Promoted release", {
				product,
				version,
				from: oldChannel,
				to: targetChannel,
			});
			return m;
		});

		if (!meta) {
			return c.json({ error: "Release not found" }, 404);
		}

		setCachedRelease(product, meta);
		return c.json({
			success: true,
			version,
			channel: targetChannel,
			platforms: Object.keys(meta.platforms),
		});
	});

	// DELETE /api/v2/products/:product/releases/:version
	routes.delete("/:product/releases/:version", requireAuth("admin"), async (c) => {
		const product = c.req.param("product") as string;
		const version = c.req.param("version") as string;
		const releasePath = `products/${product}/releases/${version}`;

		const exists = await storage.fileExists(`${releasePath}/meta.json`);
		if (!exists) {
			return c.json({ error: "Release not found" }, 404);
		}

		await storage.deleteDirectory(releasePath);

		// Remove from cache
		removeCachedRelease(product, version);

		logger.info("Deleted release", { product, version });
		return c.json({ success: true, version });
	});

	return routes;
}
