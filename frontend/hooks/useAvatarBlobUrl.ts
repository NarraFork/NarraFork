import { useEffect, useState } from "react";
import { getAvatarUrl, getToken } from "../lib/api";

interface CacheEntry {
	blobUrl: string;
	refCount: number;
}

/** Shared cache: key = "userId:avatarImageId" → blob URL with ref counting. */
const cache = new Map<string, CacheEntry>();
/** In-flight fetches to avoid duplicate requests. */
const pending = new Map<string, Promise<string | null>>();

function cacheKey(userId: string, avatarImageId: string): string {
	return `${userId}:${avatarImageId}`;
}

function scheduleUnreferencedCleanup(key: string) {
	setTimeout(() => {
		const entry = cache.get(key);
		if (entry && entry.refCount <= 0) {
			URL.revokeObjectURL(entry.blobUrl);
			cache.delete(key);
		}
	}, 0);
}

function fetchAvatar(userId: string, avatarImageId: string): Promise<string | null> {
	const key = cacheKey(userId, avatarImageId);

	const existing = pending.get(key);
	if (existing) return existing;

	const token = getToken();
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;

	const promise = fetch(getAvatarUrl(userId, avatarImageId), { headers })
		.then((res) => (res.ok ? res.blob() : null))
		.then((blob) => {
			pending.delete(key);
			if (!blob) return null;

			// Race guard: another fetch may have populated the cache while this
			// request was in flight. Reuse that URL and do not create an orphan URL.
			const cached = cache.get(key);
			if (cached) return cached.blobUrl;

			const url = URL.createObjectURL(blob);
			cache.set(key, { blobUrl: url, refCount: 0 });
			// If every component unmounted before the fetch completed, nobody will
			// acquire the zero-ref entry. Drop it on the next macrotask.
			scheduleUnreferencedCleanup(key);
			return url;
		})
		.catch(() => {
			pending.delete(key);
			return null;
		});

	pending.set(key, promise);
	return promise;
}

function acquire(userId: string, avatarImageId: string): string | null {
	const key = cacheKey(userId, avatarImageId);
	const entry = cache.get(key);
	if (entry) {
		entry.refCount++;
		return entry.blobUrl;
	}
	return null;
}

function release(userId: string, avatarImageId: string) {
	const key = cacheKey(userId, avatarImageId);
	const entry = cache.get(key);
	if (!entry) return;
	entry.refCount--;
	if (entry.refCount <= 0) {
		URL.revokeObjectURL(entry.blobUrl);
		cache.delete(key);
	}
}

/**
 * Invalidate a cached avatar (e.g. after upload). Any component still
 * mounted will re-fetch on next render cycle.
 */
export function invalidateAvatarCache(userId: string, avatarImageId: string) {
	const key = cacheKey(userId, avatarImageId);
	const entry = cache.get(key);
	if (entry) {
		URL.revokeObjectURL(entry.blobUrl);
		cache.delete(key);
	}
	pending.delete(key);
}

/**
 * Fetch an authenticated avatar image and return a shared blob URL.
 * Multiple components referencing the same user/image share one fetch
 * and one blob URL via ref-counted module-level cache.
 */
export function useAvatarBlobUrl(
	userId: string | null | undefined,
	avatarImageId: string | null | undefined,
): string | null {
	const [blobUrl, setBlobUrl] = useState<string | null>(() => {
		if (!userId || !avatarImageId) return null;
		return cache.get(cacheKey(userId, avatarImageId))?.blobUrl ?? null;
	});

	useEffect(() => {
		// Clear immediately on key change to prevent stale avatar flash
		setBlobUrl(null);

		if (!userId || !avatarImageId) return;

		const currentUserId = userId;
		const currentAvatarId = avatarImageId;
		let cancelled = false;
		// Track whether this effect successfully acquired a ref so cleanup
		// only releases what was actually acquired — prevents double-release.
		let acquired = false;

		const cached = acquire(currentUserId, currentAvatarId);
		if (cached) {
			acquired = true;
			setBlobUrl(cached);
			return () => release(currentUserId, currentAvatarId);
		}

		fetchAvatar(currentUserId, currentAvatarId).then((url) => {
			if (cancelled) return; // cleanup already ran — nothing to release (refCount wasn't bumped)
			if (url) {
				acquire(currentUserId, currentAvatarId);
				acquired = true;
				setBlobUrl(url);
			}
		});

		return () => {
			cancelled = true;
			if (acquired) {
				release(currentUserId, currentAvatarId);
			}
		};
	}, [userId, avatarImageId]);

	return blobUrl;
}
