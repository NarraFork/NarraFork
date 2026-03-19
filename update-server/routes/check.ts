/**
 * Version check route.
 * Public endpoint — no auth required.
 *
 * GET /api/v2/products/:product/releases/latest?channel=&platform=&version=
 */
import { Hono } from "hono";
import { isValidChannel, isValidPlatform } from "../lib/platform";
import { compareVersions, isNewerVersion } from "../lib/version";
import type { StorageBackend } from "../storage/types";
import type { CheckUpdateResponse, ReleaseMeta, ZstdPatchMeta } from "../types";

export function createCheckRoutes(storage: StorageBackend) {
	const routes = new Hono();

	routes.get("/:product/releases/latest", async (c) => {
		const product = c.req.param("product");
		const channel = c.req.query("channel") ?? "stable";
		const platform = c.req.query("platform");
		const currentVersion = c.req.query("version");

		if (!platform || !isValidPlatform(platform)) {
			return c.json({ error: "Invalid or missing platform parameter" }, 400);
		}

		if (!isValidChannel(channel)) {
			return c.json({ error: "Invalid channel parameter" }, 400);
		}

		// Find the latest version for this product/channel/platform
		const latestMeta = await findLatestRelease(storage, product, channel, platform);

		if (!latestMeta) {
			const resp: CheckUpdateResponse = {
				updateAvailable: false,
				currentVersion: currentVersion ?? undefined,
			};
			return c.json(resp);
		}

		// Check if update is available
		if (currentVersion && !isNewerVersion(latestMeta.version, currentVersion)) {
			const resp: CheckUpdateResponse = {
				updateAvailable: false,
				currentVersion,
				version: latestMeta.version,
			};
			return c.json(resp);
		}

		const platformInfo = latestMeta.platforms[platform];
		if (!platformInfo) {
			const resp: CheckUpdateResponse = {
				updateAvailable: false,
				currentVersion: currentVersion ?? undefined,
			};
			return c.json(resp);
		}

		const baseUrl = `/api/v2/products/${product}/releases/${latestMeta.version}`;

		const resp: CheckUpdateResponse = {
			updateAvailable: true,
			currentVersion: currentVersion ?? undefined,
			version: latestMeta.version,
			releaseDate: latestMeta.releaseDate,
			releaseNotes: latestMeta.releaseNotes,
			platform,
			file: {
				filename: platformInfo.filename,
				size: platformInfo.size,
				sha512: platformInfo.sha512,
			},
			blockmap: platformInfo.hasBlockmap
				? { url: `${baseUrl}/blockmap/${platformInfo.filename}` }
				: undefined,
			zstdPatch: null,
		};

		// Check zstd patch availability for the client's current version
		if (platformInfo.hasZstdPatch && currentVersion) {
			const metaPath = `products/${product}/releases/${latestMeta.version}/${platform}/${platformInfo.filename}.zstd-patch.meta.json`;
			const metaBuf = await storage.getFile(metaPath);
			if (metaBuf) {
				try {
					const patchMeta = JSON.parse(metaBuf.toString("utf-8")) as ZstdPatchMeta;
					if (patchMeta.fromVersion === currentVersion) {
						resp.zstdPatch = {
							fromVersion: patchMeta.fromVersion,
							patchSize: patchMeta.patchSize,
							url: `${baseUrl}/zstd-patch/${platformInfo.filename}`,
							metaUrl: `${baseUrl}/zstd-patch-meta/${platformInfo.filename}`,
						};
					}
				} catch {
					// ignore malformed meta
				}
			}
		}

		return c.json(resp);
	});

	return routes;
}

/**
 * Find the latest release for a product/channel/platform.
 * Scans all version directories and returns the newest one that has the requested platform.
 */
async function findLatestRelease(
	storage: StorageBackend,
	product: string,
	channel: string,
	platform: string,
): Promise<ReleaseMeta | null> {
	const releasesPrefix = `products/${product}/releases`;
	const files = await storage.listFiles(releasesPrefix);

	// Extract unique version directories
	const versions = new Set<string>();
	for (const file of files) {
		// file format: products/{product}/releases/{version}/...
		const parts = file.split("/");
		const relIdx = parts.indexOf("releases");
		if (relIdx >= 0 && parts[relIdx + 1]) {
			versions.add(parts[relIdx + 1]);
		}
	}

	// Sort versions descending and find the latest matching one
	const sorted = [...versions].sort((a, b) => compareVersions(b, a));

	for (const version of sorted) {
		const metaPath = `${releasesPrefix}/${version}/meta.json`;
		const metaBuf = await storage.getFile(metaPath);
		if (!metaBuf) continue;

		try {
			const meta = JSON.parse(metaBuf.toString("utf-8")) as ReleaseMeta;
			if (meta.channel !== channel) continue;
			if (!meta.platforms[platform]) continue;
			return meta;
		} catch {}
	}

	return null;
}
