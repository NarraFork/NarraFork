/**
 * Version check route.
 * Public endpoint — no auth required.
 *
 * GET /api/v2/products/:product/releases/latest?channel=&platform=&version=
 */
import { Hono } from "hono";
import { isValidChannel, isValidPlatform } from "../lib/platform";
import { getLatestRelease } from "../lib/release-cache";
import { isNewerVersion } from "../lib/version";
import type { StorageBackend } from "../storage/types";
import type { CheckUpdateResponse, ZstdPatchMeta } from "../types";

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

		// O(1) cache lookup instead of filesystem scan
		const latestMeta = await getLatestRelease(storage, product, channel, platform);

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
