import { afterAll, describe, expect, mock, test } from "bun:test";

/**
 * The real i18n namespace, kept as the module-mock restore target.
 *
 * This used to require rewriting `lib/i18n.ts` into a temporary file to strip its
 * Vite-only `import.meta.glob`. That macro now lives behind
 * `lib/i18n-locale-loaders.ts`, which degrades to an empty registry outside Vite,
 * so the module imports directly.
 */
const realI18nModule = { ...(await import("../../lib/i18n")) };
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
const { shouldRenderFileModificationsDrawer } = await import(
	"./NarratorPanel" + "?file-modifications-lazy-test"
);

afterAll(() => {
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
