/**
 * Fine-grained Shiki loader.
 *
 * Do not import the `shiki` package entry here. Its bundled entry exposes every
 * grammar as a dynamic dependency, which makes Vite/Rolldown preload hundreds
 * of language chunks when a narrator route is entered. The core entry keeps the
 * highlighter small; grammar and theme modules are loaded only when requested.
 */

import type { BundledLanguage, GrammarState, RegexEngine, ThemedToken } from "shiki";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { assetUrl } from "./base-path";
import { SHIKI_LANGUAGE_ALIASES as languageAliases } from "./shiki-language-aliases";
import { createShikiLanguageEnsurer } from "./shiki-language-loader";

export function createShikiOnigurumaEngine() {
	return createOnigurumaEngine(import("shiki/wasm"));
}

/**
 * Equivalent current-position fast path for Oniguruma's ordered pattern scanner.
 * The aggregate scanner otherwise searches every candidate across the rest of a
 * long line before selecting an identifier already at startPosition (quadratic
 * for JS/TS declaration rules). A match at startPosition cannot be beaten by a
 * later candidate; probing in original order also preserves ties/capture indices.
 * The optional probe compiler must use strict Oniguruma-to-ES conversion. Only
 * wholly native groups are probed with sticky exec at the EXACT original start;
 * unsupported/emulated patterns, anchors, reset-start and custom find options
 * retain the untouched Oniguruma aggregate scanner/cache. No text is sliced.
 */
export function withCurrentPositionFastPath(
	engine: RegexEngine,
	compileNative?: (pattern: string) => RegExp,
): RegexEngine {
	if (!compileNative) return engine;
	const cache = new Map<string, RegExp>();
	const hasNonAscii = (text: string) => {
		for (let index = 0; index < text.length; index++)
			if (text.charCodeAt(index) > 0x7f) return true;
		return false;
	};
	return {
		...engine,
		createScanner(patterns) {
			const fallback = engine.createScanner(patterns);
			// No dropped rules, emulation, recursive approximation or altered anchors.
			if (
				patterns.some(
					(pattern) =>
						typeof pattern !== "string" || /\(\?[a-z-]*s/.test(pattern) || /\\[KGg]/.test(pattern),
				)
			)
				return fallback;
			let sticky: RegExp[];
			try {
				sticky = (patterns as string[]).map((pattern) => {
					let regex = cache.get(pattern);
					if (!regex) {
						const compiled = compileNative(pattern);
						if (compiled.constructor !== RegExp || !compiled.hasIndices)
							throw new Error("Native strict regex required");
						regex = new RegExp(compiled.source, `${compiled.flags.replace(/[gy]/g, "")}y`);
						cache.set(pattern, regex);
					}
					return regex;
				});
			} catch {
				return fallback;
			}
			return {
				dispose() {
					fallback.dispose?.();
				},
				findNextMatchSync(...args) {
					if (args[2]) return fallback.findNextMatchSync(...args);
					const input = args[0];
					const text = typeof input === "string" ? input : input.content;
					const position = args[1];
					// UTF16 starts inside a surrogate pair are native-engine territory.
					if (
						position > 0 &&
						/[\ud800-\udbff]/.test(text[position - 1]) &&
						/[\udc00-\udfff]/.test(text[position] ?? "")
					)
						return fallback.findNextMatchSync(...args);
					for (let index = 0; index < sticky.length; index++) {
						sticky[index].lastIndex = position;
						const match = sticky[index].exec(text);
						if (!match || match.index !== position || !match.indices) continue;
						const nativeInput = input as typeof input & {
							convertUtf8OffsetToUtf16?: (offset: number) => number;
						};
						const missing =
							typeof input === "string"
								? hasNonAscii(text)
									? text.length
									: 0xffffffff
								: (nativeInput.convertUtf8OffsetToUtf16?.(0xffffffff) ?? 0xffffffff);
						return {
							index,
							captureIndices: match.indices.map((range) =>
								range
									? { start: range[0], end: range[1], length: range[1] - range[0] }
									: { start: missing, end: missing, length: 0 },
							),
						};
					}
					// All other searches use the original aggregate and its native cache.
					return fallback.findNextMatchSync(...args);
				},
			};
		},
	};
}

export async function createShikiDocumentEngine(): Promise<RegexEngine> {
	const [engine, { defaultJavaScriptRegexConstructor }] = await Promise.all([
		createShikiOnigurumaEngine(),
		import("shiki/engine/javascript"),
	]);
	return withCurrentPositionFastPath(engine, (pattern) =>
		defaultJavaScriptRegexConstructor(pattern, {
			accuracy: "strict",
			lazyCompileLength: Infinity,
		}),
	);
}

export interface ShikiHighlightOptions {
	lang: BundledLanguage;
	theme: string;
	grammarState?: GrammarState;
	tokenizeMaxLineLength?: number;
	tokenizeTimeLimit?: number;
}

export interface ShikiModule {
	/** Compatibility surface used by language-resolution helpers. */
	bundledLanguages: Record<string, unknown>;
	codeToHtml: (code: string, options: ShikiHighlightOptions) => Promise<string>;
	codeToTokens: (
		code: string,
		options: ShikiHighlightOptions,
	) => Promise<{ tokens: ThemedToken[][]; grammarState?: GrammarState }>;
}

// Grammars/themes are emitted by the Vite config as standalone runtime assets,
// deliberately outside Rollup's module graph. Only the selected URL is imported
// when a code block actually asks for that language or theme.
//
// Resolved through `assetUrl` rather than `import.meta.env.BASE_URL`: with
// `base: "./"` that constant is the literal `"./"`, which a dynamic `import()`
// resolves against the IMPORTING MODULE's URL — i.e. `/assets/`, where no grammars
// exist. `assetUrl` resolves against the app's mount root instead. The failure is
// per-language and silent (a code block renders unhighlighted), so it would survive
// review easily.
function getLanguageUrl(language: string) {
	return assetUrl(`shiki/langs/${language}.mjs`);
}

function getThemeUrl(theme: string) {
	return assetUrl(`shiki/themes/${theme}.mjs`);
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

/**
 * Cache a single-flight async result, but only when it SUCCEEDED.
 *
 * The eviction is the whole point. The promises this guards are module-level, so
 * a cached failure outlives every component that asked for it and the only way
 * to clear it is a full page load. That produced a genuinely confusing bug: one
 * transient failure (a cold PWA start where the inlined Oniguruma WASM chunk
 * times out, a flaky mobile network) permanently disabled syntax highlighting
 * for the whole session, and because the failure path renders a plain `<Code>`
 * block, the app looked like it had simply decided the file needed no colours.
 * Restarting the PWA "fixed" it — the signature of cached module state.
 *
 * Failures are therefore evicted so a later call retries, matching what
 * `createShikiLanguageEnsurer` and `createShikiThemeEnsurer` already do for
 * grammars and themes. A successful promise stays cached forever, so this costs
 * nothing in the normal case and cannot re-create the core per highlight.
 *
 * Extracted (and exported) because "retry after failure" is invisible in the
 * happy path: nothing observable changes until something fails, so a regression
 * here would only surface as a user restarting the app to get colours back.
 */
export function cacheSuccessfulResult<T>(
	read: () => Promise<T | null> | null,
	write: (promise: Promise<T | null> | null) => void,
	start: () => Promise<T | null>,
): Promise<T | null> {
	const existing = read();
	if (existing) return existing;

	const attempt = start();
	write(attempt);
	void attempt.then(
		(value) => {
			// Compare identity before clearing: a concurrent caller may already have
			// installed a newer attempt, and dropping that one would undo its result.
			if (value == null && read() === attempt) write(null);
		},
		() => {
			if (read() === attempt) write(null);
		},
	);
	return attempt;
}

function getCore() {
	return cacheSuccessfulResult(
		() => corePromise,
		(promise) => {
			corePromise = promise;
		},
		() =>
			createHighlighterCore({
				engine: createShikiOnigurumaEngine(),
				langs: [],
				themes: [],
			}).catch(() => null),
	);
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
	// Same success-only caching as `getCore`, and needed for the same reason: this
	// layer would otherwise cache the core's null just as durably, making the
	// retry inside `getCore` unreachable.
	return cacheSuccessfulResult(
		() => shikiPromise,
		(promise) => {
			shikiPromise = promise;
		},
		() =>
			getCore().then((core) => {
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
							...options,
							lang: canonicalLanguage as BundledLanguage,
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
							...options,
							lang: canonicalLanguage as BundledLanguage,
						});
					},
				};

				shikiCache = module;
				return module;
			}),
	);
}

/**
 * Synchronous access to the cached Shiki wrapper.
 * Returns null until the core has been initialized by loadShiki().
 */
export function getCachedShiki(): ShikiModule | null {
	return shikiCache;
}

/** Independent worker instance. Never consults document/assetUrl or the code-block cache. */
export async function createWorkerShiki(
	absoluteAppBase: string,
	importAsset: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url),
): Promise<ShikiModule> {
	const base = new URL(absoluteAppBase);
	if (!/^https?:$/.test(base.protocol) || !base.pathname.endsWith("/")) {
		throw new Error("Shiki Worker requires an absolute, trailing-slash app mount URL");
	}
	const core = await createHighlighterCore({
		engine: await createShikiDocumentEngine(),
		langs: [],
		themes: [],
	});
	const ensureLanguage = createShikiLanguageEnsurer(
		languageAliases,
		(id) => importAsset(new URL(`shiki/langs/${id}.mjs`, base).href),
		(language) => core.loadLanguage(language as Parameters<typeof core.loadLanguage>[0]),
	);
	const loadTheme = createShikiThemeEnsurer(
		(theme) => {
			if (!/^[\w-]+$/.test(theme)) throw new Error("Invalid Shiki theme");
			return importAsset(new URL(`shiki/themes/${theme}.mjs`, base).href);
		},
		(theme) => core.loadTheme(theme as Parameters<typeof core.loadTheme>[0]),
	);
	async function optionsFor(options: ShikiHighlightOptions) {
		const plain = ["text", "plaintext", "txt"].includes(options.lang);
		const [language, ready] = await Promise.all([
			plain ? Promise.resolve("text") : ensureLanguage(options.lang),
			loadTheme(options.theme),
		]);
		if (!language || !ready)
			throw new Error("Shiki Worker language or theme unavailable; retry available");
		return {
			...options,
			lang: language as BundledLanguage,
			// Only worker tokenization disables TextMate's silent 500ms early stop.
			tokenizeMaxLineLength: 0,
			tokenizeTimeLimit: 0,
		};
	}
	return {
		bundledLanguages,
		codeToHtml: async (code, options) => core.codeToHtml(code, await optionsFor(options)),
		codeToTokens: async (code, options) => core.codeToTokens(code, await optionsFor(options)),
	};
}
