/**
 * shiki-language-aliases.test.ts — the build-time language alias map.
 *
 * The point of this module is that it resolves in EVERY runtime, not just Vite.
 * A regression here (e.g. reintroducing a virtual-module import) would once again
 * make every transitive importer of the highlighter unloadable under `bun test`.
 */

import { describe, expect, test } from "bun:test";
import { SHIKI_LANGUAGE_ALIASES } from "./shiki-language-aliases";
import { resolveShikiLanguage } from "./shiki-language-loader";

describe("SHIKI_LANGUAGE_ALIASES", () => {
	test("is populated (not the empty stub some tests used to inject)", () => {
		expect(Object.keys(SHIKI_LANGUAGE_ALIASES).length).toBeGreaterThan(100);
	});

	test("maps canonical ids to themselves", () => {
		expect(SHIKI_LANGUAGE_ALIASES.javascript).toBe("javascript");
		expect(SHIKI_LANGUAGE_ALIASES.typescript).toBe("typescript");
		expect(SHIKI_LANGUAGE_ALIASES.python).toBe("python");
	});

	test("maps aliases to their canonical grammar id", () => {
		expect(SHIKI_LANGUAGE_ALIASES.js).toBe("javascript");
		expect(SHIKI_LANGUAGE_ALIASES.ts).toBe("typescript");
		expect(SHIKI_LANGUAGE_ALIASES.py).toBe("python");
		expect(SHIKI_LANGUAGE_ALIASES.adoc).toBe("asciidoc");
	});

	test("is keyed by lowercased ids", () => {
		for (const key of Object.keys(SHIKI_LANGUAGE_ALIASES)) {
			expect(key).toBe(key.toLowerCase());
		}
	});

	test("every value is itself a canonical key (no dangling grammar refs)", () => {
		for (const canonical of Object.values(SHIKI_LANGUAGE_ALIASES)) {
			expect(Object.hasOwn(SHIKI_LANGUAGE_ALIASES, canonical.toLowerCase())).toBe(true);
		}
	});

	test("works with the loader's resolver", () => {
		expect(resolveShikiLanguage("TS", SHIKI_LANGUAGE_ALIASES)).toBe("typescript");
		expect(resolveShikiLanguage("text", SHIKI_LANGUAGE_ALIASES)).toBeNull();
		expect(resolveShikiLanguage("definitely-not-a-language", SHIKI_LANGUAGE_ALIASES)).toBeNull();
	});
});

/**
 * The Vite plugin replaces this module at build time so `shiki/langs` (and its
 * per-grammar dynamic imports) never reach the browser graph. A miss is SILENT —
 * the real module still resolves, the build still succeeds, and the only symptom
 * is hundreds of grammar chunks preloaded on the narrator route. So the id
 * comparison itself needs a guard.
 */
describe("the build-time substitution plugin's id matching", () => {
	test("compares separator-normalized paths, so Windows ids match too", async () => {
		const source = await Bun.file(new URL("../vite.config.ts", import.meta.url).pathname).text();
		// The target path is normalized once at module scope...
		expect(source).toContain("const SHIKI_LANGUAGE_ALIASES_MODULE = normalizeModulePath(");
		// ...and the incoming id is normalized before the comparison.
		expect(source).toContain("const path = normalizeModulePath(");
		// A raw `resolve(...)` comparison is the regression being prevented.
		expect(source).not.toMatch(
			/const SHIKI_LANGUAGE_ALIASES_MODULE = resolve\(__dirname, "lib\/shiki-language-aliases\.ts"\)/,
		);
	});
});
