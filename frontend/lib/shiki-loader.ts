/**
 * Shared lazy-loaded shiki module.
 *
 * The dynamic import may fail on older browsers (e.g. Safari < 17) because
 * oniguruma-to-es uses the RegExp `v` flag at module init time.  All
 * consumers should handle the `null` case gracefully.
 */

import type { BundledLanguage } from "shiki";

// The subset of shiki we actually use, resolved once on first import.
export interface ShikiModule {
	bundledLanguages: Record<string, unknown>;
	codeToHtml: (code: string, options: { lang: BundledLanguage; theme: string }) => Promise<string>;
	codeToTokens: typeof import("shiki").codeToTokens;
}

let shikiPromise: Promise<ShikiModule | null> | null = null;
let shikiCache: ShikiModule | null = null;

/**
 * Load shiki lazily.  The returned promise is cached — subsequent calls
 * return the same instance.  Resolves to `null` when the import fails.
 */
export function loadShiki(): Promise<ShikiModule | null> {
	if (!shikiPromise) {
		shikiPromise = import("shiki")
			.then((m) => {
				const mod: ShikiModule = {
					bundledLanguages: m.bundledLanguages,
					codeToHtml: m.codeToHtml,
					codeToTokens: m.codeToTokens,
				};
				shikiCache = mod;
				return mod;
			})
			.catch(() => null);
	}
	return shikiPromise;
}

/**
 * Synchronous access to the cached shiki module.
 * Returns `null` until the first successful `loadShiki()` resolves.
 */
export function getCachedShiki(): ShikiModule | null {
	return shikiCache;
}
