import map from "lang-map";
import { bundledLanguages } from "shiki";

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
 */
export function getShikiLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

	if (OVERRIDES[ext]) {
		const o = OVERRIDES[ext];
		if (o in bundledLanguages) return o;
	}

	const langs = map.languages(ext);
	const type = langs?.[0]?.toLowerCase();

	if (type && type in bundledLanguages) return type;

	// Try the extension itself as a language name (e.g. "json", "toml")
	if (ext in bundledLanguages) return ext;

	return "text";
}
