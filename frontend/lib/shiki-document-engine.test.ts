import { beforeAll, describe, expect, test } from "bun:test";
import type { RegexEngine } from "shiki";
import { createHighlighterCore } from "shiki/core";
import { writeStreamText } from "../../scripts/smoke-write-stream-data";
import { createShikiDocumentEngine, createShikiOnigurumaEngine } from "./shiki-loader";

let original: RegexEngine;
let optimized: RegexEngine;
beforeAll(async () => {
	original = await createShikiOnigurumaEngine();
	optimized = await createShikiDocumentEngine();
});

describe("equivalent Oniguruma current-position fast path", () => {
	for (const size of [100_000, 1024 * 1024]) {
		test(`smoke object/Chinese/emoji single line ${size} chars matches complete unmodified Oniguruma tokens`, async () => {
			const languages = [import("@shikijs/langs/typescript")];
			const themes = [import("@shikijs/themes/github-dark-default")];
			const baseline = await createHighlighterCore({ engine: original, langs: languages, themes });
			const fast = await createHighlighterCore({ engine: optimized, langs: languages, themes });
			const text = writeStreamText({ chars: size, singleLine: true });
			const options = {
				lang: "typescript",
				theme: "github-dark-default",
				tokenizeMaxLineLength: 0,
				tokenizeTimeLimit: 0,
			};
			// Warm the grammar/strict probes. Time the actual full pressure line,
			// not cold imports; a C-level G-probe regression took ~58s at 100k.
			fast.codeToTokens(text.slice(0, 2048), options);
			const started = performance.now();
			const result = fast.codeToTokens(text, options).tokens;
			const elapsed = performance.now() - started;
			const expected = baseline.codeToTokens(text, options).tokens;
			expect(result).toEqual(expected);
			expect(result[0].map((token) => token.content).join("")).toBe(text);
			expect(new Set(result[0].map((token) => token.color)).size).toBeGreaterThanOrEqual(3);
			expect(elapsed).toBeLessThan(size === 100_000 ? 8_000 : 40_000);
		}, 90_000);
	}

	test("preserves ordered match/captures at every UTF16 start, anchors, lookbehind, flags, G and K", () => {
		const ruleSets = [
			["(foo)|(bar)", "[a-z]+", "(?<=中)(😀)", "\\s+", "(?=z)"],
			["\\G(a)", "a(b)", "(?<=a)b", "b", "$"],
			["a\\Kb", "a", "b", "(?i:FOO)", "."],
			["(?m)^foo$", "[\\w]+", "(?s:.)"],
			["(?x)foo # comment to EOF", "foo", "."], // Wrapper compilation fails: untouched earlier rule must win.
		];
		const strings = ["foo bar", "abfoo中😀 z", "foo\r\nbar\n", "\ud800foo\udfff", "z", "", "FOO"];
		for (const patterns of ruleSets) {
			const baseline = original.createScanner(patterns),
				fast = optimized.createScanner(patterns);
			for (const text of strings)
				for (let start = 0; start <= text.length; start++) {
					const result = baseline.findNextMatchSync(text, start, 0);
					expect({
						patterns,
						text,
						start,
						result: fast.findNextMatchSync(text, start, 0),
					}).toEqual({ patterns, text, start, result });
				}
			baseline.dispose?.();
			fast.dispose?.();
		}
	});
	test("same JS/TS grammar and themes match unmodified Oniguruma full tokens on adversarial corpora", async () => {
		const languages = [import("@shikijs/langs/javascript"), import("@shikijs/langs/typescript")];
		const themes = [import("@shikijs/themes/github-dark"), import("@shikijs/themes/github-light")];
		const baseline = await createHighlighterCore({ engine: original, langs: languages, themes });
		const fast = await createHighlighterCore({ engine: optimized, langs: languages, themes });
		const corpus = [
			`const x = '${"x".repeat(500)}';`,
			`const x = /\\w+/g; // c\r\n/*中😀*/\nconst t = \`a\${x}b\`;`,
			"function f<T extends string>(a:T):T {return a;}\r\ninterface I { x?: 'a' | \"b\"; }",
			"const x = '\ud800😀\udfff';\nconst a = {nested: {x: 1}};\n",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Verbatim source-code fixture.
			'const text = `中\r\n😀 ${"x\\""}`;',
		];
		for (const lang of ["javascript", "typescript"])
			for (const theme of ["github-dark", "github-light"]) {
				for (const text of corpus) {
					const options = { lang, theme, tokenizeMaxLineLength: 0, tokenizeTimeLimit: 0 };
					expect(fast.codeToTokens(text, options).tokens).toEqual(
						baseline.codeToTokens(text, options).tokens,
					);
				}
			}
	});
	test("100k/1MiB pathological JS/TS strings finish complete without silent time or length limits", async () => {
		const highlighter = await createHighlighterCore({
			engine: optimized,
			langs: [import("@shikijs/langs/javascript"), import("@shikijs/langs/typescript")],
			themes: [import("@shikijs/themes/github-dark")],
		});
		for (const lang of ["javascript", "typescript"])
			for (const size of [100_000, 1024 * 1024]) {
				const text = `const long = "${"x".repeat(size)}";`;
				const tokens = highlighter.codeToTokens(text, {
					lang,
					theme: "github-dark",
					tokenizeMaxLineLength: 0,
					tokenizeTimeLimit: 0,
				}).tokens[0];
				expect(tokens.map((token) => token.content).join("")).toBe(text);
				expect(tokens[tokens.length - 1].offset + tokens[tokens.length - 1].content.length).toBe(
					text.length,
				);
			}
	}, 30_000);
});
