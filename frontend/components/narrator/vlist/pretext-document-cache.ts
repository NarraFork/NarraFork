/**
 * pretext-document-cache.ts — Cross-switch snapshot cache for the exact-layout document.
 *
 * Why this exists
 * ---------------
 * `usePretextDocument` creates its `PretextLayoutCoordinator` in a `useMemo`, and
 * the narrator route mounts the panel under `key={narratorId}`. Switching
 * narrators therefore destroys the coordinator and `reset()`s the previous
 * document, so returning to a narrator re-fetched its whole tail page (measured
 * at 283KB-1.3MB for long histories) and re-ran the full measure pass, even when
 * the reader had been on that narrator seconds earlier.
 *
 * This module keeps the last loaded `PretextDocumentInput` per narrator so a
 * remount can adopt it synchronously and paint the first screen without a network
 * round trip. The layout itself is deliberately NOT cached: it is a function of
 * width / LOD / viewport, all of which may have changed while away, and rebuilding
 * from a retained input hits `measureCache` (keyed by messageVersion, never
 * cleared on switch) and `prepared-markdown-cache` (keyed by body text), so the
 * rebuild is the cheap part once the data is in hand.
 *
 * INVARIANT THIS RELIES ON: `PretextDocumentInput` is copy-on-write. Every
 * coordinator mutation path (`applyCompactProgress`, `applyLivePatch`,
 * `appendMessage`, `loadOlder`) rebuilds `{...input, messages: [...]}` and
 * replaces message objects wholesale rather than mutating them in place, which is
 * the same property `narrator-chunks-cache.ts` depends on. Storing references is
 * therefore safe and needs no deep clone. If that ever changes, this cache must
 * clone.
 *
 * Streaming state is intentionally NOT cached: the server re-sends a
 * `streaming_snapshot` on every `kind: "messages"` subscribe, so in-flight output
 * heals itself after a remount.
 *
 * Deliberately REACT-FREE so it can be unit tested without a DOM, mirroring
 * `narrator-chunks-cache.ts` and `frontend/lib/shiki-token-cache.ts`.
 */

import type { PretextDocumentInput } from "./pretext-document-loader";

/** A restorable snapshot of one narrator's loaded document window. */
export interface CachedPretextDocument {
	narratorId: string;
	input: PretextDocumentInput;
}

export interface PretextDocumentCacheLimits {
	/** Max retained narrators (LRU eviction beyond this). */
	maxEntries?: number;
	/** Entries older than this are treated as a miss and dropped. */
	ttlMs?: number;
	/** Max retained messages per entry (tail-anchored truncation). */
	maxMessages?: number;
}

export interface PretextDocumentCache {
	/**
	 * Read a snapshot without consuming it. Non-destructive so React StrictMode's
	 * double render/mount cannot make the second pass miss.
	 */
	peek(narratorId: string): PretextDocumentInput | null;
	/** Store a snapshot, subject to the validity gate, truncation and LRU. */
	write(snapshot: CachedPretextDocument): void;
	invalidate(narratorId: string): void;
	clear(): void;
	/** Introspection for tests and diagnostics. */
	stats(): { entries: number; messages: number };
}

const DEFAULT_MAX_ENTRIES = 4;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
/**
 * Retained messages per narrator. Sized to hold several first screens (the tail
 * fetch is 40-100) plus a few upward pages, without pinning a 30k-message history
 * in memory across four narrators.
 */
const DEFAULT_MAX_MESSAGES = 400;

interface CacheEntry {
	input: PretextDocumentInput;
	storedAt: number;
}

/**
 * A snapshot is only worth caching once it describes a real loaded window.
 *
 * An empty message list or a zero version means the initial load never finished
 * (or StrictMode is tearing down the throwaway first mount), and restoring that
 * would show an empty conversation while suppressing the fetch that fills it.
 */
function isCacheable(input: PretextDocumentInput): boolean {
	return input.messages.length > 0 && input.messageVersion > 0;
}

/**
 * Keep only the newest `maxMessages` messages.
 *
 * Safe because the loaded window is already tail-anchored: `hasPrev` drives lazy
 * upward expansion and `oldestLoadedSeq` is the cursor for the next older page,
 * so both are recomputed from the retained head. Whenever we cut, `hasPrev` is
 * forced true so the view still offers to load the history we dropped.
 */
function truncateInput(input: PretextDocumentInput, maxMessages: number): PretextDocumentInput {
	if (input.messages.length <= maxMessages) return input;
	const messages = input.messages.slice(input.messages.length - maxMessages);
	let oldestLoadedSeq: number | null = null;
	for (const message of messages) {
		const seq = typeof message.seq === "number" ? message.seq : null;
		if (seq == null) continue;
		if (oldestLoadedSeq == null || seq < oldestLoadedSeq) oldestLoadedSeq = seq;
	}
	return {
		...input,
		messages,
		// We dropped older history, so older messages definitely exist upstream.
		hasPrev: true,
		oldestLoadedSeq: oldestLoadedSeq ?? input.oldestLoadedSeq,
	};
}

/**
 * Decide whether `next` should replace an already cached `current`.
 *
 * Two hooks can hold independent state for the same narrator (a workspace panel
 * preview beside the full conversation), and both write on unmount. Prefer the
 * newer server version, then the wider window, so a preview can never clobber the
 * real conversation view.
 */
function shouldReplace(current: PretextDocumentInput, next: PretextDocumentInput): boolean {
	if (next.messageVersion !== current.messageVersion) {
		return next.messageVersion > current.messageVersion;
	}
	return next.messages.length >= current.messages.length;
}

export function createPretextDocumentCache(
	limits: PretextDocumentCacheLimits = {},
	now: () => number = Date.now,
): PretextDocumentCache {
	const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const ttlMs = limits.ttlMs ?? DEFAULT_TTL_MS;
	const maxMessages = limits.maxMessages ?? DEFAULT_MAX_MESSAGES;

	const entries = new Map<string, CacheEntry>();

	const evictOldest = () => {
		const oldestKey = entries.keys().next().value;
		if (oldestKey === undefined) return;
		entries.delete(oldestKey);
	};

	return {
		peek(narratorId) {
			if (!narratorId) return null;
			const entry = entries.get(narratorId);
			if (!entry) return null;
			if (now() - entry.storedAt > ttlMs) {
				entries.delete(narratorId);
				return null;
			}
			// LRU touch: a restored narrator is the most recently used one.
			entries.delete(narratorId);
			entries.set(narratorId, entry);
			return entry.input;
		},

		write(snapshot) {
			if (!snapshot.narratorId) return;
			if (!isCacheable(snapshot.input)) {
				// An unusable snapshot must not leave a stale predecessor behind: the
				// narrator may have just been compacted, reset or deleted.
				entries.delete(snapshot.narratorId);
				return;
			}
			const existing = entries.get(snapshot.narratorId);
			const fresh = existing != null && now() - existing.storedAt <= ttlMs;
			if (existing && fresh && !shouldReplace(existing.input, snapshot.input)) return;

			entries.delete(snapshot.narratorId);
			entries.set(snapshot.narratorId, {
				input: truncateInput(snapshot.input, maxMessages),
				storedAt: now(),
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
			for (const entry of entries.values()) messages += entry.input.messages.length;
			return { entries: entries.size, messages };
		},
	};
}

const sharedCache = createPretextDocumentCache();

export const peekCachedPretextDocument: PretextDocumentCache["peek"] = (narratorId) =>
	sharedCache.peek(narratorId);
export const writeCachedPretextDocument: PretextDocumentCache["write"] = (snapshot) =>
	sharedCache.write(snapshot);
export const invalidateCachedPretextDocument: PretextDocumentCache["invalidate"] = (narratorId) =>
	sharedCache.invalidate(narratorId);
/**
 * Clear every cached document (tests, and any future in-page principal switch).
 *
 * Unlike `clearNarratorChunksCache` this is NOT wired into logout, for two
 * reasons: `useLogout` navigates with `window.location.href`, which tears down the
 * whole module graph including this cache, and the vlist isolation guard forbids
 * `useAuth` from statically importing anything under `vlist/`. If logout ever
 * becomes an in-page transition, this needs calling from a dynamic import there.
 */
export const clearPretextDocumentCache: PretextDocumentCache["clear"] = () => sharedCache.clear();
export const pretextDocumentCacheStats: PretextDocumentCache["stats"] = () => sharedCache.stats();

// Dev only: a hot replacement of this module installs a fresh `sharedCache`, so any
// consumer still holding the old module's bound writer would keep filling a map
// nobody reads. Dropping the outgoing contents keeps the two from disagreeing; the
// cost is one refetch, which is exactly what a cache miss already does.
if (import.meta.hot) {
	import.meta.hot.dispose(() => sharedCache.clear());
}
