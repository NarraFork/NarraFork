/**
 * narrator-chunks-cache.ts — In-memory snapshot cache for the chunk message layer.
 *
 * `useNarratorChunks` owns its manifest + loaded chunks in component state, so an
 * unmount used to throw the whole history away: remounting cleared the list,
 * re-fetched manifest + tail and restarted a reconcile transaction. That happens
 * on every desktop/mobile breakpoint switch (the narrator route renders two
 * different trees), on dockview panel remounts and on route back/forward.
 *
 * This module keeps the last snapshot per narrator so a remount can restore it
 * synchronously and only run a cheap `diff` reconcile to confirm it is current.
 *
 * INVARIANT THIS RELIES ON: chunk state is copy-on-write. Every realtime updater
 * rebuilds `loaded` via `new Map(state.loaded)` and replaces message arrays
 * wholesale rather than mutating them in place, so storing references here is
 * safe and needs no deep clone. If that ever changes, this cache must clone.
 *
 * Deliberately REACT-FREE so it can be unit tested without a DOM, mirroring the
 * factory + shared-instance shape of `frontend/lib/shiki-token-cache.ts`.
 *
 * Streaming state is intentionally NOT cached: the server re-sends a
 * `streaming_snapshot` on every `kind: "messages"` subscribe, and the client
 * merges it, so in-flight output heals itself after a remount.
 */

import type { ChunkManifestEntry, TreeMessage } from "../../lib/api";

/** A restorable snapshot of one narrator's chunk state. */
export interface CachedChunkSnapshot {
	narratorId: string;
	manifest: ChunkManifestEntry[];
	loaded: Map<string, TreeMessage[]>;
	total: number;
	messageVersion: number;
	hasOlderChunks: boolean;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
}

export interface NarratorChunksCacheLimits {
	/** Max retained narrators (LRU eviction beyond this). */
	maxEntries?: number;
	/** Entries older than this are treated as a miss and dropped. */
	ttlMs?: number;
	/** Max manifest chunks retained per entry (tail-anchored truncation). */
	maxChunks?: number;
	/** Max loaded messages retained per entry (tail-anchored truncation). */
	maxMessages?: number;
}

export interface NarratorChunksCache {
	/**
	 * Read a snapshot without consuming it. Non-destructive so React StrictMode's
	 * double render/mount cannot make the second pass miss.
	 */
	peek(narratorId: string): CachedChunkSnapshot | null;
	/** Store a snapshot, subject to the validity gate, truncation and LRU. */
	write(snapshot: CachedChunkSnapshot): void;
	invalidate(narratorId: string): void;
	clear(): void;
	/** Introspection for tests and diagnostics. */
	stats(): { entries: number; messages: number };
}

const DEFAULT_MAX_ENTRIES = 4;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CHUNKS = 60;
const DEFAULT_MAX_MESSAGES = 3_000;

interface CacheEntry {
	snapshot: CachedChunkSnapshot;
	storedAt: number;
	messages: number;
}

function countLoadedMessages(loaded: Map<string, TreeMessage[]>): number {
	let total = 0;
	for (const messages of loaded.values()) total += messages.length;
	return total;
}

/**
 * A snapshot is only worth caching once it describes a real committed history.
 * An empty manifest or a zero version means the initial load never finished (or
 * StrictMode is tearing down the throwaway first mount), and restoring that
 * would show an empty conversation while suppressing the fetch that fills it.
 */
function isCacheable(snapshot: CachedChunkSnapshot): boolean {
	return (
		snapshot.narratorId.length > 0 && snapshot.manifest.length > 0 && snapshot.messageVersion > 0
	);
}

/**
 * Keep only the newest `maxChunks` manifest entries (and at most `maxMessages`
 * loaded messages), dropping the `loaded` data of everything cut away.
 *
 * Safe because the manifest is already a tail-anchored window: `hasOlderChunks`
 * drives lazy upward expansion, and `firstDirtyManifestIndex` compares the two
 * windows backward from the tail, so extra older chunks in one window are never
 * treated as dirty. Whenever we cut, `hasOlderChunks` is forced true so the view
 * still offers to load the history we dropped.
 */
function truncateSnapshot(
	snapshot: CachedChunkSnapshot,
	maxChunks: number,
	maxMessages: number,
): CachedChunkSnapshot {
	let manifest = snapshot.manifest;
	let truncated = false;

	if (manifest.length > maxChunks) {
		manifest = manifest.slice(manifest.length - maxChunks);
		truncated = true;
	}

	// Walk backward from the tail, keeping chunks until the message budget is hit.
	// A chunk is kept whole or not at all: a partially retained chunk would look
	// incomplete to `isChunkComplete` and force a redundant refetch anyway.
	const keptIds = new Set<string>();
	let messages = 0;
	let firstKeptIndex = manifest.length;
	for (let i = manifest.length - 1; i >= 0; i--) {
		const entry = manifest[i];
		const loadedMessages = snapshot.loaded.get(entry.id);
		const size = loadedMessages?.length ?? 0;
		if (loadedMessages && messages + size > maxMessages && keptIds.size > 0) break;
		if (loadedMessages) {
			keptIds.add(entry.id);
			messages += size;
		}
		firstKeptIndex = i;
		if (messages >= maxMessages) break;
	}

	if (firstKeptIndex > 0) {
		manifest = manifest.slice(firstKeptIndex);
		truncated = true;
	}

	let loaded = snapshot.loaded;
	if (truncated) {
		const manifestIds = new Set(manifest.map((entry) => entry.id));
		loaded = new Map();
		for (const [chunkId, chunkMessages] of snapshot.loaded) {
			if (manifestIds.has(chunkId) && keptIds.has(chunkId)) loaded.set(chunkId, chunkMessages);
		}
	}

	if (!truncated) return snapshot;
	return {
		...snapshot,
		manifest,
		loaded,
		// We dropped older history, so older chunks definitely exist upstream.
		hasOlderChunks: true,
	};
}

/**
 * Decide whether `next` should replace an already cached `current`.
 *
 * Two hooks can hold independent state for the same narrator (the workspace
 * chunk preview renders a tiny tail-only window beside the full list), and both
 * write on unmount. Prefer the newer server version, then the wider window, so a
 * preview can never clobber the real conversation view.
 */
function shouldReplace(current: CachedChunkSnapshot, next: CachedChunkSnapshot): boolean {
	if (next.messageVersion !== current.messageVersion) {
		return next.messageVersion > current.messageVersion;
	}
	if (next.manifest.length !== current.manifest.length) {
		return next.manifest.length > current.manifest.length;
	}
	return countLoadedMessages(next.loaded) >= countLoadedMessages(current.loaded);
}

export function createNarratorChunksCache(
	limits: NarratorChunksCacheLimits = {},
	now: () => number = Date.now,
): NarratorChunksCache {
	const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const ttlMs = limits.ttlMs ?? DEFAULT_TTL_MS;
	const maxChunks = limits.maxChunks ?? DEFAULT_MAX_CHUNKS;
	const maxMessages = limits.maxMessages ?? DEFAULT_MAX_MESSAGES;

	const entries = new Map<string, CacheEntry>();

	const evictOldest = () => {
		const oldestKey = entries.keys().next().value;
		if (oldestKey === undefined) return;
		entries.delete(oldestKey);
	};

	return {
		peek(narratorId) {
			const entry = entries.get(narratorId);
			if (!entry) return null;
			if (now() - entry.storedAt > ttlMs) {
				entries.delete(narratorId);
				return null;
			}
			// LRU touch: a restored narrator is the most recently used one.
			entries.delete(narratorId);
			entries.set(narratorId, entry);
			return entry.snapshot;
		},

		write(snapshot) {
			if (!isCacheable(snapshot)) {
				// An unusable snapshot must not leave a stale predecessor behind: the
				// narrator may have just been compacted, reset or deleted.
				entries.delete(snapshot.narratorId);
				return;
			}
			const existing = entries.get(snapshot.narratorId);
			const fresh = existing != null && now() - existing.storedAt <= ttlMs;
			if (existing && fresh && !shouldReplace(existing.snapshot, snapshot)) return;

			const stored = truncateSnapshot(snapshot, maxChunks, maxMessages);
			entries.delete(snapshot.narratorId);
			entries.set(snapshot.narratorId, {
				snapshot: stored,
				storedAt: now(),
				messages: countLoadedMessages(stored.loaded),
			});
			while (entries.size > maxEntries) evictOldest();
		},

		invalidate(narratorId) {
			entries.delete(narratorId);
		},

		clear() {
			entries.clear();
		},

		stats() {
			let messages = 0;
			for (const entry of entries.values()) messages += entry.messages;
			return { entries: entries.size, messages };
		},
	};
}

const sharedCache = createNarratorChunksCache();

export const peekCachedChunkSnapshot: NarratorChunksCache["peek"] = (narratorId) =>
	sharedCache.peek(narratorId);
export const writeCachedChunkSnapshot: NarratorChunksCache["write"] = (snapshot) =>
	sharedCache.write(snapshot);
export const invalidateCachedChunkSnapshot: NarratorChunksCache["invalidate"] = (narratorId) =>
	sharedCache.invalidate(narratorId);
/** Clear every cached snapshot. Call on logout so history cannot leak across accounts. */
export const clearNarratorChunksCache: NarratorChunksCache["clear"] = () => sharedCache.clear();
export const narratorChunksCacheStats: NarratorChunksCache["stats"] = () => sharedCache.stats();
