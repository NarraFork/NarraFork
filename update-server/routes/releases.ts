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
import type { StorageBackend } from "../storage/types";
import type { PlatformFileInfo, ReleaseListItem, ReleaseMeta, ZstdPatchMeta } from "../types";

export function createReleaseRoutes(storage: StorageBackend) {
	const routes = new Hono();

	// POST /api/v2/products/:product/releases
	routes.post("/:product/releases", requireAuth("upload"), async (c) => {
		const product = c.req.param("product");

		const formData = await c.req.formData();
		const version = formData.get("version") as string | null;
		const channel = formData.get("channel") as string | null;
		const platform = formData.get("platform") as string | null;
		const releaseNotes = formData.get("releaseNotes") as string | null;
		const file = formData.get("file") as File | null;
		const blockmapFile = formData.get("blockmap") as File | null;
		const zstdPatchFile = formData.get("zstdPatch") as File | null;
		const zstdPatchMetaFile = formData.get("zstdPatchMeta") as File | null;

		// Validate required fields
		if (!version) return c.json({ error: "Missing version" }, 400);
		if (!channel || !isValidChannel(channel)) {
			return c.json({ error: "Invalid or missing channel" }, 400);
		}
		if (!platform || !isValidPlatform(platform)) {
			return c.json({ error: "Invalid or missing platform" }, 400);
		}
		if (!file) return c.json({ error: "Missing file" }, 400);

		const basePath = `products/${product}/releases/${version}/${platform}`;
		const filename = file.name;

		// Read file into buffer and compute SHA512
		const fileBuffer = Buffer.from(await file.arrayBuffer());
		const sha512 = createHash("sha512").update(fileBuffer).digest("base64");

		// Save main binary
		await storage.saveFile(`${basePath}/${filename}`, fileBuffer);
		logger.info("Saved release file", {
			product,
			version,
			platform,
			filename,
			size: fileBuffer.length,
		});

		// Save blockmap if provided
		let hasBlockmap = false;
		if (blockmapFile) {
			const blockmapBuffer = Buffer.from(await blockmapFile.arrayBuffer());
			await storage.saveFile(`${basePath}/${filename}.blockmap`, blockmapBuffer);
			hasBlockmap = true;
			logger.info("Saved blockmap", { filename: `${filename}.blockmap` });
		}

		// Save zstd patch if provided
		let hasZstdPatch = false;
		let zstdPatchFromVersion: string | undefined;
		if (zstdPatchFile && zstdPatchMetaFile) {
			const patchBuffer = Buffer.from(await zstdPatchFile.arrayBuffer());
			const metaBuffer = Buffer.from(await zstdPatchMetaFile.arrayBuffer());

			await storage.saveFile(`${basePath}/${filename}.zstd-patch`, patchBuffer);
			await storage.saveFile(`${basePath}/${filename}.zstd-patch.meta.json`, metaBuffer);

			hasZstdPatch = true;
			try {
				const meta = JSON.parse(metaBuffer.toString("utf-8")) as ZstdPatchMeta;
				zstdPatchFromVersion = meta.fromVersion;
			} catch {
				// ignore
			}
			logger.info("Saved zstd patch", {
				filename: `${filename}.zstd-patch`,
				size: patchBuffer.length,
			});
		}

		// Update or create meta.json
		const metaPath = `products/${product}/releases/${version}/meta.json`;
		let meta: ReleaseMeta;

		const existingMeta = await storage.getFile(metaPath);
		if (existingMeta) {
			meta = JSON.parse(existingMeta.toString("utf-8")) as ReleaseMeta;
		} else {
			meta = {
				version,
				channel,
				releaseDate: new Date().toISOString(),
				releaseNotes: releaseNotes ?? undefined,
				platforms: {},
			};
		}

		// Update release notes if provided
		if (releaseNotes) {
			meta.releaseNotes = releaseNotes;
		}

		const platformInfo: PlatformFileInfo = {
			filename,
			size: fileBuffer.length,
			sha512,
			hasBlockmap,
			hasZstdPatch,
			zstdPatchFromVersion,
		};

		meta.platforms[platform] = platformInfo;
		await storage.saveFile(metaPath, Buffer.from(JSON.stringify(meta, null, "\t")));

		return c.json({
			success: true,
			version,
			platform,
			filename,
			size: fileBuffer.length,
			sha512: `${sha512.slice(0, 16)}...`,
			hasBlockmap,
			hasZstdPatch,
		});
	});

	// GET /api/v2/products/:product/releases
	routes.get("/:product/releases", requireAuth("upload"), async (c) => {
		const product = c.req.param("product");
		const releasesPrefix = `products/${product}/releases`;
		const files = await storage.listFiles(releasesPrefix);

		// Find all meta.json files
		const metaFiles = files.filter((f) => f.endsWith("/meta.json"));
		const releases: ReleaseListItem[] = [];

		for (const metaFile of metaFiles) {
			const buf = await storage.getFile(metaFile);
			if (!buf) continue;

			try {
				const meta = JSON.parse(buf.toString("utf-8")) as ReleaseMeta;
				releases.push({
					version: meta.version,
					channel: meta.channel,
					releaseDate: meta.releaseDate,
					releaseNotes: meta.releaseNotes,
					platforms: Object.keys(meta.platforms),
				});
			} catch {}
		}

		// Sort by version descending
		releases.sort((a, b) => {
			const partsA = a.version.split(".").map(Number);
			const partsB = b.version.split(".").map(Number);
			for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
				const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0);
				if (diff !== 0) return diff;
			}
			return 0;
		});

		return c.json({ releases });
	});

	// DELETE /api/v2/products/:product/releases/:version
	routes.delete("/:product/releases/:version", requireAuth("admin"), async (c) => {
		const { product, version } = c.req.param();
		const releasePath = `products/${product}/releases/${version}`;

		const exists = await storage.fileExists(`${releasePath}/meta.json`);
		if (!exists) {
			return c.json({ error: "Release not found" }, 404);
		}

		await storage.deleteDirectory(releasePath);
		logger.info("Deleted release", { product, version });

		return c.json({ success: true, version });
	});

	return routes;
}
