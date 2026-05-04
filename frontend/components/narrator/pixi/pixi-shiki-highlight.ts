import { getCachedShiki, loadShiki } from "@frontend/lib/shiki-loader";
import type { BundledLanguage, ThemedToken } from "shiki";

export interface PixiHighlightToken {
	content: string;
	color?: number;
}

const tokenCache = new Map<string, PixiHighlightToken[][]>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
const MAX_CACHE = 300;

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

function emit(): void {
	for (const listener of listeners) listener();
}

function setCache(key: string, tokens: PixiHighlightToken[][]): void {
	if (tokenCache.size >= MAX_CACHE) {
		const first = tokenCache.keys().next().value;
		if (first) tokenCache.delete(first);
	}
	tokenCache.set(key, tokens);
}

export function subscribePixiShikiHighlights(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function clearPixiShikiHighlightCache(): void {
	tokenCache.clear();
	loading.clear();
}

export function getPixiHighlightedTokens(
	code: string,
	lang: string | undefined,
	theme: string,
): PixiHighlightToken[][] | null {
	if (!code || !lang || lang === "text") return null;
	const key = `${theme}\u0000${lang}\u0000${code}`;
	const cached = tokenCache.get(key);
	if (cached) return cached;
	if (loading.has(key)) return null;

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
