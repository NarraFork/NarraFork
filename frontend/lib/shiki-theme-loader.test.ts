import { afterAll, describe, expect, mock, test } from "bun:test";
import { bundledLanguagesAlias, bundledLanguagesInfo } from "shiki";
import { createShikiLanguageAliasMap } from "../build/shiki-language-aliases";

const realLanguageAliases = createShikiLanguageAliasMap(
	bundledLanguagesInfo,
	bundledLanguagesAlias,
);
const shikiLanguageAliasesModule = () => ({ default: realLanguageAliases });

// Bun cannot resolve this Vite virtual module directly. Use the same real alias
// map as the Vite plugin, then re-point the process-wide module mock in afterAll.
mock.module("virtual:shiki-language-aliases", shikiLanguageAliasesModule);
const { createShikiThemeEnsurer } = await import("./shiki-loader");

afterAll(() => {
	mock.module("virtual:shiki-language-aliases", shikiLanguageAliasesModule);
	mock.restore();
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
