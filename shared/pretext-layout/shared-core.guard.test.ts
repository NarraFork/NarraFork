/**
 * shared-core.guard.test.ts — Bundle/purity boundary for the DOM-FREE layout core.
 *
 * `shared/pretext-layout/` is the height model itself: it is imported by the
 * frontend vlist AND must stay runnable under plain Bun (no window, no React).
 * A single `@frontend/*` or `react` import here would tie the pure arithmetic to
 * a UI runtime, and a DOM measurement would break CONTRACT.md §0 rule 2 at its
 * source.
 *
 * The listing is ENUMERATED, not hand-written. A hand-written array is only ever
 * correct on the day it is written: this guard once listed 22 files while the
 * directory held 26, so every module added by the change that mattered
 * (`prepared-markdown-cache.ts`, `streaming-live-blocks.ts`,
 * `reasoning-live-tail.ts`, …) landed OUTSIDE the check. Reading the directory
 * makes a new module covered by default — the same approach
 * the shared-core purity guards already take.
 *
 * Division of labour with `vlist/zero-dom-measure.guard.test.ts`: that guard
 * scans the vlist-side pure path, where the seven migrated modules are now only
 * two-line re-export shells. The real implementations live here, so this file is
 * the one that must enumerate rather than list.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORE_DIR = import.meta.dir;

function coreSourceFiles(): string[] {
	return readdirSync(CORE_DIR)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.sort();
}

/**
 * Source with comment-only lines dropped.
 *
 * The browser-global check below would otherwise fire on ordinary English: these
 * modules discuss "the rest of the document." and "a document without math" in
 * their JSDoc constantly. Stripping the lines that cannot contain executable code
 * keeps the assertion about real property access.
 */
function codeLines(source: string): string {
	return source
		.split("\n")
		.filter((line) => {
			const trimmed = line.trimStart();
			return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
		})
		.join("\n");
}

describe("shared pretext core boundary", () => {
	it("covers every non-test module in the directory", () => {
		// The listing drives the checks below, so an empty/failed read must not pass
		// silently. The named anchors are the load-bearing modules: if one is renamed
		// away the coverage claim in this file's header needs revisiting.
		const files = coreSourceFiles();
		expect(files.length).toBeGreaterThan(0);
		expect(files).toContain("parse-markdown.ts");
		expect(files).toContain("prepared-block.ts");
		expect(files).toContain("prepared-markdown-cache.ts");
	});

	it("does not import React/Mantine/frontend modules or call DOM measurement APIs", () => {
		for (const file of coreSourceFiles()) {
			const source = readFileSync(join(CORE_DIR, file), "utf8");
			expect(source, `${file} must not import react/mantine/@frontend`).not.toMatch(
				/from\s+["'](?:react|react-dom|@mantine|@frontend)/,
			);
			// Dynamic imports are followed by the bundler just like static ones.
			expect(source, `${file} must not dynamically import a UI runtime`).not.toMatch(
				/import\(\s*["'](?:react|react-dom|@mantine|@frontend)/,
			);
			expect(source, `${file} must not measure the DOM`).not.toMatch(
				/\b(?:getBoundingClientRect|offsetHeight|offsetWidth|createElement)\s*\(/,
			);
		}
	});

	/**
	 * The height model is arithmetic over injected resolvers, so it must not reach
	 * for browser globals directly — `document.fonts` in particular. Font-generation
	 * invalidation is real (see prepared-markdown-cache's FONT REVISION note) but it
	 * has to arrive through a setter the frontend calls, exactly like the KaTeX
	 * runtime and the glyph resolvers do.
	 */
	it("does not touch browser globals", () => {
		for (const file of coreSourceFiles()) {
			const code = codeLines(readFileSync(join(CORE_DIR, file), "utf8"));
			expect(code, `${file} must not read document.*`).not.toMatch(/\bdocument\s*\./);
			expect(code, `${file} must not read window\\.`).not.toMatch(/\bwindow\s*\./);
		}
	});
});
