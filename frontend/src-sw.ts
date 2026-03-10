/// <reference lib="webworker" />
import {
	cleanupOutdatedCaches,
	createHandlerBoundToURL,
	precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope;

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA: serve index.html for all navigation requests
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// API requests always go to network
registerRoute(/^https?:\/\/.*\/api\//, new NetworkOnly(), "GET");

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
