import map from "lang-map";
import { SHIKI_LANGUAGE_ALIASES } from "./shiki-language-aliases";

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
 * Validated against the build-time alias map rather than the loaded highlighter.
 * The old implementation read `getCachedShiki()?.bundledLanguages`, which is null
 * until the first successful highlight, so before Shiki loaded every candidate was
 * returned unvalidated and the same file could resolve differently before and
 * after load. The alias map is always available, so resolution is now stable — and
 * this module no longer drags the highlighter into its importers' module graphs.
 */
export function getShikiLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

	const override = OVERRIDES[ext];
	if (override && isKnownLanguage(override)) return override;

	const langs = map.languages(ext);
	const type = langs?.[0]?.toLowerCase();
	if (type && isKnownLanguage(type)) return type;

	// Try the extension itself as a language name (e.g. "json", "toml")
	if (ext && isKnownLanguage(ext)) return ext;

	return "text";
}

function isKnownLanguage(language: string): boolean {
	return Object.hasOwn(SHIKI_LANGUAGE_ALIASES, language);
}
