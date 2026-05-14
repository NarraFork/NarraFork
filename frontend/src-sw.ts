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

declare let self: ServiceWorkerGlobalScope;

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

function isApiOrWsPath(pathname: string) {
	return (
		pathname === "/api" ||
		pathname.startsWith("/api/") ||
		pathname === "/ws" ||
		pathname.startsWith("/ws/")
	);
}

// Same-origin JS/CSS/workers: keep fast while refreshing in the background.
registerRoute(
	({ request, url }) =>
		url.origin === self.location.origin &&
		!isApiOrWsPath(url.pathname) &&
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
		STATIC_MEDIA_DESTINATIONS.has(request.destination),
	new CacheFirst({
		cacheName: "narrafork-static-media",
		plugins: [
			new CacheableResponsePlugin({ statuses: [200] }),
			new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: THIRTY_DAYS_SECONDS }),
		],
	}),
);

// SPA: serve index.html for navigation requests, but NOT for /api/ or /ws/ paths
registerRoute(
	new NavigationRoute(createHandlerBoundToURL("index.html"), {
		denylist: [/^\/api\//, /^\/ws\//],
	}),
);

// ── Version check on activate ──────────────────────────────────────────────
const APP_VERSION = __APP_VERSION__;
const VERSION_CHECK_TIMEOUT_MS = 2500;

function normalizeVersion(version: string | undefined): string | undefined {
	return version?.replace(/^v/, "");
}

async function fetchServerVersion(): Promise<string | undefined> {
	const controller = new AbortController();
	const timeout = self.setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);

	try {
		const res = await fetch("/api/health", {
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

async function checkVersionAndMaybeUnregister(): Promise<boolean> {
	const serverVersion = await fetchServerVersion();
	if (!serverVersion) return false;

	if (normalizeVersion(serverVersion) !== normalizeVersion(APP_VERSION)) {
		await notifyVersionMismatch(serverVersion);
		await self.registration.unregister();
		return true;
	}

	return false;
}

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// Check before claiming clients. A stale SW should notify and unregister,
			// but must not take over current pages and start handling their fetches.
			const unregistered = await checkVersionAndMaybeUnregister();
			if (!unregistered) {
				await self.clients.claim();
			}
		})(),
	);
});

self.skipWaiting();
