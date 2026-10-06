/**
 * shiki-lang.test.ts — file path → Shiki language id resolution.
 *
 * These tests pin the behaviour change from moving validation off the loaded
 * highlighter and onto the build-time alias map. The old implementation read
 * `getCachedShiki()?.bundledLanguages`, which is null until the first successful
 * highlight, so before Shiki loaded EVERY candidate was returned unvalidated —
 * the same path could resolve differently before and after load. Resolution is
 * now stable because the alias map is always present.
 */

import { describe, expect, test } from "bun:test";
import { getShikiLang } from "./shiki-lang";
import { SHIKI_LANGUAGE_ALIASES } from "./shiki-language-aliases";

describe("getShikiLang", () => {
	test("resolves common source extensions", () => {
		expect(getShikiLang("src/index.ts")).toBe("typescript");
		expect(getShikiLang("src/app.tsx")).toBe("tsx");
		expect(getShikiLang("script.js")).toBe("javascript");
		expect(getShikiLang("data.json")).toBe("json");
	});

	test("applies the overrides for extensions lang-map gets wrong", () => {
		expect(getShikiLang("nginx.conf")).toBe("shellscript");
		expect(getShikiLang("bundle.mjs")).toBe("javascript");
		expect(getShikiLang("bundle.cjs")).toBe("javascript");
		expect(getShikiLang("types.mts")).toBe("typescript");
		expect(getShikiLang("types.cts")).toBe("typescript");
		expect(getShikiLang("doc.mdx")).toBe("mdx");
	});

	test("falls back to the extension itself when it names a language", () => {
		// lang-map has no entry for these, but Shiki does.
		expect(getShikiLang("Cargo.toml")).toBe("toml");
		expect(getShikiLang("config.yaml")).toBe("yaml");
	});

	test("returns text for unknown or missing extensions", () => {
		expect(getShikiLang("notes.qqqzzz")).toBe("text");
		expect(getShikiLang("Makefile.unknownext")).toBe("text");
		expect(getShikiLang("README")).toBe("text");
		expect(getShikiLang("")).toBe("text");
	});

	test("ignores case and leading path segments", () => {
		expect(getShikiLang("deep/nested/dir/File.TS")).toBe("typescript");
		expect(getShikiLang("/abs/path/style.CSS")).toBe("css");
	});

	test("only ever returns an id the highlighter can actually load", () => {
		// The critical invariant: a returned id must be resolvable to a grammar,
		// otherwise the highlighter silently falls back and the code renders plain.
		const paths = [
			"a.ts",
			"a.tsx",
			"a.js",
			"a.json",
			"a.toml",
			"a.yaml",
			"a.py",
			"a.rs",
			"a.go",
			"a.sh",
			"nginx.conf",
			"a.mjs",
			"a.mdx",
			"a.unknownext",
		];
		for (const path of paths) {
			const lang = getShikiLang(path);
			if (lang === "text") continue;
			expect(Object.hasOwn(SHIKI_LANGUAGE_ALIASES, lang)).toBe(true);
		}
	});

	test("resolution does not depend on highlighter load state", () => {
		// Previously this module consulted the lazily-populated highlighter cache,
		// so the answer changed once Shiki loaded. Repeated calls must be identical.
		const first = getShikiLang("src/index.ts");
		const second = getShikiLang("src/index.ts");
		expect(second).toBe(first);
	});
});
