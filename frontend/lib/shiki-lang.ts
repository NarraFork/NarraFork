import map from "lang-map";
import { getCachedShiki } from "./shiki-loader";

/** Extra overrides where lang-map returns a name shiki doesn't recognise */
const OVERRIDES: Record<string, string> = {
	conf: "shellscript",
	mjs: "javascript",
	cjs: "javascript",
	mts: "typescript",
	cts: "typescript",
	mdx: "mdx",
};

/**
 * Resolve a shiki-compatible language id from a file path or extension.
 * Returns "text" when no match is found.
 *
 * Uses the synchronously cached bundledLanguages if available (after the
 * first successful dynamic import of shiki). Falls back to a best-effort
 * heuristic when shiki hasn't loaded yet.
 */
export function getShikiLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const cache = getCachedShiki()?.bundledLanguages ?? null;

	if (OVERRIDES[ext]) {
		const o = OVERRIDES[ext];
		if (!cache || o in cache) return o;
	}

	const langs = map.languages(ext);
	const type = langs?.[0]?.toLowerCase();

	if (type && (!cache || type in cache)) return type;

	// Try the extension itself as a language name (e.g. "json", "toml")
	if (!cache || ext in cache) return ext || "text";

	return "text";
}
