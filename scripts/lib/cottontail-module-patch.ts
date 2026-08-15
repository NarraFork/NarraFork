/**
 * Pure helpers for the Cottontail module-loader compatibility patch.
 *
 * Why this exists
 * ---------------
 * Cottontail 0.2.3 (Electrobun's default main-process runtime) fails to load any module
 * that uses a static `import` statement AND whose final line is a `//` comment AND which
 * has no trailing newline. Loading such a file throws:
 *
 *     BuildMessage: Unexpected token ')'
 *
 * Root cause: a static import routes the file through Cottontail's
 * `compileAsyncModuleWrapper()`, which builds `(async function(args) {\n<source>\n})`.
 * When `<source>` ends in a line comment with no newline of its own, the comment swallows
 * the generated closing `})` and the wrapper no longer parses. Dynamic `import()` and
 * files without static imports take a different path and are unaffected.
 *
 * This is the ordinary shape of esbuild output (`//# sourceMappingURL=...` emitted without
 * a trailing newline), so it affects published packages rather than our own source. In this
 * dependency tree it hits ~1.6k files across drizzle-orm, @mantine/*, @tanstack/*,
 * @modelcontextprotocol/sdk and puppeteer-core.
 *
 * The fix is deliberately the most conservative one available: append a single newline.
 * That is a semantic no-op for JavaScript, is idempotent, and becomes inert once upstream
 * fixes the loader (already-newline-terminated files are skipped).
 */

/** File extensions worth inspecting. Only JS is run through the module wrapper. */
export const PATCHABLE_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;

/** Directory names never worth descending into while scanning for affected files. */
export const SKIPPED_DIRECTORIES = new Set([".git", ".cache", ".bin"]);

export interface PatchSummary {
	/** Files inspected. */
	scanned: number;
	/** Files rewritten because they would break Cottontail's loader. */
	patched: number;
}

/**
 * Decide whether a source file trips the Cottontail loader bug.
 *
 * All three conditions must hold, mirroring the minimal reproduction:
 *   1. no trailing newline — otherwise the generated `})` survives
 *   2. last line is a `//` comment — otherwise there is nothing to swallow it
 *   3. contains a static `import` — otherwise the async module wrapper is not used
 */
export function needsTrailingNewline(source: string): boolean {
	// An empty file has nothing to swallow the wrapper's closing brace.
	if (source.length === 0) return false;
	// Condition 1: a file already ending in a newline is safe.
	if (source.endsWith("\n")) return false;

	// Condition 2: the final line must be a line comment. A block comment (`*/`) cannot
	// swallow what follows it, so it is safe and must not be rewritten.
	const lastLine = source.slice(source.lastIndexOf("\n") + 1).trimStart();
	if (!lastLine.startsWith("//")) return false;

	// Condition 3: the file must use a static import. Checked last because it is the most
	// expensive test. `import(` (dynamic) and `import.meta` do not use the wrapper, so they
	// are excluded; `import x from`, `import {`, `import *` and bare `import "..."` do.
	return hasStaticImport(source);
}

/**
 * Detect a static `import` declaration.
 *
 * Static imports are only valid at the start of a line (ignoring indentation), which lets us
 * avoid matching the substring `import` inside identifiers or strings. Dynamic `import(...)`
 * and `import.meta` are deliberately excluded: they do not route through the async wrapper.
 */
export function hasStaticImport(source: string): boolean {
	// `m` anchors ^ per line; the trailing class rejects `import(` and `import.meta`.
	return /^[ \t]*import[ \t]*["'{*]/m.test(source) || /^[ \t]*import[ \t]+[A-Za-z_$]/m.test(source);
}

/** Append the newline that keeps Cottontail's module wrapper parseable. */
export function applyTrailingNewline(source: string): string {
	return needsTrailingNewline(source) ? `${source}\n` : source;
}

/** Whether a path should be inspected, based on its extension. */
export function isPatchableFile(filePath: string): boolean {
	return PATCHABLE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/** Whether a directory should be descended into while scanning. */
export function shouldScanDirectory(name: string): boolean {
	return !SKIPPED_DIRECTORIES.has(name);
}
