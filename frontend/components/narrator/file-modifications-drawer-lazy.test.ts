import { afterAll, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledLanguagesAlias, bundledLanguagesInfo } from "shiki";
import { createShikiLanguageAliasMap } from "../../build/shiki-language-aliases";

const realLanguageAliases = createShikiLanguageAliasMap(
	bundledLanguagesInfo,
	bundledLanguagesAlias,
);
const shikiLanguageAliasesModule = () => ({ default: realLanguageAliases });
mock.module("virtual:shiki-language-aliases", shikiLanguageAliasesModule);

/**
 * Bun cannot evaluate the production i18n module's Vite-only import.meta.glob.
 * Transform only that build-time expression in a temporary test module, then
 * keep the resulting real production namespace as the module-mock restore target.
 */
async function loadRealI18nModule(): Promise<Record<string, unknown>> {
	const sourcePath = resolve(import.meta.dir, "../../lib/i18n.ts");
	const source = readFileSync(sourcePath, "utf8");
	const localesPath = resolve(import.meta.dir, "../../locales");
	const localeLoaders = readdirSync(localesPath)
		.flatMap((language) =>
			readdirSync(join(localesPath, language))
				.filter((fileName) => fileName.endsWith(".json"))
				.map((fileName) => {
					const resourcePath = join(localesPath, language, fileName);
					const resource = readFileSync(resourcePath, "utf8").trim();
					const key = `../locales/${language}/${fileName}`;
					return `${JSON.stringify(key)}: () => Promise.resolve({ default: ${resource} })`;
				}),
		)
		.join(",");
	const sharedLocalesPath = pathToFileURL(
		resolve(import.meta.dir, "../../../shared/i18n-locales.ts"),
	);
	const transformed = source
		.replace(
			/import \{([\s\S]*?)\} from "@shared\/i18n-locales";/,
			`import {$1} from ${JSON.stringify(sharedLocalesPath.href)};`,
		)
		.replace(
			/const localeLoaders = import\.meta\.glob<[^;]+;/,
			`const localeLoaders = {${localeLoaders}};`,
		);
	const temporaryPath = join(
		import.meta.dir,
		`.i18n-runtime-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
	);
	await Bun.write(temporaryPath, transformed);
	try {
		return (await import(`${pathToFileURL(temporaryPath).href}?real`)) as Record<string, unknown>;
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

const realI18nModule = await loadRealI18nModule();
const mockedI18n = {
	language: "en",
	resolvedLanguage: "en",
	t: (key: string) => key,
	changeLanguage: async () => mockedI18n,
};
const testI18nModule = () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["common", "narrator"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["common"],
	getInitialNamespaces: () => ["common"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => mockedI18n,
	initI18n: async () => mockedI18n,
	default: mockedI18n,
});
mock.module("../../lib/i18n", testI18nModule);
mock.module("@frontend/lib/i18n", testI18nModule);
const { shouldRenderFileModificationsDrawer } = await import("./NarratorPanel");

afterAll(() => {
	mock.module("virtual:shiki-language-aliases", shikiLanguageAliasesModule);
	mock.module("../../lib/i18n", () => realI18nModule);
	mock.module("@frontend/lib/i18n", () => realI18nModule);
	mock.restore();
});

describe("FileModificationsDrawer lazy gate", () => {
	test("does not mount the lazy drawer, and therefore cannot start its import, while initially closed", () => {
		expect(shouldRenderFileModificationsDrawer(false, false)).toBe(false);
	});

	test("mounts on first open and stays mounted after closing", () => {
		expect(shouldRenderFileModificationsDrawer(true, false)).toBe(true);
		expect(shouldRenderFileModificationsDrawer(false, true)).toBe(true);
	});
});
