/**
 * Version check route.
 * Public endpoint — no auth required.
 *
 * GET /api/v2/products/:product/releases/latest?channel=&platform=&version=
 */
import { Hono } from "hono";
import { isValidChannel, isValidPlatform } from "../lib/platform";
import { getAllReleases, getLatestRelease, getReleaseByVersion } from "../lib/release-cache";
import { compareVersions, isNewerVersion } from "../lib/version";
import type { StorageBackend } from "../storage/types";
import type { CheckUpdateResponse, PlatformFileInfo, ZstdPatchMeta } from "../types";

const PATCH_BASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?$/;

interface ResolvedPatch {
	meta: ZstdPatchMeta;
	url: string;
	metaUrl: string;
}

async function resolvePatch(
	storage: StorageBackend,
	product: string,
	releaseVersion: string,
	platform: string,
	platformInfo: PlatformFileInfo,
	fromVersion: string,
): Promise<ResolvedPatch | null> {
	if (!PATCH_BASE_VERSION_RE.test(fromVersion)) return null;

	const storageBase = `products/${product}/releases/${releaseVersion}/${platform}`;
	const publicBase = `/api/v2/products/${product}/releases/${releaseVersion}`;
	const versionedStem = `${platformInfo.filename}.from-${fromVersion}.zstd-patch`;
	const candidates = [
		{
			metaPath: `${storageBase}/${versionedStem}.meta.json`,
			url: `${publicBase}/zstd-patch/${platformInfo.filename}?fromVersion=${encodeURIComponent(fromVersion)}`,
			metaUrl: `${publicBase}/zstd-patch-meta/${platformInfo.filename}?fromVersion=${encodeURIComponent(fromVersion)}`,
		},
		{
			metaPath: `${storageBase}/${platformInfo.filename}.zstd-patch.meta.json`,
			url: `${publicBase}/zstd-patch/${platformInfo.filename}`,
			metaUrl: `${publicBase}/zstd-patch-meta/${platformInfo.filename}`,
		},
	];

	for (const candidate of candidates) {
		const metaBuf = await storage.getFile(candidate.metaPath);
		if (!metaBuf) continue;
		try {
			const meta = JSON.parse(metaBuf.toString("utf-8")) as ZstdPatchMeta;
			if (meta.fromVersion !== fromVersion || meta.toVersion !== releaseVersion) continue;
			return { meta, url: candidate.url, metaUrl: candidate.metaUrl };
		} catch {
			// Try the next candidate when metadata is malformed.
		}
	}
	return null;
}

export function createCheckRoutes(storage: StorageBackend) {
	const routes = new Hono();

	routes.get("/:product/releases/:version/metadata", async (c) => {
		const product = c.req.param("product");
		const version = c.req.param("version");
		const release = await getReleaseByVersion(storage, product, version);
		if (!release) return c.json({ error: "Release not found" }, 404);
		return c.json(release);
	});

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
			zstdPatch: null,
		};

		// Check zstd patch availability for the client's current version
		if (platformInfo.hasZstdPatch && currentVersion) {
			// Check direct patch (latest release has an exact patch for currentVersion).
			const directPatch = await resolvePatch(
				storage,
				product,
				latestMeta.version,
				platform,
				platformInfo,
				currentVersion,
			);
			if (directPatch) {
				resp.zstdPatch = {
					fromVersion: directPatch.meta.fromVersion,
					patchSize: directPatch.meta.patchSize,
					url: directPatch.url,
					metaUrl: directPatch.metaUrl,
				};
			}

			// Build patch chain: find intermediate versions between current and latest.
			// Allow cross-channel releases as intermediates — a version promoted from
			// beta to stable should still be usable as a stepping stone in a beta chain.
			if (!resp.zstdPatch) {
				const allReleases = await getAllReleases(storage, product);
				const candidates = allReleases
					.filter(
						(r) =>
							r.platforms[platform] &&
							compareVersions(r.version, currentVersion) > 0 &&
							compareVersions(r.version, latestMeta.version) <= 0,
					)
					.sort((a, b) => compareVersions(a.version, b.version));

				const chain: NonNullable<CheckUpdateResponse["patchChain"]> = [];
				let prevVersion = currentVersion;

				for (const release of candidates) {
					const pi = release.platforms[platform];
					if (!pi?.hasZstdPatch) break;

					const resolved = await resolvePatch(
						storage,
						product,
						release.version,
						platform,
						pi,
						prevVersion,
					);
					if (!resolved) break;

					chain.push({
						fromVersion: resolved.meta.fromVersion,
						toVersion: resolved.meta.toVersion,
						patchSize: resolved.meta.patchSize,
						url: resolved.url,
						metaUrl: resolved.metaUrl,
					});
					prevVersion = release.version;
				}

				if (chain.length > 0 && prevVersion === latestMeta.version) {
					resp.patchChain = chain;
					// Include release notes for each version in the chain
					resp.releaseNotesPerVersion = candidates
						.filter((r) => compareVersions(r.version, currentVersion) > 0)
						.map((r) => ({
							version: r.version,
							releaseDate: r.releaseDate,
							releaseNotes: r.releaseNotes,
						}));
				}
			}
		}

		return c.json(resp);
	});

	return routes;
}
