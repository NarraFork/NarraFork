/** Historical release metadata compatibility. New canonical mirrors use /api/v3. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_MIRROR_MAIN_BINARY_BYTES } from "../../shared/independent-update-mirror";
import { isValidReleaseVersion } from "../../shared/release-version";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { isValidChannel, isValidPlatform } from "../lib/platform";
import { getAllReleases, removeCachedRelease, setCachedRelease } from "../lib/release-cache";
import { getReleaseIdentityMismatch } from "../lib/release-integrity";
import type { StorageBackend } from "../storage/types";
import type { ReleaseListItem, ReleaseMeta } from "../types";

const metaLocks = new Map<string, Promise<void>>();
async function withMetaLock<T>(product: string, version: string, fn: () => Promise<T>): Promise<T> {
	const key = `${product}/${version}`;
	while (metaLocks.has(key)) await metaLocks.get(key);
	let releaseLock: (() => void) | undefined;
	metaLocks.set(
		key,
		new Promise<void>((resolve) => {
			releaseLock = resolve;
		}),
	);
	try {
		return await fn();
	} finally {
		metaLocks.delete(key);
		releaseLock?.();
	}
}
export function createReleaseRoutes(storage: StorageBackend) {
	const routes = new Hono();
	// Never buffer old full/patch multipart uploads. Only small compatibility metadata is accepted.
	routes.use(
		"/:product/releases",
		bodyLimit({
			maxSize: 256 * 1024,
			onError: (c) =>
				c.json(
					{ error: "Legacy uploads accept metadata only; use the v3 canonical mirror protocol" },
					413,
				),
		}),
	);
	routes.post("/:product/releases", requireAuth("upload"), async (c) => {
		const product = c.req.param("product") as string;
		const form = await c.req.formData();
		if (form.get("file") || form.get("zstdPatch") || form.get("zstdPatchMeta"))
			return c.json(
				{
					error:
						"Binary and legacy patch publishing is deprecated; publish to GitHub then use /api/v3/products/:product/mirror",
				},
				410,
			);
		const version = form.get("version");
		const channel = form.get("channel");
		const platform = form.get("platform");
		const filename = form.get("filename");
		const size = Number(form.get("size"));
		const sha512 = form.get("sha512");
		if (
			!/^[A-Za-z0-9_-]{1,64}$/.test(product) ||
			typeof version !== "string" ||
			!isValidReleaseVersion(version)
		)
			return c.json({ error: "Invalid product/version" }, 400);
		if (typeof channel !== "string" || !isValidChannel(channel))
			return c.json({ error: "Invalid or missing channel" }, 400);
		if (typeof platform !== "string" || !isValidPlatform(platform))
			return c.json({ error: "Invalid or missing platform" }, 400);
		if (
			typeof filename !== "string" ||
			filename.length > 255 ||
			!/^[A-Za-z0-9._-]+$/.test(filename) ||
			filename.includes("..") ||
			!Number.isSafeInteger(size) ||
			size <= 0 ||
			size > MAX_MIRROR_MAIN_BINARY_BYTES ||
			typeof sha512 !== "string" ||
			!/^[A-Za-z0-9+/]{86}==$/.test(sha512)
		)
			return c.json({ error: "Invalid filename/size/SHA512 metadata" }, 400);
		const notes = form.get("releaseNotes");
		let releaseNotes: ReleaseMeta["releaseNotes"];
		if (typeof notes === "string") {
			try {
				const parsed = JSON.parse(notes);
				releaseNotes =
					parsed &&
					typeof parsed === "object" &&
					!Array.isArray(parsed) &&
					Object.values(parsed).every((v) => typeof v === "string")
						? parsed
						: notes;
			} catch {
				releaseNotes = notes;
			}
		}
		const result = await withMetaLock(product, version, async () => {
			const path = `products/${product}/releases/${version}/meta.json`;
			const bytes = await storage.getFile(path);
			const meta: ReleaseMeta = bytes
				? JSON.parse(bytes.toString("utf8"))
				: { version, channel, releaseDate: new Date().toISOString(), releaseNotes, platforms: {} };
			const previous = meta.platforms[platform];
			const mismatch = previous && getReleaseIdentityMismatch(previous, { filename, size, sha512 });
			if (mismatch)
				return {
					error: `Release v${version} ${platform} is immutable once published. ${mismatch}`,
					status: 409 as const,
				};
			if (releaseNotes !== undefined) meta.releaseNotes = releaseNotes;
			// Reading legacy patch availability is compatible; metadata-only writes never invent or add patch paths.
			meta.platforms[platform] = previous ?? { filename, size, sha512, hasZstdPatch: false };
			await storage.saveFile(path, Buffer.from(JSON.stringify(meta, null, "\t")));
			return { meta };
		});
		if ("error" in result) return c.json({ error: result.error }, result.status);
		setCachedRelease(product, result.meta);
		return c.json({
			success: true,
			version,
			platform,
			filename,
			size,
			sha512: `${sha512.slice(0, 16)}...`,
			hasZstdPatch: result.meta.platforms[platform]?.hasZstdPatch === true,
			zstdPatchFromVersions: result.meta.platforms[platform]?.zstdPatchFromVersions ?? [],
		});
	});
	routes.get("/:product/releases", requireAuth("upload"), async (c) => {
		const product = c.req.param("product") as string;
		const releases: ReleaseListItem[] = (await getAllReleases(storage, product)).map((meta) => ({
			version: meta.version,
			channel: meta.channel,
			releaseDate: meta.releaseDate,
			releaseNotes: meta.releaseNotes,
			platforms: Object.keys(meta.platforms),
		}));
		return c.json({ releases });
	});
	// This legacy channel is not consulted by the canonical v3 index or its clients.
	routes.post(
		"/:product/releases/:version/promote",
		requireAuth("upload"),
		bodyLimit({ maxSize: 1024 }),
		async (c) => {
			const product = c.req.param("product") as string;
			const version = c.req.param("version") as string;
			let targetChannel = "stable";
			try {
				const body = await c.req.json();
				if (typeof body?.channel === "string") targetChannel = body.channel;
			} catch {
				/* Historical empty body means stable. */
			}
			if (targetChannel !== "stable" && targetChannel !== "beta")
				return c.json({ error: "Invalid channel (must be 'stable' or 'beta')" }, 400);
			const meta = await withMetaLock(product, version, async () => {
				const path = `products/${product}/releases/${version}/meta.json`;
				const bytes = await storage.getFile(path);
				if (!bytes) return null;
				const m = JSON.parse(bytes.toString("utf8")) as ReleaseMeta;
				m.channel = targetChannel as "stable" | "beta";
				await storage.saveFile(path, Buffer.from(JSON.stringify(m, null, "\t")));
				return m;
			});
			if (!meta) return c.json({ error: "Release not found" }, 404);
			setCachedRelease(product, meta);
			return c.json({
				success: true,
				version,
				channel: targetChannel,
				platforms: Object.keys(meta.platforms),
			});
		},
	);
	// Retain explicit authenticated historical management; no mirror operation calls this route.
	routes.delete("/:product/releases/:version", requireAuth("admin"), async (c) => {
		const product = c.req.param("product") as string;
		const version = c.req.param("version") as string;
		const path = `products/${product}/releases/${version}`;
		if (!(await storage.fileExists(`${path}/meta.json`)))
			return c.json({ error: "Release not found" }, 404);
		await storage.deleteDirectory(path);
		removeCachedRelease(product, version);
		logger.info("Deleted release", { product, version });
		return c.json({ success: true, version });
	});
	return routes;
}
