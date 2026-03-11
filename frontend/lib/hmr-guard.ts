/**
 * Prevent Vite HMR from triggering a full page reload when the browser tab
 * returns from background (mobile).
 *
 * Vite's HMR client treats a WebSocket disconnect as "server restarted" and
 * calls `location.reload()` once it can reconnect. On mobile, switching away
 * from the browser for a while causes the HMR WebSocket to close, so coming
 * back always triggers an unwanted full reload.
 *
 * We intercept the `vite:ws:disconnect` custom event and prevent the default
 * reload when the disconnect was caused by a background-tab WebSocket drop
 * rather than an actual server restart.
 */

if (import.meta.hot) {
	let pageWasHidden = false;
	let restoreTimer: ReturnType<typeof setTimeout> | null = null;
	let origReload: typeof window.location.reload | null = null;

	const restoreReload = () => {
		if (origReload) {
			// biome-ignore lint/suspicious/noExplicitAny: restoring native API
			(window.location as any).reload = origReload;
			origReload = null;
		}
		if (restoreTimer) {
			clearTimeout(restoreTimer);
			restoreTimer = null;
		}
	};

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			pageWasHidden = true;
		}
	});

	import.meta.hot.on("vite:ws:disconnect", () => {
		// If the page is hidden (or was just hidden), the disconnect is from
		// the browser suspending the tab, not from the server restarting.
		// Set a flag so we can suppress the reload on reconnect.
		if (document.hidden || pageWasHidden) {
			pageWasHidden = false;

			// Vite's internal handler for vite:ws:disconnect does:
			//   await waitForSuccessfulPing(url)
			//   location.reload()
			//
			// We race it by temporarily replacing location.reload with a no-op.
			// The real reload is restored on ws:connect or after a safety timeout.
			origReload = window.location.reload;
			// biome-ignore lint/suspicious/noExplicitAny: patching native API
			(window.location as any).reload = () => {
				console.debug("[hmr-guard] Suppressed Vite full-reload after tab returned from background");
			};
			restoreTimer = setTimeout(restoreReload, 10_000);
		}
	});

	import.meta.hot.on("vite:ws:connect", () => {
		restoreReload();
	});
}
