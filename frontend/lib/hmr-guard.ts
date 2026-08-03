// --- Polyfills for older browsers (Safari < 15.4 / iOS 14–15.3) ---
// Object.hasOwn is ES2022; used internally by @xyflow/react and others.
// esbuild's `target` only down-levels syntax, not runtime APIs.
if (typeof Object.hasOwn !== "function") {
	const _hasOwnProperty = Object.prototype.hasOwnProperty;
	Object.hasOwn = (obj: object, key: PropertyKey) => _hasOwnProperty.call(obj, key);
}

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

/**
 * Report a React render error that an error boundary already handled.
 *
 * A boundary-caught error never reaches `window.onerror`, so the listeners below
 * cannot see it. TanStack Router gives EVERY route a `CatchBoundary`, which means
 * a stale-module-graph failure inside a route (the "useXxx must be used within
 * XxxProvider" class) is swallowed into a route-level error card and the one-time
 * reload that would repair the module graph never fires — the user is stuck until
 * they reload by hand.
 *
 * `main.tsx` wires this to `createRoot`'s `onCaughtError` / `onUncaughtError` so
 * those errors get the same treatment. It is a no-op outside the dev server.
 */
export function reportReactRenderError(_error: unknown): void {
	reportReactRenderErrorImpl?.(_error);
}

let reportReactRenderErrorImpl: ((error: unknown) => void) | null = null;

if (import.meta.hot) {
	const staleReactReloadKey = "narrafork:stale-react-dev-reload-at";
	const staleReactReloadCooldownMs = 30_000;
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

	const isStandalonePwa = () => {
		const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
		return (
			window.matchMedia?.("(display-mode: standalone)").matches ||
			Boolean(navigatorWithStandalone.standalone)
		);
	};

	const isLikelyMobileTabSuspension = () => {
		const isMobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
		const hasCoarsePointer = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
		return isMobileUserAgent || Boolean(hasCoarsePointer) || isStandalonePwa();
	};

	const reloadOnceForStaleReactGraph = () => {
		const lastReloadAt = Number(sessionStorage.getItem(staleReactReloadKey) ?? 0);
		if (Date.now() - lastReloadAt < staleReactReloadCooldownMs) return;

		sessionStorage.setItem(staleReactReloadKey, String(Date.now()));
		restoreReload();
		window.location.reload();
	};

	const isStaleReactHookError = (message: string) =>
		/Cannot read properties of null \(reading 'use[A-Z][A-Za-z]+'\)/.test(message) ||
		message.includes("Invalid hook call") ||
		// A context module (e.g. ImageViewerProvider) re-evaluated by Fast Refresh
		// creates a NEW context object, while the mounted provider higher in the
		// tree still holds the OLD one. Consumers then read a null context and
		// throw "useXxx must be used within XxxProvider". Same class of stale
		// module-graph split — recover with a one-time reload.
		/must be used within [A-Za-z]+Provider/.test(message);

	const recoverIfStale = (message: string) => {
		if (!isStaleReactHookError(message)) return;

		console.warn("[hmr-guard] Detected a stale React module graph; reloading once.");
		reloadOnceForStaleReactGraph();
	};

	const onRuntimeError = (error: ErrorEvent | PromiseRejectionEvent) => {
		const reason = "reason" in error ? error.reason : error.error;
		recoverIfStale(String(reason?.message ?? ("message" in error ? error.message : "")));
	};

	// Errors an error boundary already handled never reach the listeners below.
	reportReactRenderErrorImpl = (error: unknown) => {
		recoverIfStale(String((error as { message?: unknown } | null)?.message ?? error ?? ""));
	};

	const onVisibilityChange = () => {
		if (document.hidden) {
			pageWasHidden = true;
		}
	};

	document.addEventListener("visibilitychange", onVisibilityChange);
	window.addEventListener("error", onRuntimeError);
	window.addEventListener("unhandledrejection", onRuntimeError);

	import.meta.hot.dispose(() => {
		document.removeEventListener("visibilitychange", onVisibilityChange);
		window.removeEventListener("error", onRuntimeError);
		window.removeEventListener("unhandledrejection", onRuntimeError);
		reportReactRenderErrorImpl = null;
	});

	import.meta.hot.on("vite:ws:disconnect", () => {
		// Only suppress background disconnect reloads in environments that are
		// likely to suspend tabs. On desktop, a disconnect is more likely to mean
		// the Vite server restarted or optimized dependency hashes changed; skipping
		// the reload can leave React DOM and lazy route modules on different React
		// instances, which surfaces as hooks reading from a null dispatcher.
		if ((document.hidden || pageWasHidden) && isLikelyMobileTabSuspension()) {
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
			return;
		}

		pageWasHidden = false;
	});

	import.meta.hot.on("vite:ws:connect", () => {
		restoreReload();
	});
}
