/**
 * shiki-token-cache.ts — Subscribable Shiki token cache for the DOM render path.
 *
 * The pretext virtual list paints code line-by-line at geometry the measure layer
 * already committed to, so it cannot use Shiki's `codeToHtml` (which brings its own
 * markup and layout). It needs raw TOKENS instead: pretext decides where lines
 * break, Shiki only says what colour each run of characters is.
 *
 * The structure here was modelled on the deleted Pixi renderer's
 * `pixi-shiki-highlight`, with two differences:
 *   - colours are CSS strings (`#rrggbb`) rather than Pixi's numeric form
 *   - a monotonic `version` counter is exposed so React's useSyncExternalStore has
 *     a reference-stable snapshot (the LRU's delete+set re-insertion reorders the
 *     Map without changing `version`, so it never triggers a spurious re-render)
 *
 * Deliberately REACT-FREE. It lives in `frontend/lib/` (next to shiki-loader) for
 * two reasons: the narrator route needs to clear it on unmount but must not
 * statically import anything under components/narrator/vlist/ (isolation guard),
 * and keeping it hook-free matches shiki-loader's character. The React binding is
 * a separate module inside vlist/.
 *
 * `get()` triggers the async highlight as a side effect when it misses. That is
 * safe to call during render because the in-flight set makes the trigger
 * idempotent: React strict-mode double invocation, several components asking for
 * the same code, or repeated renders all collapse into ONE Shiki request.
 *
 * The cache is built through `createShikiTokenCache(loader)` so tests can inject a
 * deterministic loader instead of process-wide module mocking — the same
 * injection seam `createShikiThemeEnsurer` uses in shiki-loader.ts.
 */

import type { BundledLanguage, ThemedToken } from "shiki";
import { getCachedShiki, loadShiki } from "./shiki-loader";

/** One Shiki token in DOM form: text plus an optional CSS colour. */
export interface ShikiToken {
	content: string;
	color?: string;
}

/**
 * Resolves tokens for one (code, lang, theme) triple. Returning null means "not
 * highlightable" (unknown grammar, highlighter unavailable) and is cached as a
 * miss rather than an error.
 */
export type ShikiTokenLoader = (
	code: string,
	lang: string,
	theme: string,
) => Promise<ShikiToken[][] | null>;

export interface ShikiTokenCacheLimits {
	/** Max retained entries (LRU eviction beyond this). */
	maxEntries?: number;
	/** Max estimated retained bytes across all entries. */
	maxBytes?: number;
	/** Bodies longer than this are never highlighted. */
	maxCodeChars?: number;
}

export interface ShikiTokenCache {
	/**
	 * Cached tokens, or null when unavailable (no language, plain text, oversized,
	 * or not highlighted yet). Triggers the async highlight on a miss unless
	 * `cacheOnly`.
	 */
	get(
		code: string,
		lang: string | undefined,
		theme: string,
		cacheOnly?: boolean,
	): ShikiToken[][] | null;
	subscribe(listener: () => void): () => void;
	/**
	 * useSyncExternalStore snapshot. A number, NOT the token array, so identity is
	 * stable across LRU re-insertions and only moves when a highlight lands.
	 */
	getVersion(): number;
	clear(): void;
	/** Introspection for tests and diagnostics. */
	stats(): { entries: number; bytes: number; inFlight: number };
}

/** Matches HighlightedCode / StreamingCode: past this a highlight is not worth it. */
export const MAX_HIGHLIGHT_CODE_CHARS = 20_000;
const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Normalize a Shiki theme colour to a CSS string, dropping anything unusable. */
function normalizeColor(color: string | undefined): string | undefined {
	if (!color) return undefined;
	const trimmed = color.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeThemedTokens(lines: ThemedToken[][]): ShikiToken[][] {
	return lines.map((line) =>
		line.map((token) => {
			const color = normalizeColor(token.color);
			return color === undefined ? { content: token.content } : { content: token.content, color };
		}),
	);
}

/**
 * Rough retained size of one cache entry. Strings count 2 bytes per char plus a
 * flat per-token/per-line object overhead — precise enough to hold a memory
 * ceiling without walking the heap.
 */
function estimateBytes(key: string, tokens: ShikiToken[][]): number {
	let chars = key.length;
	let tokenCount = 0;
	for (const line of tokens) {
		tokenCount += line.length;
		for (const token of line) chars += token.content.length + (token.color?.length ?? 0);
	}
	return chars * 2 + tokenCount * 16 + tokens.length * 16;
}

export function createShikiTokenCache(
	loadTokens: ShikiTokenLoader,
	limits: ShikiTokenCacheLimits = {},
): ShikiTokenCache {
	const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxCodeChars = limits.maxCodeChars ?? MAX_HIGHLIGHT_CODE_CHARS;

	const entries = new Map<string, { tokens: ShikiToken[][]; bytes: number }>();
	const inFlight = new Set<string>();
	const listeners = new Set<() => void>();
	let cacheBytes = 0;
	let version = 0;

	const evictOldest = () => {
		const oldestKey = entries.keys().next().value;
		if (oldestKey === undefined) return;
		const oldest = entries.get(oldestKey);
		if (oldest) cacheBytes = Math.max(0, cacheBytes - oldest.bytes);
		entries.delete(oldestKey);
	};

	const write = (key: string, tokens: ShikiToken[][]) => {
		const bytes = estimateBytes(key, tokens);
		// One entry larger than the whole budget would evict everything else on
		// insert, so it is simply not cached (callers fall back to plain text).
		if (bytes > maxBytes) return;
		const existing = entries.get(key);
		if (existing) {
			cacheBytes = Math.max(0, cacheBytes - existing.bytes);
			entries.delete(key);
		}
		entries.set(key, { tokens, bytes });
		cacheBytes += bytes;
		while (entries.size > maxEntries || cacheBytes > maxBytes) evictOldest();
	};

	/** LRU read: a hit is re-inserted so it becomes most-recently-used. */
	const read = (key: string): ShikiToken[][] | null => {
		const entry = entries.get(key);
		if (!entry) return null;
		entries.delete(key);
		entries.set(key, entry);
		return entry.tokens;
	};

	return {
		get(code, lang, theme, cacheOnly) {
			if (!code || !lang || lang === "text" || code.length > maxCodeChars) return null;
			const key = `${theme}\u0000${lang}\u0000${code}`;
			const cached = read(key);
			if (cached) return cached;
			if (cacheOnly || inFlight.has(key)) return null;

			// Reserve the slot BEFORE starting, and start in this same tick: the
			// reservation is what makes a render-time call idempotent, and starting
			// eagerly means the grammar/WASM fetch is not delayed by a microtask hop.
			inFlight.add(key);
			let request: Promise<ShikiToken[][] | null>;
			try {
				request = loadTokens(code, lang, theme);
			} catch {
				inFlight.delete(key);
				return null;
			}
			request
				.then((tokens) => {
					if (!tokens) return;
					write(key, tokens);
					version++;
					for (const listener of listeners) listener();
				})
				.catch(() => {})
				.finally(() => {
					inFlight.delete(key);
				});
			return null;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getVersion() {
			return version;
		},
		clear() {
			entries.clear();
			cacheBytes = 0;
			inFlight.clear();
		},
		stats() {
			return { entries: entries.size, bytes: cacheBytes, inFlight: inFlight.size };
		},
	};
}

/** The production loader: the shared fine-grained Shiki core. */
const loadShikiTokens: ShikiTokenLoader = async (code, lang, theme) => {
	const cachedShiki = getCachedShiki();
	const shiki = cachedShiki ?? (await loadShiki());
	if (!shiki || !(lang in shiki.bundledLanguages)) return null;
	const result = await shiki.codeToTokens(code, { lang: lang as BundledLanguage, theme });
	return normalizeThemedTokens(result.tokens);
};

const sharedCache = createShikiTokenCache(loadShikiTokens);

export const getShikiTokens: ShikiTokenCache["get"] = (code, lang, theme, cacheOnly) =>
	sharedCache.get(code, lang, theme, cacheOnly);
export const subscribeShikiTokens: ShikiTokenCache["subscribe"] = (listener) =>
	sharedCache.subscribe(listener);
export const getShikiTokensVersion: ShikiTokenCache["getVersion"] = () => sharedCache.getVersion();
/** Clear the token cache. Call when navigating away from narrator pages. */
export const clearShikiTokenCache: ShikiTokenCache["clear"] = () => sharedCache.clear();
