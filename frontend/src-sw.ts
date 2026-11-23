/// <reference lib="webworker" />
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import {
	cleanupOutdatedCaches,
	createHandlerBoundToURL,
	precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import { setBaseHref } from "../server/lib/spa-base-href";
import { STARTUP_STATUS_HEADER } from "../shared/startup-status";
import { API_WS_PREFIXES, isApiOrWsRelativePath } from "./lib/app-path-classify";
import { appVersionsMatch } from "./lib/version-match";

declare let self: ServiceWorkerGlobalScope;
const RELOAD_NAVIGATION_TIMEOUT_MS = 8000;

// Try fresh HTML before the cached shell. Register BEFORE precaching.
registerRoute(
	({ request, url }) => request.mode === "navigate" && url.searchParams.has("_nf_reload"),
	async (options) => {
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await Promise.race([
				fetch(new Request(options.request, { cache: "no-store", signal: controller.signal })),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						controller.abort();
						reject(new Error("Navigation timeout"));
					}, RELOAD_NAVIGATION_TIMEOUT_MS);
				}),
			]);
			// The startup page polls itself back; a proxy 502/504 page runs no app code.
			if (response.status < 500 || response.headers.has(STARTUP_STATUS_HEADER)) {
				return response;
			}
			void response.body?.cancel();
		} catch {
			// Keep the installed shell available while the server is unreachable.
		} finally {
			clearTimeout(timeout);
		}
		return serveSpaShell(options);
	},
);

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// API and WebSocket requests are intentionally left to the browser network stack.
// NarraFork is server-backed; Service Worker caching should only cover static
// frontend assets and SPA navigations.
const STATIC_ASSET_DESTINATIONS = new Set(["script", "style", "worker"]);
const STATIC_MEDIA_DESTINATIONS = new Set(["font", "image"]);
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * Brand assets, which must NOT be cached by this worker.
 *
 * These paths are fixed but their meaning is not: index.html points the icon links
 * at either these static defaults or `/api/branding/*` depending on the configured
 * instance colour, and the manifest is generated per-request with the instance
 * name. The `CacheFirst` media route below would otherwise hold an icon for up to
 * 30 days — long enough that changing a brand colour looks like it did nothing.
 *
 * `/api/branding/*` is already excluded by `isApiOrWsPath`; these are the
 * non-API paths that need the same treatment.
 */
const BRAND_ASSET_PATHS = new Set([
	"favicon.svg",
	"apple-touch-icon-180x180.png",
	"pwa-192x192.png",
	"pwa-512x512.png",
	"manifest.webmanifest",
]);

/**
 * The app's mount path, taken from this worker's own registration scope.
 *
 * A Service Worker sees FULL pathnames (`/proxy/7778/api/health`), while every
 * classification below is written against app-relative paths. The scope is the
 * authoritative prefix here — `document` does not exist in a worker, so the
 * `<base href>` route the app uses is unavailable.
 *
 * Getting this wrong is silent in both directions: too broad and API responses get
 * cached (stale data, no error); too narrow and asset caching quietly stops.
 */
const SW_BASE = (() => {
	try {
		const scope = new URL(self.registration.scope);
		return scope.pathname.endsWith("/") ? scope.pathname : `${scope.pathname}/`;
	} catch {
		return "/";
	}
})();

/** Strip the mount prefix; a path outside it is not ours to classify. */
function appRelativePath(pathname: string): string | null {
	if (!pathname.startsWith(SW_BASE)) return null;
	return pathname.slice(SW_BASE.length);
}

/** Quote a literal for use inside a `RegExp`, so a path cannot act as a pattern. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isApiOrWsPath(pathname: string) {
	const relative = appRelativePath(pathname);
	if (relative === null) return false;
	// Shared with the app's own classifier so the two cannot drift — see
	// `lib/app-path-classify.ts` for why that matters and why only the
	// prefix-stripped half is shared.
	return isApiOrWsRelativePath(relative);
}

function isBrandAssetPath(pathname: string) {
	const relative = appRelativePath(pathname);
	return relative !== null && BRAND_ASSET_PATHS.has(relative);
}

// Same-origin JS/CSS/workers: keep fast while refreshing in the background.
registerRoute(
	({ request, url }) =>
		url.origin === self.location.origin &&
		!isApiOrWsPath(url.pathname) &&
		!isBrandAssetPath(url.pathname) &&
		STATIC_ASSET_DESTINATIONS.has(request.destination),
	new StaleWhileRevalidate({
		cacheName: "narrafork-static-assets",
		plugins: [
			new CacheableResponsePlugin({ statuses: [200] }),
			new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: SEVEN_DAYS_SECONDS }),
		],
	}),
);

// Same-origin fonts/images: prefer cached media with bounded retention.
registerRoute(
	({ request, url }) =>
		url.origin === self.location.origin &&
		!isApiOrWsPath(url.pathname) &&
		!isBrandAssetPath(url.pathname) &&
		STATIC_MEDIA_DESTINATIONS.has(request.destination),
	new CacheFirst({
		cacheName: "narrafork-static-media",
		plugins: [
			new CacheableResponsePlugin({ statuses: [200] }),
			new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: THIRTY_DAYS_SECONDS }),
		],
	}),
);

/*
 * SPA: serve index.html for navigation requests, but NOT for /api/ or /ws/ paths.
 *
 * ⚠️ The cached shell CANNOT be served verbatim, and this is the part that is easy to
 * get wrong because it looks like it already works.
 *
 * `base: "./"` makes the shell's asset references relative (`./assets/index-abc.js`),
 * and relative references resolve against the DOCUMENT's directory. In production the
 * server fixes that per navigation by injecting a `<base href>`
 * (`server/lib/spa-base-href.ts`) — but what Workbox precaches is the BUILD ARTIFACT,
 * which never passed through that injection and therefore carries no `<base>` at all.
 * Serving it for `/settings/providers` makes the browser request
 * `/settings/assets/index-abc.js`: a 404 on the entry script, i.e. a blank page with no
 * client code left running to report it.
 *
 * That failure is NOT limited to a prefixed mount. At the origin root the cached shell
 * is correct only for root-level navigations, so a reload on any nested route while the
 * worker is in control breaks — which is most routes in this app.
 *
 * So the base href is rewritten on the way out. The worker is the one party that knows
 * the mount root ABSOLUTELY (its registration scope), so unlike the server it does not
 * need per-navigation arithmetic: one absolute `<base href="${SW_BASE}">` is correct for
 * every navigation depth, and it works under a mount prefix too.
 */
const spaShellHandler = createHandlerBoundToURL("index.html");

async function serveSpaShell(options: Parameters<typeof spaShellHandler>[0]) {
	const response = await spaShellHandler(options);
	if (!response?.ok) return response;
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/html")) return response;
	const html = setBaseHref(await response.text(), SW_BASE);
	return new Response(html, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

registerRoute(
	new NavigationRoute(serveSpaShell, {
		// Anchored at the mount base, so the denylist keeps working under a prefix —
		// a rooted `/^\/api\//` would not match `/proxy/7778/api/…` and the worker
		// would answer API navigations with the app shell.
		denylist: API_WS_PREFIXES.map(
			(prefix) => new RegExp(`^${escapeRegExp(SW_BASE)}${prefix}(?:/|$)`),
		),
	}),
);

// ── Version check on activate ──────────────────────────────────────────────
const APP_VERSION = __APP_VERSION__;
const VERSION_CHECK_TIMEOUT_MS = 2500;

self.addEventListener("message", (event) => {
	if (event.data?.type === "GET_VERSION") event.ports[0]?.postMessage({ version: APP_VERSION });
});

async function fetchServerVersion(): Promise<string | undefined> {
	const controller = new AbortController();
	const timeout = self.setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);

	try {
		// Mount-prefixed: a rooted `/api/health` reaches the proxy's own root, which
		// answers with something that is not our health payload, so the version check
		// would silently always read `undefined` and never report an update.
		const res = await fetch(`${SW_BASE}api/health`, {
			cache: "no-store",
			headers: { "Cache-Control": "no-cache" },
			signal: controller.signal,
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as { version?: string };
		return data.version;
	} catch {
		// Network error — skip check, don't block activation.
		return undefined;
	} finally {
		self.clearTimeout(timeout);
	}
}

async function notifyVersionMismatch(serverVersion: string) {
	const clients = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	for (const client of clients) {
		client.postMessage({
			type: "VERSION_MISMATCH",
			serverVersion,
			swVersion: APP_VERSION,
		});
	}
}

async function checkVersion(): Promise<void> {
	const serverVersion = await fetchServerVersion();
	if (!serverVersion) return;

	// Prefix-tolerant: release-CI server binaries embed the full commit while
	// this bundle carries the short one (see lib/version-match.ts).
	if (!appVersionsMatch(serverVersion, APP_VERSION)) {
		await notifyVersionMismatch(serverVersion);
	}
}

self.addEventListener("activate", (event) => {
	// Claim without waiting on the network: fetches queue until activation finishes,
	// so a slow health check here would stall every controlled page. The version
	// check is only a hint; pages confirm with the live server themselves.
	event.waitUntil(self.clients.claim());
	void checkVersion().catch(() => {});
});

self.skipWaiting();
