/**
 * Shared highlight HTML cache — separated from HighlightedCode.tsx so that
 * callers who only need `clearHighlightCache()` (e.g. the narrator route
 * cleanup effect) don't pull in the heavy `shiki` dependency.
 */

type CacheEntry = {
	html: string;
	size: number;
};

const htmlCache = new Map<string, CacheEntry>();
let htmlCacheBytes = 0;

const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 1 * 1024 * 1024;
export const MAX_CACHEABLE_CODE_CHARS = 20_000;
// A dedicated file panel can spend more than a chat preview, without removing
// the rendering budget or retaining large documents in the shared HTML cache.
export const MAX_FILE_HIGHLIGHT_CODE_CHARS = 200_000;
export const FILE_HIGHLIGHT_OPTIONS = {
	tokenizeMaxLineLength: 10_000,
	tokenizeTimeLimit: 10,
} as const;

function hashCodeForCache(code: string): string {
	let hash1 = 0xdeadbeef;
	let hash2 = 0x41c6ce57;
	for (let i = 0; i < code.length; i++) {
		const ch = code.charCodeAt(i);
		hash1 = Math.imul(hash1 ^ ch, 2654435761);
		hash2 = Math.imul(hash2 ^ ch, 1597334677);
	}
	hash1 =
		Math.imul(hash1 ^ (hash1 >>> 16), 2246822507) ^ Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);
	hash2 =
		Math.imul(hash2 ^ (hash2 >>> 16), 2246822507) ^ Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);
	return `${(hash2 >>> 0).toString(36)}${(hash1 >>> 0).toString(36)}`;
}

export function cacheKey(theme: string, lang: string, code: string) {
	return `${theme}\0${lang}\0${code.length}\0${hashCodeForCache(code)}`;
}

export function peekCachedHtml(key: string): string | null {
	return htmlCache.get(key)?.html ?? null;
}

export function getCachedHtml(key: string): string | null {
	const entry = htmlCache.get(key);
	if (!entry) return null;
	htmlCache.delete(key);
	htmlCache.set(key, entry);
	return entry.html;
}

function evictOldestCachedHtml() {
	const oldestKey = htmlCache.keys().next().value;
	if (!oldestKey) return;
	const oldest = htmlCache.get(oldestKey);
	if (!oldest) return;
	htmlCacheBytes -= oldest.size;
	htmlCache.delete(oldestKey);
}

export function setCachedHtml(key: string, html: string) {
	const existing = htmlCache.get(key);
	if (existing) {
		htmlCacheBytes -= existing.size;
		htmlCache.delete(key);
	}
	const entry = { html, size: (key.length + html.length) * 2 };
	htmlCache.set(key, entry);
	htmlCacheBytes += entry.size;
	while (htmlCache.size > MAX_CACHE_ENTRIES || htmlCacheBytes > MAX_CACHE_BYTES) {
		evictOldestCachedHtml();
	}
}

/** Clear the entire highlight cache. Call when navigating away from narrator pages. */
export function clearHighlightCache() {
	htmlCache.clear();
	htmlCacheBytes = 0;
}
