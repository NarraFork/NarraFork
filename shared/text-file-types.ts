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

/** Max raw narrator request and combined newly uploaded attachment bytes (128 MiB). */
export const MAX_NARRATOR_ATTACHMENT_BYTES = 128 * 1024 * 1024;

/** Max text files retained on one message. */
export const MAX_EDIT_TEXT_FILES_PER_MESSAGE = 10;

/**
 * Max images on one message.
 *
 * Deliberately NOT the text-file count: a message may legitimately carry many
 * screenshots, and 10 was low enough that users hit it while pasting a normal
 * batch. The real guard on attachment volume is MAX_NARRATOR_ATTACHMENT_BYTES —
 * this bound only keeps the count finite, because every image is validated and
 * written to disk in a synchronous loop, so an unbounded array is a resource
 * exhaustion path rather than a generous limit.
 *
 * 100 matches the highest documented upstream ceiling (Anthropic Messages API).
 * Other providers publish no number, and none of them are checked here: a
 * request that exceeds what the upstream accepts still fails at the upstream,
 * not at this bound.
 *
 * Measured before raising it from 10, since the loop is synchronous per file:
 * 100 × 1.28 MB (the largest batch the byte cap admits at this count) costs
 * ~48 ms of main thread in total, ~2 ms for the worst single file. It does not
 * scale with file size — only `MAX_IMAGE_HEADER_SIZE` (256 KiB) of each image is
 * ever parsed, and 6 × 20 MB is faster than the 100-file batch. So the count is
 * bounded to keep the array finite, not because 100 is near a cliff.
 */
export const MAX_EDIT_IMAGES_PER_MESSAGE = 100;

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
