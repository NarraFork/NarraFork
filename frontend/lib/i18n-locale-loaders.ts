/**
 * Locale resource loaders — the one Vite-only expression in the i18n stack.
 *
 * `import.meta.glob` is a Vite compile-time macro: it does not exist in Bun, Node
 * or `tsgo`. Keeping it inside `i18n.ts` made that whole module unloadable outside
 * Vite, and since `lib/query-client.ts` imports `i18n` at the top level for its
 * error toasts, the unresolvable edge propagated into everything that touches the
 * query client — including pure geometry code in the narrator list.
 *
 * Isolating the macro here means only THIS module is Vite-specific. Outside Vite
 * it degrades to an empty registry, which is correct for tests and type checking:
 * nothing renders translated strings there, and `loadLocaleResource` already
 * rejects on a missing loader.
 *
 * Same pattern as `shiki-language-aliases.ts`: build-time-only data stays behind a
 * single, clearly-marked boundary instead of poisoning the module graph.
 */

declare global {
	interface ImportMeta {
		glob<T>(pattern: string): Record<string, () => Promise<T>>;
	}
}

export type LocaleResourceModule = { default: Record<string, unknown> };
export type LocaleResourceLoaders = Record<string, () => Promise<LocaleResourceModule>>;

/**
 * `../locales/<lang>/<namespace>.json` → dynamic import. Empty outside Vite.
 *
 * Vite statically analyses the glob pattern, so it must stay a literal argument
 * to `import.meta.glob` — do not refactor it into a variable.
 *
 * ⚠️ Do NOT guard this with `typeof import.meta.glob === "function"`. Vite only
 * rewrites the glob CALL; a bare `import.meta.glob` property READ is left in the
 * output verbatim, and no runtime defines that property. The guard therefore
 * evaluates to "undefined" IN THE BROWSER, silently yielding an empty registry —
 * every namespace then rejects with "Missing i18n resource" and the app white-
 * screens through the i18n Suspense boundary. Outside Vite the macro is a plain
 * unresolved identifier, so the degradation has to be a runtime THROW that this
 * try/catch converts into the intended empty registry.
 *
 * Scope of the try/catch: it only ever fires OUTSIDE Vite (Bun tests, tsgo, plain
 * Node). In a Vite build the call is replaced at compile time by a literal import
 * map, so there is nothing left to throw and this catch is dead code in the browser
 * bundle — it is NOT a runtime safety net there. Browser-side correctness comes from
 * the compile-time expansion instead: if the pattern ever stopped matching, the map
 * would be empty and `loadLocaleResource` would reject loudly with "Missing i18n
 * resource" rather than degrade quietly.
 */
function resolveLocaleLoaders(): LocaleResourceLoaders {
	try {
		return import.meta.glob<LocaleResourceModule>("../locales/*/*.json");
	} catch {
		// Bun / Node / tsgo: no glob macro. Nothing renders translated strings
		// there, and `loadLocaleResource` already rejects on a missing loader.
		return {};
	}
}

export const localeLoaders: LocaleResourceLoaders = resolveLocaleLoaders();
