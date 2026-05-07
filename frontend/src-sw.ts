/// <reference lib="webworker" />
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import {
	cleanupOutdatedCaches,
	createHandlerBoundToURL,
	precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkOnly, StaleWhileRevalidate } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope;

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// API and WebSocket requests always go to network
registerRoute(/^https?:\/\/.*\/api\//, new NetworkOnly(), "GET");
registerRoute(/^https?:\/\/.*\/api\//, new NetworkOnly(), "POST");

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

async function checkVersionAndMaybeUnregister() {
	try {
		const res = await fetch("/api/health", { cache: "no-store" });
		if (!res.ok) return;
		const data = await res.json();
		const serverVersion: string = data.version;

		if (serverVersion && serverVersion !== APP_VERSION) {
			// Notify all controlled clients before unregistering
			const clients = await self.clients.matchAll({ type: "window" });
			for (const client of clients) {
				client.postMessage({
					type: "VERSION_MISMATCH",
					serverVersion,
					swVersion: APP_VERSION,
				});
			}
			// Unregister this service worker
			await self.registration.unregister();
		}
	} catch {
		// Network error — skip check, don't block activation
	}
}

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// Claim clients first so the SW controls pages immediately
			await self.clients.claim();
			await checkVersionAndMaybeUnregister();
		})(),
	);
});

self.skipWaiting();
