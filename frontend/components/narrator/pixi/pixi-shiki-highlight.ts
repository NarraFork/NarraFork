import { getCachedShiki, loadShiki } from "@frontend/lib/shiki-loader";
import type { BundledLanguage, ThemedToken } from "shiki";

export interface PixiHighlightToken {
	content: string;
	color?: number;
}

interface TokenCacheEntry {
	tokens: PixiHighlightToken[][];
	bytes: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
const MAX_CACHE = 300;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_HIGHLIGHT_CODE_CHARS = 20_000;
let tokenCacheBytes = 0;

function parseTokenColor(color: string | undefined): number | undefined {
	if (!color?.startsWith("#")) return undefined;
	const hex = color.slice(1);
	if (hex.length !== 6) return undefined;
	const parsed = Number.parseInt(hex, 16);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeTokens(lines: ThemedToken[][]): PixiHighlightToken[][] {
	return lines.map((line) =>
		line.map((token) => ({ content: token.content, color: parseTokenColor(token.color) })),
	);
}

function estimateTokensBytes(key: string, tokens: PixiHighlightToken[][]): number {
	let chars = key.length;
	let tokenCount = 0;
	for (const line of tokens) {
		tokenCount += line.length;
		for (const token of line) chars += token.content.length;
	}
	return chars * 2 + tokenCount * 16 + tokens.length * 16;
}

function emit(): void {
	for (const listener of listeners) listener();
}

function evictOldestCacheEntry(): void {
	const oldestKey = tokenCache.keys().next().value;
	if (!oldestKey) return;
	const oldest = tokenCache.get(oldestKey);
	if (oldest) tokenCacheBytes = Math.max(0, tokenCacheBytes - oldest.bytes);
	tokenCache.delete(oldestKey);
}

function setCache(key: string, tokens: PixiHighlightToken[][]): void {
	const bytes = estimateTokensBytes(key, tokens);
	if (bytes > MAX_CACHE_BYTES) return;
	const existing = tokenCache.get(key);
	if (existing) {
		tokenCacheBytes = Math.max(0, tokenCacheBytes - existing.bytes);
		tokenCache.delete(key);
	}
	tokenCache.set(key, { tokens, bytes });
	tokenCacheBytes += bytes;
	while (tokenCache.size > MAX_CACHE || tokenCacheBytes > MAX_CACHE_BYTES) {
		evictOldestCacheEntry();
	}
}

function getCachedTokens(key: string): PixiHighlightToken[][] | null {
	const cached = tokenCache.get(key);
	if (!cached) return null;
	tokenCache.delete(key);
	tokenCache.set(key, cached);
	return cached.tokens;
}

export function subscribePixiShikiHighlights(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function clearPixiShikiHighlightCache(): void {
	tokenCache.clear();
	tokenCacheBytes = 0;
	loading.clear();
}

export function getPixiHighlightedTokens(
	code: string,
	lang: string | undefined,
	theme: string,
	cacheOnly?: boolean,
): PixiHighlightToken[][] | null {
	if (!code || !lang || lang === "text" || code.length > MAX_HIGHLIGHT_CODE_CHARS) return null;
	const key = `${theme}\u0000${lang}\u0000${code}`;
	const cached = getCachedTokens(key);
	if (cached) return cached;
	if (cacheOnly || loading.has(key)) return null;

	const cachedShiki = getCachedShiki();
	const start = cachedShiki ? Promise.resolve(cachedShiki) : loadShiki();
	loading.add(key);
	start
		.then((shiki) => {
			if (!shiki || !(lang in shiki.bundledLanguages)) return;
			return shiki.codeToTokens(code, { lang: lang as BundledLanguage, theme }).then((result) => {
				setCache(key, normalizeTokens(result.tokens));
				emit();
			});
		})
		.catch(() => {})
		.finally(() => loading.delete(key));
	return null;
}
