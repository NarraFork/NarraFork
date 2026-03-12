/**
 * Clear all PWA caches and unregister service workers.
 * Used when applying updates to ensure fresh assets are loaded.
 */
export async function clearPwaCache(): Promise<void> {
	try {
		// Unregister service worker
		const reg = await navigator.serviceWorker?.getRegistration();
		if (reg) {
			await reg.unregister();
			console.log("[PWA] Service worker unregistered");
		}

		// Clear all caches
		const keys = await caches.keys();
		if (keys.length > 0) {
			await Promise.allSettled(keys.map((k) => caches.delete(k)));
			console.log(`[PWA] Cleared ${keys.length} caches`);
		}
	} catch (err) {
		console.warn("[PWA] Failed to clear cache:", err);
		// Continue anyway - the reload will still work
	}
}

/**
 * Clear PWA cache and reload the page.
 */
export async function clearPwaCacheAndReload(): Promise<void> {
	await clearPwaCache();
	window.location.reload();
}
