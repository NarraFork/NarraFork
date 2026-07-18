/**
 * Fine-grained Shiki loader.
 *
 * Do not import the `shiki` package entry here. Its bundled entry exposes every
 * grammar as a dynamic dependency, which makes Vite/Rolldown preload hundreds
 * of language chunks when a narrator route is entered. The core entry keeps the
 * highlighter small; grammar and theme modules are loaded only when requested.
 */

import languageAliases from "virtual:shiki-language-aliases";
import type { BundledLanguage, ThemedToken } from "shiki";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createShikiLanguageEnsurer } from "./shiki-language-loader";

export interface ShikiModule {
	/** Compatibility surface used by language-resolution helpers. */
	bundledLanguages: Record<string, unknown>;
	codeToHtml: (code: string, options: { lang: BundledLanguage; theme: string }) => Promise<string>;
	codeToTokens: (
		code: string,
		options: { lang: BundledLanguage; theme: string },
	) => Promise<{ tokens: ThemedToken[][] }>;
}

// Grammars/themes are emitted by the Vite config as standalone runtime assets,
// deliberately outside Rollup's module graph. Only the selected URL is imported
// when a code block actually asks for that language or theme.
const SHIKI_RUNTIME_BASE = `${import.meta.env.BASE_URL}shiki`;

function getLanguageUrl(language: string) {
	return `${SHIKI_RUNTIME_BASE}/langs/${language}.mjs`;
}

function getThemeUrl(theme: string) {
	return `${SHIKI_RUNTIME_BASE}/themes/${theme}.mjs`;
}

// Preserve the existing `lang in bundledLanguages` compatibility surface while
// exposing only ids and aliases from the tiny build-generated manifest.
const bundledLanguages = Object.assign(
	Object.create(null) as Record<string, unknown>,
	languageAliases,
);

export type ShikiThemeImporter = (theme: string) => Promise<unknown>;
export type ShikiThemeRegistrar = (theme: unknown) => Promise<void> | void;

function unwrapThemeDefault(module: unknown): unknown {
	if (module && typeof module === "object" && "default" in module) {
		return (module as { default: unknown }).default;
	}
	return module;
}

/**
 * Create a canonical theme loader. Concurrent callers share one in-flight
 * request; failed imports/registrations are evicted so a later request can
 * recover after a transient network or chunk-loading failure. Successful
 * promises remain cached for the lifetime of the highlighter.
 */
export function createShikiThemeEnsurer(
	importTheme: ShikiThemeImporter,
	registerTheme: ShikiThemeRegistrar,
): (theme: string) => Promise<boolean> {
	const promises = new Map<string, Promise<boolean>>();

	return (theme: string) => {
		const normalized = theme.trim();
		if (!normalized) return Promise.resolve(false);

		const existing = promises.get(normalized);
		if (existing) return existing;

		const promise = Promise.resolve()
			.then(() => importTheme(normalized))
			.then(unwrapThemeDefault)
			.then(async (registration) => {
				await registerTheme(registration);
				return true;
			})
			.catch(() => false);
		promises.set(normalized, promise);
		void promise.then((result) => {
			if (!result && promises.get(normalized) === promise) {
				promises.delete(normalized);
			}
		});
		return promise;
	};
}

let corePromise: Promise<Awaited<ReturnType<typeof createHighlighterCore>> | null> | null = null;
let shikiPromise: Promise<ShikiModule | null> | null = null;
let shikiCache: ShikiModule | null = null;
type ThemeEnsurer = (theme: string) => Promise<boolean>;
const themeEnsurers = new WeakMap<object, ThemeEnsurer>();

async function getCore() {
	if (!corePromise) {
		corePromise = createHighlighterCore({
			engine: createJavaScriptRegexEngine(),
			langs: [],
			themes: [],
		}).catch(() => null);
	}
	return corePromise;
}

function ensureTheme(
	core: Awaited<ReturnType<typeof createHighlighterCore>>,
	theme: string,
): Promise<boolean> {
	const key = core as object;
	let ensure = themeEnsurers.get(key);
	if (!ensure) {
		ensure = createShikiThemeEnsurer(
			(normalized) => import(/* @vite-ignore */ getThemeUrl(normalized)),
			(registration) => core.loadTheme(registration as Parameters<typeof core.loadTheme>[0]),
		);
		themeEnsurers.set(key, ensure);
	}
	return ensure(theme);
}

/**
 * Load the small Shiki core. The first actual code highlight then loads only
 * its requested language and theme modules.
 */
export function loadShiki(): Promise<ShikiModule | null> {
	if (!shikiPromise) {
		shikiPromise = getCore().then((core) => {
			if (!core) return null;

			const ensureLanguage = createShikiLanguageEnsurer(
				languageAliases,
				(canonicalId) => import(/* @vite-ignore */ getLanguageUrl(canonicalId)),
				(language) => core.loadLanguage(language as Parameters<typeof core.loadLanguage>[0]),
			);
			const module: ShikiModule = {
				bundledLanguages,
				codeToHtml: async (code, options) => {
					const [canonicalLanguage, themeReady] = await Promise.all([
						ensureLanguage(options.lang),
						ensureTheme(core, options.theme),
					]);
					if (!canonicalLanguage || !themeReady) {
						throw new Error("Shiki language or theme unavailable");
					}
					return core.codeToHtml(code, {
						lang: canonicalLanguage as BundledLanguage,
						theme: options.theme,
					});
				},
				codeToTokens: async (code, options) => {
					const [canonicalLanguage, themeReady] = await Promise.all([
						ensureLanguage(options.lang),
						ensureTheme(core, options.theme),
					]);
					if (!canonicalLanguage || !themeReady) {
						throw new Error("Shiki language or theme unavailable");
					}
					return core.codeToTokens(code, {
						lang: canonicalLanguage as BundledLanguage,
						theme: options.theme,
					});
				},
			};

			shikiCache = module;
			return module;
		});
	}
	return shikiPromise;
}

/**
 * Synchronous access to the cached Shiki wrapper.
 * Returns null until the core has been initialized by loadShiki().
 */
export function getCachedShiki(): ShikiModule | null {
	return shikiCache;
}
