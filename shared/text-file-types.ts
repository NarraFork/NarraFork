/**
 * Shared text/code file extension allowlist.
 * Used by both frontend (client-side validation) and backend (upload validation).
 *
 * All entries are lowercase. Callers must lowercase the extension before checking.
 */
export const TEXT_FILE_EXTENSIONS = new Set([
	"txt",
	"md",
	"markdown",
	"json",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"xml",
	"csv",
	"tsv",
	"log",
	"ini",
	"cfg",
	"conf",
	"env",
	"properties",
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"mts",
	"cts",
	"py",
	"pyi",
	"go",
	"rs",
	"java",
	"kt",
	"kts",
	"scala",
	"clj",
	"cljs",
	"c",
	"cpp",
	"cc",
	"cxx",
	"h",
	"hpp",
	"hxx",
	"cs",
	"fs",
	"fsx",
	"rb",
	"php",
	"swift",
	"m",
	"mm",
	"r",
	"jl",
	"lua",
	"pl",
	"pm",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"cmd",
	"css",
	"scss",
	"sass",
	"less",
	"html",
	"htm",
	"vue",
	"svelte",
	"astro",
	"sql",
	"graphql",
	"gql",
	"proto",
	"dockerfile",
	"containerfile",
	"makefile",
	"cmake",
	"gitignore",
	"gitattributes",
	"editorconfig",
	"prettierrc",
	"eslintrc",
	"tf",
	"hcl",
	"nix",
	"dhall",
	"tex",
	"bib",
	"rst",
	"adoc",
	"org",
	"patch",
	"diff",
]);

/** Max text file upload size in bytes (100 MB). */
export const MAX_TEXT_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Check whether a filename is an allowed text/code file.
 * Accepts any file — the extension allowlist is kept only for display hints.
 */
export function isTextFile(_filename: string): boolean {
	return true;
}

/** Format a byte size into a human-readable string (B / KB / MB). */
export function formatFileSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}
