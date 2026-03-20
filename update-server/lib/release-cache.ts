/**
 * In-memory release metadata cache.
 *
 * Avoids scanning the filesystem on every check-update request.
 * Cache is populated on startup and invalidated on upload/delete.
 *
 * Structure: product → version → ReleaseMeta
 */

import type { StorageBackend } from "../storage/types";
import type { ReleaseMeta } from "../types";
import { logger } from "./logger";
import { compareVersions } from "./version";

/** product → version → ReleaseMeta */
const cache = new Map<string, Map<string, ReleaseMeta>>();

/** Dedup concurrent loadProduct calls for the same product. */
const loading = new Map<string, Promise<void>>();

/**
 * Load all release metadata for a product into cache.
 */
async function loadProduct(storage: StorageBackend, product: string): Promise<void> {
	const prefix = `products/${product}/releases`;
	const files = await storage.listFiles(prefix);

	const metaFiles = files.filter((f) => f.endsWith("/meta.json"));
	const versions = new Map<string, ReleaseMeta>();

	for (const metaFile of metaFiles) {
		const buf = await storage.getFile(metaFile);
		if (!buf) continue;
		try {
			const meta = JSON.parse(buf.toString("utf-8")) as ReleaseMeta;
			versions.set(meta.version, meta);
		} catch {
			// skip malformed
		}
	}

	cache.set(product, versions);
	logger.debug("Release cache loaded", { product, versions: versions.size });
}

/**
 * Warm the cache for a product. Call on first access or after invalidation.
 */
export async function ensureProductCached(storage: StorageBackend, product: string): Promise<void> {
	if (cache.has(product)) return;
	if (!loading.has(product)) {
		const p = loadProduct(storage, product).finally(() => loading.delete(product));
		loading.set(product, p);
	}
	await loading.get(product);
}

/**
 * Get the latest release for a product/channel/platform from cache.
 * Returns null if no matching release exists.
 */
export async function getLatestRelease(
	storage: StorageBackend,
	product: string,
	channel: string,
	platform: string,
): Promise<ReleaseMeta | null> {
	await ensureProductCached(storage, product);

	const versions = cache.get(product);
	if (!versions || versions.size === 0) return null;

	// Sort versions descending
	const sorted = [...versions.values()]
		.filter((m) => m.channel === channel && m.platforms[platform])
		.sort((a, b) => compareVersions(b.version, a.version));

	return sorted[0] ?? null;
}

/**
 * Get all releases for a product from cache.
 */
export async function getAllReleases(
	storage: StorageBackend,
	product: string,
): Promise<ReleaseMeta[]> {
	await ensureProductCached(storage, product);

	const versions = cache.get(product);
	if (!versions) return [];

	return [...versions.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Update a single release in the cache (after upload).
 */
export function setCachedRelease(product: string, meta: ReleaseMeta): void {
	let versions = cache.get(product);
	if (!versions) {
		versions = new Map();
		cache.set(product, versions);
	}
	versions.set(meta.version, meta);
}

/**
 * Remove a release from the cache (after delete).
 */
export function removeCachedRelease(product: string, version: string): void {
	const versions = cache.get(product);
	if (versions) {
		versions.delete(version);
	}
}

/**
 * Invalidate the entire cache for a product (forces reload on next access).
 */
export function invalidateProduct(product: string): void {
	cache.delete(product);
}

/**
 * Invalidate all cached data.
 */
export function invalidateAll(): void {
	cache.clear();
}
