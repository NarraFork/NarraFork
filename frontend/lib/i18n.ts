import {
	DEFAULT_LOCALE,
	getLocaleDirection,
	getLocaleFallbackChain,
	type Locale,
	normalizeLocale,
	SUPPORTED_LOCALES,
} from "@shared/i18n-locales";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { stripBase } from "./base-path";
import { localeLoaders } from "./i18n-locale-loaders";

export const supportedLanguages = SUPPORTED_LOCALES;
export type SupportedLanguage = Locale;

export const namespaces = [
	"common",
	"errors",
	"chapters",
	"containers",
	"dashboard",
	"explorations",
	"git",
	"graph",
	"narrator",
	"nav",
	"learning",
	"projects",
	"search",
	"narrators",
	"settings",
	"terminal",
	"routines",
	"knowledge",
	"scheduledTasks",
	"plugins",
	"chat",
] as const;
export type Namespace = (typeof namespaces)[number];

const namespaceSet = new Set<string>(namespaces);
const resourceCache = new Map<string, Promise<Record<string, unknown>>>();
let initPromise: Promise<typeof i18n> | undefined;

export function normalizeLanguage(lng: string | null | undefined): SupportedLanguage {
	return normalizeLocale(lng);
}

/**
 * Reduce a raw `location.pathname` to the route path these tables are keyed by.
 *
 * The mount prefix is stripped first: callers pass `window.location.pathname`, which
 * behind a reverse-proxy subpath or code-server's `/proxy/<port>/` carries that
 * prefix, and none of the keys below have it. Without stripping, `/proxy/7778/login`
 * matches no entry, falls through to the authenticated-shell defaults, and the login
 * page renders raw translation keys — a visible defect with no error attached to it.
 */
function normalizePathname(pathname: string): string {
	const withoutQuery = pathname.split(/[?#]/, 1)[0] || "/";
	const path = `/${stripBase(withoutQuery)}`;
	if (path === "/") return path;
	return path.replace(/\/+$/, "") || "/";
}

/**
 * Namespaces the authenticated app shell itself renders with.
 *
 * `AuthenticatedLayout` translates from `common` and `nav`, uses `settings` for
 * the setup-wizard return button, and always mounts `ProviderBaseUrlFixHost`,
 * which also translates from `settings`.
 *
 * The shell renders ABOVE the route match, so the root route provides it with no
 * Suspense boundary of its own (TanStack only wraps non-root matches). If a
 * namespace the shell needs is not loaded yet, `useTranslation` suspends the
 * whole app shell instead of a single route, and any error thrown in that window
 * escapes our `RootErrorBoundary` and surfaces TanStack's default
 * "Something went wrong!" screen. Every authenticated path must therefore
 * preload these before the shell can render.
 */
const APP_SHELL_NAMESPACES = ["common", "errors", "nav", "settings"] as const satisfies Namespace[];

/**
 * Public paths that render without the authenticated app shell.
 *
 * `errors` is in every entry, not just the authenticated shell: a failed request can happen on
 * any surface, including the login form and the consent page. A path missing it does not throw
 * — `describeApiError` silently falls back to the server's English prose, which is exactly the
 * defect this whole change exists to remove, and it would be invisible in review.
 */
const PUBLIC_PATH_NAMESPACES = new Map<string, Namespace[]>([
	["/login", ["common", "errors"]],
	["/oauth/authorize", ["common", "errors"]],
	["/licenses", ["common", "errors", "nav"]],
]);

export function getNamespacesForPath(pathname: string): Namespace[] {
	const path = normalizePathname(pathname);

	const publicNamespaces = PUBLIC_PATH_NAMESPACES.get(path);
	if (publicNamespaces) return publicNamespaces;

	// Authenticated routes always render inside the app shell, so its namespaces
	// are part of the contract rather than something each path repeats.
	return uniqueNamespaces([...APP_SHELL_NAMESPACES, ...getRouteNamespaces(path)]);
}

/** Namespaces a route needs BEYOND the app shell's own. */
function getRouteNamespaces(path: string): Namespace[] {
	if (path === "/changelog") return ["common", "nav", "settings"];
	if (path === "/") return ["common", "nav", "dashboard"];
	if (path === "/projects") return ["common", "nav", "projects"];
	if (path.startsWith("/projects/")) {
		return [
			"common",
			"nav",
			"projects",
			"chapters",
			"graph",
			"narrator",
			"settings",
			"terminal",
			"git",
			"chat",
		];
	}
	if (path === "/messages") return ["common", "nav", "chat"];
	if (path === "/narrators") return ["common", "nav", "narrators", "narrator", "chat"];
	if (path === "/narrators/archived") return ["common", "nav", "narrators"];
	if (path.startsWith("/narrators/workspace/")) {
		return ["common", "nav", "narrators", "narrator", "terminal", "git", "chat"];
	}
	if (path.startsWith("/narrators/")) {
		return [
			"common",
			"nav",
			"narrators",
			"narrator",
			"chapters",
			"settings",
			"terminal",
			"git",
			"chat",
		];
	}
	if (path === "/settings/providers" || path === "/settings/models" || path === "/settings/agent") {
		return ["common", "nav", "settings", "narrator"];
	}
	if (path === "/settings/terminals") {
		return ["common", "nav", "settings", "terminal"];
	}
	if (path === "/settings/users") {
		return ["common", "nav", "settings", "knowledge"];
	}
	if (path === "/settings/plugins" || path.startsWith("/settings/plugins/")) {
		return ["common", "nav", "settings", "plugins"];
	}
	if (path === "/settings" || path.startsWith("/settings/")) {
		return ["common", "nav", "settings"];
	}
	if (path === "/routines" || path.startsWith("/routines/")) {
		return ["common", "nav", "routines", "settings"];
	}

	if (path === "/scheduled-tasks" || path.startsWith("/scheduled-tasks/")) {
		return ["common", "nav", "scheduledTasks"];
	}
	if (path === "/learn") return ["common", "nav", "learning"];
	if (path === "/knowledge" || path.startsWith("/knowledge/")) {
		return ["common", "nav", "knowledge"];
	}
	if (path === "/search") return ["common", "nav", "search"];

	return ["common", "nav"];
}

export function getInitialNamespaces(pathname: string): Namespace[] {
	return getNamespacesForPath(pathname);
}

function normalizeNamespace(namespace: string): Namespace {
	if (namespaceSet.has(namespace)) return namespace as Namespace;
	throw new Error(`Unsupported i18n namespace: ${namespace}`);
}

/**
 * Memoize i18next's per-lookup language resolution.
 *
 * `t()` calls `languageUtils.toResolveHierarchy(lng, fallback)` on EVERY
 * invocation, which calls `formatLanguageCode(code)` for each code in the
 * hierarchy. `formatLanguageCode` runs `Intl.getCanonicalLocales` (~2.8µs each)
 * for any code containing a hyphen (e.g. "zh-CN"). With hundreds of `t()` calls
 * per mounted message during fast scroll, this becomes a measurable hot path
 * (~480ms of `formatLanguageCode` + ~210ms of `toResolveHierarchy` in a 42s
 * fast-scroll production trace).
 *
 * Both functions are pure w.r.t. their inputs (the runtime options they read —
 * lowerCaseLng/cleanCode/load/fallbackLng/supportedLngs — are fixed after init),
 * so we wrap them with a Map cache. The cache returns a frozen array snapshot
 * for toResolveHierarchy to prevent callers from mutating the shared result.
 */
function installLanguageResolutionCache(): void {
	const lu = (i18n as { services?: { languageUtils?: Record<string, unknown> } }).services
		?.languageUtils as
		| {
				formatLanguageCode?: (code: string) => string;
				toResolveHierarchy?: (code: string, fallbackCode?: unknown) => string[];
				__nfCached?: boolean;
		  }
		| undefined;
	if (!lu || lu.__nfCached) return;

	if (typeof lu.formatLanguageCode === "function") {
		const orig = lu.formatLanguageCode.bind(lu);
		const cache = new Map<string, string>();
		lu.formatLanguageCode = (code: string) => {
			const cached = cache.get(code);
			if (cached !== undefined) return cached;
			const result = orig(code);
			cache.set(code, result);
			return result;
		};
	}

	if (typeof lu.toResolveHierarchy === "function") {
		const orig = lu.toResolveHierarchy.bind(lu);
		const cache = new Map<string, string[]>();
		lu.toResolveHierarchy = (code: string, fallbackCode?: unknown) => {
			// Only cache the common case (no per-call fallback override), which is
			// what `t()` uses. Anything passing an explicit fallbackCode bypasses.
			if (fallbackCode !== undefined) return orig(code, fallbackCode);
			const key = String(code);
			const cached = cache.get(key);
			if (cached !== undefined) return cached.slice();
			const result = orig(code);
			cache.set(key, result.slice());
			return result;
		};
	}

	lu.__nfCached = true;
}

function uniqueNamespaces(ns: readonly Namespace[]): Namespace[] {
	return Array.from(new Set(ns));
}

function getCurrentRouteNamespaces(): Namespace[] {
	if (typeof window === "undefined") return getInitialNamespaces("/");
	return getNamespacesForPath(window.location.pathname);
}

function setDocumentLanguage(lng: string | null | undefined) {
	if (typeof document === "undefined") return;
	const locale = normalizeLanguage(lng);
	document.documentElement.lang = locale;
	document.documentElement.dir = getLocaleDirection(locale);
}

function loadLocaleResource(
	language: string | null | undefined,
	namespace: string,
): Promise<Record<string, unknown>> {
	const normalizedLng = normalizeLanguage(language);
	const normalizedNamespace = normalizeNamespace(namespace);
	const cacheKey = `${normalizedLng}:${normalizedNamespace}`;
	const cached = resourceCache.get(cacheKey);
	if (cached) return cached;

	const resourcePath = `../locales/${normalizedLng}/${normalizedNamespace}.json`;
	const loader = localeLoaders[resourcePath];
	if (!loader) {
		return Promise.reject(new Error(`Missing i18n resource: ${resourcePath}`));
	}

	const promise = loader()
		.then((module) => module.default)
		.catch((error) => {
			resourceCache.delete(cacheKey);
			throw error;
		});
	resourceCache.set(cacheKey, promise);
	return promise;
}

const dynamicResourcesBackend = {
	type: "backend" as const,
	read(
		language: string,
		namespace: string,
		callback: (error: Error | null, resources?: false | Record<string, unknown>) => void,
	) {
		void loadLocaleResource(language, namespace)
			.then((resources) => callback(null, resources))
			.catch((error) => {
				callback(error instanceof Error ? error : new Error(String(error)), false);
			});
	},
};

async function loadNamespaceBundle(
	language: SupportedLanguage,
	namespace: Namespace,
): Promise<void> {
	if (i18n.hasResourceBundle(language, namespace)) return;
	const resources = await loadLocaleResource(language, namespace);
	if (!i18n.hasResourceBundle(language, namespace)) {
		i18n.addResourceBundle(language, namespace, resources, true, true);
	}
}

export async function ensureI18nNamespaces(ns: readonly Namespace[], lng?: string): Promise<void> {
	const targetNamespaces = uniqueNamespaces(ns);
	if (targetNamespaces.length === 0) return;

	const targetLanguage = normalizeLanguage(lng ?? i18n.resolvedLanguage ?? i18n.language);
	const languages = getLocaleFallbackChain(targetLanguage);

	await Promise.all(
		languages.flatMap((language) =>
			targetNamespaces.map((namespace) => loadNamespaceBundle(language, namespace)),
		),
	);
}

export async function changeAppLanguage(
	lng: string,
	extraNamespaces: readonly Namespace[] = [],
): Promise<void> {
	const normalizedLng = normalizeLanguage(lng);
	const requiredNamespaces = uniqueNamespaces([...getCurrentRouteNamespaces(), ...extraNamespaces]);

	await ensureI18nNamespaces(requiredNamespaces, normalizedLng);
	await i18n.changeLanguage(normalizedLng);
	setDocumentLanguage(normalizedLng);
}

i18n.on("languageChanged", (lng) => {
	setDocumentLanguage(lng);
});

export function initI18n(initialNamespaces: readonly Namespace[]): Promise<typeof i18n> {
	const initialNs = uniqueNamespaces(initialNamespaces.length > 0 ? initialNamespaces : ["common"]);

	if (i18n.isInitialized) {
		return ensureI18nNamespaces(initialNs).then(() => i18n);
	}
	if (initPromise) return initPromise;

	initPromise = i18n
		.use(dynamicResourcesBackend)
		.use(LanguageDetector)
		.use(initReactI18next)
		.init({
			fallbackLng: DEFAULT_LOCALE,
			supportedLngs: [...supportedLanguages],
			load: "currentOnly",
			defaultNS: "common",
			ns: initialNs,
			interpolation: {
				escapeValue: false,
			},
			detection: {
				order: ["localStorage", "navigator"],
				lookupLocalStorage: "narrafork_lang",
				caches: ["localStorage"],
				convertDetectedLanguage: normalizeLanguage,
			},
			react: {
				useSuspense: true,
			},
		})
		.then(async () => {
			installLanguageResolutionCache();
			await ensureI18nNamespaces(initialNs);
			setDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
			return i18n;
		});

	return initPromise;
}

export default i18n;
