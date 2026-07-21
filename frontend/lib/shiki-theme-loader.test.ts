import { afterAll, describe, expect, mock, test } from "bun:test";
import { createHighlighterCore } from "shiki/core";
import { bundledLanguages, bundledLanguagesAlias, bundledLanguagesInfo } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import { createShikiLanguageAliasMap } from "../build/shiki-language-aliases";

const realLanguageAliases = createShikiLanguageAliasMap(
	bundledLanguagesInfo,
	bundledLanguagesAlias,
);
const shikiLanguageAliasesModule = () => ({ default: realLanguageAliases });

function createLegacyRegExpConstructor(nativeRegExp: RegExpConstructor): RegExpConstructor {
	function rejectUnicodeSets(args: unknown[]) {
		const flags = args[1];
		if (typeof flags === "string" && flags.includes("v")) {
			throw new SyntaxError("Invalid flags supplied to RegExp constructor");
		}
	}

	return new Proxy(nativeRegExp, {
		apply(target, thisArg, args) {
			rejectUnicodeSets(args);
			return Reflect.apply(target, thisArg, args) as RegExp;
		},
		construct(target, args, newTarget) {
			rejectUnicodeSets(args);
			return Reflect.construct(target, args, newTarget) as RegExp;
		},
	});
}

async function withLegacyRegExp<T>(run: () => Promise<T>): Promise<T> {
	const nativeRegExp = globalThis.RegExp;
	globalThis.RegExp = createLegacyRegExpConstructor(nativeRegExp);
	try {
		return await run();
	} finally {
		globalThis.RegExp = nativeRegExp;
	}
}

// Bun cannot resolve this Vite virtual module directly. Use the same real alias
// map as the Vite plugin. Import the loader while `v` is rejected so a future
// browser-side JavaScript regex engine dependency fails at the original boundary.
mock.module("virtual:shiki-language-aliases", shikiLanguageAliasesModule);
const { createShikiOnigurumaEngine, createShikiThemeEnsurer } = await withLegacyRegExp(
	() => import("./shiki-loader"),
);

afterAll(() => {
	mock.module("virtual:shiki-language-aliases", shikiLanguageAliasesModule);
	mock.restore();
});

describe("Shiki Oniguruma engine", () => {
	test("highlights the complete JavaScript grammar when RegExp rejects the v flag", async () => {
		await withLegacyRegExp(async () => {
			const [javascriptModule, githubDarkModule] = await Promise.all([
				bundledLanguages.javascript(),
				bundledThemes["github-dark"](),
			]);
			const highlighter = await createHighlighterCore({
				engine: createShikiOnigurumaEngine(),
				langs: javascriptModule.default,
				themes: [githubDarkModule.default],
			});

			try {
				const html = highlighter.codeToHtml('const greeting = "hello";', {
					lang: "javascript",
					theme: "github-dark",
				});
				expect(html).toContain('class="shiki github-dark"');
				expect(html).toContain("greeting");
				expect(html).toContain("color:");
			} finally {
				highlighter.dispose();
			}
		});
	});
});

describe("Shiki theme loader", () => {
	test("uses the real generated language alias adapter instead of an empty permanent stub", () => {
		expect(realLanguageAliases.javascript).toBe("javascript");
		expect(realLanguageAliases.js).toBe("javascript");
	});

	test("evicts a failed theme promise so a later request can retry", async () => {
		let attempts = 0;
		const registered: unknown[] = [];
		const ensureTheme = createShikiThemeEnsurer(
			async () => {
				attempts++;
				if (attempts === 1) throw new Error("temporary network failure");
				return { default: { id: "github-dark" } };
			},
			(theme) => {
				registered.push(theme);
			},
		);

		expect(await ensureTheme("github-dark")).toBe(false);
		expect(await ensureTheme("github-dark")).toBe(true);
		expect(await ensureTheme("github-dark")).toBe(true);
		expect(attempts).toBe(2);
		expect(registered).toEqual([{ id: "github-dark" }]);
	});

	test("shares an in-flight request for aliases of the same normalized theme", async () => {
		let attempts = 0;
		let release: (() => void) | undefined;
		const ensureTheme = createShikiThemeEnsurer(
			() => {
				attempts++;
				return new Promise((resolve) => {
					release = () => resolve({ default: { id: "one-dark-pro" } });
				});
			},
			() => {},
		);

		const first = ensureTheme(" one-dark-pro ");
		const second = ensureTheme("one-dark-pro");
		expect(first).toBe(second);
		await Promise.resolve();
		expect(attempts).toBe(1);
		release?.();
		expect(await first).toBe(true);
	});
});
